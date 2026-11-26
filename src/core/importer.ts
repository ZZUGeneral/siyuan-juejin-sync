/**
 * Reverse import (P2): Juejin article → local SiYuan document.
 *
 * Sequence (§4.2):
 *   parse link → fetch body (private API, then the `__NUXT__`/HTML fallback of A4) →
 *   relocate remote images into the notebook's `assets/` → `createDocWithMd` →
 *   write `custom-juejin-source-article-id` + `status = imported`.
 *
 * Degradation is explicit, never silent: the page-extraction path always adds
 * `import.degraded.notice` to `warnings`, and every image that cannot be relocated keeps its
 * original remote URL and lands in `imageFailed[]`.
 */
import { sha256Hex } from "../api/juejinSign";
import { extensionForMime, guessMime } from "../api/kernel";
import type { Logger } from "./logger";
import type { BindingService } from "./binding";
import { countChars, plainText } from "./brief";
import { toSyncError, SyncError } from "./errors";
import { collectImageRefs } from "./markdown";
import { effectivePathTemplate } from "./settings";
import type { SettingsService } from "./settings";
import type {
    ImageRef,
    ImportRequest,
    ImportResult,
    JuejinApi,
    JuejinArticlePreview,
    KernelApi,
} from "../types";
import { ErrorKind } from "../types";

/** Gap between two asset downloads; the proxy is a shared resource (§5.4). */
const DOWNLOAD_INTERVAL_MS = 300;

/** JSON keys that may carry the article body in the rendered page (A4). */
const BODY_KEYS = ["mark_content", "markContent", "content"];

function delay(ms: number): Promise<void> {
    return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode the handful of HTML entities that appear in `<title>` / `og:title`. */
export function decodeEntities(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

/** Read `"key":"value"` out of an HTML payload (the page embeds JSON, not JSONP). */
export function jsonStringField(source: string, key: string): string {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const match = pattern.exec(source);
    if (!match) {
        return "";
    }
    try {
        return JSON.parse(`"${match[1]}"`) as string;
    } catch {
        return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
}

/** Read `<meta property="…" content="…">`. */
export function metaContent(source: string, property: string): string {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i");
    return pattern.exec(source)?.[1] ?? "";
}

/** Read the text of the first `<tag>…</tag>`. */
export function tagText(source: string, tag: string): string {
    const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    return pattern.exec(source)?.[1]?.trim() ?? "";
}

/**
 * A4 fallback extractor: pull title + body out of the rendered article page.
 *
 * This is deliberately shallow — if the page shape changes we return an empty body and the
 * caller reports `import.err.emptyBody` instead of importing a broken document.
 */
export function extractFromPage(html: string): { title: string; markdown: string } {
    let markdown = "";
    for (const key of BODY_KEYS) {
        markdown = jsonStringField(html, key);
        if (markdown.trim().length > 0) {
            break;
        }
    }
    const title = jsonStringField(html, "title") || metaContent(html, "og:title") || tagText(html, "title");
    return { title: decodeEntities(title).trim(), markdown };
}

/** Identify an image by its magic bytes; falls back to the URL extension. */
export function sniffMime(bytes: ArrayBuffer, url: string): string {
    const view = new Uint8Array(bytes.slice(0, 12));
    if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) {
        return "image/png";
    }
    if (view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
        return "image/jpeg";
    }
    if (view[0] === 0x47 && view[1] === 0x49 && view[2] === 0x46) {
        return "image/gif";
    }
    if (
        view[0] === 0x52 &&
        view[1] === 0x49 &&
        view[2] === 0x46 &&
        view[3] === 0x46 &&
        view[8] === 0x57 &&
        view[9] === 0x45 &&
        view[10] === 0x42 &&
        view[11] === 0x50
    ) {
        return "image/webp";
    }
    if (view[0] === 0x42 && view[1] === 0x4d) {
        return "image/bmp";
    }
    const guessed = guessMime(url.split("?")[0]);
    return guessed === "application/octet-stream" ? "image/png" : guessed;
}

/** Strip the characters SiYuan does not accept inside a document path segment. */
export function sanitizePathSegment(value: string): string {
    return value
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

/** Placeholder used by the path template. */
const TITLE_TOKEN = "{{title}}";

/** Expand `{{title}}` inside a template and normalize the leading slash. */
export function buildDocPath(template: string, title: string): string {
    const segment = sanitizePathSegment(title) || "untitled";
    const expanded = template.split(TITLE_TOKEN).join(segment);
    const collapsed = expanded.split("//").join("/").trim();
    if (collapsed.length === 0) {
        return `/${segment}`;
    }
    return collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
}

export interface ImporterDeps {
    api: JuejinApi;
    kernel: KernelApi;
    binding: BindingService;
    settings: SettingsService;
    logger: Logger;
    /** i18n resolver; the importer never renders text on its own. */
    translate: (key: string, params?: Record<string, string | number>) => string;
    /**
     * Additive helper supplied by `api/kernel.ts`: replace the body of an existing document.
     * Without it, "overwrite" degrades to "create another document" (reported as a warning).
     */
    replaceDocContent?: (docId: string, markdown: string) => Promise<void>;
}

interface RelocationOutcome {
    markdown: string;
    total: number;
    relocated: number;
    failed: string[];
    warnings: string[];
}

export class Importer {
    private readonly deps: ImporterDeps;

    constructor(deps: ImporterDeps) {
        this.deps = deps;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.deps.translate(key, params);
    }

    /* ---------------- link parsing ---------------- */

    /**
     * Accept `https://juejin.cn/post/<id>`, the share URL with query string, an `editor/drafts`
     * link, or a bare numeric id.
     *
     * @returns The article id, or `""` when nothing usable was found.
     */
    parseArticleId(input: string): string {
        const text = (input ?? "").trim();
        if (text.length === 0) {
            return "";
        }
        const bare = /^(\d{10,})$/.exec(text);
        if (bare) {
            return bare[1];
        }
        const inUrl = /juejin\.cn\/(?:post|editor\/drafts)\/(\d{10,})/.exec(text);
        if (inUrl) {
            return inUrl[1];
        }
        const loose = /(?:^|\D)(\d{12,})(?:\D|$)/.exec(text);
        return loose ? loose[1] : "";
    }

    /* ---------------- preview ---------------- */

    /** Fetch the article body, degrading to the page extractor when the API answers 404. */
    async preview(articleId: string): Promise<JuejinArticlePreview> {
        const warnings: string[] = [];
        let title = "";
        let markdown = "";
        let origin: JuejinArticlePreview["origin"] = "api";

        try {
            const article = await this.deps.api.getArticle(articleId);
            title = article.title;
            markdown = article.markdown;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.warn(`article.detail failed for ${articleId}, falling back to page: ${message}`);
        }

        if (markdown.trim().length === 0) {
            origin = "page";
            const page = await this.deps.api.fetchArticlePage(articleId);
            const extracted = extractFromPage(page);
            markdown = extracted.markdown;
            title = title.trim().length > 0 ? title : extracted.title;
            warnings.push("import.degraded.notice");
        }

        if (markdown.trim().length === 0) {
            throw new SyncError(ErrorKind.NOT_FOUND, {
                i18nKey: "import.err.emptyBody",
                raw: { endpoint: `juejin.cn/post/${articleId}` },
            });
        }
        const finalTitle = title.trim().length > 0 ? title.trim() : `juejin-${articleId}`;
        return {
            articleId,
            title: finalTitle,
            markdown,
            imageCount: collectImageRefs(markdown).length,
            wordCount: countChars(plainText(markdown)),
            origin,
            warnings,
        };
    }

    /** Find a document previously imported from this article (FR-27). */
    async findExisting(articleId: string): Promise<string | null> {
        return this.deps.binding.findBySourceArticleId(articleId);
    }

    /* ---------------- import ---------------- */

    /** Execute the import. Never throws; every failure is described by `error`. */
    async import(request: ImportRequest): Promise<ImportResult> {
        const articleId = this.parseArticleId(request.articleId);
        const empty: ImportResult = {
            ok: false,
            title: "",
            imageTotal: 0,
            imageRelocated: 0,
            imageFailed: [],
            warnings: [],
        };
        if (articleId.length === 0) {
            return { ...empty, error: new SyncError(ErrorKind.PARAM_INVALID, { i18nKey: "import.parse.invalid" }).toIssue() };
        }
        if (request.notebook.trim().length === 0) {
            return { ...empty, error: new SyncError(ErrorKind.UNKNOWN, { i18nKey: "import.err.noNotebook" }).toIssue() };
        }

        let preview: JuejinArticlePreview;
        try {
            preview = await this.preview(articleId);
        } catch (error) {
            const issue = toSyncError(error);
            this.deps.logger.warn(`preview failed for ${articleId}: ${issue.message}`);
            return { ...empty, warnings: [], error: issue.toIssue() };
        }

        const warnings = [...preview.warnings];
        const existing = await this.findExisting(articleId);
        if (existing && !request.overwrite) {
            return {
                ok: false,
                title: preview.title,
                imageTotal: preview.imageCount,
                imageRelocated: 0,
                imageFailed: [],
                warnings,
                error: new SyncError(ErrorKind.UNKNOWN, {
                    i18nKey: "import.duplicated.text",
                    params: { docId: existing },
                }).toIssue(),
            };
        }

        const relocation = await this.relocateImages(preview.markdown, articleId);
        relocation.warnings.forEach((key) => {
            if (!warnings.includes(key)) {
                warnings.push(key);
            }
        });

        const settings = await this.deps.settings.load();
        const template =
            request.path.trim().length > 0
                ? request.path
                : effectivePathTemplate(settings, this.t("import.path.defaultTemplate"));
        const path = buildDocPath(template, preview.title);

        try {
            let docId = "";
            let contentReplaced = false;
            if (existing && request.overwrite && this.deps.replaceDocContent) {
                try {
                    await this.deps.replaceDocContent(existing, relocation.markdown);
                    docId = existing;
                    contentReplaced = true;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    // Falling back keeps the import useful instead of turning it into a failure.
                    this.deps.logger.warn(`in-place replace failed, creating a new document: ${message}`);
                }
            }
            if (!contentReplaced) {
                docId = await this.deps.kernel.createDocWithMd(request.notebook, path, relocation.markdown);
            }
            await this.deps.binding.write(docId, {
                sourceArticleId: articleId,
                status: "imported",
                syncTime: new Date().toISOString(),
            });
            this.deps.logger.info(`imported ${articleId} -> ${docId} images=${relocation.relocated}/${relocation.total}`);
            return {
                ok: true,
                docId,
                title: preview.title,
                imageTotal: relocation.total,
                imageRelocated: relocation.relocated,
                imageFailed: relocation.failed,
                warnings,
            };
        } catch (error) {
            const issue = toSyncError(error);
            this.deps.logger.warn(`createDocWithMd failed: ${issue.message}`);
            return {
                ok: false,
                title: preview.title,
                imageTotal: relocation.total,
                imageRelocated: relocation.relocated,
                imageFailed: relocation.failed,
                warnings,
                error: issue.toIssue(),
            };
        }
    }

    /* ---------------- image relocation ---------------- */

    /**
     * Download every remote image and store it in the notebook assets directory.
     *
     * A failure keeps the original URL in the body — the import still succeeds (partial).
     */
    private async relocateImages(markdown: string, articleId: string): Promise<RelocationOutcome> {
        const refs: ImageRef[] = collectImageRefs(markdown).filter(
            (ref) => ref.kind === "remote" && (ref.sourceUrl ?? "").length > 0,
        );
        let output = markdown;
        let relocated = 0;
        const failed: string[] = [];
        const warnings: string[] = [];

        for (const ref of refs) {
            const url = ref.sourceUrl ?? "";
            try {
                const bytes = await this.deps.api.downloadBinary(url);
                if (bytes.byteLength === 0) {
                    failed.push(url);
                    continue;
                }
                const mime = sniffMime(bytes, url);
                const extension = extensionForMime(mime);
                const hash = sha256Hex(new Uint8Array(bytes)).slice(0, 8);
                const filename = `juejin-${articleId}-${hash}.${extension === "bin" ? "png" : extension}`;
                // Contract (§9-Q3.1): no leading slash — `/assets/` can create `assets/assets`.
                const outcome = await this.deps.kernel.uploadAsset(bytes, filename, mime, "assets/");
                if (!outcome.ok || outcome.path.length === 0) {
                    this.deps.logger.warn(`asset upload rejected ${filename}: ${outcome.error ?? ""}`);
                    failed.push(url);
                    continue;
                }
                output = output.split(url).join(outcome.path);
                relocated += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.deps.logger.warn(`image download failed ${url}: ${message}`);
                failed.push(url);
            }
            if (refs.length > 1) {
                await delay(DOWNLOAD_INTERVAL_MS);
            }
        }

        if (failed.length > 0) {
            warnings.push("import.result.partial");
        }
        return { markdown: output, total: refs.length, relocated, failed, warnings };
    }
}

/**
 * Markdown sanitizer — the S0–S5 pipeline of `docs/ARCHITECTURE.md` §5.2.
 *
 * Everything in this module is a **pure function**: no network, no kernel, no DOM. That is
 * what lets `tests/markdown.test.ts` cover the whole cleaning logic offline, and what keeps
 * the single IO step (S4, image relocation in `core/images.ts`) isolated.
 *
 * Step order is correctness, not style:
 *   S0 front matter → S1 IAL/zero-width → S2 unsupported blocks → S3 refs → S4 images → S5 audit
 *
 * - S2 must run before S4: widget/iframe HTML can *contain* `![` and `assets/`, and scanning
 *   it would upload phantom images (and pollute the failure list).
 * - S1 must run before S3: `((id "text")){: id="x"}` would otherwise leave a half IAL behind.
 * - `contentHash` is computed on the S0–S3 output, i.e. **before** S4 rewrites URLs, otherwise
 *   every sync would look like a content change (the signed CDN URL changes per upload).
 */
import { sha256Hex, utf8Bytes } from "../api/juejinSign";
import type { Degradation, DegradationKind, ImageRef, SanitizeOutput } from "../types";

/** Block types that have no Juejin counterpart and are replaced by a placeholder. */
export type UnsupportedBlockKind = "superBlock" | "database" | "widget" | "iframe" | "video" | "audio";

/** i18n key of the placeholder line for each unsupported block kind. */
export const UNSUPPORTED_PLACEHOLDER_KEY: Record<UnsupportedBlockKind, string> = {
    superBlock: "sync.placeholder.unsupportedBlock",
    database: "sync.placeholder.database",
    widget: "sync.placeholder.widget",
    iframe: "sync.placeholder.iframe",
    video: "sync.placeholder.video",
    audio: "sync.placeholder.audio",
};

export interface SanitizeOptions {
    /** Builds the placeholder line (resolved from i18n by the caller). */
    placeholder: (kind: UnsupportedBlockKind) => string;
    /** Emit `sync.warn.contentTooLarge` above this many UTF-8 bytes. Defaults to 2 MiB. */
    warnAboveBytes?: number;
}

const DEFAULT_WARN_BYTES = 2 * 1024 * 1024;

/** Tracks `{kind → {count, sample}}` while the steps run. */
class DegradationCollector {
    private readonly entries = new Map<DegradationKind, Degradation>();

    add(kind: DegradationKind, sample?: string): void {
        const existing = this.entries.get(kind);
        if (existing) {
            existing.count += 1;
            if (!existing.sample && sample) {
                existing.sample = sample;
            }
            return;
        }
        this.entries.set(kind, { kind, count: 1, sample });
    }

    addMany(kind: DegradationKind, count: number, sample?: string): void {
        if (count <= 0) {
            return;
        }
        const existing = this.entries.get(kind);
        if (existing) {
            existing.count += count;
            if (!existing.sample && sample) {
                existing.sample = sample;
            }
            return;
        }
        this.entries.set(kind, { kind, count, sample });
    }

    /** Only kinds that actually happened, sorted for stable output. */
    toArray(): Degradation[] {
        return [...this.entries.values()].sort((left, right) => (left.kind < right.kind ? -1 : 1));
    }

    get total(): number {
        return [...this.entries.values()].reduce((sum, item) => sum + item.count, 0);
    }
}

/* ------------------------------------------------------------------ *
 * S0 · YAML front matter
 * ------------------------------------------------------------------ */

export interface FrontMatterResult {
    markdown: string;
    removed: boolean;
}

/**
 * S0: strip the YAML front matter that `exportMdContent` always prepends.
 *
 * Must be first: `title:` would otherwise pollute the H1 extraction, the word count and the
 * excerpt, and Juejin would render the block as a horizontal rule plus a stray `title:` line.
 *
 * @param markdown Raw Kramdown from the kernel.
 */
export function stripFrontMatter(markdown: string): FrontMatterResult {
    const normalized = markdown.replace(/^\uFEFF/, "");
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(normalized);
    if (!match) {
        return { markdown: normalized, removed: false };
    }
    return { markdown: normalized.slice(match[0].length), removed: true };
}

/* ------------------------------------------------------------------ *
 * S1 · block attributes / inline IAL / zero-width characters
 * ------------------------------------------------------------------ */

/**
 * Matches a real attribute list: `{: ` followed by one or more `key="value"` pairs.
 *
 * Requiring the quoted-pair shape (instead of a bare `{:` … `}`) keeps JSON / template
 * snippets inside code blocks intact.
 */
const IAL_PATTERN = /\{\:[ \t]+(?:[A-Za-z_][\w:-]*="[^"\n]*"[ \t]*)+\}/g;

export interface BlockAttrResult {
    markdown: string;
    removed: number;
    sample?: string;
}

/**
 * S1: remove block attributes (`{: id="…"}`) and stray zero-width characters.
 *
 * @param markdown Output of S0.
 */
export function stripBlockAttrs(markdown: string): BlockAttrResult {
    let removed = 0;
    let sample: string | undefined;

    const withoutIal = markdown.replace(IAL_PATTERN, (match: string) => {
        removed += 1;
        if (!sample) {
            sample = match.slice(0, 80);
        }
        return "";
    });
    IAL_PATTERN.lastIndex = 0;

    // Zero-width space and BOM survive the export and render as invisible gaps on Juejin.
    //
    // Trailing blanks are trimmed as well, with one deliberate exception: **exactly two
    // spaces** before a newline is the GFM hard line break (`<br>`). Dropping them merged two
    // visual lines into one on Juejin, so that exact run is preserved while single spaces and
    // tabs-indented runs (export noise) are still removed.
    const cleaned = withoutIal
        .replace(/[\u200b\ufeff]/g, "")
        .replace(/[ \t]+$/gm, (run: string) => (run === "  " ? run : ""));
    return { markdown: cleaned, removed, sample };
}

/* ------------------------------------------------------------------ *
 * S2 · unsupported blocks → placeholder
 * ------------------------------------------------------------------ */

interface BlockRule {
    kind: UnsupportedBlockKind;
    pattern: RegExp;
    /** Use the first capture group as the degradation sample. */
    sampleGroup?: number;
}

const BLOCK_RULES: BlockRule[] = [
    { kind: "iframe", pattern: /<iframe\b[\s\S]*?<\/iframe>/g },
    { kind: "iframe", pattern: /<iframe\b[^>]*\/>/g },
    { kind: "video", pattern: /<video\b[\s\S]*?<\/video>/g },
    { kind: "audio", pattern: /<audio\b[\s\S]*?<\/audio>/g },
    { kind: "database", pattern: /<div\b[^>]*data-type="NodeAttributeView"[\s\S]*?<\/div>/g },
    { kind: "widget", pattern: /<div\b[^>]*data-type="NodeWidget"[\s\S]*?<\/div>/g },
    { kind: "widget", pattern: /<div\b[^>]*data-type="NodeHTMLBlock"[\s\S]*?<\/div>/g },
    { kind: "superBlock", pattern: /\{\{\{[\s\S]*?\}\}\}/g },
];

export interface UnsupportedBlockResult {
    markdown: string;
    counts: Record<string, number>;
    samples: Partial<Record<UnsupportedBlockKind, string>>;
}

/**
 * S2: replace blocks that cannot survive the trip with a single placeholder line.
 *
 * @param markdown Output of S1.
 * @param placeholder Placeholder builder (i18n resolved by the caller).
 */
export function replaceUnsupportedBlocks(
    markdown: string,
    placeholder: (kind: UnsupportedBlockKind) => string,
): UnsupportedBlockResult {
    let result = markdown;
    const counts: Record<string, number> = {};
    const samples: Partial<Record<UnsupportedBlockKind, string>> = {};

    BLOCK_RULES.forEach((rule) => {
        result = result.replace(rule.pattern, (match: string) => {
            counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
            if (!samples[rule.kind]) {
                samples[rule.kind] = match.slice(0, 80);
            }
            return `\n${placeholder(rule.kind)}\n`;
        });
    });

    // Nested `<div>` wrappers leave stray closing tags behind once the outer block is gone;
    // drop the bare tags so the body does not render as literal HTML.
    result = result.replace(/<div\b[^>]*>/g, "").replace(/<\/div>/g, "");

    return { markdown: result, counts, samples };
}

/* ------------------------------------------------------------------ *
 * S3 · references and links
 * ------------------------------------------------------------------ */

const BLOCK_REF_PATTERN = /\(\(\s*(\d{14}-[0-9a-z]{7})\s*(?:"([^"]*)")?\s*\)\)/g;
const DOC_REF_LINK_PATTERN = /\[([^\]]*)\]\(\s*siyuan:\/\/[^)]*\)/g;
const BARE_SIYUAN_URL_PATTERN = /siyuan:\/\/[^\s)]+/g;
const WIKI_REF_PATTERN = /\[\[([^\]]+)\]\]/g;

export interface ReferenceResult {
    markdown: string;
    blockRefs: number;
    docRefs: number;
    sample?: string;
}

/**
 * S3: downgrade SiYuan references to plain text.
 *
 * Runs before S4 so the image scanner only ever sees real image syntax.
 *
 * @param markdown Output of S2.
 */
export function downgradeRefs(markdown: string): ReferenceResult {
    let blockRefs = 0;
    let docRefs = 0;
    let sample: string | undefined;

    // `[label](siyuan://blocks/<id>)` → label
    let result = markdown.replace(DOC_REF_LINK_PATTERN, (match: string, label: string) => {
        docRefs += 1;
        if (!sample) {
            sample = match.slice(0, 80);
        }
        return label;
    });

    // `((<id> "text"))` → text, `((<id>))` → id
    result = result.replace(BLOCK_REF_PATTERN, (match: string, id: string, text?: string) => {
        blockRefs += 1;
        if (!sample) {
            sample = match.slice(0, 80);
        }
        return text && text.length > 0 ? text : id;
    });

    // `[[<id>]]` / `[[<text>]]` → text when it is not an id, otherwise dropped
    result = result.replace(WIKI_REF_PATTERN, (match: string, inner: string) => {
        docRefs += 1;
        if (!sample) {
            sample = match.slice(0, 80);
        }
        return /^\d{14}-[0-9a-z]{7}$/.test(inner.trim()) ? "" : inner;
    });

    // Any leftover bare `siyuan://…` URL cannot resolve outside SiYuan.
    result = result.replace(BARE_SIYUAN_URL_PATTERN, () => {
        docRefs += 1;
        return "";
    });

    return { markdown: result, blockRefs, docRefs, sample };
}

/* ------------------------------------------------------------------ *
 * S4 helper · code-region stripping (pure, reused by images.ts)
 * ------------------------------------------------------------------ */

/**
 * Blank out fenced code blocks and inline code spans.
 *
 * The returned copy is only used for **scanning**; replacements always apply to the original
 * text, so code samples survive untouched.
 *
 * @param markdown Markdown body.
 */
export function stripCodeRegions(markdown: string): string {
    const lines = markdown.split("\n");
    const kept: string[] = [];
    let fence: string | null = null;

    lines.forEach((line) => {
        const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
                fence = null;
            }
            kept.push("");
            return;
        }
        if (match) {
            fence = match[1];
            kept.push("");
            return;
        }
        kept.push(line);
    });

    return kept.join("\n").replace(/`[^`\n]*`/g, "");
}

/** `![alt](target "title")` — target excludes whitespace and the closing paren. */
const IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * Classify one image target.
 *
 * @param target Raw URL / path from the markdown.
 */
export function classifyImageTarget(target: string): ImageRef {
    const ref = target.trim();
    if (/^data:/i.test(ref)) {
        return { kind: "data", ref };
    }
    if (/^https?:\/\//i.test(ref)) {
        return { kind: "remote", ref, sourceUrl: ref };
    }
    const assetPath = ref.replace(/^\.?\//, "");
    return { kind: "local", ref, assetPath };
}

/**
 * S4 (scan half): collect every image reference that is **not** inside code.
 *
 * @param markdown Output of S3.
 */
export function collectImageRefs(markdown: string): ImageRef[] {
    const scannable = stripCodeRegions(markdown);
    const seen = new Set<string>();
    const refs: ImageRef[] = [];

    for (const match of scannable.matchAll(IMAGE_PATTERN)) {
        const target = match[2];
        if (!target || seen.has(target)) {
            continue;
        }
        seen.add(target);
        refs.push(classifyImageTarget(target));
    }
    return refs;
}

/* ------------------------------------------------------------------ *
 * S5 · audit
 * ------------------------------------------------------------------ */

/**
 * S5: last-pass assertions. Findings become warnings — **never** a hard failure (§5.2).
 *
 * @param markdown Body after S0–S3 (images are replaced later, so `assets/` is expected then).
 * @param options.expectAssets Set to `false` after S4 to report leftovers as a warning.
 */
export function audit(markdown: string, options?: { expectAssets?: boolean }): string[] {
    const warnings: string[] = [];
    if (/\{\:[ \t]/.test(markdown)) {
        warnings.push("sync.warn.residualBlockAttr");
    }
    if (/\(\(\s*\d{14}-[0-9a-z]{7}/.test(markdown) || markdown.indexOf("siyuan://") >= 0) {
        warnings.push("sync.warn.residualRef");
    }
    if (options?.expectAssets === false && /\]\([^)]*assets\//.test(markdown)) {
        warnings.push("sync.warn.residualAsset");
    }
    return warnings;
}

/**
 * Run the whole S0–S3 + S5 pipeline.
 *
 * (S4 lives in `core/images.ts` because it is the only step with network side effects.)
 *
 * @param markdown Raw Kramdown from `exportMdContent`.
 * @param options Placeholder builder + size threshold.
 */
export function sanitize(markdown: string, options: SanitizeOptions): SanitizeOutput {
    const degradations = new DegradationCollector();

    const s0 = stripFrontMatter(markdown);
    const s1 = stripBlockAttrs(s0.markdown);
    if (s1.removed > 0) {
        degradations.addMany("block-attr", s1.removed, s1.sample);
    }

    const s2 = replaceUnsupportedBlocks(s1.markdown, options.placeholder);
    Object.entries(s2.counts).forEach(([kind, count]) => {
        degradations.addMany("unsupported-block", count, s2.samples[kind as UnsupportedBlockKind]);
    });

    const s3 = downgradeRefs(s2.markdown);
    if (s3.blockRefs > 0) {
        degradations.addMany("block-ref", s3.blockRefs, s3.sample);
    }
    if (s3.docRefs > 0) {
        degradations.addMany("doc-ref", s3.docRefs, s3.sample);
    }

    const body = s3.markdown.trim();
    const imageRefs = collectImageRefs(body);

    const warnings = audit(body);
    if (imageRefs.some((ref) => ref.kind === "remote")) {
        warnings.push("sync.warn.remoteImage");
        degradations.addMany("remote-image", imageRefs.filter((ref) => ref.kind === "remote").length);
    }
    const threshold = options.warnAboveBytes ?? DEFAULT_WARN_BYTES;
    if (utf8Bytes(body).length > threshold) {
        warnings.push("sync.warn.contentTooLarge");
    }

    return {
        markdown: body,
        contentHash: sha256Hex(body),
        degradations: degradations.toArray(),
        warnings,
        imageRefs,
    };
}

/**
 * Extract a usable title: an H1 if present, otherwise the first non-empty line.
 *
 * @param markdown Body after S0.
 */
export function extractTitle(markdown: string): string {
    const heading = /^#[ \t]+(.+)$/m.exec(markdown);
    if (heading) {
        return heading[1].trim();
    }
    const firstLine = markdown
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("!") && !line.startsWith("<"));
    return firstLine ?? "";
}

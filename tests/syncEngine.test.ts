/**
 * Regression tests for the newly covered orchestration layer.
 *
 * Before this file existed, `core/syncEngine.ts` had **zero** tests, which is exactly where
 * the PRD's riskiest acceptance criteria live (FR-10 repeat-sync, D1/D2 image-stage
 * behaviour, content-hash timing). Everything here uses injected fakes — no network, no
 * kernel, no Juejin account — so the suite stays offline and fast.
 *
 * Fakes are deliberately thin: the *real* `BindingService`, `ImagePipeline`, `SyncStore`,
 * `sanitize` and `brief` code runs against fake transports, so a regression in any of them
 * is caught here rather than only in a real sync.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { BindingService } from "../src/core/binding";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { ImagePipeline } from "../src/core/images";
import { SyncEngine } from "../src/core/syncEngine";
import { sanitize } from "../src/core/markdown";
import { SyncStore } from "../src/core/store";
import { sha256Hex } from "../src/api/juejinSign";
import { BRIEF_MAX, BRIEF_MIN, BLOCK_ATTR } from "../src/types";
import type {
    JuejinApi,
    KernelApi,
    SyncSettings,
    SyncResult,
} from "../src/types";
import type { Logger } from "../src/core/logger";
import type { SettingsService } from "../src/core/settings";

const DOC_ID = "20261125220000-doc0001";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

/** Home-made i18n resolver: returning the key keeps assertions readable. */
const t = (key: string, params?: Record<string, string | number>): string =>
    params ? `${key}:${JSON.stringify(params)}` : key;

/** Placeholder builder identical in shape to the one `index.ts` injects. */
const placeholder = (kind: string): string => `> [${kind}]`;

const CONTENT_WITH_IMAGE = [
    "---",
    "title: My Doc",
    "date: 2026-11-25T00:00:00Z",
    "---",
    "",
    "# My Doc",
    "",
    "A paragraph of body text that is long enough to look like a real article.",
    "",
    "![shot](assets/shot.png)",
    "",
    "Tail paragraph.",
    "",
].join("\n");

interface FakeApi extends Record<string, Mock> {
    createDraft: Mock;
    updateDraft: Mock;
    publishDraft: Mock;
    uploadImage: Mock;
}

interface Harness {
    engine: SyncEngine;
    api: FakeApi;
    kernel: KernelApi;
    store: SyncStore;
    settings: SyncSettings;
    attrsOf: (docId?: string) => Record<string, string>;
    syncCalls: () => { created: number; updated: number };
}

interface HarnessOptions {
    content?: string;
    attrs?: Record<string, string>;
    settings?: Partial<SyncSettings>;
    /** `null` makes every asset lookup miss, which is how D2's "preflight fails" is faked. */
    assetBytes?: ArrayBuffer | null;
    uploadImage?: Mock;
    kernelOverrides?: Partial<KernelApi>;
}

function createHarness(options: HarnessOptions = {}): Harness {
    const content = options.content ?? CONTENT_WITH_IMAGE;
    const settings: SyncSettings = {
        ...DEFAULT_SETTINGS,
        riskAccepted: true,
        defaultCategoryId: "6809637767543259144",
        defaultTagIds: ["tag-a"],
        requestIntervalMs: 0,
        ...options.settings,
    };

    const attrStore = new Map<string, Record<string, string>>([
        [DOC_ID, { ...(options.attrs ?? {}) }],
    ]);

    const kernel = {
        exportMdContent: vi.fn(async () => ({ hPath: "/notes/My Doc", content })),
        getBlockAttrs: vi.fn(async (id: string) => ({ ...(attrStore.get(id) ?? {}) })),
        setBlockAttrs: vi.fn(async (id: string, attrs: Record<string, string>) => {
            const merged = { ...(attrStore.get(id) ?? {}) };
            Object.entries(attrs).forEach(([key, value]) => {
                if (value === "") {
                    delete merged[key];
                } else {
                    merged[key] = value;
                }
            });
            attrStore.set(id, merged);
        }),
        getDocNotebook: vi.fn(async () => "nb-1"),
        createDocWithMd: vi.fn(async () => "new-doc"),
        fetchAssetBinary: vi.fn(async () => {
            if (options.assetBytes === null) {
                return null;
            }
            return { bytes: options.assetBytes ?? new Uint8Array([1, 2, 3, 4]).buffer, mime: "image/png" };
        }),
        uploadAsset: vi.fn(async () => ({ ok: true, path: "assets/x.png" })),
        querySql: vi.fn(async () => []),
        listNotebooks: vi.fn(async () => []),
        openDoc: vi.fn(),
        ...(options.kernelOverrides ?? {}),
    } as unknown as KernelApi;

    const api = {
        probeCredential: vi.fn(),
        fetchCategories: vi.fn(async () => []),
        fetchTags: vi.fn(async () => []),
        createDraft: vi.fn(async () => ({ draftId: "draft-1" })),
        updateDraft: vi.fn(async () => ({ draftId: "draft-1" })),
        getDraft: vi.fn(),
        publishDraft: vi.fn(async () => ({ articleId: "article-1", draftId: "draft-1" })),
        getArticle: vi.fn(),
        uploadImage: options.uploadImage ?? vi.fn(async () => "https://cdn.example/1.png"),
        probeEndpoints: vi.fn(async () => []),
        downloadBinary: vi.fn(),
        fetchArticlePage: vi.fn(),
    } as unknown as FakeApi;

    const binding = new BindingService({ kernel, logger: silentLogger });
    const pipeline = new ImagePipeline({
        api: api as unknown as JuejinApi,
        kernel,
        logger: silentLogger,
        uploadEnabled: settings.autoUploadImages,
        intervalMs: 0,
    });
    const store = new SyncStore();

    const engine = new SyncEngine({
        kernel,
        api: api as unknown as JuejinApi,
        settings: { load: async () => settings } as unknown as SettingsService,
        binding,
        pipeline,
        store,
        logger: silentLogger,
        translate: t,
    });

    return {
        engine,
        api,
        kernel,
        store,
        settings,
        attrsOf: (docId: string = DOC_ID) => ({ ...(attrStore.get(docId) ?? {}) }),
        syncCalls: () => ({
            created: api.createDraft.mock.calls.length,
            updated: api.updateDraft.mock.calls.length,
        }),
    };
}

/** Body the pipeline produces before S4 (used to recompute the expected hash). */
function expectedHash(content: string): string {
    return sanitize(content, { placeholder }).contentHash;
}

describe("FR-10 · repeat sync never creates a second article", () => {
    it("creates once and updates twice across three consecutive runs", async () => {
        const harness = createHarness();
        const results: SyncResult[] = [];
        for (let run = 0; run < 3; run += 1) {
            results.push(await harness.engine.sync(DOC_ID));
        }

        expect(results.every((result) => result.ok)).toBe(true);
        expect(harness.syncCalls()).toEqual({ created: 1, updated: 2 });
        expect(results[0].action).toBe("created");
        expect(results[1].action).toBe("updated");
        expect(results[2].action).toBe("updated");
        // One document, one draft id, for ever.
        expect(new Set(results.map((result) => result.draftId))).toEqual(new Set(["draft-1"]));
    });

    it("uses draft.update when a draft id is already bound (status=draft)", async () => {
        const harness = createHarness({
            attrs: {
                [BLOCK_ATTR.DRAFT_ID]: "draft-9",
                [BLOCK_ATTR.ARTICLE_ID]: "article-9",
                [BLOCK_ATTR.STATUS]: "draft",
            },
        });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(true);
        expect(result.action).toBe("updated");
        expect(harness.api.createDraft).not.toHaveBeenCalled();
        expect(harness.api.updateDraft).toHaveBeenCalledTimes(1);
        expect(harness.api.updateDraft.mock.calls[0][0]).toBe("draft-9");
    });

    it("aborts without touching any write endpoint when the article is published (FR-10 ②)", async () => {
        const harness = createHarness({
            attrs: {
                [BLOCK_ATTR.DRAFT_ID]: "draft-9",
                [BLOCK_ATTR.ARTICLE_ID]: "article-9",
                [BLOCK_ATTR.STATUS]: "published",
            },
        });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(false);
        expect(result.action).toBe("blocked");
        expect(result.error?.i18nKey).toBe("sync.blocked.published");
        expect(harness.api.createDraft).not.toHaveBeenCalled();
        expect(harness.api.updateDraft).not.toHaveBeenCalled();
        expect(harness.api.publishDraft).not.toHaveBeenCalled();
        // The published article must keep its binding intact.
        expect(harness.attrsOf()[BLOCK_ATTR.ARTICLE_ID]).toBe("article-9");
    });
});

describe("D2 · a failed pre-flight only warns and never blocks the sync", () => {
    it("still creates the draft when every asset lookup misses", async () => {
        const harness = createHarness({ assetBytes: null });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(true);
        expect(harness.api.createDraft).toHaveBeenCalledTimes(1);
        expect(result.warnings).toContain("sync.warn.precheckFailed");
        // The missing image is still reported, per FR-08 ②.
        expect(result.imageFailed.length).toBeGreaterThan(0);
        expect(result.partial).toBe(true);
    });

    it("keeps going when the asset fetch throws instead of returning null", async () => {
        const harness = createHarness({
            kernelOverrides: {
                fetchAssetBinary: vi.fn(async () => {
                    throw new Error("kernel exploded");
                }),
            },
        });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(true);
        expect(harness.api.createDraft).toHaveBeenCalledTimes(1);
        expect(result.warnings).toContain("sync.warn.precheckFailed");
    });
});

describe("D1 · the image stage is unconditional and never silently passes", () => {
    it("reports every local image as failed when uploads are disabled", async () => {
        const harness = createHarness({ settings: { autoUploadImages: false } });

        const result = await harness.engine.sync(DOC_ID);

        expect(harness.api.uploadImage).not.toHaveBeenCalled();
        expect(harness.api.createDraft).toHaveBeenCalledTimes(1);
        expect(result.partial).toBe(true);
        expect(result.imageUploaded).toBe(0);
        expect(result.imageFailed.map((item) => item.reason)).toEqual(["image.skip.disabled"]);
        // The body must keep the original reference, not lose the picture.  ->
        const submitted = harness.api.createDraft.mock.calls[0][0] as { markdown: string };
        expect(submitted.markdown).toContain("assets/shot.png");
    });
});

describe("FR-08 ④ · a failing upload degrades to 'partial', never to an exception", () => {
    it("keeps the original reference and still submits the draft", async () => {
        const uploadImage = vi.fn(async () => {
            throw new Error("imagex 500");
        });
        const harness = createHarness({ uploadImage });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(true);
        expect(result.partial).toBe(true);
        expect(result.imageFailed).toHaveLength(1);
        expect(result.imageFailed[0].ok).toBe(false);
        expect(typeof result.imageFailed[0].reason).toBe("string");
        expect(harness.api.createDraft).toHaveBeenCalledTimes(1);
        const submitted = harness.api.createDraft.mock.calls[0][0] as { markdown: string };
        expect(submitted.markdown).toContain("assets/shot.png");
        expect(submitted.markdown).not.toContain("cdn.example");
    });

    it("replaces only the URL when the upload succeeds", async () => {
        const harness = createHarness();

        const result = await harness.engine.sync(DOC_ID);

        expect(result.imageUploaded).toBe(1);
        expect(result.imageFailed).toEqual([]);
        const submitted = harness.api.createDraft.mock.calls[0][0] as { markdown: string };
        expect(submitted.markdown).toContain("![shot](https://cdn.example/1.png)");
        expect(submitted.markdown).not.toContain("assets/shot.png");
    });
});

describe("§5.2.1 #3 · contentHash is computed before the image URLs are rewritten", () => {
    it("writes the same hash even though every upload yields a different signed URL", async () => {
        const uploads = ["https://cdn.example/aaa.png", "https://cdn.example/bbb.png"];
        let call = 0;
        const uploadImage = vi.fn(async () => uploads[call++ % uploads.length]);
        const harness = createHarness({ uploadImage });

        await harness.engine.sync(DOC_ID);
        const firstHash = harness.attrsOf()[BLOCK_ATTR.CONTENT_HASH];
        await harness.engine.sync(DOC_ID);
        const secondHash = harness.attrsOf()[BLOCK_ATTR.CONTENT_HASH];

        expect(firstHash).toBe(expectedHash(CONTENT_WITH_IMAGE));
        expect(secondHash).toBe(firstHash);
        // Sanity: the hash is *not* the hash of the submitted (post-replacement) body,
        // which would change on every sync because the CDN URL is signed.
        const submitted = harness.api.updateDraft.mock.calls[0][1] as { markdown: string };
        expect(sha256Hex(submitted.markdown)).not.toBe(firstHash);
    });
});

describe("M1 · metadata assembly and validation", () => {
    it("blocks before uploading anything when no category is configured", async () => {
        const harness = createHarness({ settings: { defaultCategoryId: "", defaultTagIds: ["tag-a"] } });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(false);
        expect(result.error?.i18nKey).toBe("sync.blocked.noCategory");
        expect(harness.api.createDraft).not.toHaveBeenCalled();
        expect(harness.api.uploadImage).not.toHaveBeenCalled();
    });

    it("blocks when no tag is configured", async () => {
        const harness = createHarness({ settings: { defaultTagIds: [] } });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(false);
        expect(result.error?.i18nKey).toBe("sync.blocked.noTag");
        expect(harness.api.createDraft).not.toHaveBeenCalled();
    });

    it("blocks an empty document (FR-04 ②)", async () => {
        const harness = createHarness({ content: "   \n\n  " });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(false);
        expect(result.error?.i18nKey).toBe("sync.blocked.empty");
        expect(harness.api.createDraft).not.toHaveBeenCalled();
    });

    it("prefers per-document overrides, then the notebook mapping, then the global default", async () => {
        const harness = createHarness({
            settings: {
                defaultCategoryId: "cat-global",
                defaultTagIds: ["tag-global"],
                notebookCategoryMapping: { "nb-1": { categoryId: "cat-notebook", tagIds: ["tag-notebook"] } },
            },
        });

        await harness.engine.sync(DOC_ID, { categoryId: "cat-override", tagIds: ["tag-override"] });
        const overrideInput = harness.api.createDraft.mock.calls[0][0] as { categoryId: string; tagIds: string[] };
        expect(overrideInput.categoryId).toBe("cat-override");
        expect(overrideInput.tagIds).toEqual(["tag-override"]);

        await harness.engine.sync(DOC_ID);
        const mappingInput = harness.api.updateDraft.mock.calls[0][1] as { categoryId: string; tagIds: string[] };
        expect(mappingInput.categoryId).toBe("cat-notebook");
        expect(mappingInput.tagIds).toEqual(["tag-notebook"]);
    });

    it("always submits a brief inside [50, 100] code points (A1)", async () => {
        const harness = createHarness({ content: "# T\n\nshort\n" });

        await harness.engine.sync(DOC_ID, { brief: "\u{1F600}".repeat(5) });

        const submitted = harness.api.createDraft.mock.calls[0][0] as { briefContent: string };
        const length = Array.from(submitted.briefContent).length;
        expect(length).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(length).toBeLessThanOrEqual(BRIEF_MAX);
        expect(harness.attrsOf()[BLOCK_ATTR.BRIEF]).toBe(submitted.briefContent);
    });

    it("applies the title prefix and suffix", async () => {
        const harness = createHarness({ settings: { titlePrefix: "P-", titleSuffix: "-S" } });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.title).toBe("P-My Doc-S");
        const submitted = harness.api.createDraft.mock.calls[0][0] as { title: string };
        expect(submitted.title).toBe("P-My Doc-S");
    });

    it("never applies any length or keyword pre-check to the body (G-02 / D4)", async () => {
        const longBody = `${"# Long\n\n"}${"正文内容段落。".repeat(4000)}\n\n敏感词占位文本\n`;
        const harness = createHarness({ content: longBody, assetBytes: null });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(true);
        const submitted = harness.api.createDraft.mock.calls[0][0] as { markdown: string };
        expect(submitted.markdown).toContain("敏感词占位文本");
        expect(submitted.markdown.length).toBeGreaterThan(10000);
    });
});

describe("FR-13 · publishing is never implied by a setting alone", () => {
    it("refuses to publish without the explicit second confirmation", async () => {
        const harness = createHarness({ settings: { publishMode: "publish" } });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(false);
        expect(result.error?.i18nKey).toBe("sync.publish.confirmTitle");
        expect(harness.api.createDraft).not.toHaveBeenCalled();
        expect(harness.api.publishDraft).not.toHaveBeenCalled();
    });

    it("publishes, records the article id and flags the status once confirmed", async () => {
        const harness = createHarness({ settings: { publishMode: "publish" } });

        const result = await harness.engine.sync(DOC_ID, { confirmedPublish: true });

        expect(result.ok).toBe(true);
        expect(harness.api.publishDraft).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("published");
        expect(result.juejinUrl).toBe("https://juejin.cn/post/article-1");
        expect(harness.attrsOf()[BLOCK_ATTR.STATUS]).toBe("published");
        expect(harness.attrsOf()[BLOCK_ATTR.ARTICLE_ID]).toBe("article-1");
    });
});

describe("error handling · sync() never throws", () => {
    it("turns a kernel failure into a blocked result", async () => {
        const harness = createHarness({
            kernelOverrides: {
                exportMdContent: vi.fn(async () => {
                    throw new Error("kernel down");
                }),
            },
        });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(false);
        expect(result.action).toBe("blocked");
        expect(result.error?.kind).toBe("unknown");
        expect(result.error?.raw.errMsg).toBe("kernel down");
    });

    it("marks the document as failed so the dock can show 'last run failed' (FR-11 ①)", async () => {
        const harness = createHarness({ settings: { defaultCategoryId: "" } });

        await harness.engine.sync(DOC_ID);

        expect(harness.attrsOf()[BLOCK_ATTR.STATUS]).toBe("failed");
        // `rememberFailure` renders the i18n key through the injected translator.
        expect(harness.attrsOf()[BLOCK_ATTR.LAST_ERROR]).toContain("sync.blocked.noCategory");
    });

    it("refuses a concurrent run while the store is busy", async () => {
        const harness = createHarness();
        harness.store.patch({ busy: true });

        const result = await harness.engine.sync(DOC_ID);

        expect(result.ok).toBe(false);
        expect(result.error?.i18nKey).toBe("sync.blocked.busy");
        expect(harness.api.createDraft).not.toHaveBeenCalled();
    });
});

describe("preview · read-only M1 view", () => {
    it("counts images and reports the action without uploading", async () => {
        const harness = createHarness();

        const preview = await harness.engine.preview(DOC_ID);

        expect(preview.imageTotal).toBe(1);
        expect(preview.action).toBe("created");
        expect(preview.status).toBe("unsynced");
        expect(preview.title).toBe("My Doc");
        expect(harness.api.uploadImage).not.toHaveBeenCalled();
        expect(harness.api.createDraft).not.toHaveBeenCalled();
    });
});

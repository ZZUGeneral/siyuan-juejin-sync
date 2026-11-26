/**
 * Reverse import (P2 / FR-22 … FR-27) — the parts that are verifiable offline.
 *
 * The two riskiest pieces are covered here:
 *  1. **link parsing** — three accepted shapes plus junk, because a mis-parse silently imports
 *     the wrong article;
 *  2. **path construction** — `{{title}}` is user content, so a title containing `/`, `:` or
 *     `..` must never be able to escape the intended folder or produce an invalid document path.
 */
import { describe, expect, it, vi } from "vitest";
import {
    Importer,
    buildDocPath,
    decodeEntities,
    extractFromPage,
    jsonStringField,
    metaContent,
    sanitizePathSegment,
    sniffMime,
    tagText,
} from "../src/core/importer";
import type { JuejinApi, ImportRequest, KernelApi } from "../src/types";
import type { BindingService } from "../src/core/binding";
import type { Logger } from "../src/core/logger";
import type { SettingsService } from "../src/core/settings";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

const t = (key: string): string => key;

interface ImporterHarness {
    importer: Importer;
    api: Record<string, ReturnType<typeof vi.fn>>;
    kernel: Record<string, ReturnType<typeof vi.fn>>;
    binding: Record<string, ReturnType<typeof vi.fn>>;
}

function makeImporter(options: {
    article?: { title: string; markdown: string } | Error;
    page?: string;
    existing?: string | null;
    notebooks?: string[];
} = {}): ImporterHarness {
    const api = {
        getArticle: vi.fn(async () => {
            if (options.article instanceof Error) {
                throw options.article;
            }
            return {
                articleId: "7000000000000000001",
                title: options.article?.title ?? "Imported title",
                markdown: options.article?.markdown ?? "body text",
                status: 0,
            };
        }),
        fetchArticlePage: vi.fn(async () => options.page ?? ""),
        downloadBinary: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]).buffer),
    };
    const kernel = {
        createDocWithMd: vi.fn(async () => "new-doc-id"),
        uploadAsset: vi.fn(async () => ({ ok: true, path: "assets/juejin-1-abcdef12.png" })),
    };
    const binding = {
        findBySourceArticleId: vi.fn(async () => options.existing ?? null),
        write: vi.fn(async () => undefined),
    };

    const importer = new Importer({
        api: api as unknown as JuejinApi,
        kernel: kernel as unknown as KernelApi,
        binding: binding as unknown as BindingService,
        settings: { load: async () => ({ reverseImportPathTemplate: "" }) } as unknown as SettingsService,
        logger: silentLogger,
        translate: t,
        replaceDocContent: vi.fn(async () => undefined),
    });

    return { importer, api, kernel, binding };
}

const REQUEST: ImportRequest = {
    articleId: "7000000000000000001",
    notebook: "nb-1",
    path: "/imported/{{title}}",
    overwrite: false,
};

describe("parseArticleId · three accepted shapes (FR-22 ①)", () => {
    const { importer } = makeImporter();

    it.each([
        ["https://juejin.cn/post/7000000000000000001", "7000000000000000001"],
        ["https://juejin.cn/post/7000000000000000001?share_token=abc", "7000000000000000001"],
        ["juejin.cn/post/7000000000000000001", "7000000000000000001"],
        ["/post/7000000000000000001", "7000000000000000001"],
        ["7000000000000000001", "7000000000000000001"],
        ["https://juejin.cn/editor/drafts/7000000000000000001", "7000000000000000001"],
        ["  7000000000000000001  ", "7000000000000000001"],
    ])("extracts the id from %s", (input, expected) => {
        expect(importer.parseArticleId(input)).toBe(expected);
    });

    it.each(["", "   ", "not a link", "https://example.com/post/123", "12345"])(
        "returns an empty string for %s",
        (input) => {
            expect(importer.parseArticleId(input)).toBe("");
        },
    );
});

describe("sanitizePathSegment · titles are user content", () => {
    it.each([
        ["a/b", "a_b"],
        ["a:b", "a_b"],
        ["a*b?c", "a_b_c"],
        ["a<b>c|d", "a_b_c_d"],
        ['a"b', "a_b"],
        ["a\\b", "a_b"],
    ])("replaces the reserved character in %s", (input, expected) => {
        expect(sanitizePathSegment(input)).toBe(expected);
    });

    it("neutralizes path traversal: the title stays one path segment", () => {
        // `/` becomes `_`, so ".." can survive as literal text but can never act as a segment.
        expect(sanitizePathSegment("../../etc/passwd")).not.toContain("/");
        const path = buildDocPath("/imported/{{title}}", "../../etc/passwd");
        const segments = path.split("/");
        expect(segments).not.toContain("..");
        expect(segments.filter((part) => part.length > 0)).toHaveLength(2);
        expect(path.startsWith("/imported/")).toBe(true);
    });

    it("caps the segment length", () => {
        expect(sanitizePathSegment("x".repeat(400))).toHaveLength(120);
    });

    it("collapses whitespace", () => {
        expect(sanitizePathSegment("  a    b  ")).toBe("a b");
    });
});

describe("buildDocPath · template expansion", () => {
    it("expands {{title}} and keeps a single leading slash", () => {
        expect(buildDocPath("/博客导入/{{title}}", "My Note")).toBe("/博客导入/My Note");
    });

    it("adds the missing leading slash", () => {
        expect(buildDocPath("博客导入/{{title}}", "N")).toBe("/博客导入/N");
    });

    it("collapses doubled slashes", () => {
        expect(buildDocPath("//a//{{title}}", "N")).toBe("/a/N");
    });

    it("falls back to 'untitled' for an unusable title", () => {
        expect(buildDocPath("/imported/{{title}}", "   ")).toBe("/imported/untitled");
    });

    it("supports a template without the token", () => {
        expect(buildDocPath("/fixed/path", "Whatever")).toBe("/fixed/path");
    });

    it("replaces every occurrence of the token", () => {
        expect(buildDocPath("/a/{{title}}/{{title}}", "N")).toBe("/a/N/N");
    });
});

describe("page extraction (A4 fallback)", () => {
    it("reads mark_content out of the embedded JSON", () => {
        const html = '<script>window.__NUXT__={"mark_content":"# Title\\n\\nBody text"}</script>';
        expect(extractFromPage(html).markdown).toBe("# Title\n\nBody text");
    });

    it("falls back to og:title and then to <title>", () => {
        expect(extractFromPage('<meta property="og:title" content="OG Title">').title).toBe("OG Title");
        expect(extractFromPage("<title>Tag Title</title>").title).toBe("Tag Title");
    });

    it("decodes HTML entities", () => {
        expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f")).toBe('a & b <c> "d" \'e\' f');
    });

    it("returns an empty body when the page shape is unknown", () => {
        expect(extractFromPage("<html><body>nothing</body></html>").markdown).toBe("");
    });

    it("handles escape sequences inside the JSON field", () => {
        expect(jsonStringField('{"content":"a\\"b"}', "content")).toBe('a"b');
    });

    it("reads meta content with a name attribute too", () => {
        expect(metaContent('<meta name="description" content="desc">', "description")).toBe("desc");
    });

    it("reads tag text", () => {
        expect(tagText("<h1> Heading </h1>", "h1")).toBe("Heading");
    });
});

describe("sniffMime · magic bytes before extensions", () => {
    it.each([
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer, "https://x/a.bin", "image/png"],
        [new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer, "https://x/a.bin", "image/jpeg"],
        [new Uint8Array([0x47, 0x49, 0x46, 0x38]).buffer, "https://x/a.bin", "image/gif"],
        [new Uint8Array([0x42, 0x4d, 0, 0]).buffer, "https://x/a.bin", "image/bmp"],
    ])("detects %s", (bytes, url, expected) => {
        expect(sniffMime(bytes as ArrayBuffer, url)).toBe(expected);
    });

    it("falls back to the URL extension", () => {
        expect(sniffMime(new Uint8Array([1, 2, 3]).buffer, "https://x/a.jpeg?sign=1")).toBe("image/jpeg");
    });
});

describe("Importer.import · end to end with fakes", () => {
    it("creates the document, relocates images and marks the status imported", async () => {
        const harness = makeImporter({ article: { title: "T", markdown: "![a](https://cdn.juejin.cn/x.png)" } });

        const result = await harness.importer.import({ ...REQUEST, articleId: "https://juejin.cn/post/7000000000000000001" });

        expect(result.ok).toBe(true);
        expect(result.docId).toBe("new-doc-id");
        expect(result.imageTotal).toBe(1);
        expect(result.imageRelocated).toBe(1);
        expect(harness.kernel.uploadAsset).toHaveBeenCalledTimes(1);
        const [notebook, path, markdown] = harness.kernel.createDocWithMd.mock.calls[0] as [string, string, string];
        expect(notebook).toBe("nb-1");
        expect(path).toBe("/imported/T");
        expect(markdown).toContain("assets/juejin-1-abcdef12.png");
        expect(markdown).not.toContain("cdn.juejin.cn");
        expect(harness.binding.write).toHaveBeenCalledWith(
            "new-doc-id",
            expect.objectContaining({ sourceArticleId: "7000000000000000001", status: "imported" }),
        );
    });

    it("uploads into 'assets/' without a leading slash (§9-Q3.1)", async () => {
        // `/assets/` makes the kernel create `assets/assets/…`; the contract is the bare name.
        const harness = makeImporter({ article: { title: "T", markdown: "![a](https://cdn.juejin.cn/x.png)" } });

        await harness.importer.import(REQUEST);

        const args = harness.kernel.uploadAsset.mock.calls[0] as unknown[];
        expect(args[3]).toBe("assets/");
        expect(String(args[3]).startsWith("/")).toBe(false);
    });

    it("keeps the remote URL when an image cannot be relocated (FR-24 ③)", async () => {
        const harness = makeImporter({ article: { title: "T", markdown: "![a](https://cdn.juejin.cn/x.png)" } });
        harness.kernel.uploadAsset.mockResolvedValue({ ok: false, path: "", error: "denied" });

        const result = await harness.importer.import(REQUEST);

        expect(result.ok).toBe(true);
        expect(result.imageRelocated).toBe(0);
        expect(result.imageFailed).toEqual(["https://cdn.juejin.cn/x.png"]);
        expect(result.warnings).toContain("import.result.partial");
        const markdown = harness.kernel.createDocWithMd.mock.calls[0][2] as string;
        expect(markdown).toContain("https://cdn.juejin.cn/x.png");
    });

    it("refuses a malformed link before doing any work", async () => {
        const harness = makeImporter();

        const result = await harness.importer.import({ ...REQUEST, articleId: "nonsense" });

        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe("param_invalid");
        expect(harness.kernel.createDocWithMd).not.toHaveBeenCalled();
    });

    it("refuses to import without a target notebook", async () => {
        const harness = makeImporter();

        const result = await harness.importer.import({ ...REQUEST, notebook: "  " });

        expect(result.ok).toBe(false);
        expect(harness.kernel.createDocWithMd).not.toHaveBeenCalled();
    });

    it("reports a duplicate instead of creating a second document (FR-27)", async () => {
        const harness = makeImporter({ existing: "old-doc-id" });

        const result = await harness.importer.import(REQUEST);

        expect(result.ok).toBe(false);
        expect(result.error?.i18nKey).toBe("import.duplicated.text");
        expect(harness.kernel.createDocWithMd).not.toHaveBeenCalled();
    });

    it("degrades to page extraction and says so out loud (A4)", async () => {
        const harness = makeImporter({
            article: new Error("404"),
            page: '<script>{"mark_content":"# From page","title":"Page Title"}</script>',
        });

        const preview = await harness.importer.preview("7000000000000000001");

        expect(preview.origin).toBe("page");
        expect(preview.title).toBe("Page Title");
        expect(preview.markdown).toContain("# From page");
        expect(preview.warnings).toContain("import.degraded.notice");
    });

    it("fails loudly when neither the API nor the page yields a body", async () => {
        const harness = makeImporter({ article: new Error("404"), page: "<html></html>" });

        await expect(harness.importer.preview("7000000000000000001")).rejects.toMatchObject({
            i18nKey: "import.err.emptyBody",
        });
    });
});

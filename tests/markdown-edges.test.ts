/**
 * Sanitizer edge cases that the fixture-driven suite does not reach.
 *
 * Focus: the regexes of S1–S3 must be *narrow*. A block-attribute stripper that is too greedy
 * silently eats prose (and the damage is invisible until a user reads their Juejin draft), and
 * an image scanner that ignores code regions prevents "phantom uploads" of example images.
 */
import { describe, expect, it } from "vitest";
import {
    audit,
    collectImageRefs,
    downgradeRefs,
    extractTitle,
    sanitize,
    stripBlockAttrs,
    stripCodeRegions,
    stripFrontMatter,
    type SanitizeOptions,
    type UnsupportedBlockKind,
} from "../src/core/markdown";
import { sha256Hex } from "../src/api/juejinSign";

const LABELS: Record<UnsupportedBlockKind, string> = {
    superBlock: "> [super]",
    database: "> [database]",
    widget: "> [widget]",
    iframe: "> [iframe]",
    video: "> [video]",
    audio: "> [audio]",
};

const OPTIONS: SanitizeOptions = { placeholder: (kind: UnsupportedBlockKind) => LABELS[kind] };

describe("S1 · the IAL stripper must stay narrow", () => {
    it("removes a well formed attribute list", () => {
        const result = stripBlockAttrs('para\n{: id="20240101120000-abcdefg" updated="20240101120000"}\n');
        expect(result.removed).toBe(1);
        expect(result.markdown).not.toContain("{:");
    });

    it("removes a custom attribute list", () => {
        const result = stripBlockAttrs('para\n{: custom-juejin-status="draft" style="color: red"}\n');
        expect(result.removed).toBe(1);
        expect(result.markdown).not.toContain("custom-juejin-status");
    });

    it("leaves prose that merely contains '{: ' alone", () => {
        const body = "这是一个 {: 符号示例，不是属性列表。\n";
        expect(stripBlockAttrs(body).removed).toBe(0);
        expect(stripBlockAttrs(body).markdown).toBe(body);
    });

    it("leaves JSON / template snippets inside code fences alone", () => {
        const body = ['```json', '{"a": "b", "c": 1}', "```", ""].join("\n");
        expect(stripBlockAttrs(body).removed).toBe(0);
        expect(stripBlockAttrs(body).markdown).toContain('{"a": "b", "c": 1}');
    });

    it("does not strip an attribute list whose values are unquoted (documented limitation)", () => {
        // Kramdown always quotes, so this cannot come from a real export. If it ever does,
        // S5 turns it into a visible warning rather than silently shipping it.
        const body = "para\n{: id=abc}\n";
        expect(stripBlockAttrs(body).removed).toBe(0);
        expect(audit(body)).toContain("sync.warn.residualBlockAttr");
    });

    it("removes zero-width characters and trailing spaces", () => {
        const body = "`synchronized`\u200b and text   \n";
        const result = stripBlockAttrs(body);
        expect(result.markdown).not.toContain("\u200b");
        expect(result.markdown).not.toMatch(/[ \t]+$/m);
    });
});

describe("S0 · front matter", () => {
    it("handles CRLF line endings", () => {
        const body = "---\r\ntitle: X\r\n---\r\n\r\n# H1\r\n";
        const result = stripFrontMatter(body);
        expect(result.removed).toBe(true);
        expect(result.markdown).not.toContain("title: X");
        expect(result.markdown).toContain("# H1");
    });

    it("strips a leading BOM before looking for the fence", () => {
        expect(stripFrontMatter("\uFEFF---\ntitle: X\n---\nbody\n").removed).toBe(true);
    });

    it("leaves a document that starts with a rule untouched", () => {
        const body = "---\n\ncontent\n";
        expect(stripFrontMatter(body).removed).toBe(false);
    });
});

describe("S3 · reference downgrades", () => {
    it("replaces a block reference with its display text", () => {
        const result = downgradeRefs('see ((20240101120000-abcdefg "the quoted text")) end');
        expect(result.blockRefs).toBe(1);
        expect(result.markdown).toContain("the quoted text");
        expect(result.markdown).not.toContain("((");
    });

    it("falls back to the raw id when no display text is present", () => {
        const result = downgradeRefs("see ((20240101120000-abcdefg)) end");
        expect(result.markdown).toContain("20240101120000-abcdefg");
    });

    it("keeps wiki-style labels but drops bare ids", () => {
        expect(downgradeRefs("[[my note]]").markdown).toContain("my note");
        expect(downgradeRefs("[[20240101120000-abcdefg]]").markdown.trim()).toBe("");
    });

    it("removes a bare siyuan:// URL that has no label", () => {
        const result = downgradeRefs("open siyuan://blocks/20240101120000-abcdefg now");
        expect(result.docRefs).toBe(1);
        expect(result.markdown).not.toContain("siyuan://");
    });
});

describe("S2 · unsupported blocks", () => {
    it("replaces a database block and drops the orphan div tags", () => {
        const body = '<div data-type="NodeAttributeView" data-node-id="x"><div>inner</div></div>\n';
        const output = sanitize(body, OPTIONS);
        expect(output.markdown).toContain(LABELS.database);
        expect(output.markdown).not.toContain("</div>");
    });

    it("replaces a super block", () => {
        const output = sanitize("{{{\nrow\n}}}\n", OPTIONS);
        expect(output.markdown).toContain(LABELS.superBlock);
    });
});

describe("S4 scan · T-F, images inside code are never uploaded", () => {
    it("ignores fenced code blocks", () => {
        const body = ["![real](assets/real.png)", "", "```md", "![fake](assets/fenced.png)", "```", ""].join("\n");
        const refs = collectImageRefs(body);
        expect(refs).toHaveLength(1);
        expect(refs[0].ref).toBe("assets/real.png");
    });

    it("ignores tilde fences", () => {
        const body = ["~~~", "![fake](assets/tilde.png)", "~~~", "![real](assets/real.png)"].join("\n");
        expect(collectImageRefs(body).map((ref) => ref.ref)).toEqual(["assets/real.png"]);
    });

    it("ignores inline code spans", () => {
        const body = "use `![x](assets/inline.png)` as an example\n\n![real](assets/real.png)\n";
        expect(collectImageRefs(body).map((ref) => ref.ref)).toEqual(["assets/real.png"]);
    });

    it("does not close a fence on a shorter run of backticks", () => {
        const body = ["````", "```", "![fake](assets/deep.png)", "````", "![real](assets/real.png)"].join("\n");
        expect(collectImageRefs(body).map((ref) => ref.ref)).toEqual(["assets/real.png"]);
    });

    it("keeps the fenced content in the output body", () => {
        const body = ["```md", "![fake](assets/fenced.png)", "```", ""].join("\n");
        expect(sanitize(body, OPTIONS).markdown).toContain("![fake](assets/fenced.png)");
    });

    it("blanks the whole fence including its info string", () => {
        const scannable = stripCodeRegions("```ts\nconst a = 1;\n```\n");
        expect(scannable.trim()).toBe("");
    });
});

describe("S5 · content hash semantics", () => {
    it("is a sha256 of the S0–S3 body", () => {
        const output = sanitize("# T\n\nbody\n", OPTIONS);
        expect(output.contentHash).toBe(sha256Hex(output.markdown));
    });

    it("ignores the front matter (metadata churn must not look like a content change)", () => {
        const first = sanitize("---\ntitle: A\n---\n\nbody\n", OPTIONS);
        const second = sanitize("---\ntitle: B\nlastmod: 2026-11-25\n---\n\nbody\n", OPTIONS);
        expect(first.contentHash).toBe(second.contentHash);
    });

    it("changes when the body changes", () => {
        expect(sanitize("body one", OPTIONS).contentHash).not.toBe(sanitize("body two", OPTIONS).contentHash);
    });

    it("is unaffected by the local asset path (it is computed before S4)", () => {
        const withAsset = sanitize("![a](assets/a.png)", OPTIONS);
        // Same body but the image ref already replaced by a (different) CDN URL.
        const replaced = sanitize("![a](https://cdn.example/a.png)", OPTIONS);
        expect(withAsset.contentHash).not.toBe(replaced.contentHash);
        // ...which is exactly why the engine must hash `withAsset` and never the submitted body.
        expect(withAsset.imageRefs).toHaveLength(1);
        expect(replaced.imageRefs[0].kind).toBe("remote");
    });
});

describe("extractTitle", () => {
    it("prefers the first H1", () => {
        expect(extractTitle("intro\n\n# Real Title\n\nmore")).toBe("Real Title");
    });

    it("skips image-only and html-only first lines", () => {
        expect(extractTitle("![a](assets/a.png)\n\n<div>x</div>\n\nReal first line")).toBe("Real first line");
    });

    it("returns an empty string for an empty body", () => {
        expect(extractTitle("\n\n")).toBe("");
    });
});

/**
 * S0–S5 sanitizer tests, driven by real `exportMdContent` samples.
 *
 * `sample-1.md` / `sample-2.md` are genuine kernel exports (2026-11-25, SiYuan 3.8.12):
 * YAML front matter, zero-width characters, GFM tables and fenced code are all present.
 * `sample-3.md` is synthetic on purpose — real exports already flatten block references and
 * omit IAL, so the defensive rules of §5.1 need their own fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    collectImageRefs,
    extractTitle,
    sanitize,
    stripCodeRegions,
    stripFrontMatter,
    type SanitizeOptions,
    type UnsupportedBlockKind,
} from "../src/core/markdown";
import { sha256Hex } from "../src/api/juejinSign";

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const LABELS: Record<UnsupportedBlockKind, string> = {
    superBlock: "> [super block]",
    database: "> [database block]",
    widget: "> [widget block]",
    iframe: "> [embedded page]",
    video: "> [video block]",
    audio: "> [audio block]",
};

const OPTIONS: SanitizeOptions = { placeholder: (kind: UnsupportedBlockKind) => LABELS[kind] };

const sample1 = read("sample-1.md");
const sample2 = read("sample-2.md");
const sample3 = read("sample-3.md");

describe("S0 · front matter", () => {
    it("detects and removes the real front matter", () => {
        const result = stripFrontMatter(sample1);
        expect(result.removed).toBe(true);
        expect(result.markdown.startsWith("---")).toBe(false);
        expect(result.markdown).not.toContain("lastmod:");
        expect(result.markdown).not.toContain("title:");
    });

    it("keeps documents without front matter untouched", () => {
        const plain = "# Title\n\nbody\n";
        expect(stripFrontMatter(plain)).toEqual({ markdown: plain, removed: false });
    });

    it("does not confuse a horizontal rule with front matter", () => {
        const body = "text\n\n---\n\nmore text\n";
        expect(stripFrontMatter(body).removed).toBe(false);
    });
});

describe("S0-S5 · real export sample 1 (front matter + tables + fences)", () => {
    const output = sanitize(sample1, OPTIONS);

    it("leaves no front matter behind", () => {
        expect(output.markdown).not.toMatch(/^---\ntitle:/);
        expect(output.markdown).not.toContain("lastmod:");
    });

    it("strips zero-width characters", () => {
        expect(output.markdown).not.toContain("\u200b");
        expect(sample1).toContain("\u200b");
    });

    it("keeps GFM tables and code fences intact", () => {
        expect(output.markdown).toContain("| ---");
        expect(output.markdown).toContain("```");
    });

    it("finds no image and reports no residual warnings", () => {
        expect(output.imageRefs).toEqual([]);
        expect(output.warnings).toEqual([]);
    });

    it("produces a stable sha256 content hash", () => {
        expect(output.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(output.contentHash).toBe(sha256Hex(output.markdown));
    });

    it("extracts the H1 as the title", () => {
        expect(extractTitle(output.markdown)).toContain("siyuan-dsh-notes");
    });
});

describe("S4 scan · code regions must never be uploaded", () => {
    it("ignores the image syntax inside the fenced block of sample 2", () => {
        const output = sanitize(sample2, OPTIONS);
        // One real image + one inside a fence that reuses the same path.
        expect(output.imageRefs).toHaveLength(1);
        expect(output.imageRefs[0].kind).toBe("local");
        expect(output.imageRefs[0].assetPath).toBe("assets/image-20261124161531-ag7m6zn.png");
    });

    it("ignores both the fenced and the inline image of sample 3", () => {
        const output = sanitize(sample3, OPTIONS);
        const targets = output.imageRefs.map((ref) => ref.ref);
        expect(targets).toContain("assets/image-20240101120000-real01.png");
        expect(targets).toContain("https://example.com/remote.png");
        expect(targets.some((target) => target.includes("fenced"))).toBe(false);
        expect(targets.some((target) => target.includes("inline"))).toBe(false);
        expect(targets.some((target) => target.includes("fake-widget"))).toBe(false);
    });

    it("blanks fenced and inline code when scanning", () => {
        const scannable = stripCodeRegions("a `code` b\n\n```js\nfenced\n```\n");
        expect(scannable).not.toContain("fenced");
        expect(scannable).not.toContain("code");
        expect(scannable).toContain("a ");
    });

    it("keeps the original fence content in the output body", () => {
        const output = sanitize(sample3, OPTIONS);
        expect(output.markdown).toContain("![fenced](assets/image-20240101120000-fenced.png)");
    });
});

describe("S1-S3 · unsupported syntax of sample 3", () => {
    const output = sanitize(sample3, OPTIONS);

    it("removes every inline IAL", () => {
        expect(output.markdown).not.toContain("{: ");
        expect(output.markdown).not.toContain("custom-juejin-demo");
    });

    it("downgrades block references to plain text", () => {
        expect(output.markdown).not.toContain("((");
        expect(output.markdown).toContain("被引用的段落");
        expect(output.markdown).toContain("20240101120000-hijklmn");
    });

    it("removes siyuan:// links but keeps the label", () => {
        expect(output.markdown).not.toContain("siyuan://");
        expect(output.markdown).toContain("另一篇笔记");
    });

    it("drops bare wiki style document references", () => {
        expect(output.markdown).not.toContain("[[");
    });

    it("replaces unsupported blocks with placeholders", () => {
        expect(output.markdown).toContain(LABELS.superBlock);
        expect(output.markdown).toContain(LABELS.widget);
        expect(output.markdown).toContain(LABELS.database);
        expect(output.markdown).toContain(LABELS.iframe);
        expect(output.markdown).toContain(LABELS.video);
        expect(output.markdown).toContain(LABELS.audio);
        expect(output.markdown).not.toContain("<iframe");
        expect(output.markdown).not.toContain("data-type=");
    });

    it("counts every degradation", () => {
        const byKind = new Map(output.degradations.map((item) => [item.kind, item.count]));
        expect(byKind.get("block-attr")).toBeGreaterThanOrEqual(2);
        expect(byKind.get("block-ref")).toBe(2);
        expect(byKind.get("doc-ref")).toBeGreaterThanOrEqual(2);
        expect(byKind.get("unsupported-block")).toBe(6);
        expect(byKind.get("remote-image")).toBe(1);
    });

    it("warns about remote images but does not remove them", () => {
        expect(output.warnings).toContain("sync.warn.remoteImage");
        expect(output.markdown).toContain("https://example.com/remote.png");
    });

    it("keeps footnotes, highlights, math and tables", () => {
        expect(output.markdown).toContain("[^1]");
        expect(output.markdown).toContain("==需要保留==");
        expect(output.markdown).toContain("$a^2+b^2=c^2$");
        expect(output.markdown).toContain("| 列一 | 列二 |");
    });

    it("passes the S5 audit (no residual markers)", () => {
        expect(output.markdown).not.toContain("{: ");
        expect(output.markdown).not.toContain("siyuan://");
    });
});

describe("S5 · audit", () => {
    it("is warning-only: a dirty body still returns a usable markdown", () => {
        const output = sanitize("text {: id=\"20240101120000-abcdefg\"}\n", OPTIONS);
        expect(output.markdown.length).toBeGreaterThan(0);
        expect(output.degradations.some((item) => item.kind === "block-attr")).toBe(true);
    });
});

describe("collectImageRefs · classification", () => {
    it("classifies local, remote and data URIs", () => {
        const refs = collectImageRefs(
            [
                "![a](assets/x.png)",
                "![b](https://cdn.example.com/y.png)",
                '![c](data:image/png;base64,AAAA "title")',
            ].join("\n\n"),
        );
        expect(refs.map((ref) => ref.kind)).toEqual(["local", "remote", "data"]);
        expect(refs[0].assetPath).toBe("assets/x.png");
        expect(refs[1].sourceUrl).toBe("https://cdn.example.com/y.png");
    });

    it("de-duplicates identical targets", () => {
        const refs = collectImageRefs("![a](assets/x.png)\n\n![b](assets/x.png)");
        expect(refs).toHaveLength(1);
    });
});

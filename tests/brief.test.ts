/**
 * Excerpt (`brief_content`) tests — §5.3.
 *
 * Juejin rejects anything outside 50–100 characters, so the invariant under test is:
 * **whatever goes in, the returned value has between 50 and 100 code points.**
 */
import { describe, expect, it } from "vitest";
import { briefState, buildBrief, countChars, fitBrief, plainText, sliceChars } from "../src/core/brief";
import { BRIEF_MAX, BRIEF_MIN } from "../src/types";

/** Short aliases used by every assertion below. */
const MIN = BRIEF_MIN;
const MAX = BRIEF_MAX;

const FALLBACK = "Synced from SiYuan Note.";

describe("countChars · code point semantics", () => {
    it("counts a surrogate pair as one character", () => {
        const emoji = "\u{1F600}".repeat(30);
        expect(emoji.length).toBe(60); // UTF-16 units
        expect(countChars(emoji)).toBe(30); // code points — the only number we may use
    });

    it("counts CJK characters one by one", () => {
        expect(countChars("文本".repeat(30))).toBe(60);
    });

    it("sliceChars never splits a surrogate pair", () => {
        const sliced = sliceChars("\u{1F600}\u{1F601}\u{1F602}", 2);
        expect(sliced).toBe("\u{1F600}\u{1F601}");
        expect(countChars(sliced)).toBe(2);
    });
});

describe("plainText", () => {
    it("strips markdown syntax and code", () => {
        const markdown = [
            "# Heading",
            "",
            "> quote with **bold** and `code`",
            "",
            "- item one",
            "- item two",
            "",
            "| a | b |",
            "| --- | --- |",
            "| 1 | 2 |",
            "",
            "![alt text](assets/x.png)",
            "[link label](https://example.com/very/long/url)",
            "",
            "```js",
            "const ignored = true;",
            "```",
        ].join("\n");
        const text = plainText(markdown);
        expect(text).toContain("Heading");
        expect(text).toContain("quote with bold and");
        expect(text).toContain("item one");
        expect(text).toContain("alt text");
        expect(text).toContain("link label");
        expect(text).not.toContain("https://");
        expect(text).not.toContain("|---");
        expect(text).not.toContain("```");
        expect(text).not.toContain("const ignored");
        expect(text).not.toContain("#");
    });

    it("collapses newlines and repeated spaces", () => {
        expect(plainText("a\n\n\nb     c")).toBe("a b c");
    });
});

describe("buildBrief · always inside [50, 100]", () => {
    it("pads a very short body up into the band", () => {
        const brief = buildBrief("短文本只有几个字，用来测试补齐逻辑。", { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(MAX);
    });

    it("trims a huge body down into the band", () => {
        const long = "这是一个很长的段落，用来验证裁剪逻辑。".repeat(300);
        expect(countChars(long)).toBeGreaterThan(5000);
        const brief = buildBrief(long, { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(MAX);
    });

    it("handles an emoji-only body without under-counting", () => {
        const brief = buildBrief("\u{1F600}".repeat(10), { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(MAX);
    });

    it("returns an empty string only when there is nothing at all", () => {
        expect(buildBrief("", {})).toBe("");
    });
});

describe("fitBrief · user edits", () => {
    it("keeps a value that is already valid", () => {
        const value = "a".repeat(70);
        expect(fitBrief(value, { fallback: FALLBACK })).toBe(value);
    });

    it("cuts a 120 character value to at most 100", () => {
        const brief = fitBrief("a".repeat(120), { fallback: FALLBACK });
        expect(countChars(brief)).toBeLessThanOrEqual(MAX);
        expect(countChars(brief)).toBeGreaterThanOrEqual(MIN);
    });

    it("pads a 30 character value up to at least 50", () => {
        const brief = fitBrief("a".repeat(30), { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(MAX);
    });

    it("pads with the value itself when no fallback is provided", () => {
        const brief = fitBrief("a".repeat(20), {});
        expect(countChars(brief)).toBeGreaterThanOrEqual(MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(MAX);
    });

    it("falls back to the localized sentence for an empty value", () => {
        const brief = fitBrief("   ", { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(MAX);
    });

    it("is idempotent", () => {
        const once = fitBrief("a".repeat(30), { fallback: FALLBACK });
        expect(fitBrief(once, { fallback: FALLBACK })).toBe(once);
    });
});

describe("briefState · drives the live counter", () => {
    it("classifies short, ok and long values", () => {
        expect(briefState("a".repeat(10))).toBe("short");
        expect(briefState("a".repeat(50))).toBe("ok");
        expect(briefState("a".repeat(100))).toBe("ok");
        expect(briefState("a".repeat(101))).toBe("long");
    });

    it("uses code points, so 60 emoji are 'ok' only at 60 code points", () => {
        expect(briefState("\u{1F600}".repeat(30))).toBe("short");
        expect(briefState("\u{1F600}".repeat(60))).toBe("ok");
    });
});

describe("BRIEF constants match the Juejin hard limits", () => {
    it("exposes 50/100", () => {
        expect([MIN, MAX]).toEqual([50, 100]);
        expect(BRIEF_MAX).toBe(100);
    });
});

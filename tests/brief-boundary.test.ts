/**
 * `brief_content` boundary tests (T-G / §5.3).
 *
 * Juejin rejects anything outside 50–100 characters, so the boundary values are the product
 * risk: 49 is rejected, 50 accepted, 100 accepted, 101 rejected. The counting unit is the
 * **Unicode code point**, and the emoji case is the one where `.length` disagrees with the
 * server and produces a silently-too-short excerpt.
 */
import { describe, expect, it } from "vitest";
import { briefState, buildBrief, countChars, fitBrief, sliceChars } from "../src/core/brief";
import { BRIEF_MAX, BRIEF_MIN, BRIEF_TARGET_MAX, BRIEF_TARGET_MIN } from "../src/types";

const FALLBACK = "Synced from SiYuan Note, please review before publishing.";
const of = (length: number): string => "a".repeat(length);

/** No lone surrogate may survive, otherwise the emoji was cut in half. */
function hasLoneSurrogate(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                return true;
            }
        }
    }
    return false;
}

describe("briefState · the 49/50/100/101 boundary", () => {
    it.each([
        [0, "short"],
        [1, "short"],
        [49, "short"],
        [50, "ok"],
        [51, "ok"],
        [99, "ok"],
        [100, "ok"],
        [101, "long"],
        [500, "long"],
    ])("classifies %i code points as %s", (length, expected) => {
        expect(briefState(of(length))).toBe(expected);
    });

    it("uses the documented constants", () => {
        expect([BRIEF_MIN, BRIEF_MAX, BRIEF_TARGET_MIN, BRIEF_TARGET_MAX]).toEqual([50, 100, 60, 90]);
    });
});

describe("emoji · code points vs UTF-16 units", () => {
    it("counts 30 emoji as 30, although .length says 60", () => {
        const emoji = "\u{1F600}".repeat(30);
        expect(emoji.length).toBe(60);
        expect(countChars(emoji)).toBe(30);
        expect(briefState(emoji)).toBe("short");
    });

    it("pads 30 emoji up into the band and never splits a surrogate pair", () => {
        const brief = fitBrief("\u{1F600}".repeat(30), { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_MAX);
        expect(hasLoneSurrogate(brief)).toBe(false);
    });

    it("cuts 200 emoji down without producing a broken pair", () => {
        const brief = fitBrief("\u{1F600}".repeat(200), { fallback: FALLBACK });
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_MAX);
        expect(hasLoneSurrogate(brief)).toBe(false);
    });

    it("sliceChars keeps code point semantics", () => {
        const sliced = sliceChars("\u{1F600}\u{1F601}\u{1F602}", 2);
        expect(countChars(sliced)).toBe(2);
        expect(hasLoneSurrogate(sliced)).toBe(false);
    });
});

describe("fitBrief · assembly into the legal band", () => {
    it.each([0, 1, 30, 49, 50, 59])("pads %i code points up to at least 50", (length) => {
        const brief = fitBrief(of(length), { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_MAX);
    });

    it.each([60, 90, 91, 99, 100])("keeps %i code points as-is (already legal)", (length) => {
        const value = of(length);
        expect(fitBrief(value, { fallback: FALLBACK })).toBe(value);
    });

    it.each([101, 120, 5000])("trims %i code points to the safety band", (length) => {
        const brief = fitBrief(of(length), { fallback: FALLBACK });
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_TARGET_MAX);
        expect(countChars(brief)).toBeGreaterThanOrEqual(BRIEF_MIN);
    });

    it("is idempotent for every boundary value", () => {
        // P2-5 fixed: the cut now lands on a readable boundary and is trimmed, so a second pass
        // returns the identical string. Previously this assertion needed a `.trim()` crutch
        // because a mid-word cut could leave a trailing space.
        [0, 30, 49, 50, 101, 500].forEach((length) => {
            const once = fitBrief(of(length), { fallback: FALLBACK });
            const twice = fitBrief(once, { fallback: FALLBACK });
            expect(twice).toBe(once);
            expect(countChars(once)).toBeLessThanOrEqual(BRIEF_MAX);
            expect(countChars(twice)).toBeLessThanOrEqual(BRIEF_MAX);
        });
    });

    it("never leaves a trailing space on a mid-word cut (P2-5)", () => {
        const brief = fitBrief(of(0), { fallback: FALLBACK });
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_MAX);
        expect(countChars(brief)).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(brief).toBe(brief.trim());
        expect(brief.endsWith(" ")).toBe(false);
    });

    it("normalizes whitespace without changing the code point sequence", () => {
        expect(countChars(fitBrief("a   b\n\n c", { fallback: FALLBACK }))).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(fitBrief("a   b", { fallback: FALLBACK })).toContain("a b");
    });

    it("returns an empty string only when there is nothing to work with", () => {
        expect(fitBrief("", {})).toBe("");
        expect(fitBrief("   ", {})).toBe("");
    });

    it("still lands in the band when the fallback itself is too short", () => {
        const brief = fitBrief("x", { fallback: "hi" });
        expect(countChars(brief)).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_MAX);
    });
});

describe("buildBrief · real documents", () => {
    it("stays inside the band for a 20-character document (FR-06b ③)", () => {
        const brief = buildBrief("# T\n\nvery short body", { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_MAX);
    });

    it("stays inside the band for a 5000-character document", () => {
        const brief = buildBrief(`# T\n\n${"内容".repeat(2500)}`, { fallback: FALLBACK });
        expect(countChars(brief)).toBeGreaterThanOrEqual(BRIEF_MIN);
        expect(countChars(brief)).toBeLessThanOrEqual(BRIEF_MAX);
    });

    it("does not let a code block dominate the excerpt", () => {
        const markdown = ["# T", "", "```js", "const secretCodeToken = 1;", "```", "", "Real prose here."].join("\n");
        const brief = buildBrief(markdown, { fallback: FALLBACK });
        expect(brief).not.toContain("secretCodeToken");
    });
});

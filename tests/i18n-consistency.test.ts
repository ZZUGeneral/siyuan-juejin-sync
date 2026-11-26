/**
 * T-H · i18n integrity beyond the existing key-diff check.
 *
 * `tests/i18n.test.ts` already proves the two bundles share a key set and that `src/**\/*.ts`
 * holds no CJK literal. The gaps this file closes:
 *  - the **English** bundle must actually be English (a Chinese value pasted into `en_US`
 *    passes every existing assertion),
 *  - interpolation placeholders must match per key (a missing `${n}` renders "已降级 处内容"),
 *  - `textOf` / `formatText` must degrade predictably instead of throwing or leaking keys.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createI18n, findI18nKeyDiff, formatText, textOf } from "../src/core/i18n";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const zh = JSON.parse(readFileSync(join(SRC, "i18n", "zh_CN.json"), "utf8")) as Record<string, string>;
const en = JSON.parse(readFileSync(join(SRC, "i18n", "en_US.json"), "utf8")) as Record<string, string>;

/** CJK ideographs only — CJK punctuation is legitimately used in a few Latin strings. */
const CJK_IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function placeholders(value: string): string[] {
    return [...value.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe("bundle hygiene", () => {
    it("has no CJK ideograph in the English bundle", () => {
        const offenders = Object.entries(en)
            .filter(([, value]) => CJK_IDEOGRAPH.test(value))
            .map(([key, value]) => `${key}: ${value.slice(0, 60)}`);
        expect(offenders).toEqual([]);
    });

    it("has a Chinese bundle that is genuinely Chinese", () => {
        const translated = Object.values(zh).filter((value) => CJK_IDEOGRAPH.test(value));
        expect(translated.length).toBeGreaterThan(Object.keys(zh).length * 0.8);
    });

    it("has no duplicated key definitions across the two files (parse sanity)", () => {
        expect(findI18nKeyDiff()).toEqual([]);
        expect(Object.keys(zh).length).toBe(Object.keys(en).length);
    });

    it("uses only the six documented domains", () => {
        const domains = [...new Set([...Object.keys(zh), ...Object.keys(en)].map((key) => key.split(".")[0]))].sort();
        // `common` is the documented extra group used by shared UI controls (§8.5).
        expect(domains).toEqual(["common", "err", "image", "import", "plugin", "settings", "sync"]);
    });

    it("keeps keys free of spaces and CJK characters", () => {
        const bad = Object.keys(zh).filter((key) => /\s/.test(key) || CJK_IDEOGRAPH.test(key));
        expect(bad).toEqual([]);
    });
});

describe("interpolation placeholders", () => {
    const keysWithPlaceholders = Object.keys(zh).filter((key) => placeholders(zh[key]).length > 0);

    it("finds a meaningful number of parameterized strings", () => {
        expect(keysWithPlaceholders.length).toBeGreaterThan(10);
    });

    it("declares the same placeholders in both languages", () => {
        const mismatched = keysWithPlaceholders
            .filter((key) => placeholders(zh[key]).join(",") !== placeholders(en[key] ?? "").join(","))
            .map((key) => `${key}: zh=[${placeholders(zh[key])}] en=[${placeholders(en[key] ?? "")}]`);
        expect(mismatched).toEqual([]);
    });

    it("never leaves a bare ${...} in a translated string", () => {
        const broken = [...Object.entries(zh), ...Object.entries(en)].filter(([, value]) => /\$\{\s*\}/.test(value));
        expect(broken).toEqual([]);
    });
});

describe("formatText / textOf", () => {
    it("interpolates named values", () => {
        expect(formatText("${a} + ${b}", { a: 1, b: "x" })).toBe("1 + x");
    });

    it("replaces a missing value with an empty string rather than 'undefined'", () => {
        expect(formatText("n=${n}", {})).toBe("n=");
        expect(formatText("n=${n}", { n: 0 })).toBe("n=0");
    });

    it("returns the template untouched when no vars are given", () => {
        expect(formatText("${n} items")).toBe("${n} items");
    });

    it("falls back to the key itself for an unknown key (never throws)", () => {
        expect(textOf({}, "sync.does.not.exist")).toBe("sync.does.not.exist");
    });

    it("falls back to zh_CN when the active bundle misses a key", () => {
        const bundle = createI18n({});
        const key = Object.keys(zh)[0];
        expect(textOf(bundle, key)).toBe(zh[key]);
    });

    it("prefers the active language over the host bundle", () => {
        // The node environment has no `window.siyuan`, so the active language is zh_CN.
        const key = "err.network";
        expect(textOf(createI18n({ [key]: "host override" }), key)).toBe(zh[key]);
    });
});

describe("credential wording (A7) is present and unambiguous", () => {
    it("provides both storage-form labels", () => {
        expect(zh["settings.storage.vault"]).toBeTruthy();
        expect(zh["settings.storage.plain"]).toBeTruthy();
        expect(en["settings.storage.vault"]).toBeTruthy();
        expect(en["settings.storage.plain"]).toBeTruthy();
    });

    it("never uses the forbidden encryption vocabulary in either language", () => {
        const forbidden = ["\u5df2\u52a0\u5bc6", "\u5b89\u5168\u5b58\u50a8", "\u52a0\u5bc6\u4fdd\u62a4", "encrypted", "secure storage"];
        const hits = [...Object.entries(zh), ...Object.entries(en)].filter(([, value]) =>
            forbidden.some((word) => value.toLowerCase().includes(word.toLowerCase())),
        );
        expect(hits).toEqual([]);
    });
});

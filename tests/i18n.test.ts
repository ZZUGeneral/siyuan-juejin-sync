/**
 * D3 gate — three automated i18n checks (§8.5).
 *
 * V1  both bundles expose exactly the same key set (symmetric difference is empty),
 * V2  no CJK literal survives in `src/**\/*.ts` outside comments,
 * V3  `plugin.json` declares `default` / `zh_CN` / `en_US` for `displayName`, `description`
 *     and `readme`, and every referenced file actually exists.
 *
 * This file intentionally uses Node APIs — it is a *test*, not plugin runtime code, so the
 * "no Node.js API" rule does not apply here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** CJK Unified Ideographs + common CJK punctuation. */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return walk(full);
        }
        return entry.isFile() ? [full] : [];
    });
}

/** Remove `//` and block comments so only real code/string literals remain. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function readJson(path: string): Record<string, string> {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

const zh = readJson(join(SRC, "i18n", "zh_CN.json"));
const en = readJson(join(SRC, "i18n", "en_US.json"));

describe("V1 · zh_CN and en_US expose the same keys", () => {
    it("has a non-trivial number of keys", () => {
        expect(Object.keys(zh).length).toBeGreaterThan(100);
    });

    it("has no key that only exists in zh_CN", () => {
        const onlyZh = Object.keys(zh).filter((key) => !(key in en));
        expect(onlyZh).toEqual([]);
    });

    it("has no key that only exists in en_US", () => {
        const onlyEn = Object.keys(en).filter((key) => !(key in zh));
        expect(onlyEn).toEqual([]);
    });

    it("has no empty values", () => {
        const empty = [...Object.entries(zh), ...Object.entries(en)]
            .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
            .map(([key]) => key);
        expect(empty).toEqual([]);
    });

    it("uses only the allowed domains", () => {
        const domains = new Set(Object.keys(zh).map((key) => key.split(".")[0]));
        expect([...domains].sort()).toEqual(["common", "err", "image", "import", "plugin", "settings", "sync"]);
    });
});

describe("V2 · no CJK literal in src/**/*.ts outside comments", () => {
    const files = walk(SRC).filter((file) => file.endsWith(".ts"));

    it("scans a plausible number of files", () => {
        expect(files.length).toBeGreaterThanOrEqual(10);
    });

    it("reports zero offenders", () => {
        const offenders: string[] = [];
        files.forEach((file) => {
            const source = stripComments(readFileSync(file, "utf8"));
            source.split("\n").forEach((line, index) => {
                if (CJK.test(line)) {
                    offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
                }
            });
        });
        expect(offenders).toEqual([]);
    });

    it("only references keys that exist in the bundle", () => {
        const pattern = /["'`]((?:plugin|settings|sync|image|import|err)\.[A-Za-z0-9_.]+)["'`]/g;
        // Filenames inside string literals (`image.bin`) are not i18n keys.
        const looksLikeFile = /\.(bin|png|jpe?g|gif|webp|svg|bmp|json|md|tsx?|js|css|html)$/i;
        const missing: string[] = [];
        walk(SRC)
            .filter((file) => file.endsWith(".ts"))
            .forEach((file) => {
                const source = stripComments(readFileSync(file, "utf8"));
                for (const match of source.matchAll(pattern)) {
                    const key = match[1];
                    if (looksLikeFile.test(key)) {
                        continue;
                    }
                    if (!(key in zh)) {
                        missing.push(`${relative(ROOT, file)} -> ${key}`);
                    }
                }
            });
        expect([...new Set(missing)]).toEqual([]);
    });
});

describe("V3 · plugin.json declarations match the shipped files", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "plugin.json"), "utf8")) as Record<string, unknown>;

    it("declares minAppVersion 3.8.5 (A2)", () => {
        expect(manifest.minAppVersion).toBe("3.8.5");
    });

    it.each(["displayName", "description", "readme"])("declares %s for default / zh_CN / en_US", (field) => {
        const value = manifest[field] as Record<string, string> | undefined;
        expect(value).toBeTruthy();
        ["default", "zh_CN", "en_US"].forEach((lang) => {
            expect(typeof value?.[lang]).toBe("string");
            expect((value?.[lang] ?? "").length).toBeGreaterThan(0);
        });
    });

    it("points at files that exist", () => {
        const readme = manifest.readme as Record<string, string>;
        ["default", "zh_CN", "en_US"].forEach((lang) => {
            const path = join(ROOT, readme[lang]);
            expect(existsSync(path), `${readme[lang]} must exist`).toBe(true);
            expect(statSync(path).size).toBeGreaterThan(0);
        });
        [manifest.icon, manifest.preview].forEach((asset) => {
            expect(existsSync(join(ROOT, String(asset)))).toBe(true);
        });
    });

    it("declares the same language set as src/i18n", () => {
        const files = readdirSync(join(SRC, "i18n")).filter((name) => name.endsWith(".json")).sort();
        expect(files).toEqual(["en_US.json", "zh_CN.json"]);
    });
});

describe("A7 · credential wording never claims encryption", () => {
    const zh = readJson(join(SRC, "i18n", "zh_CN.json"));
    const en = readJson(join(SRC, "i18n", "en_US.json"));

    it("uses the exact approved Chinese wording", () => {
        expect(zh["settings.storage.vault"]).toBe("\u5df2\u5b58\u5165\u601d\u6e90\u5bc6\u94a5\u5e93");
        expect(zh["settings.storage.plain"]).toBe("\u4ee5\u660e\u6587\u4fdd\u5b58\u5728\u672c\u5730\u6570\u636e\u76ee\u5f55");
    });

    it("never advertises encryption anywhere in the bundles", () => {
        const forbidden = ["\u5df2\u52a0\u5bc6", "\u5b89\u5168\u5b58\u50a8", "\u52a0\u5bc6\u4fdd\u62a4"];
        const hits = Object.entries({ ...zh, ...en }).filter(([, value]) =>
            forbidden.some((word) => value.includes(word)),
        );
        expect(hits).toEqual([]);
    });
});

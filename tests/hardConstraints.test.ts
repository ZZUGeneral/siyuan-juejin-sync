/**
 * Hard-constraint gate: assertions that must hold **in the source text**, not only in behaviour.
 *
 * The PRD/architecture freeze a set of "must never appear" rules (D1, D2, D4, A3, A7 and the
 * three engineering constraints). A behavioural test can pass while the forbidden branch is
 * still present on a path the test does not walk, so these checks read the files instead.
 *
 * These are static greps by design — they are cheap, they never flake, and they fail loudly
 * when someone adds `if (!preflight.ok) return;` "just to be safe".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return walk(full);
        }
        return entry.isFile() ? [full] : [];
    });
}

function read(path: string): string {
    return readFileSync(join(ROOT, path), "utf8");
}

/** Source slice between two markers, used to isolate a single function body. */
function slice(source: string, from: string, to: string): string {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    expect(start, `marker "${from}" must exist`).toBeGreaterThanOrEqual(0);
    return end > start ? source.slice(start, end) : source.slice(start);
}

const tsFiles = walk(SRC).filter((file) => file.endsWith(".ts"));
const engineSource = read("src/core/syncEngine.ts");
const imagesSource = read("src/core/images.ts");
const resultPanelSource = read("src/ui/resultPanel.ts");
const manifest = JSON.parse(read("plugin.json")) as Record<string, unknown>;
const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

describe("硬约束① · no Node.js API anywhere under src/", () => {
    it.each(tsFiles.map((file) => relative(ROOT, file)))("%s does not touch the Node runtime", (file) => {
        const source = read(file);
        const forbidden = [
            /require\s*\(/,
            /__dirname/,
            /__filename/,
            /from\s+["']node:/,
            /from\s+["'](?:fs|path|os|child_process|crypto)["']/,
        ];
        const hits = forbidden.filter((pattern) => pattern.test(source));
        expect(hits.map((pattern) => String(pattern))).toEqual([]);
    });

    it("declares zero runtime dependencies", () => {
        expect(pkg.dependencies ?? {}).toEqual({});
    });
});

describe("硬约束③ · fetch() appears only in api/kernel.ts, on relative paths", () => {
    const fetchCallSites = tsFiles.filter((file) => /\bfetch\s*\(/.test(read(relative(ROOT, file)))).map((file) => relative(ROOT, file));

    it("confines fetch to the kernel client", () => {
        expect(fetchCallSites).toEqual([join("src", "api", "kernel.ts")]);
    });

    it("never fetches an absolute URL", () => {
        const source = read("src/api/kernel.ts");
        const absolute = [...source.matchAll(/fetch\s*\(\s*([`"'])([^`"']*)/g)].map((match) => match[2]);
        expect(absolute.length).toBeGreaterThan(0);
        absolute.forEach((target) => {
            expect(target.startsWith("http")).toBe(false);
            expect(target.startsWith("/")).toBe(true);
        });
    });

    it("only writes the Juejin host in the endpoint table", () => {
        const offenders = tsFiles
            .map((file) => relative(ROOT, file))
            .filter((file) => file !== join("src", "api", "juejin.ts"))
            .filter((file) => /["'`]https:\/\/api\.juejin\.cn/.test(read(file)));
        // `draftUrl()` lives in juejin.ts; UI code must use it instead of pasting a URL.
        expect(offenders).toEqual([]);
    });
});

describe("D1 · the image stage cannot be skipped", () => {
    it("calls preflight and process unconditionally in the engine", () => {
        const body = slice(engineSource, "private async run(", "private placeholder");
        expect(body).toContain("this.deps.pipeline.preflight(");
        expect(body).toContain("this.deps.pipeline.process(");
        // No guard on the settings flag may short-circuit the stage.
        expect(/autoUploadImages[\s\S]{0,120}?\breturn\b/.test(body)).toBe(false);
        expect(/if\s*\(\s*!?\s*settings\.autoUploadImages\s*\)\s*\{?\s*return/.test(body)).toBe(false);
    });

  it("reports uploads-disabled as a countable failure", () => {
        expect(imagesSource).toContain("image.skip.disabled");
    });
});

describe("D2 · pre-flight can warn, never abort", () => {
    it("keeps the preflight body free of throw / return-based aborts", () => {
        const body = slice(imagesSource, "async preflight(", "async process(");
        expect(/\bthrow\b/.test(body)).toBe(false);
        expect(/\breturn\s+null\b/.test(body)).toBe(false);
    });

    it("keeps the engine free of any early return between preflight and submission", () => {
        const body = slice(engineSource, "const preflight =", "// ---- M1");
        expect(body).not.toMatch(/\breturn\b/);
        expect(body).not.toMatch(/\bthrow\b/);
    });

    it("merges preflight findings into warnings only", () => {
        expect(engineSource).toContain("warnings.push(\"sync.warn.precheckFailed\")");
    });
});

describe("D4 · verbatim upstream errors, no content moderation", () => {
    it("keeps errNo / errMsg / httpStatus in the issue model", () => {
        const types = read("src/types.ts");
        expect(types).toMatch(/interface SyncIssueRaw[\s\S]*?errNo\?: number[\s\S]*?errMsg\?: string[\s\S]*?httpStatus\?: number/);
    });

    it("ships no sensitive-word list and no content-review library", () => {
        const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const banned = ["bad-words", "sensitive-word", "sensitive-word-filter", "profanity", "content-moderation"];
        expect(Object.keys(dependencies).filter((name) => banned.some((word) => name.includes(word)))).toEqual([]);

        const suspicious = tsFiles
            .map((file) => relative(ROOT, file))
            .filter((file) => /sensitiveWords|bannedWords|profanityFilter|sensitiveWord/i.test(read(file)));
        expect(suspicious).toEqual([]);
    });

    it("does not pre-check the body length before submitting", () => {
        // The only length rule allowed is the brief assembly (see `core/brief.ts`).
        expect(/markdown\.length\s*[<>]/.test(engineSource)).toBe(false);
        expect(/if\s*\(.*content\.length\s*>/.test(engineSource)).toBe(false);
    });

    it("never rewrites the upstream message into a guess", () => {
        const forbidden = ["\u53ef\u80fd\u662f\u654f\u611f\u8bcd", "\u5185\u5bb9\u4e0d\u5408\u89c4", "sensitive word", "not compliant"];
        tsFiles.forEach((file) => {
            const source = read(relative(ROOT, file));
            forbidden.forEach((phrase) => expect(source.toLowerCase()).not.toContain(phrase.toLowerCase()));
        });
    });

    it("does not retry 4xx blindly", () => {
        // The single documented retry is `draft.update` with an alternate field name, and it is
        // gated on PARAM_INVALID; nothing retries on AUTH_EXPIRED / RISK_CONTROL.
        const juejin = read("src/api/juejin.ts");
        expect(juejin).toContain('error.kind !== ErrorKind.PARAM_INVALID');
        expect(/ErrorKind\.AUTH_EXPIRED[\s\S]{0,200}retry/i.test(juejin)).toBe(false);
    });
});

describe("A3 · the failed-image list is pinned above everything else", () => {
    it("renders the failure list before the status head", () => {
        const body = slice(resultPanelSource, "render(host: HTMLElement", "/* ---------------- sections");
        const failedIndex = body.indexOf("this.buildFailedImages(result.imageFailed)");
        const headIndex = body.indexOf("this.buildHead(result)");
        expect(failedIndex).toBeGreaterThanOrEqual(0);
        expect(headIndex).toBeGreaterThan(failedIndex);
    });

    it("wraps only the raw technical details in <details>", () => {
        const occurrences = [...resultPanelSource.matchAll(/details\(/g)].length;
        expect(occurrences).toBe(1);
        expect(resultPanelSource).toContain('details(this.t("err.raw")');
        expect(/details\([\s\S]{0,80}imageFailed/.test(resultPanelSource)).toBe(false);
    });

    it("does not use <details> to hide the failure block", () => {
        const body = slice(resultPanelSource, "private buildFailedImages", "private buildHead");
        expect(body).not.toContain("details(");
        expect(body).not.toContain("<details");
    });
});

describe("A7 · no fabricated encryption claims", () => {
    it("has no forbidden wording in shipped text files", () => {
        const files = [
            ...tsFiles.map((file) => relative(ROOT, file)),
            "plugin.json",
            "README.md",
            "README_zh_CN.md",
            "src/i18n/zh_CN.json",
            "src/i18n/en_US.json",
            "src/ui/styles.scss",
        ];
        const forbidden = ["\u5df2\u52a0\u5bc6", "\u5b89\u5168\u5b58\u50a8", "\u52a0\u5bc6\u4fdd\u62a4"];
        const hits = files.flatMap((file) => {
            const source = read(file);
            return forbidden
                .filter((phrase) => source.includes(phrase))
                .map((phrase) => `${file}: ${phrase}`);
        });
        expect(hits).toEqual([]);
    });

    it("never claims encryption in the manifest or the READMEs", () => {
        const manifestText = JSON.stringify(manifest);
        expect(manifestText).not.toContain("\u5df2\u52a0\u5bc6");
        expect(read("README.md").toLowerCase()).not.toContain("encrypted for you");
    });
});

describe("A2 / D3 · manifest declarations", () => {
    it("pins minAppVersion to 3.8.5", () => {
        expect(manifest.minAppVersion).toBe("3.8.5");
    });

    it("declares the plugin name consistently", () => {
        expect(manifest.name).toBe(pkg && (JSON.parse(read("package.json")) as { name: string }).name);
    });

    it("declares all three languages for the user-visible fields", () => {
        ["displayName", "description", "readme"].forEach((field) => {
            const value = manifest[field] as Record<string, string> | undefined;
            expect(value, field).toBeTruthy();
            ["default", "zh_CN", "en_US"].forEach((lang) => {
                expect((value?.[lang] ?? "").length, `${field}.${lang}`).toBeGreaterThan(0);
            });
        });
    });

    it("ships the compiled i18n files into dist", () => {
        ["dist/i18n/zh_CN.json", "dist/i18n/en_US.json", "dist/plugin.json", "dist/index.js"].forEach((file) => {
            expect(statSync(join(ROOT, file)).size).toBeGreaterThan(0);
        });
    });
});

describe("i18n-exempt audit · console output must not be a user-facing string", () => {
    it("keeps console.* calls free of translated copy (they are exempt from the CJK gate)", () => {
        const offenders = tsFiles
            .map((file) => relative(ROOT, file))
            .filter((file) => /console\.(?:log|info|warn|error)\(\s*this\.t\(/.test(read(file)));
        expect(offenders).toEqual([]);
    });
});

describe("settings save ordering · the risk flag must reach disk before the secret", () => {
    const saveBody = (): string => slice(read("src/ui/settingsPanel.ts"), "private async save(", "private buildSyncGroup(");

    it("persists settings before calling setCredential", () => {
        // `SettingsService.setCredential()` re-reads `riskAccepted` from disk and throws while it
        // is false, so writing the secret first makes the very first save fail unconditionally.
        const body = saveBody();
        const saveAt = body.indexOf("this.deps.settings.save({");
        const credentialAt = body.indexOf("this.deps.settings.setCredential(");
        expect(saveAt, "save() must persist settings").toBeGreaterThanOrEqual(0);
        expect(credentialAt, "save() must persist the credential").toBeGreaterThanOrEqual(0);
        expect(saveAt, "settings must be written before the credential").toBeLessThan(credentialAt);
    });

    it("does not reuse the 'risk not accepted' copy as a catch-all", () => {
        // A generic catch that prints `settings.save.noRisk` hides real failures behind a hint
        // about a checkbox the user already ticked.
        expect(saveBody()).toContain("settings.save.failed");
    });
});

describe("settings dialog · long content must stay reachable", () => {
    it("gives .jjs-settings a max-height and its own vertical scroller", () => {
        // SiYuan's dialog frame does not scroll its body; without this rule the last group is
        // clipped and there is no way to reach it.
        const block = slice(read("src/ui/styles.scss"), ".jjs-settings {", "}");
        expect(block).toContain("max-height");
        expect(block).toContain("overflow-y: auto");
    });
});

describe("tag picker · the cached list must not be the only source", () => {
    const dialogSource = read("src/ui/syncDialog.ts");
    const settingsSource = read("src/ui/settingsPanel.ts");
    const componentsSource = read("src/ui/components.ts");

    it("wires a server-side search into the chip picker", () => {
        // `query_tag_list` returns one page of *popular* tags (the real account cached 10), so a
        // local-only filter answers "no match" for tags that plainly exist — typing "kuber" made
        // the whole suggestion box look empty.
        expect(dialogSource).toContain("onSearch:");
        expect(dialogSource).toContain("this.deps.api.searchTags(");
    });

    it("explains an empty suggestion list instead of drawing a blank box", () => {
        expect(componentsSource).toContain("jjs-suggestions__note");
    });

    it("offers the in-dialog tag reload", () => {
        expect(dialogSource).toContain("sync.dialog.tagRefresh");
        expect(dialogSource).toContain("sync.dialog.tagRefreshed");
        expect(dialogSource).toContain("this.deps.api.fetchTags(");
    });

    it("merges a tag refresh into the pool instead of replacing it", () => {
        // Upstream only ever returns the popular page (ten tags) and ignores paging/search, so a
        // refresh that assigns `tags` directly would shrink a pool the user had already widened.
        expect(dialogSource).toContain("mergeTags(previous");
        expect(settingsSource).toContain("mergeTags(state.meta?.tags");
        expect(dialogSource).toContain("fetchFeedTags(");
        expect(dialogSource).toContain("fetchArticleTags(");
    });
});

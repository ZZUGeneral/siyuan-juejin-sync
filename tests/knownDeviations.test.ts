/**
 * Regression pins for previously documented deviations.
 *
 * These blocks originally asserted the *broken* behaviour so the suite stayed green while the
 * QA report recorded the gap. Every P1/P2 finding has since been fixed, so each block now
 * pins the **fixed** behaviour: if the old behaviour ever comes back, this file goes red and
 * points at the exact regression.
 *
 * The two remaining P3 items (unused S5 audit, unused P1 settings) are still listed as
 * deviations — they are intentional scope decisions, not defects.
 */
import { describe, expect, it, vi } from "vitest";
import { BindingService } from "../src/core/binding";
import { DEFAULT_SETTINGS, SettingsService } from "../src/core/settings";
import { ImagePipeline } from "../src/core/images";
import { Importer } from "../src/core/importer";
import { SyncEngine } from "../src/core/syncEngine";
import { stripBlockAttrs } from "../src/core/markdown";
import { crc32Hex, crc32HexLittleEndian } from "../src/api/juejinSign";
import { isChecksumMismatch, JuejinClient } from "../src/api/juejin";
import { HttpProxy } from "../src/api/proxy";
import { isPublishedHint, ProxyError, SyncError } from "../src/core/errors";
import { SyncStore } from "../src/core/store";
import { BLOCK_ATTR, ErrorKind } from "../src/types";
import type { JuejinApi, KernelApi, SyncSettings } from "../src/types";
import type { Logger } from "../src/core/logger";
import type { Plugin } from "siyuan";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
const t = (key: string): string => key;

/** Reverse the bytes of an 8-digit hex string. */
function reverseHexBytes(hex: string): string {
    return (hex.match(/../g) ?? []).reverse().join("");
}

describe("P2 fixed · S1 keeps GFM hard line breaks", () => {
    it("preserves exactly two trailing spaces and strips every other trailing run", () => {
        // `  \n` is the GFM hard-break marker; S1 must not eat it.
        const kept = stripBlockAttrs("first line  \nsecond line\n");
        expect(kept.markdown).toBe("first line  \nsecond line\n");
        expect(kept.markdown).toContain("  \n");

        // A single space or a three-space run is export noise and still goes away.
        expect(stripBlockAttrs("noise   \nnext\n").markdown).toBe("noise\nnext\n");
        expect(stripBlockAttrs("noise \nnext\n").markdown).toBe("noise\nnext\n");
    });
});

describe("P1 fixed · Content-CRC32 byte order is self-healing", () => {
    const bytes = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);

    it("uses big-endian first and little-endian as the byte-reversed fallback", () => {
        expect(crc32Hex(bytes)).toBe("cbf43926");
        expect(crc32HexLittleEndian(bytes)).toBe("2639f4cb");
        // Same number, opposite byte order — that is why a retry can rescue the upload.
        expect(crc32HexLittleEndian(bytes)).toBe(reverseHexBytes(crc32Hex(bytes)));
        expect(crc32Hex(bytes)).not.toBe(crc32HexLittleEndian(bytes));
    });

    it("recognises a checksum rejection but not an unrelated HTTP failure", () => {
        const mismatch = new ProxyError({
            reason: "http",
            status: 400,
            body: '{"code":4007,"message":"MismatchChecksum"}',
            url: "https://tos/uri",
        });
        expect(isChecksumMismatch(mismatch)).toBe(true);

        const serverError = new ProxyError({ reason: "http", status: 500, body: "boom", url: "https://tos/uri" });
        expect(isChecksumMismatch(serverError)).toBe(false);
        expect(isChecksumMismatch(new Error("timeout"))).toBe(false);
    });
});

describe("P1 fixed · reverse import passes assetsDirPath without a leading slash", () => {
    it("sends 'assets/' (verified contract) so no nested assets/assets folder appears", async () => {
        const api = {
            getArticle: vi.fn(async () => ({ articleId: "1", title: "T", markdown: "![a](https://c/x.png)", status: 0 })),
            fetchArticlePage: vi.fn(async () => ""),
            downloadBinary: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]).buffer),
        };
        const kernel = {
            createDocWithMd: vi.fn(async () => "doc-1"),
            uploadAsset: vi.fn(async () => ({ ok: true, path: "assets/x.png" })),
        };
        const importer = new Importer({
            api: api as unknown as JuejinApi,
            kernel: kernel as unknown as KernelApi,
            binding: { findBySourceArticleId: async () => null, write: async () => undefined } as never,
            settings: { load: async () => DEFAULT_SETTINGS } as unknown as SettingsService,
            logger: silentLogger,
            translate: t,
        });

        await importer.import({ articleId: "7000000000000000001", notebook: "nb", path: "/a/{{title}}", overwrite: false });

        const call = kernel.uploadAsset.mock.calls[0] as unknown[];
        expect(call[3]).toBe("assets/");
    });
});

describe("P1 fixed · FR-10② detects a publish performed on the website", () => {
    it("classifies an 'already published / not editable' message", () => {
        const published = new SyncError(ErrorKind.UNKNOWN, {
            raw: { errMsg: "\u6587\u7ae0\u5df2\u53d1\u5e03\uff0c\u4e0d\u53ef\u7f16\u8f91" },
        });
        expect(isPublishedHint(published)).toBe(true);
        expect(isPublishedHint(new SyncError(ErrorKind.NETWORK, { raw: { errMsg: "timeout" } }))).toBe(false);
    });

    it("marks the binding 'unknown' instead of retrying a draft that is gone", async () => {
        const engine = harness({
            seed: { [BLOCK_ATTR.DRAFT_ID]: "d-1", [BLOCK_ATTR.STATUS]: "draft" },
            updateDraft: async () => {
                throw new SyncError(ErrorKind.UNKNOWN, {
                    raw: { errMsg: "\u6587\u7ae0\u5df2\u53d1\u5e03\uff0c\u4e0d\u53ef\u7f16\u8f91" },
                });
            },
        });

        const result = await engine.sync("20261125220000-doc0001");

        expect(result.ok).toBe(false);
        expect(result.status).toBe("unknown");
        expect(result.warnings).toContain("sync.hint.maybePublished");
    });
});

describe("P2 fixed · credential probe reports 'not-configured'", () => {
    it("does not claim the credential expired when nothing was ever saved", async () => {
        const client = new JuejinClient({
            getCredential: async () => null,
            proxy: new HttpProxy({ logger: silentLogger }),
            logger: silentLogger,
        });

        const probe = await client.probeCredential();

        expect(probe.state).toBe("not-configured");
        expect(probe.errMsg).toBeUndefined();
        expect(probe.errNo).toBeUndefined();
    });
});

describe("P2 fixed · notebook mapping warning is not noise", () => {
    it("stays silent when the user configured no per-notebook mapping at all", async () => {
        const result = await harness().sync("20261125220000-doc0001");

        expect(result.ok).toBe(true);
        expect(result.warnings).not.toContain("sync.warn.notebookMappingMissing");
    });

    it("warns when mappings exist but this notebook is missing from them", async () => {
        const result = await harness({
            settings: {
                notebookCategoryMapping: { "nb-other": { categoryId: "cat-2", tagIds: ["tag-2"] } },
            },
        }).sync("20261125220000-doc0001");

        expect(result.warnings).toContain("sync.warn.notebookMappingMissing");
    });
});

describe("P2 fixed · a successful sync clears a previously stored error", () => {
    it("removes custom-juejin-last-error by sending an empty attribute value", async () => {
        const attrs: Record<string, string> = {};
        const kernel = {
            getBlockAttrs: async () => ({ ...attrs }),
            setBlockAttrs: async (_id: string, next: Record<string, string>) => {
                Object.entries(next).forEach(([key, value]) => {
                    if (value === "") {
                        delete attrs[key];
                    } else {
                        attrs[key] = value;
                    }
                });
            },
        } as unknown as KernelApi;
        const binding = new BindingService({ kernel, logger: silentLogger });

        await binding.write("doc", { status: "failed", lastError: "boom" });
        expect(attrs[BLOCK_ATTR.LAST_ERROR]).toBe("boom");

        await binding.write("doc", { status: "draft", lastError: "" });

        expect(attrs[BLOCK_ATTR.STATUS]).toBe("draft");
        expect(attrs[BLOCK_ATTR.LAST_ERROR]).toBeUndefined();
    });
});

describe("P3 · the S5 post-image audit is never executed", () => {
    it("never calls audit() with expectAssets:false after S4", async () => {
        const source = await import("node:fs").then((fs) => fs.readFileSync("src/core/syncEngine.ts", "utf8"));

        // `audit(body, { expectAssets: false })` exists in markdown.ts but no caller uses it,
        // so `sync.warn.residualAsset` is unreachable and leftovers are only visible through
        // `imageFailed[]`.
        expect(source.includes("audit(")).toBe(false);
        expect(source.includes("residualAsset")).toBe(false);
    });
});

describe("P3 · unused settings surface", () => {
    it("exposes P1-only flags that the P0 flow never reads", () => {
        const settings = { ...DEFAULT_SETTINGS };
        // Documented as P1 slots in §7; listed here so the report can state them explicitly.
        expect(settings.appendLinkToDoc).toBe(false);
        expect(settings.requestIntervalMs).toBe(1000);
        expect(Object.keys(settings)).toContain("enableReverseImport");
    });

    it("stores a plugin-storage credential even when a vault secret exists (§8.8 asymmetry)", async () => {
        const files: Record<string, unknown> = { settings: { riskAccepted: true } };
        const plugin = {
            loadData: async (key: string) => files[key] ?? "",
            saveData: async (key: string, content: unknown) => {
                files[key] = content;
                return { code: 0 };
            },
            removeData: async (key: string) => {
                delete files[key];
                return { code: 0 };
            },
            getSecret: () => "vault-value",
        } as unknown as Plugin;
        const service = new SettingsService({ plugin, logger: silentLogger });

        const credential = await service.setCredential("typed-value");

        // The write always targets plugin storage; the vault read still wins, which is why the
        // UI must show both facts (A7 wording) rather than "saved encrypted".
        expect(credential.source).toBe("plugin-storage");
        expect(files.credential).toMatchObject({ sessionId: "typed-value" });
        await expect(service.getCredential()).resolves.toMatchObject({ source: "vault", sessionId: "vault-value" });
    });
});

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

interface HarnessOptions {
    /** Extra settings merged over the defaults. */
    settings?: Partial<SyncSettings>;
    /** Pre-existing block attributes of the document. */
    seed?: Record<string, string>;
    /** Override for `JuejinApi.updateDraft` (used by the "already published" case). */
    updateDraft?: () => Promise<{ draftId: string }>;
}

function harness(options: HarnessOptions = {}): SyncEngine {
    const settings: SyncSettings = {
        ...DEFAULT_SETTINGS,
        defaultCategoryId: "cat-1",
        defaultTagIds: ["tag-1"],
        requestIntervalMs: 0,
        ...(options.settings ?? {}),
    };
    const attrStore = new Map<string, Record<string, string>>();
    const docId = "20261125220000-doc0001";
    if (options.seed) {
        attrStore.set(docId, { ...options.seed });
    }
    const kernel = {
        exportMdContent: async () => ({ hPath: "/a/b", content: "# T\n\nbody\n" }),
        getBlockAttrs: async (id: string) => ({ ...(attrStore.get(id) ?? {}) }),
        setBlockAttrs: async (id: string, attrs: Record<string, string>) => {
            const merged = { ...(attrStore.get(id) ?? {}) };
            Object.entries(attrs).forEach(([key, value]) => {
                if (value === "") {
                    delete merged[key];
                } else {
                    merged[key] = value;
                }
            });
            attrStore.set(id, merged);
        },
        getDocNotebook: async () => "nb-1",
        fetchAssetBinary: async () => null,
    } as unknown as KernelApi;
    const api = {
        createDraft: async () => ({ draftId: "d-1" }),
        updateDraft: options.updateDraft ?? (async () => ({ draftId: "d-1" })),
        uploadImage: async () => "https://cdn/x.png",
        publishDraft: async () => ({ articleId: "a-1" }),
    } as unknown as JuejinApi;

    return new SyncEngine({
        kernel,
        api,
        settings: { load: async () => settings } as unknown as SettingsService,
        binding: new BindingService({ kernel, logger: silentLogger }),
        pipeline: new ImagePipeline({ api, kernel, logger: silentLogger, uploadEnabled: true, intervalMs: 0 }),
        store: new SyncStore(),
        logger: silentLogger,
        translate: t,
    });
}

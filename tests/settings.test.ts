/**
 * Settings / credential persistence (§8.3, §8.8, FR-01, FR-12, R4).
 *
 * Two properties matter more than anything else here:
 *  1. the credential is **never** written into the `settings` blob (so "clear credential"
 *     cannot be defeated by a stale copy),
 *  2. `source` is reported honestly, because the UI wording (A7) is derived from it and the
 *     plugin is not allowed to claim encryption it does not perform.
 *
 * No real plugin instance: `Plugin` is faked down to the four storage methods actually used.
 */
import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "siyuan";
import {
    DEFAULT_SETTINGS,
    SettingsService,
    clampNumber,
    effectivePathTemplate,
    normalizeSettings,
} from "../src/core/settings";
import { createLogger, maskSecret } from "../src/core/logger";
import { STORAGE_KEY } from "../src/types";
import type { Logger } from "../src/core/logger";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

interface FakePlugin {
    loadData: ReturnType<typeof vi.fn>;
    saveData: ReturnType<typeof vi.fn>;
    removeData: ReturnType<typeof vi.fn>;
    getSecret: ReturnType<typeof vi.fn>;
}

function fakePlugin(seed: Record<string, unknown> = {}, secret = ""): { plugin: Plugin; files: Record<string, unknown>; api: FakePlugin } {
    const files: Record<string, unknown> = { ...seed };
    const api: FakePlugin = {
        loadData: vi.fn(async (key: string) => (key in files ? files[key] : "")),
        saveData: vi.fn(async (key: string, content: unknown) => {
            files[key] = content;
            return { code: 0 };
        }),
        removeData: vi.fn(async (key: string) => {
            delete files[key];
            return { code: 0 };
        }),
        getSecret: vi.fn(() => secret),
    };
    return { plugin: api as unknown as Plugin, files, api };
}

describe("normalizeSettings · reads whatever is on disk", () => {
    it("falls back to factory defaults for missing / garbage input", () => {
        expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings("")).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
    });

    it("keeps publishMode safe: anything but 'publish' becomes 'draft'", () => {
        expect(normalizeSettings({ publishMode: "publish" }).publishMode).toBe("publish");
        expect(normalizeSettings({ publishMode: "PUBLISH" }).publishMode).toBe("draft");
        expect(normalizeSettings({ publishMode: 1 }).publishMode).toBe("draft");
    });

    it("keeps autoUploadImages default true but honours an explicit false (D1)", () => {
        expect(normalizeSettings({}).autoUploadImages).toBe(true);
        expect(normalizeSettings({ autoUploadImages: false }).autoUploadImages).toBe(false);
    });

    it("clamps the numeric settings", () => {
        expect(normalizeSettings({ syncTimeoutMs: 10 }).syncTimeoutMs).toBe(5000);
        expect(normalizeSettings({ syncTimeoutMs: 999999 }).syncTimeoutMs).toBe(120000);
        expect(normalizeSettings({ requestIntervalMs: -5 }).requestIntervalMs).toBe(0);
        expect(normalizeSettings({ requestIntervalMs: "700" }).requestIntervalMs).toBe(700);
    });

    it("normalizes tag arrays: strings only, trimmed, de-duplicated", () => {
        expect(normalizeSettings({ defaultTagIds: [" a ", "a", 2, null, ""] }).defaultTagIds).toEqual(["a", "2"]);
        expect(normalizeSettings({ defaultTagIds: "a,b" }).defaultTagIds).toEqual([]);
    });

    it("normalizes the notebook mapping and drops junk entries", () => {
        const result = normalizeSettings({
            notebookCategoryMapping: {
                "nb-1": { categoryId: "c-1", tagIds: ["t-1"] },
                "nb-2": "nope",
                "nb-3": null,
            },
        });
        expect(result.notebookCategoryMapping).toEqual({ "nb-1": { categoryId: "c-1", tagIds: ["t-1"] } });
    });

    it("clampNumber rejects NaN and non-finite values", () => {
        expect(clampNumber(Number.NaN, 42, 0, 100)).toBe(42);
        expect(clampNumber(Number.POSITIVE_INFINITY, 42, 0, 100)).toBe(42);
        expect(clampNumber(Number.NEGATIVE_INFINITY, 42, 0, 100)).toBe(42);
        expect(clampNumber(50.4, 42, 0, 100)).toBe(50);
    });

    it("ships no brief / excerpt field at all (FR-06b ④)", () => {
        expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("brief");
        expect(Object.keys(DEFAULT_SETTINGS).some((key) => key.toLowerCase().includes("brief"))).toBe(false);
    });
});

describe("SettingsService · FR-12 separation of settings and credential", () => {
    it("persists settings under the dedicated key only", async () => {
        const { plugin, files } = fakePlugin();
        const service = new SettingsService({ plugin, logger: silentLogger });

        await service.save({ defaultCategoryId: "cat-1", riskAccepted: true });

        expect(Object.keys(files)).toEqual([STORAGE_KEY.SETTINGS]);
        const stored = files[STORAGE_KEY.SETTINGS] as Record<string, unknown>;
        expect(stored.defaultCategoryId).toBe("cat-1");
        // R4: no credential material may ever appear in the settings blob.
        expect(JSON.stringify(stored)).not.toMatch(/sessionid/i);
        expect(stored.sessionId).toBeUndefined();
    });

    it("caches on load and refetches after invalidate", async () => {
        const { plugin, api } = fakePlugin();
        const service = new SettingsService({ plugin, logger: silentLogger });

        await service.load();
        await service.load();
        expect(api.loadData).toHaveBeenCalledTimes(1);

        service.invalidate();
        await service.load();
        expect(api.loadData).toHaveBeenCalledTimes(2);
    });
});

describe("SettingsService · credential handling (FR-01, R4, A7)", () => {
    it("refuses to store a credential before the risk notice is accepted", async () => {
        const { plugin, files } = fakePlugin({ [STORAGE_KEY.SETTINGS]: { riskAccepted: false } });
        const service = new SettingsService({ plugin, logger: silentLogger });

        await expect(service.setCredential("sid-value")).rejects.toMatchObject({ i18nKey: "settings.save.noRisk" });
        expect(files[STORAGE_KEY.CREDENTIAL]).toBeUndefined();
    });

    it("stores the credential in its own file, reported as plugin-storage", async () => {
        const { plugin, files } = fakePlugin({ [STORAGE_KEY.SETTINGS]: { riskAccepted: true } });
        const service = new SettingsService({ plugin, logger: silentLogger });

        const credential = await service.setCredential("  sid-value  ", "someone");

        expect(credential).toMatchObject({ sessionId: "sid-value", source: "plugin-storage", userName: "someone" });
        expect(files[STORAGE_KEY.CREDENTIAL]).toMatchObject({ sessionId: "sid-value" });
        expect(files[STORAGE_KEY.SETTINGS]).toMatchObject({ riskAccepted: true });
        expect((files[STORAGE_KEY.SETTINGS] as Record<string, unknown>).sessionId).toBeUndefined();
    });

    it("prefers the SiYuan secret vault over the plugin storage (§8.8)", async () => {
        const { plugin } = fakePlugin(
            { [STORAGE_KEY.CREDENTIAL]: { sessionId: "stored-sid", savedAt: "x", source: "plugin-storage" } },
            "vault-sid",
        );
        const service = new SettingsService({ plugin, logger: silentLogger });

        await expect(service.getCredential()).resolves.toMatchObject({ sessionId: "vault-sid", source: "vault" });
    });

    it("returns null when nothing is configured", async () => {
        const { plugin } = fakePlugin();
        const service = new SettingsService({ plugin, logger: silentLogger });

        await expect(service.getCredential()).resolves.toBeNull();
    });

    it("survives a throwing getSecret", async () => {
        const { plugin } = fakePlugin();
        (plugin as unknown as FakePlugin).getSecret = vi.fn(() => {
            throw new Error("no vault");
        });
        const service = new SettingsService({ plugin, logger: silentLogger });

        expect(service.readVaultSecret()).toBe("");
    });

    it("keeps the account name out of the settings blob", async () => {
        const { plugin, files } = fakePlugin({ [STORAGE_KEY.SETTINGS]: { riskAccepted: true } });
        const service = new SettingsService({ plugin, logger: silentLogger });

        await service.setCredential("sid");
        await service.setCredentialUserName("someone");

        expect((files[STORAGE_KEY.CREDENTIAL] as Record<string, unknown>).userName).toBe("someone");
        expect((files[STORAGE_KEY.SETTINGS] as Record<string, unknown>).userName).toBeUndefined();
    });

    it("removes only the credential file and reports whether the vault still holds one", async () => {
        const { plugin, files } = fakePlugin({ [STORAGE_KEY.CREDENTIAL]: { sessionId: "sid" } }, "vault-sid");
        const service = new SettingsService({ plugin, logger: silentLogger });

        const vaultStillHasSecret = await service.clearCredential();

        expect(files[STORAGE_KEY.CREDENTIAL]).toBeUndefined();
        expect(vaultStillHasSecret).toBe(true);
    });

    it("keeps the other settings when the credential is cleared (FR-12 ②)", async () => {
        const { plugin, files } = fakePlugin({
            [STORAGE_KEY.SETTINGS]: { riskAccepted: true, defaultCategoryId: "cat-1" },
            [STORAGE_KEY.CREDENTIAL]: { sessionId: "sid" },
        });
        const service = new SettingsService({ plugin, logger: silentLogger });

        await service.clearCredential();

        expect(files[STORAGE_KEY.SETTINGS]).toMatchObject({ defaultCategoryId: "cat-1" });
    });

    it("wipes every plugin-owned file on uninstall", async () => {
        const { plugin, files } = fakePlugin({
            [STORAGE_KEY.SETTINGS]: { riskAccepted: true },
            [STORAGE_KEY.CREDENTIAL]: { sessionId: "sid" },
            [STORAGE_KEY.META]: { categories: [], tags: [] },
            [STORAGE_KEY.HISTORY]: [],
        });
        const service = new SettingsService({ plugin, logger: silentLogger });

        await service.clearAll();

        expect(files[STORAGE_KEY.SETTINGS]).toBeUndefined();
        expect(files[STORAGE_KEY.CREDENTIAL]).toBeUndefined();
        expect(files[STORAGE_KEY.META]).toBeUndefined();
        expect(files[STORAGE_KEY.HISTORY]).toBeUndefined();
    });
});

describe("history ring buffer", () => {
    it("keeps the newest entry first and drops malformed rows", async () => {
        const { plugin } = fakePlugin({
            [STORAGE_KEY.HISTORY]: [{ docId: "a", ok: true, action: "created" }, "junk", { docId: "b", ok: false }],
        });
        const service = new SettingsService({ plugin, logger: silentLogger });

        const history = await service.loadHistory();

        expect(history.map((entry) => entry.docId)).toEqual(["a", "b"]);
        expect(history[0].action).toBe("created");
        // Unknown action values are coerced to "created" rather than trusted.
        expect(history[1].action).toBe("created");
    });

    it("caps the stored history", async () => {
        const { plugin } = fakePlugin();
        const service = new SettingsService({ plugin, logger: silentLogger });

        for (let index = 0; index < 25; index += 1) {
            await service.pushHistory({
                docId: `doc-${index}`,
                docTitle: "t",
                at: new Date().toISOString(),
                ok: true,
                action: "created",
                imageFailed: 0,
            });
        }

        const history = await service.loadHistory();
        expect(history).toHaveLength(20);
        expect(history[0].docId).toBe("doc-24");
    });
});

describe("maskSecret · credentials never reach the log in clear text (§8.6)", () => {
    it("masks session cookies", () => {
        expect(maskSecret("Cookie: sessionid_ss=abc123")).toBe("Cookie: sessionid_ss=***");
        expect(maskSecret("sessionid_ss=abc123; other=1")).toBe("sessionid_ss=***; other=1");
    });

    it("masks kernel and STS tokens", () => {
        expect(maskSecret("Authorization: Token abcdef")).toContain("***");
        expect(maskSecret('x-amz-security-token: sts-value')).toContain("***");
    });

    it("leaves ordinary text untouched", () => {
        expect(maskSecret("err_no=403 err_msg=must login")).toBe("err_no=403 err_msg=must login");
        expect(maskSecret("")).toBe("");
    });

    it("is applied by createLogger itself", () => {
        const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
        const logger = createLogger("juejin");
        logger.info("cookie sessionid_ss=secret-value");
        expect(String(spy.mock.calls[0][0])).not.toContain("secret-value");
        expect(String(spy.mock.calls[0][0])).toContain("[juejin-sync][juejin]");
        spy.mockRestore();
    });
});

describe("effectivePathTemplate", () => {
    it("prefers the configured template and falls back to the localized default", () => {
        const settings = normalizeSettings({ reverseImportPathTemplate: "/mine/{{title}}" });
        expect(effectivePathTemplate(settings, "/fallback/{{title}}")).toBe("/mine/{{title}}");
        expect(effectivePathTemplate(normalizeSettings({}), "/fallback/{{title}}")).toBe("/fallback/{{title}}");
    });
});

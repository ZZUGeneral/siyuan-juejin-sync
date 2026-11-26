/**
 * Settings & credential persistence (§8.3, §8.8).
 *
 * Two separate files are used on purpose (FR-12):
 *  - `settings`   → `SyncSettings`, never contains the credential,
 *  - `credential` → `JuejinCredential`, deleted independently by "clear credential".
 *
 * Credential resolution order (§8.8):
 *  1. `plugin.getSecret("juejin-sessionid-ss")` — user-created entry in SiYuan's secret vault;
 *     encrypted on the kernel side, **read only** for plugins.
 *  2. `credential` file in the plugin private storage — plain text.
 *  3. none → the UI sends the user to the settings page.
 *
 * The reported `source` drives the exact A7 wording; the plugin never fabricates encryption.
 */
import type { Plugin } from "siyuan";
import { SyncError } from "./errors";
import type { Logger } from "./logger";
import { ErrorKind, type JuejinCredential, type JuejinMetaCache, type NotebookMapping, type SyncHistoryEntry, type SyncSettings } from "../types";
import { HISTORY_LIMIT, SECRET_NAME, STORAGE_KEY } from "../types";

/**
 * Factory defaults.
 *
 * `reverseImportPathTemplate` is intentionally empty: the localized default lives in the i18n
 * bundle (`import.path.defaultTemplate`), so a Chinese path is never hard-coded in TypeScript.
 */
export const DEFAULT_SETTINGS: SyncSettings = {
    riskAccepted: false,
    defaultCategoryId: "",
    defaultTagIds: [],
    notebookCategoryMapping: {},
    publishMode: "draft",
    autoUploadImages: true,
    showInDocMenu: true,
    titlePrefix: "",
    titleSuffix: "",
    appendLinkToDoc: false,
    syncTimeoutMs: 30000,
    requestIntervalMs: 1000,
    enableReverseImport: false,
    reverseImportNotebook: "",
    reverseImportPathTemplate: "",
    reverseImportOverwrite: false,
};

const TIMEOUT_MIN = 5000;
const TIMEOUT_MAX = 120000;
const INTERVAL_MIN = 0;
const INTERVAL_MAX = 10000;

/** Clamp a numeric setting into a sane range. */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(numeric)));
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    value.forEach((item) => {
        if (typeof item === "string" || typeof item === "number") {
            const text = String(item).trim();
            if (text && !seen.has(text)) {
                seen.add(text);
                out.push(text);
            }
        }
    });
    return out;
}

function toMapping(value: unknown): Record<string, NotebookMapping> {
    if (!value || typeof value !== "object") {
        return {};
    }
    const out: Record<string, NotebookMapping> = {};
    Object.entries(value as Record<string, unknown>).forEach(([notebook, raw]) => {
        if (!raw || typeof raw !== "object") {
            return;
        }
        const record = raw as Record<string, unknown>;
        out[notebook] = {
            categoryId: typeof record.categoryId === "string" ? record.categoryId : "",
            tagIds: toStringArray(record.tagIds),
        };
    });
    return out;
}

/**
 * Coerce anything read from disk into a valid {@link SyncSettings}.
 *
 * @param raw Value returned by `loadData("settings")`; may be `""`, `null` or a legacy shape.
 */
export function normalizeSettings(raw: unknown): SyncSettings {
    const source: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const merged: SyncSettings = {
        riskAccepted: Boolean(source.riskAccepted),
        defaultCategoryId: typeof source.defaultCategoryId === "string" ? source.defaultCategoryId : "",
        defaultTagIds: toStringArray(source.defaultTagIds),
        notebookCategoryMapping: toMapping(source.notebookCategoryMapping),
        publishMode: source.publishMode === "publish" ? "publish" : "draft",
        autoUploadImages: source.autoUploadImages === undefined ? DEFAULT_SETTINGS.autoUploadImages : Boolean(source.autoUploadImages),
        showInDocMenu: source.showInDocMenu === undefined ? DEFAULT_SETTINGS.showInDocMenu : Boolean(source.showInDocMenu),
        titlePrefix: typeof source.titlePrefix === "string" ? source.titlePrefix : "",
        titleSuffix: typeof source.titleSuffix === "string" ? source.titleSuffix : "",
        appendLinkToDoc: Boolean(source.appendLinkToDoc),
        syncTimeoutMs: clampNumber(source.syncTimeoutMs, DEFAULT_SETTINGS.syncTimeoutMs, TIMEOUT_MIN, TIMEOUT_MAX),
        requestIntervalMs: clampNumber(source.requestIntervalMs, DEFAULT_SETTINGS.requestIntervalMs, INTERVAL_MIN, INTERVAL_MAX),
        enableReverseImport: Boolean(source.enableReverseImport),
        reverseImportNotebook: typeof source.reverseImportNotebook === "string" ? source.reverseImportNotebook : "",
        reverseImportPathTemplate:
            typeof source.reverseImportPathTemplate === "string" ? source.reverseImportPathTemplate : "",
        reverseImportOverwrite: Boolean(source.reverseImportOverwrite),
    };
    return merged;
}

/** Settings + credential service backed by `plugin.loadData` / `plugin.saveData`. */
export class SettingsService {
    private readonly plugin: Plugin;
    private readonly logger: Logger;
    private cache: SyncSettings | null = null;

    constructor(options: { plugin: Plugin; logger: Logger }) {
        this.plugin = options.plugin;
        this.logger = options.logger;
    }

    /** Read one private storage file; never throws (a missing file is a normal state). */
    private async read(key: string): Promise<unknown> {
        try {
            const data = (await this.plugin.loadData(key)) as unknown;
            if (data === "" || data === undefined || data === null) {
                return null;
            }
            return data;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`loadData(${key}) failed: ${message}`);
            return null;
        }
    }

    /** Write one private storage file; throws only when the kernel rejects the write. */
    private async write(key: string, content: unknown): Promise<void> {
        try {
            const result = (await this.plugin.saveData(key, content)) as { code?: number; msg?: string } | null;
            if (result && typeof result.code === "number" && result.code !== 0) {
                throw new SyncError(ErrorKind.KERNEL, {
                    i18nKey: "err.kernel",
                    raw: { endpoint: `saveData(${key})`, errMsg: result.msg ?? "", code: result.code },
                    params: { msg: result.msg ?? key },
                });
            }
        } catch (error) {
            if (error instanceof SyncError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new SyncError(ErrorKind.KERNEL, {
                i18nKey: "err.kernel",
                raw: { endpoint: `saveData(${key})`, errMsg: message },
                params: { msg: message },
            });
        }
    }

    /** Load (and memoize) the settings. */
    async load(): Promise<SyncSettings> {
        if (this.cache) {
            return this.cache;
        }
        const raw = await this.read(STORAGE_KEY.SETTINGS);
        this.cache = normalizeSettings(raw);
        return this.cache;
    }

    /** Drop the in-memory cache (used when another window wrote the file). */
    invalidate(): void {
        this.cache = null;
    }

    /** Merge a patch into the settings and persist. */
    async save(patch: Partial<SyncSettings>): Promise<SyncSettings> {
        const current = await this.load();
        const next = normalizeSettings({ ...current, ...patch });
        await this.write(STORAGE_KEY.SETTINGS, next);
        this.cache = next;
        return next;
    }

    /** Restore factory defaults, keeping the credential untouched (FR-12). */
    async reset(): Promise<SyncSettings> {
        const next = normalizeSettings({ ...DEFAULT_SETTINGS });
        await this.write(STORAGE_KEY.SETTINGS, next);
        this.cache = next;
        return next;
    }

    /** Read the vault secret if the user created one; never throws. */
    readVaultSecret(): string {
        try {
            const value = this.plugin.getSecret(SECRET_NAME);
            return typeof value === "string" ? value.trim() : "";
        } catch {
            return "";
        }
    }

    /** Resolve the credential following the §8.8 priority order. */
    async getCredential(): Promise<JuejinCredential | null> {
        const vault = this.readVaultSecret();
        if (vault) {
            return { sessionId: vault, savedAt: "", source: "vault" };
        }
        const stored = await this.read(STORAGE_KEY.CREDENTIAL);
        if (stored && typeof stored === "object") {
            const record = stored as Record<string, unknown>;
            const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
            if (sessionId) {
                return {
                    sessionId,
                    savedAt: typeof record.savedAt === "string" ? record.savedAt : "",
                    source: "plugin-storage",
                    userName: typeof record.userName === "string" ? record.userName : undefined,
                };
            }
        }
        return null;
    }

    /**
     * Persist a credential into the plugin private storage.
     *
     * @throws {SyncError} when the risk notice has not been accepted (FR-01).
     */
    async setCredential(sessionId: string, userName?: string): Promise<JuejinCredential> {
        const settings = await this.load();
        if (!settings.riskAccepted) {
            throw new SyncError(ErrorKind.UNKNOWN, { i18nKey: "settings.save.noRisk" });
        }
        const credential: JuejinCredential = {
            sessionId: sessionId.trim(),
            savedAt: new Date().toISOString(),
            source: "plugin-storage",
            userName,
        };
        await this.write(STORAGE_KEY.CREDENTIAL, credential);
        this.logger.info("credential stored in plugin private storage (source=plugin-storage)");
        return credential;
    }

    /** Remember the resolved account name without touching the secret itself. */
    async setCredentialUserName(userName: string): Promise<void> {
        const stored = await this.read(STORAGE_KEY.CREDENTIAL);
        if (!stored || typeof stored !== "object") {
            return;
        }
        const record = stored as Record<string, unknown>;
        await this.write(STORAGE_KEY.CREDENTIAL, { ...record, userName });
    }

    /**
     * Delete the credential file.
     *
     * @returns `true` when a vault secret is still present — plugins can only read secrets,
     *          so the user has to remove that entry in the SiYuan settings themselves.
     */
    async clearCredential(): Promise<boolean> {
        try {
            await this.plugin.removeData(STORAGE_KEY.CREDENTIAL);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`removeData(credential) failed: ${message}`);
        }
        return this.readVaultSecret().length > 0;
    }

    /** Cached category / tag list. */
    async loadMeta(): Promise<JuejinMetaCache | null> {
        const raw = await this.read(STORAGE_KEY.META);
        if (!raw || typeof raw !== "object") {
            return null;
        }
        const record = raw as Record<string, unknown>;
        const categories = Array.isArray(record.categories) ? record.categories : [];
        const tags = Array.isArray(record.tags) ? record.tags : [];
        return {
            categories: categories
                .filter((item): item is { id: string; name: string } => !!item && typeof item === "object")
                .map((item) => ({ id: String((item as { id?: unknown }).id ?? ""), name: String((item as { name?: unknown }).name ?? "") })),
            tags: tags
                .filter((item): item is { id: string; name: string } => !!item && typeof item === "object")
                .map((item) => ({ id: String((item as { id?: unknown }).id ?? ""), name: String((item as { name?: unknown }).name ?? "") })),
            fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : "",
            userName: typeof record.userName === "string" ? record.userName : undefined,
        };
    }

    async saveMeta(meta: JuejinMetaCache): Promise<void> {
        await this.write(STORAGE_KEY.META, meta);
    }

    /** Sync history (ring buffer, newest first). */
    async loadHistory(): Promise<SyncHistoryEntry[]> {
        const raw = await this.read(STORAGE_KEY.HISTORY);
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw
            .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
            .map((item) => ({
                docId: String(item.docId ?? ""),
                docTitle: String(item.docTitle ?? ""),
                at: String(item.at ?? ""),
                ok: Boolean(item.ok),
                action: (item.action === "updated" || item.action === "skipped" || item.action === "blocked" ? item.action : "created") as SyncHistoryEntry["action"],
                articleId: typeof item.articleId === "string" ? item.articleId : undefined,
                imageFailed: Number(item.imageFailed ?? 0),
                error: typeof item.error === "string" ? item.error : undefined,
            }))
            .slice(0, HISTORY_LIMIT);
    }

    async pushHistory(entry: SyncHistoryEntry): Promise<SyncHistoryEntry[]> {
        const current = await this.loadHistory();
        const next = [entry, ...current].slice(0, HISTORY_LIMIT);
        await this.write(STORAGE_KEY.HISTORY, next);
        return next;
    }

    /** Wipe every plugin-owned file (called from `uninstall`). */
    async clearAll(): Promise<void> {
        for (const key of Object.values(STORAGE_KEY)) {
            try {
                await this.plugin.removeData(key);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`removeData(${key}) failed: ${message}`);
            }
        }
        this.cache = null;
    }
}

/** Effective reverse-import path template, falling back to the localized default. */
export function effectivePathTemplate(settings: SyncSettings, fallback: string): string {
    const value = settings.reverseImportPathTemplate.trim();
    return value.length > 0 ? value : fallback;
}

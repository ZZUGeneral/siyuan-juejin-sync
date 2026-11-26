/**
 * Global contract layer: types, constants and enumerations shared by every layer.
 *
 * Dependency direction is strictly one-way: `ui -> core -> api -> types`.
 * Nothing in this file may import from `src/api`, `src/core` or `src/ui` (cycle free by design).
 *
 * Section references (§) point at `docs/ARCHITECTURE.md` v1.2.
 */
import enUS from "./i18n/en_US.json";
import zhCN from "./i18n/zh_CN.json";

export type I18nBundle = Record<string, string>;
/** Literal union of every i18n key declared by `zh_CN.json` (the reference bundle). */
export type I18nKey = keyof typeof zhCN | keyof typeof enUS;

/* ------------------------------------------------------------------ *
 * Settings (§3.1)
 * ------------------------------------------------------------------ */

export type PublishMode = "draft" | "publish";

export interface NotebookMapping {
    categoryId: string;
    tagIds: string[];
}

export interface SyncSettings {
    /** Must be `true` before a credential may be persisted. */
    riskAccepted: boolean;
    defaultCategoryId: string;
    defaultTagIds: string[];
    notebookCategoryMapping: Record<string, NotebookMapping>;
    /** Defaults to `"draft"` — publishing requires an explicit second confirmation. */
    publishMode: PublishMode;
    /**
     * Kept for backwards compatibility of the stored settings blob.
     *
     * D1: this flag must NEVER skip the image stage. `false` only downgrades the outcome to
     * "every local reference goes into `imageFailed[]` with `reason: "upload-disabled"`".
     */
    autoUploadImages: boolean;
    showInDocMenu: boolean;
    titlePrefix: string;
    titleSuffix: string;
    /** P1 slot: append the Juejin link to the document tail after a successful sync. */
    appendLinkToDoc: boolean;
    syncTimeoutMs: number;
    requestIntervalMs: number;
    enableReverseImport: boolean;
    reverseImportNotebook: string;
    reverseImportPathTemplate: string;
    reverseImportOverwrite: boolean;
}

export type CredentialSource = "vault" | "plugin-storage";

export interface JuejinCredential {
    /** Value of the `sessionid_ss` (or `sessionid`) cookie. Never logged in clear text. */
    sessionId: string;
    /** ISO 8601 UTC. */
    savedAt: string;
    /**
     * Where the value came from. Drives the exact A7 wording in the UI:
     * `vault` → "stored in the SiYuan secret vault", otherwise "plain text in the local data dir".
     */
    source: CredentialSource;
    /** Filled in after a successful probe so the user can confirm the identity. */
    userName?: string;
}

export interface JuejinMetaCache {
    categories: JuejinCategory[];
    tags: JuejinTag[];
    /** ISO 8601 UTC. */
    fetchedAt: string;
    userName?: string;
}

export interface SyncHistoryEntry {
    docId: string;
    docTitle: string;
    /** ISO 8601 UTC. */
    at: string;
    ok: boolean;
    action: SyncAction;
    articleId?: string;
    imageFailed: number;
    /** Localized error message, already rendered when the record was created. */
    error?: string;
}

/* ------------------------------------------------------------------ *
 * Credential probe — FR-01's only exit (§3.1)
 * ------------------------------------------------------------------ */

/**
 * Outcome of {@link JuejinApi.probeCredential}.
 *
 * `not-configured` exists so a first-time user is never told their credential "expired":
 * nothing was saved yet, which is a different situation from a rejected cookie.
 */
export type CredentialState = "valid" | "expired" | "unreachable" | "not-configured";

export interface CredentialProbe {
    state: CredentialState;
    /** Present only when `state === "valid"`. */
    user?: JuejinUser;
    httpStatus?: number;
    errNo?: number;
    /** Verbatim `err_msg`, never rewritten (D4). */
    errMsg?: string;
    elapsedMs: number;
}

/* ------------------------------------------------------------------ *
 * Document <-> article binding (§3.1) — single source of truth = block attributes
 * ------------------------------------------------------------------ */

/**
 * Local sync status of a bound document.
 *
 * `unknown` is written when the plugin has a reason to believe the article is no longer a
 * draft (for example Juejin refused a draft update because it was already published), but it
 * cannot verify that without an extra round trip. Consumers must treat it as "do not assume a
 * draft" and send the user to the web UI (FR-10②, PRD R6).
 */
export type SyncStatus = "draft" | "published" | "failed" | "imported" | "unknown";

export interface DocBinding {
    articleId?: string;
    draftId?: string;
    /** ISO 8601 UTC. */
    syncTime?: string;
    status?: SyncStatus;
    contentHash?: string;
    categoryId?: string;
    tagIds?: string[];
    sourceArticleId?: string;
    lastError?: string;
    /** The excerpt actually submitted to Juejin (A1). */
    brief?: string;
}

/* ------------------------------------------------------------------ *
 * Juejin DTO (§3.1)
 * ------------------------------------------------------------------ */

export interface JuejinCategory {
    id: string;
    name: string;
}

export interface JuejinTag {
    id: string;
    name: string;
}

export interface JuejinUser {
    userName: string;
    userId: string;
}

export interface DraftInput {
    title: string;
    /** 50–100 code points, hard-validated server side. See `core/brief.ts`. */
    briefContent: string;
    categoryId: string;
    /** At least one tag id. */
    tagIds: string[];
    /** Sanitized markdown, local image references already replaced by CDN URLs. */
    markdown: string;
    /** P0 always sends an empty string (custom cover images are a non-goal). */
    coverImage?: string;
}

export interface JuejinDraftRef {
    draftId: string;
}

export interface JuejinArticleRef {
    articleId: string;
    draftId?: string;
}

export interface JuejinDraftDetail {
    draftId: string;
    title: string;
    markdown: string;
    categoryId: string;
    tagIds: string[];
    articleId?: string;
}

export interface JuejinArticleDetail {
    articleId: string;
    title: string;
    markdown: string;
    status: number;
}

/**
 * How much we trust a probed route.
 *
 * `known-missing` is not a failure: Juejin genuinely has no such route (verified 2026-11-26 with
 * both GET and POST, with a valid session). The probe is kept only to prove the absence so that a
 * future re-appearance is noticed; the UI must render it as "expected", not as a broken endpoint.
 */
export type ProbeDeterminism = "verified" | "inferred" | "unverified" | "known-missing";

export interface EndpointProbe {
    /** Stable id, e.g. `"draft.create"`. */
    name: string;
    url: string;
    /** The route exists, even when it answers `403 must login`. */
    reachable: boolean;
    determinism: ProbeDeterminism;
    /** Raw `err_no` / `err_msg` / transport note, so the user can report it upstream (D4). */
    observed?: string;
}

/* ------------------------------------------------------------------ *
 * Sync result (§3.1)
 * ------------------------------------------------------------------ */

export type ImageRefKind = "local" | "remote" | "data";

/** A candidate image reference discovered while scanning the markdown body. */
export interface ImageRef {
    kind: ImageRefKind;
    /** The token exactly as it appears in the body. */
    ref: string;
    /** `assets/xxx.png` for local images. */
    assetPath?: string;
    /** Absolute URL for remote images. */
    sourceUrl?: string;
}

export interface ImageUploadResult {
    kind: ImageRefKind;
    ref: string;
    assetPath?: string;
    sourceUrl?: string;
    cdnUrl?: string;
    ok: boolean;
    /** Hit the in-document dedupe map (P0) or the persistent cache (P1). */
    reused?: boolean;
    /** i18n key describing the failure (`image.err.missingAsset`, `image.skip.disabled`, …). */
    reason?: string;
    /** Extra interpolation values for {@link reason}. */
    reasonParams?: Record<string, string | number>;
    elapsedMs?: number;
}

export interface ImageProcessResult {
    /** Body with successfully uploaded local references replaced. */
    markdown: string;
    /** Number of distinct image references discovered. */
    total: number;
    uploaded: number;
    /** Failed entries, always listed verbatim in the result panel (A3). */
    failed: ImageUploadResult[];
    results: ImageUploadResult[];
    /** i18n keys. */
    warnings: string[];
}

export interface PreflightReport {
    total: number;
    reachable: number;
    /** i18n key + optional detail, e.g. `preflight.miss`/`assets/x.png` encoded as a plain string. */
    warnings: string[];
}

export type DegradationKind =
    | "block-attr"
    | "block-ref"
    | "doc-ref"
    | "unsupported-block"
    | "footnote"
    | "inline-ext"
    | "remote-image";

export interface Degradation {
    kind: DegradationKind;
    count: number;
    sample?: string;
}

export interface SanitizeOutput {
    markdown: string;
    /** sha256 hex of the S0–S3 output, computed **before** S4 replaces image URLs. */
    contentHash: string;
    degradations: Degradation[];
    /** i18n keys resolved by the caller. */
    warnings: string[];
    imageRefs: ImageRef[];
}

export type SyncAction = "created" | "updated" | "skipped" | "blocked";

export interface SyncResult {
    /** No fatal error occurred. */
    ok: boolean;
    /** Succeeded but with failed images and/or degradations. */
    partial: boolean;
    docId: string;
    action: SyncAction;
    status: SyncStatus;
    title: string;
    articleId?: string;
    draftId?: string;
    juejinUrl?: string;
    imageTotal: number;
    imageUploaded: number;
    /** Non-empty ⇒ the result panel must render this list at the very top, expanded (A3). */
    imageFailed: ImageUploadResult[];
    degradations: Degradation[];
    /** i18n keys. */
    warnings: string[];
    /** The excerpt actually submitted (A1). */
    brief?: string;
    error?: SyncIssue;
    /** ISO 8601 UTC. */
    startedAt: string;
    elapsedMs: number;
}

/** Read-only view produced before the user confirms a sync (M1 input). */
export interface SyncPreview {
    docId: string;
    notebook: string;
    title: string;
    brief: string;
    categoryId: string;
    tagIds: string[];
    action: SyncAction;
    status: SyncStatus | "unsynced";
    publishMode: PublishMode;
    binding: DocBinding;
    imageTotal: number;
    contentLength: number;
    degradations: Degradation[];
    /** i18n keys. */
    warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Reverse import (P2)
 * ------------------------------------------------------------------ */

export interface JuejinArticlePreview {
    articleId: string;
    title: string;
    markdown: string;
    imageCount: number;
    wordCount: number;
    /** `api` = private endpoint, `page` = degraded `__NUXT__` extraction (A4). */
    origin: "api" | "page";
    /** i18n keys, e.g. `import.degraded.notice`. */
    warnings: string[];
}

export interface ImportRequest {
    articleId: string;
    notebook: string;
    path: string;
    overwrite: boolean;
}

export interface ImportResult {
    ok: boolean;
    docId?: string;
    title: string;
    imageTotal: number;
    imageRelocated: number;
    /** Original remote URLs that could not be relocated. */
    imageFailed: string[];
    /** i18n keys. */
    warnings: string[];
    error?: SyncIssue;
}

/* ------------------------------------------------------------------ *
 * Errors (§8.4)
 * ------------------------------------------------------------------ */

export enum ErrorKind {
    AUTH_EXPIRED = "auth_expired",
    NEED_PHONE = "need_phone",
    RISK_CONTROL = "risk_control",
    API_CHANGED = "api_changed",
    PARAM_INVALID = "param_invalid",
    NOT_FOUND = "not_found",
    NETWORK = "network",
    KERNEL = "kernel",
    UNKNOWN = "unknown",
}

/** D4: everything upstream told us, verbatim, for the collapsible "technical details" block. */
export interface SyncIssueRaw {
    errNo?: number;
    errMsg?: string;
    httpStatus?: number;
    /** e.g. `content_api/v1/article_draft/create`. */
    endpoint?: string;
    elapsedMs?: number;
    /** Kernel `forwardProxy` code when the failure was transport level. */
    code?: number;
}

export interface SyncIssue {
    kind: ErrorKind;
    /** i18n key for the user-facing primary message. */
    i18nKey: string;
    /** Interpolation values for {@link i18nKey}. */
    params?: Record<string, string>;
    raw: SyncIssueRaw;
}

/* ------------------------------------------------------------------ *
 * Kernel API contract (§3.3)
 * ------------------------------------------------------------------ */

export interface KernelExportResult {
    /** Human readable path inside the notebook, e.g. `/foo/bar`. */
    hPath: string;
    content: string;
}

export interface AssetBinary {
    bytes: ArrayBuffer;
    mime: string;
}

export interface NotebookInfo {
    id: string;
    name: string;
}

/**
 * One entry of `/api/storage/getRecentDocs`.
 *
 * `closedAt` is absent while the document is still open, which is how the kernel itself tells an
 * open tab from a closed one.
 */
export interface RecentDocRef {
    rootID: string;
    title?: string;
    viewedAt?: number;
    openAt?: number;
    closedAt?: number;
}

export interface AssetUploadOutcome {
    ok: boolean;
    /** Stored relative path, e.g. `assets/xxx.png`; empty string when `ok === false`. */
    path: string;
    /** Verbatim failure reason (D4). */
    error?: string;
}

export interface KernelApi {
    exportMdContent(docId: string): Promise<KernelExportResult>;
    getBlockAttrs(id: string): Promise<Record<string, string>>;
    setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void>;
    createDocWithMd(notebook: string, path: string, markdown: string): Promise<string>;
    fetchAssetBinary(assetPath: string): Promise<AssetBinary | null>;
    uploadAsset(bytes: ArrayBuffer, filename: string, mime: string, assetsDirPath?: string): Promise<AssetUploadOutcome>;
    querySql<T>(stmt: string): Promise<T[]>;
    listNotebooks(): Promise<NotebookInfo[]>;
    /** `/api/storage/getRecentDocs` — used to find the open document when no event has told us. */
    getRecentDocs(limit?: number): Promise<RecentDocRef[]>;
    getDocNotebook(docId: string): Promise<string>;
    openDoc(docId: string): void;
}

/* ------------------------------------------------------------------ *
 * Juejin API contract (§3.2) — the only surface exposed by `api/juejin.ts`
 * ------------------------------------------------------------------ */

export interface JuejinApi {
    /**
     * FR-01's only exit. The three states are collapsed inside the adapter and this method
     * **never throws**; the UI switches on `state` and must not classify errors itself.
     */
    probeCredential(): Promise<CredentialProbe>;

    /** `GET /tag_api/v1/query_category_briefs?aid=2608` (POST answers "请求路由不存在"). */
    fetchCategories(): Promise<JuejinCategory[]>;

    /**
     * `POST /tag_api/v1/query_tag_list` — the popular page (ten tags), single request.
     *
     * The route ignores `cursor`/`limit`/`key_word` upstream, so there is nothing to page through.
     * Use {@link fetchFeedTags} and {@link fetchArticleTags} to widen the local pool.
     */
    fetchTags(): Promise<JuejinTag[]>;

    /** Tags carried by the public recommend feed (`item_info.tags[]`). */
    fetchFeedTags(): Promise<JuejinTag[]>;

    /** Tags of one rendered article page; accepts a `https://juejin.cn/post/<id>` link or a bare id. */
    fetchArticleTags(url: string): Promise<JuejinTag[]>;

    /**
     * `POST /tag_api/v1/query_tag_list` with `key_word` — server-side tag search.
     *
     * `fetchTags` only returns a page of popular tags, so the cached list cannot answer a keyword
     * like "kuber"; this can, and is what keeps the picker honest for the long tail (A6).
     */
    searchTags(keyword: string, limit?: number): Promise<JuejinTag[]>;

    createDraft(input: DraftInput): Promise<JuejinDraftRef>;
    updateDraft(draftId: string, input: DraftInput): Promise<JuejinDraftRef>;
    getDraft(draftId: string): Promise<JuejinDraftDetail>;
    publishDraft(draftId: string, meta: DraftInput): Promise<JuejinArticleRef>;
    getArticle(articleId: string): Promise<JuejinArticleDetail>;

    /** ImageX upload chain (5 steps), resolves to the CDN URL. */
    uploadImage(bytes: ArrayBuffer, mime: string, filename: string): Promise<string>;

    /** Diagnostic probes for the "endpoint self-check" block (A5). */
    probeEndpoints(): Promise<EndpointProbe[]>;

    /**
     * Additive helper (architecture §4.2 step "getBinary"): download an arbitrary binary
     * resource through the kernel proxy so the reverse import can relocate images without
     * duplicating proxy/header logic outside this adapter.
     */
    downloadBinary(url: string): Promise<ArrayBuffer>;

    /**
     * Additive helper: fetch the rendered article page HTML. Used as the A4 fallback source
     * when `article/detail` answers `404 内容为空`.
     */
    fetchArticlePage(articleId: string): Promise<string>;
}

/* ------------------------------------------------------------------ *
 * Block attribute keys (§8.2) — single source of truth
 * ------------------------------------------------------------------ */

export const BLOCK_ATTR = {
    ARTICLE_ID: "custom-juejin-article-id",
    DRAFT_ID: "custom-juejin-draft-id",
    /** ISO 8601 UTC. */
    SYNC_TIME: "custom-juejin-sync-time",
    /** `draft` | `published` | `failed` | `imported`. */
    STATUS: "custom-juejin-status",
    /** sha256 hex of the S0–S3 output (computed before image replacement). */
    CONTENT_HASH: "custom-juejin-content-hash",
    CATEGORY_ID: "custom-juejin-category-id",
    /** Comma separated, no spaces. */
    TAG_IDS: "custom-juejin-tag-ids",
    SOURCE_ARTICLE_ID: "custom-juejin-source-article-id",
    /** Human readable, capped at 200 characters. */
    LAST_ERROR: "custom-juejin-last-error",
    /** The excerpt actually submitted to Juejin (A1). */
    BRIEF: "custom-juejin-brief",
} as const;

/** Plugin private storage keys (§8.3) — `saveData(storageName, content)`, minAppVersion 3.8.5. */
export const STORAGE_KEY = {
    SETTINGS: "settings",
    CREDENTIAL: "credential",
    META: "juejinMeta",
    IMAGE_CACHE: "imageCache",
    HISTORY: "syncHistory",
} as const;

/** Name of the entry inside SiYuan "Secret and variable" that may hold the credential (§8.8). */
export const SECRET_NAME = "juejin-sessionid-ss";

/** Dock / command / icon identifiers (prefixed by the plugin name, §8.1). */
export const IDS = {
    DOCK: "juejinSyncDock",
    CMD_SYNC_DOC: "juejinSyncDoc",
    CMD_IMPORT: "juejinSyncImport",
    CMD_SETTINGS: "juejinSyncSettings",
    MENU_ITEM: "juejinSyncMenuItem",
    ICON: "iconJuejinSync",
    IMPORT_TAB_TYPE: "juejinSyncImportTab",
} as const;

/** Event bus names emitted by this plugin (§8.1). */
export const EVENTS = {
    STATE_CHANGED: "siyuan-juejin-sync:state-changed",
} as const;

/* ------------------------------------------------------------------ *
 * Excerpt limits (§5.3) — the ONLY length logic allowed in the code base (D4)
 * ------------------------------------------------------------------ */

/** Juejin hard limits (code points). */
export const BRIEF_MIN = 50;
export const BRIEF_MAX = 100;
/** Our own safety band, see §5.3 "安全带宽". */
export const BRIEF_TARGET_MIN = 60;
export const BRIEF_TARGET_MAX = 90;

/** Max records kept in the in-memory sync history ring buffer. */
export const HISTORY_LIMIT = 20;

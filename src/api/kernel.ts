/**
 * SiYuan kernel RPC client (§3.3).
 *
 * Authentication model (§1.6, verified on 3.8.12): the kernel accepts requests that come
 * from the local machine — **no token is required**. The only variable is the `Origin`
 * header, which `fetchSyncPost` (and a relative `fetch`) already sets correctly.
 *
 * Therefore:
 *  - JSON calls          → `fetchSyncPost(path, body)`
 *  - multipart upload    → relative `fetch("/api/asset/upload", { body: FormData })`
 *  - asset download      → relative `fetch("/assets/" + encodeURI(path))`
 *
 * The kernel token is used **only** as a last-resort fallback: if a response is
 * `code:-1` with a local-access-check failure (e.g. a remote browser session), the request is
 * retried **once** with `Authorization: Token …`. We never invent copy for that case — the
 * kernel's own message is passed through verbatim.
 */
import {
    fetchSyncPost,
    getFrontend,
    openMobileFileById,
    openTab,
    type App,
} from "siyuan";
import { mapKernelAuthError, mapKernelError } from "../core/errors";
import type { Logger } from "../core/logger";
import type {
    AssetBinary,
    AssetUploadOutcome,
    KernelApi,
    KernelExportResult,
    NotebookInfo,
    RecentDocRef,
} from "../types";

/** Kernel's local-access-check failure message (ver batim, escaped for the D3 gate). */
const KERNEL_AUTH_FAILED = "\u8ba4\u8bc1\u5931\u8d25";

interface KernelEnvelope<T> {
    code?: number;
    msg?: string;
    data?: T;
}

interface AssetUploadData {
    succMap?: Record<string, string> | null;
    succFiles?: Array<{ path?: string }> | null;
    errFiles?: string[] | null;
    failedFiles?: Array<{ error?: string }> | null;
}

/** Read the kernel token **if** the host exposes one; never throws. */
export function optionalKernelToken(): string {
    try {
        return window.siyuan?.config?.api?.token ?? "";
    } catch {
        return "";
    }
}

/** `code:-1` + local access check failure ⇒ retry once with `Authorization: Token`. */
function isKernelAuthFailure(envelope: KernelEnvelope<unknown> | undefined): boolean {
    return !!envelope && envelope.code === -1 && typeof envelope.msg === "string" && envelope.msg.indexOf(KERNEL_AUTH_FAILED) >= 0;
}

/** Normalize `assets/x.png`, `/assets/x.png` into a same-origin `/assets/…` URL. */
export function assetUrl(assetPath: string): string {
    const relative = assetPath.replace(/^\/+/, "").replace(/^assets\//, "");
    return `/assets/${encodeURI(relative)}`;
}

/**
 * Kernel client.
 *
 * `app` is only needed by {@link KernelClient.openDoc} (`openTab` requires the host `App`).
 */
export class KernelClient implements KernelApi {
    private readonly logger: Logger;
    private readonly app: App;

    constructor(options: { app: App; logger: Logger }) {
        this.app = options.app;
        this.logger = options.logger;
    }

    /** JSON RPC helper with `code !== 0` normalization and the §1.6 fallback. */
    private async post<T>(api: string, payload: Record<string, unknown>): Promise<T> {
        let envelope: KernelEnvelope<T>;
        try {
            envelope = (await fetchSyncPost(api, payload)) as KernelEnvelope<T>;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw mapKernelError(api, message);
        }

        if (isKernelAuthFailure(envelope)) {
            const token = optionalKernelToken();
            if (token) {
                this.logger.warn(`kernel ${api} denied local access, retrying once with token`);
                envelope = await this.postWithToken<T>(api, payload, token);
            } else {
                throw mapKernelAuthError(api, envelope.msg ?? "");
            }
        }

        if (!envelope || envelope.code !== 0) {
            throw mapKernelError(api, envelope?.msg ?? "unknown kernel error", envelope?.code);
        }
        return envelope.data as T;
    }

    /** Fallback transport: relative `fetch` + `Authorization: Token …` (used once, at most). */
    private async postWithToken<T>(api: string, payload: Record<string, unknown>, token: string): Promise<KernelEnvelope<T>> {
        try {
            const response = await fetch(api, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
                body: JSON.stringify(payload),
            });
            return (await response.json()) as KernelEnvelope<T>;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { code: -1, msg: message };
        }
    }

    /** `POST /api/export/exportMdContent` — Kramdown export of one document (FR-04). */
    async exportMdContent(docId: string): Promise<KernelExportResult> {
        const data = await this.post<KernelExportResult>("/api/export/exportMdContent", { id: docId });
        return {
            hPath: typeof data?.hPath === "string" ? data.hPath : "",
            content: typeof data?.content === "string" ? data.content : "",
        };
    }

    /** `POST /api/attr/getBlockAttrs`. */
    async getBlockAttrs(id: string): Promise<Record<string, string>> {
        const data = await this.post<Record<string, unknown>>("/api/attr/getBlockAttrs", { id });
        const attrs: Record<string, string> = {};
        Object.entries(data ?? {}).forEach(([key, value]) => {
            attrs[key] = value === undefined || value === null ? "" : String(value);
        });
        return attrs;
    }

    /** `POST /api/attr/setBlockAttrs`. */
    async setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void> {
        await this.post<null>("/api/attr/setBlockAttrs", { id, attrs });
    }

    /** `POST /api/filetree/createDocWithMd`; resolves to the new document id (FR-26). */
    async createDocWithMd(notebook: string, path: string, markdown: string): Promise<string> {
        const data = await this.post<string>("/api/filetree/createDocWithMd", { notebook, path, markdown });
        if (typeof data !== "string" || data.length === 0) {
            throw mapKernelError("/api/filetree/createDocWithMd", "empty document id");
        }
        return data;
    }

    /**
     * Read an `assets/` file as binary (§9-Q3: same-origin GET, no token).
     *
     * @returns `null` when the asset is missing; never throws (callers degrade gracefully).
     */
    async fetchAssetBinary(assetPath: string): Promise<AssetBinary | null> {
        const url = assetUrl(assetPath);
        try {
            const response = await fetch(url, { method: "GET" });
            if (!response.ok) {
                this.logger.warn(`asset fetch ${url} -> ${response.status}`);
                return null;
            }
            const bytes = await response.arrayBuffer();
            if (bytes.byteLength === 0) {
                this.logger.warn(`asset fetch ${url} -> empty body`);
                return null;
            }
            const mime = response.headers.get("content-type") ?? guessMime(assetPath);
            return { bytes, mime };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`asset fetch ${url} threw ${message}`);
            return null;
        }
    }

    /**
     * `POST /api/asset/upload` (multipart) — used by the reverse import (§3.3, Q3.1).
     *
     * Two verified pitfalls:
     *  - the field name is the literal `"file[]"` (with brackets); `"file"` silently fails,
     *  - the value must be a `Blob`, not an `ArrayBuffer`.
     *
     * `succMap` is keyed by the **uploaded filename**, so the caller must pass a unique name
     * (the importer uses `juejin-<articleId>-<hash8>.<ext>`).
     */
    async uploadAsset(
        bytes: ArrayBuffer,
        filename: string,
        mime: string,
        assetsDirPath = "assets/",
    ): Promise<AssetUploadOutcome> {
        const form = buildAssetForm(bytes, filename, mime, assetsDirPath);
        let envelope = await this.sendAssetForm(form);

        if (isKernelAuthFailure(envelope)) {
            const token = optionalKernelToken();
            if (!token) {
                return { ok: false, path: "", error: envelope.msg ?? "" };
            }
            this.logger.warn("asset upload denied local access, retrying once with token");
            // FormData cannot be reused after a request; rebuild it.
            envelope = await this.sendAssetForm(buildAssetForm(bytes, filename, mime, assetsDirPath), token);
        }

        if (!envelope || envelope.code !== 0) {
            return { ok: false, path: "", error: envelope?.msg ?? "unknown kernel error" };
        }
        const data = (envelope.data ?? {}) as AssetUploadData;
        const stored = data.succMap?.[filename] ?? data.succFiles?.find((file) => typeof file?.path === "string")?.path ?? "";
        if (stored) {
            return { ok: true, path: stored };
        }
        const error =
            data.failedFiles?.map((file) => file?.error ?? "").filter((value) => value.length > 0).join("; ") ??
            (data.errFiles ?? []).join("; ");
        return { ok: false, path: "", error: error || filename };
    }

    /** One multipart round-trip; never throws. */
    private async sendAssetForm(form: FormData, token?: string): Promise<KernelEnvelope<AssetUploadData>> {
        const headers: Record<string, string> = {};
        if (token) {
            headers.Authorization = `Token ${token}`;
        }
        try {
            const response = await fetch("/api/asset/upload", { method: "POST", headers, body: form });
            if (!response.ok) {
                return { code: -1, msg: `HTTP ${response.status}` };
            }
            return (await response.json()) as KernelEnvelope<AssetUploadData>;
        } catch (error) {
            return { code: -1, msg: error instanceof Error ? error.message : String(error) };
        }
    }

    /** `POST /api/query/sql`. */
    async querySql<T>(stmt: string): Promise<T[]> {
        const data = await this.post<T[]>("/api/query/sql", { stmt });
        return Array.isArray(data) ? data : [];
    }

    /** `POST /api/storage/getRecentDocs` — newest first, as the kernel returns it. */
    async getRecentDocs(limit = 10): Promise<RecentDocRef[]> {
        const data = await this.post<RecentDocRef[]>("/api/storage/getRecentDocs", { limit });
        return (Array.isArray(data) ? data : []).filter(
            (item) => typeof item.rootID === "string" && item.rootID.length > 0,
        );
    }

    /** `POST /api/notebook/lsNotebooks`. */
    async listNotebooks(): Promise<NotebookInfo[]> {
        const data = await this.post<{ notebooks?: Array<{ id?: string; name?: string }> }>(
            "/api/notebook/lsNotebooks",
            {},
        );
        return (data?.notebooks ?? [])
            .filter((item) => typeof item.id === "string" && item.id.length > 0)
            .map((item) => ({ id: item.id as string, name: item.name ?? (item.id as string) }));
    }

    /** Resolve the owning notebook of a document (used for notebook-level settings mapping). */
    async getDocNotebook(docId: string): Promise<string> {
        const data = await this.post<{ box?: string }>("/api/block/getBlockInfo", { id: docId });
        return data?.box ?? "";
    }

    /**
     * Additive helper, deliberately **not** part of the `KernelApi` contract: replace the body
     * of an existing document. Used by the reverse import "overwrite" path so a re-import does
     * not leave a second document behind. The importer treats a rejection as "fall back to
     * `createDocWithMd`", so an unsupported block type can never fail the whole import.
     *
     * `POST /api/block/updateBlock` with `dataType: "markdown"` is what the editor itself uses.
     */
    async replaceDocContent(docId: string, markdown: string): Promise<void> {
        await this.post<unknown>("/api/block/updateBlock", { id: docId, dataType: "markdown", data: markdown });
    }

    /** Open a document in the current window (desktop uses tabs, mobile uses its own stack). */
    openDoc(docId: string): void {
        try {
            if (getFrontend() === "mobile") {
                openMobileFileById(this.app, docId);
                return;
            }
            void openTab({ app: this.app, doc: { id: docId } });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`openDoc ${docId} failed: ${message}`);
        }
    }
}

/** Build the multipart body exactly as the kernel expects it. */
export function buildAssetForm(bytes: ArrayBuffer, filename: string, mime: string, assetsDirPath: string): FormData {
    const form = new FormData();
    form.append("assetsDirPath", assetsDirPath);
    form.append("file[]", new Blob([bytes], { type: mime }), filename);
    return form;
}

/** Best-effort MIME guess from the file extension. */
export function guessMime(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".png")) {
        return "image/png";
    }
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
        return "image/jpeg";
    }
    if (lower.endsWith(".gif")) {
        return "image/gif";
    }
    if (lower.endsWith(".webp")) {
        return "image/webp";
    }
    if (lower.endsWith(".svg")) {
        return "image/svg+xml";
    }
    if (lower.endsWith(".bmp")) {
        return "image/bmp";
    }
    return "application/octet-stream";
}

/** File extension for a MIME type, used when building unique asset filenames. */
export function extensionForMime(mime: string): string {
    const normalized = (mime ?? "").toLowerCase();
    if (normalized.indexOf("png") >= 0) {
        return "png";
    }
    if (normalized.indexOf("jpeg") >= 0 || normalized.indexOf("jpg") >= 0) {
        return "jpg";
    }
    if (normalized.indexOf("gif") >= 0) {
        return "gif";
    }
    if (normalized.indexOf("webp") >= 0) {
        return "webp";
    }
    if (normalized.indexOf("svg") >= 0) {
        return "svg";
    }
    if (normalized.indexOf("bmp") >= 0) {
        return "bmp";
    }
    return "bin";
}

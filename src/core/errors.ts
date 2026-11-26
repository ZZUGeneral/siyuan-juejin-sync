/**
 * Error model (§8.4).
 *
 * Two things must always coexist (D4):
 *  1. a **categorized** message that tells the user what to do next (`i18nKey` + `params`),
 *  2. the **raw** upstream facts (`err_no` / `err_msg` / HTTP status / endpoint / elapsed),
 *     preserved verbatim for the collapsible "technical details" block of the result panel.
 *
 * Errors are raised with an **i18n key plus interpolation values** instead of a localized
 * string, so this layer stays free of user-visible text and is unit testable offline.
 */
import { ErrorKind, type SyncIssue, type SyncIssueRaw } from "../types";

/**
 * Upstream `err_msg` literals observed in real Juejin responses (§8.4).
 *
 * These are **not** UI copy — they are the exact strings the server sends, and recognizing
 * them is the only way to classify the failure. They are written as unicode escapes so that
 * the D3 gate (no CJK literal anywhere under `src`) stays a hard, unqualified rule.
 */
const UPSTREAM_ROUTE_MISSING = "\u8def\u7531\u4e0d\u5b58\u5728"; // "route does not exist"
const UPSTREAM_PARAM_INVALID = "\u53c2\u6570\u9519\u8bef"; // "parameter error"
const UPSTREAM_NOT_FOUND = /\u5185\u5bb9\u4e3a\u7a7a|\u627e\u4e0d\u5230|\u5df2\u5220\u9664/; // empty / not found / deleted
const UPSTREAM_RISK = /\u9891\u7e41|\u98ce\u63a7|rate\s*limit|too\s+many/i; // frequent / risk control

/**
 * Upstream wording that means "this article is no longer an editable draft"
 * ("already published" / "not editable" / "cannot edit").
 *
 * FR-10② needs it because the plugin cannot poll the article state: we only learn that the
 * user published on the web when Juejin refuses to update the draft (PRD R6).
 */
const UPSTREAM_PUBLISHED_HINT = /\u5df2\u53d1\u5e03|\u4e0d\u53ef\u7f16\u8f91|\u65e0\u6cd5\u7f16\u8f91|already\s+published|not\s+editable|forbidden/i;

/** Does arbitrary upstream text suggest the article was published elsewhere? */
export function hasPublishedHintText(text: string): boolean {
    return text.length > 0 && UPSTREAM_PUBLISHED_HINT.test(text);
}

/** Same check against everything a {@link SyncError} preserved (D4 raw payload). */
export function isPublishedHint(error: SyncError): boolean {
    const params = error.params ?? {};
    const values = Object.keys(params).map((key) => String(params[key] ?? ""));
    return hasPublishedHintText([error.raw.errMsg ?? "", ...values].join(" "));
}

/** i18n key used for the default message of each {@link ErrorKind} (§8.4 table). */
export const ERROR_I18N_KEY: Record<ErrorKind, string> = {
    [ErrorKind.AUTH_EXPIRED]: "err.auth.expired",
    [ErrorKind.NEED_PHONE]: "err.needPhone",
    [ErrorKind.RISK_CONTROL]: "err.riskControl",
    [ErrorKind.API_CHANGED]: "err.apiChanged",
    [ErrorKind.PARAM_INVALID]: "err.paramInvalid",
    [ErrorKind.NOT_FOUND]: "err.notFound",
    [ErrorKind.NETWORK]: "err.network",
    [ErrorKind.KERNEL]: "err.kernel",
    [ErrorKind.UNKNOWN]: "err.unknown",
};

export interface SyncErrorOptions {
    /** Overrides {@link ERROR_I18N_KEY} when a more specific message exists. */
    i18nKey?: string;
    params?: Record<string, string>;
    raw?: SyncIssueRaw;
    cause?: unknown;
}

/** The single error type crossing layer boundaries. */
export class SyncError extends Error {
    readonly kind: ErrorKind;
    readonly i18nKey: string;
    readonly params: Record<string, string>;
    readonly raw: SyncIssueRaw;

    constructor(kind: ErrorKind, options: SyncErrorOptions = {}) {
        // `message` is developer facing only; user facing text is rendered from `i18nKey`.
        super(`[juejin-sync][${kind}] ${describeRaw(options.raw) || options.i18nKey || ""}`);
        this.name = "SyncError";
        this.kind = kind;
        this.i18nKey = options.i18nKey ?? ERROR_I18N_KEY[kind];
        this.raw = options.raw ?? {};
        this.params = { ...(options.params ?? {}) };
        // `err.paramInvalid` / `err.kernel` / `err.unknown` embed ${msg}; fill it from raw.
        if (this.params.msg === undefined && needsMsgParam(this.i18nKey)) {
            this.params.msg = this.raw.errMsg ?? describeRaw(this.raw) ?? this.i18nKey;
        }
        if (options.cause !== undefined) {
            (this as { cause?: unknown }).cause = options.cause;
        }
    }

    /** Convert into the transport-agnostic {@link SyncIssue} consumed by the UI. */
    toIssue(): SyncIssue {
        return {
            kind: this.kind,
            i18nKey: this.i18nKey,
            params: { ...this.params },
            raw: { ...this.raw },
        };
    }

    /** Attach call-site context (endpoint name, elapsed time) without losing the raw facts. */
    withContext(context: { endpoint?: string; elapsedMs?: number; httpStatus?: number }): SyncError {
        return new SyncError(this.kind, {
            i18nKey: this.i18nKey,
            params: this.params,
            raw: { ...this.raw, ...stripUndefined(context) },
        });
    }
}

function stripUndefined(input: { endpoint?: string; elapsedMs?: number; httpStatus?: number }): SyncIssueRaw {
    const out: SyncIssueRaw = {};
    if (input.endpoint !== undefined) {
        out.endpoint = input.endpoint;
    }
    if (input.elapsedMs !== undefined) {
        out.elapsedMs = input.elapsedMs;
    }
    if (input.httpStatus !== undefined) {
        out.httpStatus = input.httpStatus;
    }
    return out;
}

function needsMsgParam(i18nKey: string): boolean {
    return i18nKey === "err.paramInvalid" || i18nKey === "err.kernel" || i18nKey === "err.unknown";
}

/** Human readable digest of the raw facts, used only for `Error.message` (logs). */
function describeRaw(raw?: SyncIssueRaw): string {
    if (!raw) {
        return "";
    }
    const parts: string[] = [];
    if (raw.errNo !== undefined) {
        parts.push(`err_no=${raw.errNo}`);
    }
    if (raw.errMsg) {
        parts.push(`err_msg=${raw.errMsg}`);
    }
    if (raw.httpStatus !== undefined) {
        parts.push(`http=${raw.httpStatus}`);
    }
    if (raw.code !== undefined) {
        parts.push(`code=${raw.code}`);
    }
    if (raw.endpoint) {
        parts.push(`endpoint=${raw.endpoint}`);
    }
    return parts.join(" ");
}

/** Transport-level failure raised by `api/proxy.ts`. */
export class ProxyError extends Error {
    readonly reason: "transport" | "http";
    readonly status: number;
    /** Kernel `code` for transport failures (`code !== 0`), `0` for HTTP failures. */
    readonly code: number;
    readonly body: string;
    readonly url: string;

    constructor(options: {
        reason: "transport" | "http";
        status?: number;
        code?: number;
        body?: string;
        url: string;
    }) {
        super(`[juejin-sync][proxy] ${options.reason} ${options.status ?? options.code ?? ""} ${options.url}`);
        this.name = "ProxyError";
        this.reason = options.reason;
        this.status = options.status ?? 0;
        this.code = options.code ?? 0;
        this.body = options.body ?? "";
        this.url = options.url;
    }
}

/**
 * Map a Juejin business response to a classified error (§8.4).
 *
 * @param errNo `err_no` from the envelope (0 means success and must not reach here).
 * @param errMsg `err_msg` from the envelope, kept verbatim in `raw.errMsg`.
 * @param httpStatus Optional HTTP status (`data.status` from the proxy).
 */
export function mapJuejinErrNo(errNo: number, errMsg: string, httpStatus?: number): SyncError {
    const msg = errMsg ?? "";
    const raw: SyncIssueRaw = { errNo, errMsg: msg };
    if (httpStatus !== undefined) {
        raw.httpStatus = httpStatus;
    }

    if (errNo === 403 && /must\s+login/i.test(msg)) {
        return new SyncError(ErrorKind.AUTH_EXPIRED, { raw });
    }
    if (errNo === 403 && /bind\s+phone/i.test(msg)) {
        return new SyncError(ErrorKind.NEED_PHONE, { raw });
    }
    if (httpStatus === 401 || (httpStatus === 403 && /login|unauthor/i.test(msg))) {
        return new SyncError(ErrorKind.AUTH_EXPIRED, { raw });
    }
    if (errNo === 2 && msg.indexOf(UPSTREAM_ROUTE_MISSING) >= 0) {
        return new SyncError(ErrorKind.API_CHANGED, { raw });
    }
    if (errNo === 2 && msg.indexOf(UPSTREAM_PARAM_INVALID) >= 0) {
        return new SyncError(ErrorKind.PARAM_INVALID, { raw });
    }
    if (errNo === 404 || UPSTREAM_NOT_FOUND.test(msg)) {
        return new SyncError(ErrorKind.NOT_FOUND, { raw });
    }
    if (httpStatus === 429 || UPSTREAM_RISK.test(msg)) {
        return new SyncError(ErrorKind.RISK_CONTROL, { raw });
    }
    if (httpStatus !== undefined && httpStatus >= 500) {
        return new SyncError(ErrorKind.NETWORK, { raw });
    }
    return new SyncError(ErrorKind.UNKNOWN, { raw });
}

/** Map a proxy failure into the shared error model. */
export function mapProxyError(error: ProxyError): SyncError {
    if (error.reason === "transport") {
        const raw: SyncIssueRaw = { code: error.code, errMsg: error.body };
        // Kernel `code:10` = the response exceeds the 32 MiB proxy limit.
        if (error.code === 10) {
            return new SyncError(ErrorKind.NETWORK, { raw, i18nKey: "image.err.tooLarge" });
        }
        return new SyncError(ErrorKind.NETWORK, { raw });
    }
    // An HTTP error still carries a Juejin envelope most of the time — parse it first.
    const parsed = tryParseJson(error.body);
    if (parsed && typeof parsed.err_no === "number") {
        return mapJuejinErrNo(parsed.err_no, String(parsed.err_msg ?? ""), error.status);
    }
    if (error.status === 401 || error.status === 403) {
        return new SyncError(ErrorKind.AUTH_EXPIRED, { raw: { httpStatus: error.status, errMsg: error.body } });
    }
    if (error.status === 429) {
        return new SyncError(ErrorKind.RISK_CONTROL, { raw: { httpStatus: error.status, errMsg: error.body } });
    }
    return new SyncError(ErrorKind.NETWORK, { raw: { httpStatus: error.status, errMsg: error.body } });
}

/** Map a SiYuan kernel `/api/*` failure. */
export function mapKernelError(api: string, msg: string, code?: number): SyncError {
    const raw: SyncIssueRaw = { endpoint: api, errMsg: msg };
    if (code !== undefined) {
        raw.code = code;
    }
    return new SyncError(ErrorKind.KERNEL, { raw, i18nKey: "err.kernel", params: { msg: msg || api } });
}

/**
 * Build the error raised when the Juejin kernel-authentication fallback also fails (§1.6).
 *
 * The kernel's own message is passed through verbatim — we never invent copy for it.
 */
export function mapKernelAuthError(api: string, msg: string): SyncError {
    return new SyncError(ErrorKind.KERNEL, { raw: { endpoint: api, errMsg: msg }, params: { msg } });
}

/** Type guard usable in `catch` blocks. */
export function isSyncError(error: unknown): error is SyncError {
    return error instanceof SyncError;
}

/** Normalize any thrown value into a {@link SyncError}. */
export function toSyncError(error: unknown): SyncError {
    if (error instanceof SyncError) {
        return error;
    }
    if (error instanceof ProxyError) {
        return mapProxyError(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new SyncError(ErrorKind.UNKNOWN, { raw: { errMsg: message }, i18nKey: "err.unknown", params: { msg: message } });
}

function tryParseJson(body: string): Record<string, unknown> | null {
    if (!body) {
        return null;
    }
    try {
        const value: unknown = JSON.parse(body);
        return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/**
 * The single network exit of the plugin: a thin, opinionated wrapper around
 * `POST /api/network/forwardProxy`.
 *
 * Why this exists (architecture §1.2): the renderer **cannot** call `api.juejin.cn` itself.
 *  - `Cookie` is a forbidden header name for `fetch`, so the session could never be attached.
 *  - Juejin's WAF answers `403` to a cross-origin `Origin: http://127.0.0.1:6806`.
 *  - The response carries no `Access-Control-Allow-Origin`.
 *
 * Kernel contract quirks that this file hides from its callers:
 *  - `headers` must be an **array of single-key objects** (`[{k:v},{k:v}]`), not a map.
 *  - A 4xx/5xx response is **not** an HTTP error: the kernel returns `code:0` and the real
 *    status lives in `data.status`. We normalize both cases into {@link ProxyError}.
 *  - The kernel injects its own `req/v3` user agent, which some Juejin endpoints reject,
 *    so a browser UA is always sent explicitly.
 */
import { fetchSyncPost, type NetworkForwardRequestInput } from "siyuan";
import { ProxyError } from "../core/errors";
import type { Logger } from "../core/logger";
import { arrayBufferToBase64 } from "./juejinSign";

/** Browser UA used for every proxied request (kernel default is rejected by some endpoints). */
export const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Hard ceiling of the kernel proxy response (architecture §1.3). */
export const PROXY_MAX_BYTES = 32 * 1024 * 1024;

const FORWARD_PROXY_API = "/api/network/forwardProxy";

export type ResponseEncoding = "text" | "base64";

export interface ProxyRequest {
    url: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    /** Text payload (`payloadEncoding: "text"`). Mutually exclusive with {@link bytes}. */
    text?: string;
    /** Binary payload; converted to base64 at this boundary only. */
    bytes?: ArrayBuffer;
    contentType?: string;
    responseEncoding?: ResponseEncoding;
    timeoutMs?: number;
}

export interface ProxyResponse {
    status: number;
    /** Response body; base64 encoded when `responseEncoding === "base64"`. */
    body: string;
    headers: Record<string, string>;
    contentType: string;
    elapsedMs: number;
    encoding: ResponseEncoding;
}

export interface HttpProxyOptions {
    logger: Logger;
    /** Default per-request timeout in ms. */
    timeoutMs?: number;
    /** Minimum gap between two outgoing requests (FR-20, risk-control mitigation). */
    minIntervalMs?: number;
}

interface KernelProxyData {
    status?: number;
    body?: string;
    bodyEncoding?: string;
    contentType?: string;
    headers?: Record<string, string> | Array<Record<string, string>>;
    elapsed?: number;
}

/** `[{a:1},{b:2}]` form required by the kernel. */
function toHeaderArray(headers: Record<string, string>): Array<Record<string, string>> {
    return Object.keys(headers).map((key) => ({ [key]: headers[key] }));
}

function normalizeResponseHeaders(raw: KernelProxyData["headers"]): Record<string, string> {
    if (!raw) {
        return {};
    }
    if (Array.isArray(raw)) {
        return raw.reduce<Record<string, string>>((acc, item) => ({ ...acc, ...item }), {});
    }
    return { ...raw };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Normalized proxy client. Every outbound Juejin / image-host request goes through here.
 */
export class HttpProxy {
    private readonly logger: Logger;
    private timeoutMs: number;
    private minIntervalMs: number;
    private lastRequestAt = 0;

    constructor(options: HttpProxyOptions) {
        this.logger = options.logger;
        this.timeoutMs = options.timeoutMs ?? 30000;
        this.minIntervalMs = options.minIntervalMs ?? 0;
    }

    /** Update runtime knobs after the user edits the settings (no restart needed). */
    configure(options: { timeoutMs?: number; minIntervalMs?: number }): void {
        if (typeof options.timeoutMs === "number") {
            this.timeoutMs = options.timeoutMs;
        }
        if (typeof options.minIntervalMs === "number") {
            this.minIntervalMs = options.minIntervalMs;
        }
    }

    /** JSON POST with an optional body. */
    async postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<ProxyResponse> {
        const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
        return this.request({
            url,
            method: "POST",
            text,
            contentType: "application/json",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
        });
    }

    /** JSON GET (no body). */
    async getJson(url: string, headers?: Record<string, string>): Promise<ProxyResponse> {
        return this.request({ url, method: "GET", headers });
    }

    /** Binary POST (`payloadEncoding: "base64"`). */
    async postBinary(url: string, bytes: ArrayBuffer, headers?: Record<string, string>): Promise<ProxyResponse> {
        return this.request({
            url,
            method: "POST",
            bytes,
            contentType: "application/octet-stream",
            headers: { "Content-Type": "application/octet-stream", ...(headers ?? {}) },
        });
    }

    /** Binary GET (`responseEncoding: "base64"`). */
    async getBinary(url: string, headers?: Record<string, string>): Promise<ProxyResponse> {
        return this.request({ url, method: "GET", headers, responseEncoding: "base64" });
    }

    /**
     * Perform one proxied request.
     *
     * @throws {ProxyError} when the kernel call fails (`code !== 0`) or the upstream answers
     *         with `status >= 400`; the body is preserved so callers can parse `err_no`.
     */
    async request(req: ProxyRequest): Promise<ProxyResponse> {
        await this.waitForSlot();

        const headers: Record<string, string> = {
            "User-Agent": DEFAULT_USER_AGENT,
            Accept: "application/json, text/plain, */*",
            ...(req.headers ?? {}),
        };
        const encoding: ResponseEncoding = req.responseEncoding ?? "text";
        const payload: NetworkForwardRequestInput = {
            url: req.url,
            method: req.method ?? "GET",
            timeout: req.timeoutMs ?? this.timeoutMs,
            contentType: req.contentType ?? "application/json",
            headers: toHeaderArray(headers),
            redirect: true,
            responseEncoding: encoding,
        };
        if (req.bytes) {
            payload.payload = arrayBufferToBase64(req.bytes);
            payload.payloadEncoding = "base64";
        } else {
            // §8.7: always send a *string* with `payloadEncoding: "text"`; letting the kernel
            // serialize a JSON value would double-encode it.
            payload.payload = req.text ?? "";
            payload.payloadEncoding = "text";
        }

        const startedAt = Date.now();
        let response: { code?: number; msg?: string; data?: unknown };
        try {
            response = (await fetchSyncPost(FORWARD_PROXY_API, payload)) as { code?: number; msg?: string; data?: unknown };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`proxy transport threw ${redactUrl(req.url)} ${message}`);
            throw new ProxyError({ reason: "transport", url: req.url, code: -1, body: message });
        }

        if (!response || response.code !== 0) {
            throw new ProxyError({
                reason: "transport",
                url: req.url,
                code: response?.code ?? -1,
                body: response?.msg ?? "",
            });
        }

        const data = (response.data ?? {}) as KernelProxyData;
        const status = typeof data.status === "number" ? data.status : 0;
        const body = typeof data.body === "string" ? data.body : "";
        const result: ProxyResponse = {
            status,
            body,
            headers: normalizeResponseHeaders(data.headers),
            contentType: data.contentType ?? "",
            elapsedMs: typeof data.elapsed === "number" ? data.elapsed : Date.now() - startedAt,
            encoding,
        };

        // Log shape only — never the body (it may be a whole article).
        this.logger.info(`${req.method ?? "GET"} ${redactUrl(req.url)} → status=${status} elapsed=${result.elapsedMs}ms bytes=${body.length}`);

        if (status >= 400) {
            throw new ProxyError({ reason: "http", url: req.url, status, body });
        }
        return result;
    }

    /** Enforce the minimum gap between two requests (FR-20). */
    private async waitForSlot(): Promise<void> {
        if (this.minIntervalMs <= 0) {
            return;
        }
        const elapsed = Date.now() - this.lastRequestAt;
        const wait = this.minIntervalMs - elapsed;
        if (this.lastRequestAt > 0 && wait > 0) {
            await sleep(wait);
        }
        this.lastRequestAt = Date.now();
    }
}

/** Strip the query string from a URL for logging (it may contain signed tokens). */
export function redactUrl(url: string): string {
    const index = url.indexOf("?");
    const base = index >= 0 ? url.slice(0, index) : url;
    return base.replace(/^https?:\/\//, "");
}

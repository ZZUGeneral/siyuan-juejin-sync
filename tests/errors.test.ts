/**
 * Error-taxonomy tests (§8.4 / D4).
 *
 * This layer decides what the user actually reads, so a mis-classification is a product bug:
 * an expired cookie reported as "network unreachable" sends the user to check their Wi-Fi
 * instead of re-copying `sessionid_ss`.
 *
 * The proxy tests drive the real `HttpProxy` against the stubbed `fetchSyncPost`, which also
 * locks in the two kernel quirks documented in §1.3: `headers` must be an array of single-key
 * objects, and a 4xx is *not* an HTTP error (`code:0` + `data.status`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { fetchSyncPost } from "siyuan";
import { HttpProxy, DEFAULT_USER_AGENT } from "../src/api/proxy";
import {
    ERROR_I18N_KEY,
    ProxyError,
    SyncError,
    mapJuejinErrNo,
    mapKernelAuthError,
    mapKernelError,
    mapProxyError,
    toSyncError,
} from "../src/core/errors";
import { ErrorKind } from "../src/types";
import type { Logger } from "../src/core/logger";

/** Upstream literals, escaped so the D3 gate (no CJK in `src`) stays meaningful. */
const MUST_LOGIN = "must login";
const ROUTE_MISSING = "\u8def\u7531\u4e0d\u5b58\u5728";
const PARAM_INVALID = "\u53c2\u6570\u9519\u8bef";
const EMPTY_CONTENT = "\u5185\u5bb9\u4e3a\u7a7a";
const TOO_FREQUENT = "\u64cd\u4f5c\u8fc7\u4e8e\u9891\u7e41";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

const post = fetchSyncPost as unknown as Mock;

function kernelEnvelope(data: { status?: number; body?: string }): { code: number; data: unknown } {
    return {
        code: 0,
        data: {
            status: data.status ?? 200,
            body: data.body ?? "",
            contentType: "application/json",
            headers: [],
            elapsed: 5,
        },
    };
}

describe("mapJuejinErrNo · the user-facing classification table (§8.4)", () => {
    it("maps an expired cookie to AUTH_EXPIRED — never to NETWORK", () => {
        const issue = mapJuejinErrNo(403, MUST_LOGIN, 403);
        expect(issue.kind).toBe(ErrorKind.AUTH_EXPIRED);
        expect(issue.i18nKey).toBe("err.auth.expired");
        expect(issue.raw).toEqual({ errNo: 403, errMsg: MUST_LOGIN, httpStatus: 403 });
    });

    it("maps 'must bind phone' to NEED_PHONE", () => {
        expect(mapJuejinErrNo(403, "must bind phone", 403).kind).toBe(ErrorKind.NEED_PHONE);
    });

    it("maps 'route does not exist' to API_CHANGED", () => {
        const issue = mapJuejinErrNo(2, ROUTE_MISSING, 200);
        expect(issue.kind).toBe(ErrorKind.API_CHANGED);
        expect(issue.i18nKey).toBe("err.apiChanged");
    });

    it("maps 'parameter error' to PARAM_INVALID and interpolates the raw message", () => {
        const issue = mapJuejinErrNo(2, PARAM_INVALID, 200);
        expect(issue.kind).toBe(ErrorKind.PARAM_INVALID);
        expect(issue.params.msg).toBe(PARAM_INVALID);
    });

    it("maps 404 / 'content is empty' to NOT_FOUND", () => {
        expect(mapJuejinErrNo(404, "", 404).kind).toBe(ErrorKind.NOT_FOUND);
        expect(mapJuejinErrNo(0, EMPTY_CONTENT, 200).kind).toBe(ErrorKind.NOT_FOUND);
    });

    it("maps risk-control responses to RISK_CONTROL, not to UNKNOWN", () => {
        expect(mapJuejinErrNo(1, TOO_FREQUENT, 200).kind).toBe(ErrorKind.RISK_CONTROL);
        expect(mapJuejinErrNo(1, "too many requests", 429).kind).toBe(ErrorKind.RISK_CONTROL);
    });

    it("maps a 5xx upstream answer to NETWORK", () => {
        expect(mapJuejinErrNo(-1, "bad gateway", 502).kind).toBe(ErrorKind.NETWORK);
    });

    it("keeps the upstream text verbatim (D4: never rewritten, never dropped)", () => {
        const issue = mapJuejinErrNo(2, PARAM_INVALID, 200);
        expect(issue.raw.errMsg).toBe(PARAM_INVALID);
        expect(issue.toIssue().raw.errMsg).toBe(PARAM_INVALID);
        // The primary copy must not be the raw server text, and vice versa.
        expect(issue.i18nKey).not.toBe(PARAM_INVALID);
    });

    it("has an i18n key for every ErrorKind", () => {
        Object.values(ErrorKind).forEach((kind) => {
            expect(ERROR_I18N_KEY[kind as ErrorKind]).toBeTruthy();
        });
    });
});

describe("mapProxyError · transport vs HTTP", () => {
    it("maps a kernel code!=0 (transport) failure to NETWORK", () => {
        const issue = mapProxyError(new ProxyError({ reason: "transport", url: "https://api.juejin.cn/x", code: 1, body: "boom" }));
        expect(issue.kind).toBe(ErrorKind.NETWORK);
        expect(issue.i18nKey).toBe("err.network");
        expect(issue.raw.code).toBe(1);
        expect(issue.raw.errMsg).toBe("boom");
    });

    it("maps the 32 MiB proxy ceiling (code 10) to NETWORK with the image-specific copy", () => {
        const issue = mapProxyError(new ProxyError({ reason: "transport", url: "https://api.juejin.cn/x", code: 10 }));
        expect(issue.kind).toBe(ErrorKind.NETWORK);
        expect(issue.i18nKey).toBe("image.err.tooLarge");
    });

    it("maps a bare HTTP 403 to AUTH_EXPIRED", () => {
        const issue = mapProxyError(new ProxyError({ reason: "http", url: "https://api.juejin.cn/x", status: 403, body: "<html>Forbidden</html>" }));
        expect(issue.kind).toBe(ErrorKind.AUTH_EXPIRED);
        expect(issue.raw.httpStatus).toBe(403);
    });

    it("prefers the Juejin envelope when a 4xx still carries one", () => {
        const issue = mapProxyError(
            new ProxyError({ reason: "http", url: "https://x", status: 403, body: JSON.stringify({ err_no: 403, err_msg: MUST_LOGIN }) }),
        );
        expect(issue.kind).toBe(ErrorKind.AUTH_EXPIRED);
        expect(issue.raw.errNo).toBe(403);
        expect(issue.raw.httpStatus).toBe(403);
    });

    it("maps an HTTP 429 to RISK_CONTROL and a 5xx to NETWORK", () => {
        expect(mapProxyError(new ProxyError({ reason: "http", url: "https://x", status: 429 })).kind).toBe(ErrorKind.RISK_CONTROL);
        expect(mapProxyError(new ProxyError({ reason: "http", url: "https://x", status: 503 })).kind).toBe(ErrorKind.NETWORK);
    });
});

describe("kernel errors", () => {
    it("passes the kernel message through instead of inventing copy", () => {
        const issue = mapKernelError("/api/export/exportMdContent", "block not found", 0);
        expect(issue.kind).toBe(ErrorKind.KERNEL);
        expect(issue.params.msg).toBe("block not found");
        expect(issue.raw.endpoint).toBe("/api/export/exportMdContent");
        expect(issue.raw.code).toBe(0);
    });

    it("keeps the local-access-check message verbatim", () => {
        const message = "\u8ba4\u8bc1\u5931\u8d25: origin";
        const issue = mapKernelAuthError("/api/attr/getBlockAttrs", message);
        expect(issue.kind).toBe(ErrorKind.KERNEL);
        expect(issue.raw.errMsg).toBe(message);
        expect(issue.params.msg).toBe(message);
    });
});

describe("toSyncError · normalization used in every catch block", () => {
    it("returns SyncError instances untouched", () => {
        const original = new SyncError(ErrorKind.AUTH_EXPIRED, { raw: { errNo: 403 } });
        expect(toSyncError(original)).toBe(original);
    });

    it("normalizes a ProxyError into the shared model", () => {
        expect(toSyncError(new ProxyError({ reason: "transport", url: "u", code: 3 })).kind).toBe(ErrorKind.NETWORK);
    });

    it("normalizes a plain Error into UNKNOWN while keeping the message", () => {
        const issue = toSyncError(new Error("unexpected"));
        expect(issue.kind).toBe(ErrorKind.UNKNOWN);
        expect(issue.raw.errMsg).toBe("unexpected");
        expect(issue.params.msg).toBe("unexpected");
    });

    it("normalizes a thrown string", () => {
        expect(toSyncError("nope").raw.errMsg).toBe("nope");
    });

    it("withContext adds endpoint/elapsed/http without losing the raw facts", () => {
        const issue = mapJuejinErrNo(403, MUST_LOGIN, 403).withContext({
            endpoint: "content_api/v1/article_draft/create",
            elapsedMs: 812,
        });
        expect(issue.kind).toBe(ErrorKind.AUTH_EXPIRED);
        expect(issue.raw.errMsg).toBe(MUST_LOGIN);
        expect(issue.raw.endpoint).toBe("content_api/v1/article_draft/create");
        expect(issue.raw.elapsedMs).toBe(812);
        expect(issue.raw.httpStatus).toBe(403);
    });
});

describe("HttpProxy · kernel contract quirks (§1.3)", () => {
    beforeEach(() => {
        post.mockReset();
    });

    it("sends headers as an array of single-key objects and a text payload", async () => {
        post.mockResolvedValueOnce(kernelEnvelope({ status: 200, body: '{"err_no":0}' }));
        const proxy = new HttpProxy({ logger: silentLogger });

        await proxy.postJson("https://api.juejin.cn/x", { a: 1 }, { Cookie: "sessionid_ss=secret" });

        const payload = post.mock.calls[0][1] as {
            headers: Array<Record<string, string>>;
            payload: string;
            payloadEncoding: string;
            contentType: string;
        };
        expect(Array.isArray(payload.headers)).toBe(true);
        payload.headers.forEach((header) => expect(Object.keys(header)).toHaveLength(1));
        expect(payload.payload).toBe('{"a":1}');
        expect(payload.payloadEncoding).toBe("text");
        expect(payload.contentType).toBe("application/json");
        const merged = payload.headers.reduce<Record<string, string>>((acc, item) => ({ ...acc, ...item }), {});
        expect(merged["User-Agent"]).toBe(DEFAULT_USER_AGENT);
        expect(merged.Cookie).toBe("sessionid_ss=secret");
    });

    it("turns a kernel code!=0 into a transport ProxyError (which maps to NETWORK)", async () => {
        post.mockResolvedValueOnce({ code: 1, msg: "connect timeout" });
        const proxy = new HttpProxy({ logger: silentLogger });

        const error = await proxy.getJson("https://api.juejin.cn/x").catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(ProxyError);
        expect(error).toMatchObject({ reason: "transport", code: 1, body: "connect timeout" });
        expect(mapProxyError(error as ProxyError).kind).toBe(ErrorKind.NETWORK);
    });

    it("does not treat a 4xx as an HTTP error before reading data.status", async () => {
        post.mockResolvedValueOnce(kernelEnvelope({ status: 403, body: "Forbidden" }));
        const proxy = new HttpProxy({ logger: silentLogger });

        const error = await proxy.getJson("https://api.juejin.cn/x").catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(ProxyError);
        expect((error as ProxyError).reason).toBe("http");
        expect(mapProxyError(error as ProxyError).kind).toBe(ErrorKind.AUTH_EXPIRED);
    });

    it("returns the parsed status/body on success", async () => {
        post.mockResolvedValueOnce(kernelEnvelope({ status: 200, body: '{"err_no":0,"data":{"id":"1"}}' }));
        const proxy = new HttpProxy({ logger: silentLogger });

        const response = await proxy.postJson("https://api.juejin.cn/x", {});

        expect(response.status).toBe(200);
        expect(response.body).toContain('"err_no":0');
    });

    it("asks for base64 when downloading a binary resource", async () => {
        post.mockResolvedValueOnce(kernelEnvelope({ status: 200, body: "AAAA" }));
        const proxy = new HttpProxy({ logger: silentLogger });

        await proxy.getBinary("https://cdn.example/a.png");

        const payload = post.mock.calls[0][1] as { responseEncoding: string };
        expect(payload.responseEncoding).toBe("base64");
    });

    it("encodes binary bodies as base64 with the octet-stream content type", async () => {
        post.mockResolvedValueOnce(kernelEnvelope({ status: 200, body: "" }));
        const proxy = new HttpProxy({ logger: silentLogger });

        await proxy.postBinary("https://upload.example/x", new Uint8Array([1, 2, 3]).buffer);

        const payload = post.mock.calls[0][1] as { payload: string; payloadEncoding: string; contentType: string };
        expect(payload.payloadEncoding).toBe("base64");
        expect(payload.payload).toBe("AQID");
        expect(payload.contentType).toBe("application/octet-stream");
    });

    it("strips the query string from log lines so signed URLs do not leak", async () => {
        post.mockResolvedValueOnce(kernelEnvelope({ status: 200, body: "" }));
        const logger = { ...silentLogger, info: vi.fn() };
        const proxy = new HttpProxy({ logger });

        await proxy.getJson("https://imagex.example/?Action=X&SessionKey=secret-token");

        const logged = String(logger.info.mock.calls[0][0]);
        expect(logged).not.toContain("secret-token");
        expect(logged).toContain("imagex.example");
    });
});

/**
 * Round-2 regression: the Content-CRC32 self-healing path must be **observed**, not inferred.
 *
 * `knownDeviations.test.ts` pins the two byte orders and the classifier in isolation. That is
 * necessary but not sufficient: it cannot tell whether `uploadImage()` actually *uses* the
 * little-endian spelling as a retry, whether the retry happens exactly once, or whether a
 * non-checksum failure is excluded from the retry. Those are the three questions the round-2
 * review asked, so they are answered here by driving the real {@link JuejinClient} through a
 * fake proxy and counting the binary PUTs.
 *
 * Nothing here re-implements the production logic: the assertions are all on observable
 * effects (how many PUTs, with which `Content-CRC32`, and what the pipeline reports).
 */
import { describe, expect, it } from "vitest";
import { JuejinClient } from "../src/api/juejin";
import { crc32Hex, crc32HexLittleEndian } from "../src/api/juejinSign";
import { ImagePipeline } from "../src/core/images";
import { ProxyError, SyncError } from "../src/core/errors";
import type { Logger } from "../src/core/logger";
import type { ImageRef, JuejinApi, KernelApi } from "../src/types";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

/** "123456789" — the canonical CRC32 check vector (`cbf43926`). */
const BINARY = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]).buffer;
const BIG_ENDIAN = crc32Hex(new Uint8Array(BINARY));
const LITTLE_ENDIAN = crc32HexLittleEndian(new Uint8Array(BINARY));

/** The rejection the TOS host sends when `Content-CRC32` uses the wrong byte order. */
function checksumRejection(): ProxyError {
    return new ProxyError({
        reason: "http",
        status: 400,
        body: '{"code":4007,"message":"MismatchChecksum"}',
        url: "https://tos-d-x-hl.snssdk.com/tos-cn-i/abc.png",
    });
}

function envelope(body: unknown): {
    status: number;
    body: string;
    headers: Record<string, string>;
    contentType: string;
    elapsedMs: number;
    encoding: "text";
} {
    return {
        status: 200,
        body: JSON.stringify(body),
        headers: {},
        contentType: "application/json",
        elapsedMs: 1,
        encoding: "text",
    };
}

interface FakeProxy {
    /** Replays one outcome per `postBinary` call; `undefined` means "success". */
    putOutcomes: Array<unknown>;
}

/**
 * Build a proxy that answers the five ImageX steps and records every binary PUT.
 *
 * `putOutcomes` is consumed in order so a test can script "reject, then accept" or
 * "reject forever". The latter is longer than any legitimate retry count, which is how an
 * unbounded retry loop would show up as an extra recorded PUT instead of a hang.
 */
function fakeProxy(options: FakeProxy) {
    const putCalls: Array<{ url: string; checksum: string }> = [];

    const proxy = {
        getJson: async (url: string) => {
            if (url.includes("gen_token")) {
                return envelope({
                    err_no: 0,
                    err_msg: "",
                    data: { token: { AccessKeyId: "ak", SecretAccessKey: "sk", SessionToken: "st" } },
                });
            }
            if (url.includes("ApplyImageUpload")) {
                return envelope({
                    Result: {
                        UploadAddress: {
                            StoreInfos: [{ StoreUri: "tos-cn-i/abc.png", Auth: "store-auth" }],
                            SessionKey: "session-key",
                        },
                    },
                });
            }
            if (url.includes("CommitImageUpload")) {
                return envelope({ Result: { Results: [{ UriStatus: 2000 }] } });
            }
            if (url.includes("get_img_url")) {
                return envelope({ err_no: 0, err_msg: "", data: { main_url: "https://cdn.example.com/a.png" } });
            }
            throw new Error(`unexpected GET ${url}`);
        },
        postJson: async () => {
            throw new Error("postJson is not part of the image chain");
        },
        postBinary: async (url: string, _bytes: ArrayBuffer, headers?: Record<string, string>) => {
            putCalls.push({ url, checksum: headers?.["Content-CRC32"] ?? "" });
            const outcome = options.putOutcomes.shift();
            if (outcome !== undefined) {
                throw outcome;
            }
            return envelope({});
        },
    };

    return { proxy, putCalls };
}

/** A client wired to the fake proxy; the credential comes from the in-memory override. */
function client(proxy: unknown): JuejinClient {
    const instance = new JuejinClient({
        getCredential: async () => null,
        proxy: proxy as never,
        logger: silentLogger,
        uuid: () => "1000000000000000001",
    });
    instance.setCredentialOverride("session");
    return instance;
}

describe("P1-1 · Content-CRC32 self-healing, observed end to end", () => {
    it("uploads big-endian first and retries the same image once with little-endian", async () => {
        const { proxy, putCalls } = fakeProxy({ putOutcomes: [checksumRejection()] });

        const cdnUrl = await client(proxy).uploadImage(BINARY, "image/png", "a.png");

        expect(cdnUrl).toBe("https://cdn.example.com/a.png");
        expect(putCalls).toHaveLength(2);
        expect(putCalls[0].checksum).toBe(BIG_ENDIAN);
        expect(putCalls[1].checksum).toBe(LITTLE_ENDIAN);
        // Same object, same destination: this is a retry, not a second upload attempt elsewhere.
        expect(putCalls[1].url).toBe(putCalls[0].url);
    });

    it("does not retry a failure that is not a checksum rejection", async () => {
        const serverError = new ProxyError({ reason: "http", status: 500, body: "boom", url: "https://tos/uri" });
        const { proxy, putCalls } = fakeProxy({ putOutcomes: [serverError, serverError] });

        await expect(client(proxy).uploadImage(BINARY, "image/png", "a.png")).rejects.toBeInstanceOf(SyncError);

        expect(putCalls).toHaveLength(1);
        expect(putCalls[0].checksum).toBe(BIG_ENDIAN);
    });

    it("gives up after the single retry instead of looping", async () => {
        // Four rejections queued: a third PUT would be recorded and fail this assertion.
        const { proxy, putCalls } = fakeProxy({
            putOutcomes: [checksumRejection(), checksumRejection(), checksumRejection(), checksumRejection()],
        });

        await expect(client(proxy).uploadImage(BINARY, "image/png", "a.png")).rejects.toBeInstanceOf(SyncError);

        expect(putCalls).toHaveLength(2);
        expect(putCalls.map((call) => call.checksum)).toEqual([BIG_ENDIAN, LITTLE_ENDIAN]);
    });

    it("reports a permanent rejection as a failed image and keeps the original reference", async () => {
        const { proxy, putCalls } = fakeProxy({
            putOutcomes: [checksumRejection(), checksumRejection(), checksumRejection()],
        });
        const api = client(proxy);
        const kernel = {
            fetchAssetBinary: async () => ({ bytes: BINARY, mime: "image/png" }),
        };
        const pipeline = new ImagePipeline({
            api: api as unknown as JuejinApi,
            kernel: kernel as unknown as KernelApi,
            logger: silentLogger,
            uploadEnabled: true,
            intervalMs: 0,
        });

        const body = "para\n\n![shot](assets/shot.png)\n";
        const refs: ImageRef[] = [{ kind: "local", ref: "assets/shot.png", assetPath: "assets/shot.png" }];
        const result = await pipeline.process(body, refs);

        // FR-08④: failure is a value, never a thrown exception, and the token stays in the body.
        expect(result.failed).toHaveLength(1);
        expect(result.uploaded).toBe(0);
        expect(result.markdown).toBe(body);
        expect(result.failed[0].reason).toBeTruthy();
        expect(putCalls).toHaveLength(2);
    });
});

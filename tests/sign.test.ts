/**
 * Known-vector tests for the hand written crypto helpers (§1.4).
 *
 * Everything asserted here comes from a published standard:
 *  - SHA-256: FIPS 180-4 / RFC 6234 examples,
 *  - HMAC-SHA256: RFC 4231 test cases 1 & 2,
 *  - CRC32: the ubiquitous `123456789` check value.
 *
 * The SigV4 section is deliberately **structural**, not a golden string: ByteDance's ImageX
 * variant has no published test vector, so pinning an arbitrary output would only prove that
 * the code still does what it did yesterday. The live behaviour is covered by the
 * `imagex.gen_token` probe in `JuejinApi.probeEndpoints()` instead (see docs §9-Q2).
 */
import { describe, expect, it } from "vitest";
import {
    amzDateStamp,
    base64ToBytes,
    bytesToBase64,
    bytesToHex,
    buildSigV4,
    canonicalQueryString,
    crc32Hex,
    crc32Ieee,
    decodeSessionKeyHost,
    hexToBytes,
    hmacSha256Hex,
    sha256Hex,
    utf8Bytes,
} from "../src/api/juejinSign";

describe("sha256", () => {
    it("matches the empty-string digest", () => {
        expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("matches the abc digest", () => {
        expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("handles the padding boundary (56 byte message)", () => {
        // FIPS 180-4 sample #2: exercises the case where the length field no longer fits.
        const message = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        expect(utf8Bytes(message).length).toBe(56);
        expect(sha256Hex(message)).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    });

    it("hashes multi-byte UTF-8 correctly", () => {
        // The digest of the 3-byte character U+4E2D is stable; also proves utf8 encoding.
        expect(sha256Hex("\u4e2d")).toBe(sha256Hex(utf8Bytes("\u4e2d")));
        expect(utf8Bytes("\u4e2d").length).toBe(3);
    });

    it("is length extensible: 3 blocks of 64 bytes", () => {
        const digest = sha256Hex("a".repeat(192));
        expect(digest).toHaveLength(64);
        expect(digest).toBe(sha256Hex("a".repeat(192)));
        expect(digest).not.toBe(sha256Hex("a".repeat(191)));
    });
});

describe("hmacSha256", () => {
    it("matches RFC 4231 test case 1", () => {
        const key = hexToBytes("0b".repeat(20));
        expect(hmacSha256Hex(key, "Hi There")).toBe(
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        );
    });

    it("matches RFC 4231 test case 2 (string key)", () => {
        expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        );
    });

    it("hashes keys longer than the block size", () => {
        // RFC 4231 test case 6.
        const key = hexToBytes("aa".repeat(131));
        expect(hmacSha256Hex(key, "Test Using Larger Than Block-Size Key - Hash Key First")).toBe(
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        );
    });
});

describe("crc32", () => {
    it("matches the standard check value", () => {
        expect(crc32Ieee(utf8Bytes("123456789"))).toBe(0xcbf43926);
        expect(crc32Hex(utf8Bytes("123456789"))).toBe("cbf43926");
    });

    it("is 8 lowercase hex characters with zero padding", () => {
        expect(crc32Hex(new Uint8Array([0]))).toHaveLength(8);
        expect(crc32Hex(new Uint8Array([0]))).toMatch(/^[0-9a-f]{8}$/);
    });

    it("returns 0 for an empty buffer", () => {
        expect(crc32Ieee(new Uint8Array(0))).toBe(0);
    });
});

describe("base64", () => {
    it("round trips arbitrary bytes", () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
        expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    });

    it("encodes the empty buffer", () => {
        expect(bytesToBase64(new Uint8Array(0))).toBe("");
    });

    it("handles byte lengths not divisible by three", () => {
        for (const length of [1, 2, 4, 5, 7]) {
            const bytes = new Uint8Array(length).map((_value, index) => (index * 37) % 256);
            expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
        }
    });
});

describe("sigv4", () => {
    const options = {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret-example-key",
        sessionToken: "sts-token-value",
        host: "imagex.bytedanceapi.com",
        path: "/",
        method: "GET" as const,
        query: { ServiceId: "73owjymdk6", Action: "ApplyImageUpload", Version: "2018-08-01" },
        region: "cn-north-1",
        service: "imagex",
        date: new Date(Date.UTC(2026, 10, 25, 13, 34, 56)),
    };

    it("sorts query parameters for the canonical request", () => {
        expect(canonicalQueryString(options.query)).toBe(
            "Action=ApplyImageUpload&ServiceId=73owjymdk6&Version=2018-08-01",
        );
    });

    it("formats the amz date in UTC", () => {
        expect(amzDateStamp(options.date)).toBe("20261125T133456Z");
    });

    it("builds a canonical request with the documented signed headers", () => {
        const headers = buildSigV4(options);
        const lines = headers.canonicalRequest.split("\n");
        expect(lines[0]).toBe("GET");
        expect(lines[1]).toBe("/");
        expect(lines[2]).toBe("Action=ApplyImageUpload&ServiceId=73owjymdk6&Version=2018-08-01");
        expect(lines[3]).toBe("x-amz-date:20261125T133456Z");
        expect(lines[4]).toBe("x-amz-security-token:sts-token-value");
        // The canonical headers block ends with a newline, which AWS renders as a blank line
        // between the header block and the signed-header list (see the AWS SigV4 examples).
        expect(lines[5]).toBe("");
        expect(lines[6]).toBe("x-amz-date;x-amz-security-token");
        // payload hash of an empty body
        expect(lines[7]).toBe(sha256Hex(""));
        expect(lines).toHaveLength(8);
    });

    it("builds a well formed authorization header with the imagex scope", () => {
        const headers = buildSigV4(options);
        expect(headers["x-amz-date"]).toBe("20261125T133456Z");
        expect(headers["x-amz-security-token"]).toBe("sts-token-value");
        expect(headers.authorization).toContain("HMAC-SHA256 Credential=AKIDEXAMPLE/20261125/cn-north-1/imagex/aws4_request");
        expect(headers.authorization).toContain("SignedHeaders=x-amz-date;x-amz-security-token");
        expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
        expect(headers.signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic and sensitive to every input", () => {
        const first = buildSigV4(options);
        const second = buildSigV4(options);
        expect(first.signature).toBe(second.signature);

        expect(buildSigV4({ ...options, sessionToken: "other-token" }).signature).not.toBe(first.signature);
        expect(buildSigV4({ ...options, secretAccessKey: "other-secret" }).signature).not.toBe(first.signature);
        expect(buildSigV4({ ...options, query: { ...options.query, ServiceId: "other" } }).signature).not.toBe(
            first.signature,
        );
        expect(
            buildSigV4({ ...options, date: new Date(Date.UTC(2026, 10, 25, 13, 34, 57)) }).signature,
        ).not.toBe(first.signature);
    });

    it("signs the string-to-sign with the aws4_request scope", () => {
        const headers = buildSigV4(options);
        const lines = headers.stringToSign.split("\n");
        expect(lines[0]).toBe("HMAC-SHA256");
        expect(lines[1]).toBe("20261125T133456Z");
        expect(lines[2]).toBe("20261125/cn-north-1/imagex/aws4_request");
        expect(lines[3]).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("decodeSessionKeyHost", () => {
    const encode = (value: unknown): string => bytesToBase64(utf8Bytes(JSON.stringify(value)));

    it("reads the documented uploadHost key", () => {
        expect(decodeSessionKeyHost(encode({ uploadHost: "tos.example.com" }), "fallback")).toBe("tos.example.com");
    });

    it("reads alternate key names", () => {
        expect(decodeSessionKeyHost(encode({ UploadHost: "a.example.com" }), "fallback")).toBe("a.example.com");
        expect(decodeSessionKeyHost(encode({ UploadHosts: ["b.example.com"] }), "fallback")).toBe("b.example.com");
    });

    it("falls back when the payload cannot be decoded", () => {
        expect(decodeSessionKeyHost("", "fallback")).toBe("fallback");
        expect(decodeSessionKeyHost("not-base64-json", "fallback")).toBe("fallback");
        expect(decodeSessionKeyHost(encode({ nothing: true }), "fallback")).toBe("fallback");
    });
});

describe("hex helpers", () => {
    it("round trips", () => {
        const bytes = new Uint8Array([0, 15, 16, 255]);
        expect(bytesToHex(bytes)).toBe("000f10ff");
        expect(Array.from(hexToBytes("000f10ff"))).toEqual(Array.from(bytes));
        expect(Array.from(hexToBytes("0x000f10ff"))).toEqual(Array.from(bytes));
    });
});

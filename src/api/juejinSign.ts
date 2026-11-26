/**
 * Pure-TypeScript crypto helpers: SHA-256, HMAC-SHA256, IEEE CRC32, AWS SigV4.
 *
 * Why not `crypto.subtle`? WebCrypto requires a *secure context*. The desktop SiYuan
 * window is served from `http://127.0.0.1` (a trusted origin), but mobile WebViews and the
 * browser frontend may not be — and one unavailable call breaks the whole image pipeline.
 * A ~250 line pure implementation has zero environment assumptions and can be pinned by
 * unit tests with fixed vectors (architecture §1.4).
 *
 * Everything here is side-effect free and therefore fully covered by `tests/sign.test.ts`
 * without a network or a SiYuan kernel.
 */

/* ------------------------------------------------------------------ *
 * SHA-256
 * ------------------------------------------------------------------ */

/** Round constants: first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
    return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

/** UTF-8 encode without depending on `TextEncoder` availability differences. */
export function utf8Bytes(input: string): Uint8Array {
    if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(input);
    }
    // Manual fallback (very old WebViews). Handles BMP + surrogate pairs.
    const out: number[] = [];
    for (let i = 0; i < input.length; i += 1) {
        let code = input.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
            const next = input.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                i += 1;
            }
        }
        if (code < 0x80) {
            out.push(code);
        } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            out.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
        }
    }
    return new Uint8Array(out);
}

/**
 * SHA-256 digest of raw bytes.
 *
 * @param data Input bytes.
 * @returns 32-byte digest.
 */
export function sha256Bytes(data: Uint8Array): Uint8Array {
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;

    const length = data.length;
    // message + 0x80 + zero padding + 8-byte big-endian bit length, multiple of 64.
    const paddedLength = (((length + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(data);
    buffer[length] = 0x80;

    const view = new DataView(buffer.buffer);
    const bitLengthHi = Math.floor((length * 8) / 0x100000000);
    const bitLengthLo = (length * 8) >>> 0;
    view.setUint32(paddedLength - 8, bitLengthHi);
    view.setUint32(paddedLength - 4, bitLengthLo);

    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let i = 0; i < 16; i += 1) {
            w[i] = view.getUint32(offset + i * 4);
        }
        for (let i = 16; i < 64; i += 1) {
            const w15 = w[i - 15];
            const w2 = w[i - 2];
            const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
            const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;

        for (let i = 0; i < 64; i += 1) {
            const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const temp2 = (s0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    const digest = new Uint8Array(32);
    const digestView = new DataView(digest.buffer);
    const words = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 8; i += 1) {
        digestView.setUint32(i * 4, words[i]);
    }
    return digest;
}

/**
 * SHA-256 lowercase hex digest of a string (UTF-8) or raw bytes.
 *
 * @param input Text or bytes.
 */
export function sha256Hex(input: string | Uint8Array): string {
    const bytes = typeof input === "string" ? utf8Bytes(input) : input;
    return bytesToHex(sha256Bytes(bytes));
}

/* ------------------------------------------------------------------ *
 * HMAC-SHA256
 * ------------------------------------------------------------------ */

/**
 * HMAC-SHA256.
 *
 * @param key Secret key (string is UTF-8 encoded).
 * @param message Message bytes or string.
 * @returns 32-byte MAC.
 */
export function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Uint8Array {
    const keyBytes = typeof key === "string" ? utf8Bytes(key) : key;
    const msgBytes = typeof message === "string" ? utf8Bytes(message) : message;

    const blockSize = 64;
    let normalized = keyBytes;
    if (normalized.length > blockSize) {
        normalized = sha256Bytes(normalized);
    }
    const padded = new Uint8Array(blockSize);
    padded.set(normalized);

    const inner = new Uint8Array(blockSize + msgBytes.length);
    const outer = new Uint8Array(blockSize + 32);
    for (let i = 0; i < blockSize; i += 1) {
        inner[i] = padded[i] ^ 0x36;
        outer[i] = padded[i] ^ 0x5c;
    }
    inner.set(msgBytes, blockSize);
    outer.set(sha256Bytes(inner), blockSize);
    return sha256Bytes(outer);
}

/**
 * HMAC-SHA256 lowercase hex.
 *
 * @param key Secret key.
 * @param message Message.
 */
export function hmacSha256Hex(key: string | Uint8Array, message: string | Uint8Array): string {
    return bytesToHex(hmacSha256(key, message));
}

/* ------------------------------------------------------------------ *
 * CRC32 (IEEE 802.3, polynomial 0xEDB88320)
 * ------------------------------------------------------------------ */

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
    if (crcTable) {
        return crcTable;
    }
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
        }
        table[i] = value >>> 0;
    }
    crcTable = table;
    return table;
}

/**
 * IEEE CRC32 of raw bytes.
 *
 * @param bytes Input bytes.
 * @returns Unsigned 32-bit checksum (`crc32Ieee(utf8Bytes("123456789")) === 0xCBF43926`).
 */
export function crc32Ieee(bytes: Uint8Array): number {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * `Content-CRC32` header value: 8 lowercase hex characters of the unsigned checksum.
 *
 * Note: ByteDance's image host documents the header "in radix-16 representation", which is
 * what `toString(16)` yields. If the service ever answers `4007 MismatchChecksum`, the
 * fallback is {@link crc32HexLittleEndian} (byte-swapped) — see architecture U2.
 *
 * @param bytes Image bytes.
 */
export function crc32Hex(bytes: Uint8Array): string {
    return crc32Ieee(bytes).toString(16).padStart(8, "0");
}

/**
 * Byte-swapped variant of {@link crc32Hex}, kept as the documented fallback for U2.
 *
 * @param bytes Image bytes.
 */
export function crc32HexLittleEndian(bytes: Uint8Array): string {
    const value = crc32Ieee(bytes);
    const swapped = (((value & 0xff) << 24) | (((value >>> 8) & 0xff) << 16) | (((value >>> 16) & 0xff) << 8) | ((value >>> 24) & 0xff)) >>> 0;
    return swapped.toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ *
 * Hex / Base64 helpers
 * ------------------------------------------------------------------ */

/**
 * Lowercase hex encoding.
 *
 * @param bytes Input bytes.
 */
export function bytesToHex(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
        out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
}

/**
 * Hex decoding (odd-length input is left padded with `0`).
 *
 * @param hex Hex string, with or without `0x` prefix.
 */
export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
    const padded = clean.length % 2 === 0 ? clean : `0${clean}`;
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 encode raw bytes (works without `btoa`; output has no line breaks).
 *
 * @param bytes Input bytes.
 */
export function bytesToBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64_ALPHABET[b0 >> 2];
        out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
        out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : "=";
    }
    return out;
}

/**
 * Base64 decode into raw bytes. Accepts padding-less input and URL-safe alphabet.
 *
 * @param base64 Base64 string.
 */
export function base64ToBytes(base64: string): Uint8Array {
    const clean = base64.replace(/[^A-Za-z0-9+/=-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const withoutPadding = clean.replace(/=+$/, "");
    const out = new Uint8Array(Math.floor((withoutPadding.length * 3) / 4));
    let outIndex = 0;
    for (let i = 0; i < withoutPadding.length; i += 4) {
        const c0 = B64_ALPHABET.indexOf(withoutPadding[i]);
        const c1 = B64_ALPHABET.indexOf(withoutPadding[i + 1] ?? "A");
        const c2 = B64_ALPHABET.indexOf(withoutPadding[i + 2] ?? "A");
        const c3 = B64_ALPHABET.indexOf(withoutPadding[i + 3] ?? "A");
        const chunk = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
        if (outIndex < out.length) {
            out[outIndex] = (chunk >> 16) & 0xff;
            outIndex += 1;
        }
        if (outIndex < out.length) {
            out[outIndex] = (chunk >> 8) & 0xff;
            outIndex += 1;
        }
        if (outIndex < out.length) {
            out[outIndex] = chunk & 0xff;
            outIndex += 1;
        }
    }
    return out;
}

/**
 * Base64 encode an `ArrayBuffer` (proxy boundary helper).
 *
 * @param buffer Binary payload.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    return bytesToBase64(new Uint8Array(buffer));
}

/**
 * Base64 decode into an `ArrayBuffer` (proxy boundary helper).
 *
 * @param base64 Base64 payload.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const bytes = base64ToBytes(base64);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
}

/* ------------------------------------------------------------------ *
 * AWS SigV4
 * ------------------------------------------------------------------ */

export interface SigV4Options {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    /** `imagex.bytedanceapi.com` */
    host: string;
    /** Usually `/`. */
    path: string;
    method: "GET" | "POST";
    /** Query parameters, already decoded; they are re-encoded for canonicalisation. */
    query: Record<string, string>;
    region: string;
    service: string;
    /** Signing time; defaults to `new Date()`. */
    date?: Date;
}

export interface SigV4Headers {
    authorization: string;
    "x-amz-date": string;
    "x-amz-security-token": string;
    /** Exposed for debugging / further signing steps. */
    signedHeaders: string;
    canonicalRequest: string;
    stringToSign: string;
    signature: string;
}

/**
 * `YYYYMMDDTHHMMSSZ` in UTC.
 *
 * @param date Signing time.
 */
export function amzDateStamp(date: Date): string {
    const pad = (value: number): string => value.toString().padStart(2, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(
        date.getUTCHours(),
    )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** RFC 3986 encoding (SigV4 requires `%20` rather than `+`). */
function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonical query string: sorted by key, then `k=v` joined by `&`. */
export function canonicalQueryString(query: Record<string, string>): string {
    return Object.keys(query)
        .sort()
        .map((key) => `${uriEncode(key)}=${uriEncode(query[key] ?? "")}`)
        .join("&");
}

/**
 * Build SigV4 headers for the ImageX API.
 *
 * Only `x-amz-date` and `x-amz-security-token` are signed (architecture §1.4).
 *
 * @param options Signing inputs.
 */
export function buildSigV4(options: SigV4Options): SigV4Headers {
    const date = options.date ?? new Date();
    const amzDate = amzDateStamp(date);
    const dayStamp = amzDate.slice(0, 8);
    const scope = `${dayStamp}/${options.region}/${options.service}/aws4_request`;
    const signedHeaders = "x-amz-date;x-amz-security-token";
    const canonicalHeaders = `x-amz-date:${amzDate}\nx-amz-security-token:${options.sessionToken}\n`;
    const payloadHash = sha256Hex("");

    const canonicalRequest = [
        options.method,
        options.path || "/",
        canonicalQueryString(options.query),
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const stringToSign = ["HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

    const kDate = hmacSha256(`AWS4${options.secretAccessKey}`, dayStamp);
    const kRegion = hmacSha256(kDate, options.region);
    const kService = hmacSha256(kRegion, options.service);
    const kSigning = hmacSha256(kService, "aws4_request");
    const signature = hmacSha256Hex(kSigning, stringToSign);

    const authorization =
        `HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
        authorization,
        "x-amz-date": amzDate,
        "x-amz-security-token": options.sessionToken,
        signedHeaders,
        canonicalRequest,
        stringToSign,
        signature,
    };
}

/**
 * Extract the upload host from an ImageX `SessionKey`.
 *
 * The value is base64 of a small JSON document; different service versions use different
 * key names, so several are probed before falling back to the documented default.
 *
 * @param sessionKey `UploadAddress.SessionKey`
 * @param fallback Host used when the payload cannot be decoded.
 */
export function decodeSessionKeyHost(sessionKey: string, fallback: string): string {
    if (!sessionKey) {
        return fallback;
    }
    try {
        const json = new TextDecoder().decode(base64ToBytes(sessionKey));
        const parsed: unknown = JSON.parse(json);
        if (parsed && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            const direct = record.uploadHost ?? record.UploadHost ?? record.upload_host ?? record.host;
            if (typeof direct === "string" && direct.length > 0) {
                return direct;
            }
            const hosts = record.UploadHosts ?? record.uploadHosts ?? record.upload_hosts;
            if (Array.isArray(hosts) && hosts.length > 0 && typeof hosts[0] === "string") {
                return hosts[0];
            }
        }
    } catch {
        // Fall through to the documented default.
    }
    return fallback;
}

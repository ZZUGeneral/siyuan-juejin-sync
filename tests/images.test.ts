/**
 * S4 — `ImagePipeline` tests (D1 / D2 / FR-08).
 *
 * This stage is where "silent success" is most damaging: a user who believes the pictures
 * were transferred will publish a broken article. Every failure mode therefore has to be
 * *countable* (`failed[]`), and no failure mode may throw.
 *
 * No network: the Juejin adapter and kernel are replaced by fakes.
 */
import { describe, expect, it, vi } from "vitest";
import { ImagePipeline, UPLOAD_INTERVAL_MS } from "../src/core/images";
import { collectImageRefs } from "../src/core/markdown";
import type { JuejinApi, ImageRef, KernelApi } from "../src/types";
import type { Logger } from "../src/core/logger";

const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

function makePipeline(options: {
    uploadEnabled?: boolean;
    uploadImage?: (bytes: ArrayBuffer, mime: string, name: string) => Promise<string>;
    fetchAssetBinary?: (path: string) => Promise<{ bytes: ArrayBuffer; mime: string } | null>;
} = {}): { pipeline: ImagePipeline; api: { uploadImage: ReturnType<typeof vi.fn> }; kernel: KernelApi } {
    const uploadImage = vi.fn(
        options.uploadImage ?? (async () => "https://cdn.example/uploaded.png"),
    );
    const fetchAssetBinary = vi.fn(
        options.fetchAssetBinary ?? (async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer, mime: "image/png" })),
    );
    const api = { uploadImage };
    const kernel = { fetchAssetBinary } as unknown as KernelApi;
    const pipeline = new ImagePipeline({
        api: api as unknown as JuejinApi,
        kernel,
        logger: silentLogger,
        uploadEnabled: options.uploadEnabled ?? true,
        intervalMs: 0,
    });
    return { pipeline, api, kernel };
}

const LOCAL_REFS: ImageRef[] = [
    { kind: "local", ref: "assets/a.png", assetPath: "assets/a.png" },
    { kind: "local", ref: "assets/b.png", assetPath: "assets/b.png" },
];

describe("preflight · D2, warning only", () => {
    it("resolves and reports reachable assets", async () => {
        const { pipeline } = makePipeline();
        const report = await pipeline.preflight(LOCAL_REFS);

        expect(report.total).toBe(2);
        expect(report.reachable).toBe(2);
        expect(report.warnings).toEqual([]);
    });

    it("collects warnings when assets are missing instead of throwing", async () => {
        const { pipeline } = makePipeline({ fetchAssetBinary: async () => null });
        const report = await pipeline.preflight(LOCAL_REFS);

        expect(report.reachable).toBe(0);
        expect(report.warnings).toContain("preflight.incomplete");
        expect(report.warnings).toContain("preflight.miss:assets/a.png");
    });

    it("swallows a kernel exception and degrades to a warning", async () => {
        const { pipeline } = makePipeline({
            fetchAssetBinary: async () => {
                throw new Error("io error");
            },
        });

        await expect(pipeline.preflight(LOCAL_REFS)).resolves.toMatchObject({ reachable: 0 });
        const report = await pipeline.preflight(LOCAL_REFS);
        expect(report.warnings.some((warning) => warning.startsWith("preflight.error:"))).toBe(true);
    });

    it("does not count a remote image as a preflight failure", async () => {
        const { pipeline } = makePipeline();
        const report = await pipeline.preflight([{ kind: "remote", ref: "https://x/y.png", sourceUrl: "https://x/y.png" }]);

        expect(report.total).toBe(1);
        expect(report.reachable).toBe(1);
        expect(report.warnings).toEqual([]);
    });

    it("handles an empty reference list", async () => {
        const { pipeline } = makePipeline();
        await expect(pipeline.preflight([])).resolves.toEqual({ total: 0, reachable: 0, warnings: [] });
    });
});

describe("process · local images", () => {
    it("replaces only the URL token and keeps the markdown syntax", async () => {
        const { pipeline } = makePipeline();
        const body = "before\n\n![alt text](assets/a.png)\n\nafter\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(output.uploaded).toBe(1);
        expect(output.failed).toEqual([]);
        expect(output.markdown).toBe("before\n\n![alt text](https://cdn.example/uploaded.png)\n\nafter\n");
    });

    it("keeps the original reference when the upload rejects (FR-08 ④)", async () => {
        const { pipeline } = makePipeline({
            uploadImage: async () => {
                throw new Error("imagex down");
            },
        });
        const body = "![a](assets/a.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(output.uploaded).toBe(0);
        expect(output.failed).toHaveLength(1);
        expect(output.failed[0].ok).toBe(false);
        expect(typeof output.failed[0].reason).toBe("string");
        expect(output.markdown).toContain("assets/a.png");
        expect(output.markdown).not.toContain("cdn.example");
    });

    it("reports a missing asset without throwing", async () => {
        const { pipeline } = makePipeline({ fetchAssetBinary: async () => null });
        const body = "![a](assets/missing.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(output.failed[0].reason).toBe("image.err.missingAsset");
        expect(output.markdown).toContain("assets/missing.png");
    });

    it("reports an empty asset as a failure", async () => {
        const { pipeline } = makePipeline({
            fetchAssetBinary: async () => ({ bytes: new ArrayBuffer(0), mime: "image/png" }),
        });
        const body = "![a](assets/empty.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(output.failed[0].reason).toBe("image.err.empty");
    });

    it("keeps the rest of the pictures when a single one fails", async () => {
        const uploadImage = vi.fn(async (_bytes: ArrayBuffer, _mime: string, name: string) => {
            if (name === "b.png") {
                throw new Error("only b fails");
            }
            return "https://cdn.example/a.png";
        });
        const { pipeline } = makePipeline({ uploadImage });
        const body = "![a](assets/a.png)\n\n![b](assets/b.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(output.uploaded).toBe(1);
        expect(output.failed).toHaveLength(1);
        expect(output.failed[0].assetPath).toBe("assets/b.png");
        expect(output.markdown).toContain("https://cdn.example/a.png");
        expect(output.markdown).toContain("assets/b.png");
    });

    it("uploads a shared reference only once", async () => {
        const { pipeline, api } = makePipeline();
        const body = "![a](assets/a.png)\n\n![a again](assets/a.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(api.uploadImage).toHaveBeenCalledTimes(1);
        expect(output.markdown).not.toContain("assets/a.png");
    });
});

describe("process · D1, uploads disabled is a loud failure", () => {
    it("never calls the upload API and reports every local image", async () => {
        const { pipeline, api } = makePipeline({ uploadEnabled: false });
        const body = "![a](assets/a.png)\n\n![b](assets/b.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(api.uploadImage).not.toHaveBeenCalled();
        expect(output.uploaded).toBe(0);
        expect(output.failed).toHaveLength(2);
        expect(output.failed.every((item) => item.reason === "image.skip.disabled")).toBe(true);
        expect(output.markdown).toContain("assets/a.png");
        expect(output.markdown).toContain("assets/b.png");
    });

    it("still reports remote images so the user sees the full picture", async () => {
        const { pipeline } = makePipeline({ uploadEnabled: false });
        const body = "![r](https://cdn.other/x.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        // Remote references are deliberately *not* local-transfer failures: they are recorded
        // in `results` (and surfaced through the `remote-image` degradation + warning), while
        // `failed` stays reserved for images we were supposed to relocate.
        expect(output.results[0].reason).toBe("image.skip.remote");
        expect(output.warnings).toContain("sync.warn.remoteImage");
    });
});

describe("process · remote and data URIs", () => {
    it("leaves remote images untouched in P0 and warns about hotlinking", async () => {
        const { pipeline, api } = makePipeline();
        const body = "![r](https://cdn.other/x.png)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(api.uploadImage).not.toHaveBeenCalled();
        expect(output.markdown).toContain("https://cdn.other/x.png");
        expect(output.warnings).toContain("sync.warn.remoteImage");
        expect(output.results[0].reason).toBe("image.skip.remote");
    });

    it("uploads a data URI inline", async () => {
        const { pipeline, api } = makePipeline();
        const body = "![d](data:image/png;base64,AQID)\n";

        const output = await pipeline.process(body, collectImageRefs(body));

        expect(api.uploadImage).toHaveBeenCalledTimes(1);
        expect(output.uploaded).toBe(1);
        expect(output.markdown).not.toContain("data:image/png");
    });

    it("reports a malformed data URI instead of throwing", async () => {
        const { pipeline } = makePipeline();
        const refs: ImageRef[] = [{ kind: "data", ref: "data:image/png;base64," }];

        const output = await pipeline.process("![d](data:image/png;base64,)", refs);

        expect(output.failed[0].reason).toBe("image.err.empty");
    });
});

describe("process · progress and pacing", () => {
    it("reports progress for every reference", async () => {
        const onProgress = vi.fn();
        const { pipeline } = makePipeline();
        pipeline.configure({ onProgress });
        const body = "![a](assets/a.png)\n\n![b](assets/b.png)\n";

        await pipeline.process(body, collectImageRefs(body));

        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenLastCalledWith(2, 2);
    });

    it("exposes a 300 ms default gap between uploads (FR-20)", () => {
        expect(UPLOAD_INTERVAL_MS).toBe(300);
    });
});

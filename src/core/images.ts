/**
 * S4 — image relocation, the only step of the pipeline with network side effects.
 *
 * Contract highlights (all of them are hard constraints from §0.1 / §5.2.1):
 *  - **D1**: this stage runs *unconditionally* in `syncEngine`. `uploadEnabled === false` does
 *    not skip anything: every local reference is still reported as failed
 *    (`reason: "image.skip.disabled"`) and the result becomes `partial`. Silent success when
 *    images were never uploaded is forbidden.
 *  - **D2**: {@link ImagePipeline.preflight} always resolves. A missing or unreadable asset is
 *    a warning plus one failed entry, never an abort. There is no `return`/`throw` branch that
 *    depends on the pre-flight outcome.
 *  - A failed upload never throws: it returns `ok: false` with an i18n `reason`, the original
 *    reference stays in the body, and the entry is listed in `failed[]` (rendered at the top of
 *    the result panel, A3).
 */
import { sha256Hex } from "../api/juejinSign";
import type { JuejinApi, ImageProcessResult, ImageRef, ImageUploadResult, KernelApi, PreflightReport } from "../types";
import { toSyncError } from "./errors";
import type { Logger } from "./logger";

/** Gap between two uploads; part of the risk-control mitigation (FR-20). */
export const UPLOAD_INTERVAL_MS = 300;

export interface ImagePipelineOptions {
    api: JuejinApi;
    kernel: KernelApi;
    logger: Logger;
    /**
     * D1: `false` means "do not upload", **not** "skip the stage". Every local reference is
     * still reported as a failure so the user can never publish while believing images work.
     */
    uploadEnabled: boolean;
    intervalMs?: number;
    onProgress?: (done: number, total: number) => void;
}

function delay(ms: number): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function basename(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] || "image";
}

/** `data:image/png;base64,AAA…` → bytes + mime, or `null` when malformed. */
function decodeDataUri(uri: string): { bytes: ArrayBuffer; mime: string } | null {
    const match = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(uri);
    if (!match) {
        return null;
    }
    const mime = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    try {
        const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
            bytes[i] = raw.charCodeAt(i);
        }
        return { bytes: bytes.buffer, mime };
    } catch {
        return null;
    }
}

/** Image relocation stage. */
export class ImagePipeline {
    private readonly options: ImagePipelineOptions;

    constructor(options: ImagePipelineOptions) {
        this.options = { ...options, intervalMs: options.intervalMs ?? UPLOAD_INTERVAL_MS };
    }

    /** Swap the settings-driven flags without rebuilding the pipeline. */
    configure(patch: { uploadEnabled?: boolean; intervalMs?: number; onProgress?: (done: number, total: number) => void }): void {
        if (patch.uploadEnabled !== undefined) {
            this.options.uploadEnabled = patch.uploadEnabled;
        }
        if (patch.intervalMs !== undefined) {
            this.options.intervalMs = patch.intervalMs;
        }
        if (patch.onProgress !== undefined) {
            this.options.onProgress = patch.onProgress;
        }
    }

    /**
     * Best-effort reachability probe (D2).
     *
     * Always resolves; findings only become warnings. The caller keeps going regardless of
     * `reachable` — see the forbidden list in §5.2.1.
     */
    async preflight(refs: ImageRef[]): Promise<PreflightReport> {
        const report: PreflightReport = { total: refs.length, reachable: 0, warnings: [] };
        try {
            for (const ref of refs) {
                if (ref.kind !== "local" || !ref.assetPath) {
                    // A remote/data reference cannot "miss" locally; do not report it as incomplete.
                    report.reachable += 1;
                    continue;
                }
                try {
                    const binary = await this.options.kernel.fetchAssetBinary(ref.assetPath);
                    if (binary) {
                        report.reachable += 1;
                    } else {
                        report.warnings.push(`preflight.miss:${ref.assetPath}`);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    report.warnings.push(`preflight.error:${ref.assetPath}:${message}`);
                }
            }
        } catch (error) {
            // Even an unexpected failure only degrades to a warning.
            const message = error instanceof Error ? error.message : String(error);
            report.warnings.push(`preflight.fatal:${message}`);
        }
        if (report.reachable < report.total) {
            report.warnings.push("preflight.incomplete");
        }
        return report;
    }

    /**
     * Upload every local image and rewrite the body in place.
     *
     * Only the URL token is replaced (`split(target).join(cdnUrl)`) so the surrounding
     * `![alt](…)` syntax is never damaged.
     */
    async process(markdown: string, refs: ImageRef[]): Promise<ImageProcessResult> {
        const results: ImageUploadResult[] = [];
        const failed: ImageUploadResult[] = [];
        const warnings: string[] = [];
        const replacements = new Map<string, string>();
        const done = new Set<string>();
        let uploaded = 0;
        let attempts = 0;

        for (const ref of refs) {
            if (done.has(ref.ref)) {
                continue;
            }
            done.add(ref.ref);

            if (ref.kind === "remote") {
                // P0 keeps remote images untouched; hotlink protection is surfaced as a warning.
                results.push({
                    kind: ref.kind,
                    ref: ref.ref,
                    sourceUrl: ref.sourceUrl,
                    ok: false,
                    reason: "image.skip.remote",
                });
                if (!warnings.includes("sync.warn.remoteImage")) {
                    warnings.push("sync.warn.remoteImage");
                }
                continue;
            }

            if (attempts > 0 && this.options.uploadEnabled) {
                await delay(this.options.intervalMs ?? UPLOAD_INTERVAL_MS);
            }
            attempts += 1;

            const result = await this.relocate(ref);
            results.push(result);
            if (result.ok && result.cdnUrl) {
                uploaded += 1;
                replacements.set(ref.ref, result.cdnUrl);
            } else {
                failed.push(result);
            }
            this.options.onProgress?.(uploaded + failed.length, refs.length);
        }

        let output = markdown;
        replacements.forEach((cdnUrl, token) => {
            output = output.split(token).join(cdnUrl);
        });

        return {
            markdown: output,
            total: refs.length,
            uploaded,
            failed,
            results,
            warnings,
        };
    }

    /** Relocate a single reference. Never throws; failures are values. */
    private async relocate(ref: ImageRef): Promise<ImageUploadResult> {
        const startedAt = Date.now();
        const base: ImageUploadResult = {
            kind: ref.kind,
            ref: ref.ref,
            assetPath: ref.assetPath,
            sourceUrl: ref.sourceUrl,
            ok: false,
        };

        if (!this.options.uploadEnabled) {
            // D1: explicit, countable failure — never a silent pass.
            return { ...base, reason: "image.skip.disabled", elapsedMs: 0 };
        }

        try {
            if (ref.kind === "data") {
                const decoded = decodeDataUri(ref.ref);
                if (!decoded || decoded.bytes.byteLength === 0) {
                    return { ...base, reason: "image.err.empty", elapsedMs: Date.now() - startedAt };
                }
                const hash = sha256Hex(new Uint8Array(decoded.bytes)).slice(0, 8);
                const cdnUrl = await this.options.api.uploadImage(decoded.bytes, decoded.mime, `inline-${hash}.png`);
                return { ...base, ok: true, cdnUrl, elapsedMs: Date.now() - startedAt };
            }

            if (!ref.assetPath) {
                return { ...base, reason: "image.err.missingAsset", elapsedMs: Date.now() - startedAt };
            }
            const binary = await this.options.kernel.fetchAssetBinary(ref.assetPath);
            if (!binary) {
                this.options.logger.warn(`image missing: ${ref.assetPath}`);
                return { ...base, reason: "image.err.missingAsset", elapsedMs: Date.now() - startedAt };
            }
            if (binary.bytes.byteLength === 0) {
                return { ...base, reason: "image.err.empty", elapsedMs: Date.now() - startedAt };
            }
            const cdnUrl = await this.options.api.uploadImage(binary.bytes, binary.mime, basename(ref.assetPath));
            return { ...base, ok: true, cdnUrl, elapsedMs: Date.now() - startedAt };
        } catch (error) {
            const issue = toSyncError(error);
            this.options.logger.warn(`image upload failed for ${ref.ref}: ${issue.message}`);
            return {
                ...base,
                reason: issue.i18nKey,
                reasonParams: { ...issue.params },
                elapsedMs: Date.now() - startedAt,
            };
        }
    }
}

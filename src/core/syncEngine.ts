/**
 * Forward sync orchestration: the state machine of PRD §7.3 and the flow of §4.1.
 *
 * Full sequence: **S0–S5 → M1 → submit** (§5.2.0).
 *  - S0–S3 / S5 live in `core/markdown.ts` (`sanitize`),
 *  - S4 lives in `core/images.ts` and is called **unconditionally** (D1),
 *  - M1 (title / excerpt / category / tags → `DraftInput`) is assembled here.
 *
 * Two rules that are easy to break and therefore spelled out:
 *  - **D1** the image stage always runs. `autoUploadImages === false` produces failures, never a
 *    silent pass.
 *  - **D2** the pre-flight result is only ever turned into warnings. There is no early return
 *    between the pre-flight and the draft submission.
 */
import type { JuejinApi, DraftInput, DocBinding, KernelApi, SyncAction, SyncPreview, SyncResult, SyncStatus } from "../types";
import { ErrorKind } from "../types";
import { draftUrl } from "../api/juejin";
import { countChars, buildBrief, fitBrief } from "./brief";
import { BindingService } from "./binding";
import { toSyncError, isPublishedHint, SyncError } from "./errors";
import { ImagePipeline } from "./images";
import type { Logger } from "./logger";
import { extractTitle, sanitize, UNSUPPORTED_PLACEHOLDER_KEY } from "./markdown";
import type { SettingsService } from "./settings";
import type { SyncStore } from "./store";
import type { SyncSettings } from "../types";

export interface SyncOverrides {
    title?: string;
    brief?: string;
    categoryId?: string;
    tagIds?: string[];
    /** Set only after the second confirmation of `publishMode === "publish"` (FR-13). */
    confirmedPublish?: boolean;
}

export interface SyncEngineOptions {
    kernel: KernelApi;
    api: JuejinApi;
    settings: SettingsService;
    binding: BindingService;
    pipeline: ImagePipeline;
    store: SyncStore;
    logger: Logger;
    /** i18n resolver — the engine never renders text itself. */
    translate: (key: string, params?: Record<string, string | number>) => string;
    /** Progress callback: receives an i18n key plus optional counters. */
    onProgress?: (stage: string, done: number, total: number) => void;
}

interface LastRun {
    docId: string;
    /** Markdown that was actually submitted (images already replaced). */
    markdown: string;
    /** Locally failed references, so a retry re-uploads only those. */
    failedRefs: Array<{ ref: string; assetPath?: string }>;
    meta: DraftInput;
    draftId: string;
}

export class SyncEngine {
    private readonly deps: SyncEngineOptions;
    private lastRun: LastRun | null = null;

    constructor(options: SyncEngineOptions) {
        this.deps = options;
    }

    /* ---------------- preview ---------------- */

    /**
     * Build the read-only view shown by the confirmation dialog (M1 input).
     *
     * No upload happens here; the image count is the number of distinct references found.
     */
    async preview(docId: string): Promise<SyncPreview> {
        const settings = await this.deps.settings.load();
        const doc = await this.deps.kernel.exportMdContent(docId);
        const binding = await this.deps.binding.read(docId);
        const clean = sanitize(doc.content, { placeholder: this.placeholder });
        const notebook = await this.notebookOf(docId);
        const meta = await this.resolveMeta(settings, binding, notebook, {});
        const title = this.composeTitle(settings, extractTitle(clean.markdown) || this.titleFromPath(doc.hPath));

        return {
            docId,
            notebook,
            title,
            brief: buildBrief(clean.markdown, { fallback: this.deps.translate("sync.brief.fallback") }),
            categoryId: meta.categoryId,
            tagIds: meta.tagIds,
            action: binding.draftId ? "updated" : "created",
            status: binding.status ?? "unsynced",
            publishMode: settings.publishMode,
            binding,
            imageTotal: clean.imageRefs.length,
            contentLength: countChars(clean.markdown),
            degradations: clean.degradations,
            warnings: clean.warnings,
        };
    }

    /* ---------------- sync ---------------- */

    /** Execute one sync. Never throws; every failure becomes a {@link SyncResult}. */
    async sync(docId: string, overrides: SyncOverrides = {}): Promise<SyncResult> {
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        const state = this.deps.store.getState();
        if (state.busy) {
            return this.blockedResult(
                docId,
                startedAt,
                startedMs,
                new SyncError(ErrorKind.UNKNOWN, { i18nKey: "sync.blocked.busy" }),
            );
        }

        this.deps.store.patch({ busy: true, docId, status: "syncing", banner: null, progress: null });
        try {
            const result = await this.run(docId, overrides, startedAt, startedMs);
            this.applyResult(result);
            return result;
        } catch (error) {
            const issue = toSyncError(error);
            const result = this.blockedResult(docId, startedAt, startedMs, issue);
            await this.rememberFailure(docId, issue);
            this.applyResult(result);
            return result;
        } finally {
            this.deps.store.patch({ busy: false, progress: null });
        }
    }

    private async run(
        docId: string,
        overrides: SyncOverrides,
        startedAt: string,
        startedMs: number,
    ): Promise<SyncResult> {
        const settings = await this.deps.settings.load();

        // ---- read (FR-04)
        this.progress("sync.progress.reading", 0, 0);
        const doc = await this.deps.kernel.exportMdContent(docId);
        if (!doc.content.trim()) {
            throw new SyncError(ErrorKind.UNKNOWN, { i18nKey: "sync.blocked.empty" });
        }

        // ---- S0-S3 + S5
        this.progress("sync.progress.sanitizing", 0, 0);
        const clean = sanitize(doc.content, { placeholder: this.placeholder });
        const binding = await this.deps.binding.read(docId);

        // ---- repeat-sync guard (FR-10)
        if (binding.status === "published") {
            throw new SyncError(ErrorKind.UNKNOWN, { i18nKey: "sync.blocked.published" });
        }

        // ---- meta validation *before* wasting uploads (config check, not content review)
        const notebook = await this.notebookOf(docId);
        const warnings: string[] = [...clean.warnings];
        const meta = await this.resolveMeta(settings, binding, notebook, overrides, warnings);
        if (!meta.categoryId) {
            throw new SyncError(ErrorKind.UNKNOWN, { i18nKey: "sync.blocked.noCategory" });
        }
        if (meta.tagIds.length === 0) {
            throw new SyncError(ErrorKind.UNKNOWN, { i18nKey: "sync.blocked.noTag" });
        }

        // ---- D2: pre-flight is informational only and cannot abort the run
        this.progress("sync.progress.images", 0, clean.imageRefs.length);
        const preflight = await this.deps.pipeline.preflight(clean.imageRefs);
        if (preflight.warnings.length > 0) {
            warnings.push("sync.warn.precheckFailed");
            this.deps.logger.warn(`image preflight incomplete: ${preflight.warnings.join(", ")}`);
        }

        // ---- D1: S4 always runs, whatever `autoUploadImages` says
        const images = await this.deps.pipeline.process(clean.markdown, clean.imageRefs);
        images.warnings.forEach((warning) => {
            if (!warnings.includes(warning)) {
                warnings.push(warning);
            }
        });
        if (images.failed.some((item) => item.reason === "image.skip.disabled") && !warnings.includes("sync.blocked.noImage")) {
            warnings.push("sync.blocked.noImage");
        }

        // ---- M1: assemble the legal payload (the only place a length rule exists)
        const title = this.composeTitle(
            settings,
            overrides.title?.trim() || extractTitle(images.markdown) || this.titleFromPath(doc.hPath),
        );
        const fallback = this.deps.translate("sync.brief.fallback");
        const brief = fitBrief(overrides.brief ?? buildBrief(images.markdown, { fallback }), { fallback });
        const input: DraftInput = {
            title,
            briefContent: brief,
            categoryId: meta.categoryId,
            tagIds: meta.tagIds,
            markdown: images.markdown,
            coverImage: "",
        };

        // ---- submit
        this.progress("sync.progress.submitting", 0, 0);
        const existingDraftId = binding.draftId ?? "";
        let draftId = existingDraftId;
        let articleId = binding.articleId ?? "";
        let action: SyncAction = existingDraftId ? "updated" : "created";

        if (settings.publishMode === "publish" && !overrides.confirmedPublish) {
            // Default-safe: publishing is never implied by a setting alone (FR-13).
            throw new SyncError(ErrorKind.UNKNOWN, { i18nKey: "sync.publish.confirmTitle" });
        }

        if (existingDraftId) {
            try {
                const updated = await this.deps.api.updateDraft(existingDraftId, input);
                draftId = updated.draftId;
            } catch (error) {
                const issue = toSyncError(error);
                if (!isPublishedHint(issue)) {
                    throw issue;
                }
                // FR-10② / PRD R6: the local status said "draft" but Juejin refuses to edit it,
                // which is what happens once the user publishes on the web. We cannot verify the
                // article state without another round trip, so record "unknown" and tell the user
                // to check the website instead of retrying an operation that can never succeed.
                this.deps.logger.warn(`draft ${existingDraftId} rejected as not editable, marking status unknown`);
                await this.deps.binding.write(docId, {
                    status: "unknown",
                    lastError: this.deps.translate(issue.i18nKey, issue.params),
                });
                if (!warnings.includes("sync.hint.maybePublished")) {
                    warnings.push("sync.hint.maybePublished");
                }
                return {
                    ok: false,
                    partial: false,
                    docId,
                    action: "blocked",
                    status: "unknown",
                    title,
                    draftId: existingDraftId,
                    juejinUrl: draftUrl(existingDraftId),
                    imageTotal: images.total,
                    imageUploaded: images.uploaded,
                    imageFailed: images.failed,
                    degradations: clean.degradations,
                    warnings,
                    brief,
                    error: issue.toIssue(),
                    startedAt,
                    elapsedMs: Date.now() - startedMs,
                };
            }
        } else {
            const created = await this.deps.api.createDraft(input);
            draftId = created.draftId;
            action = "created";
        }

        if (settings.publishMode === "publish") {
            const published = await this.deps.api.publishDraft(draftId, input);
            articleId = published.articleId;
        }

        const status: SyncStatus = settings.publishMode === "publish" ? "published" : "draft";

        // ---- write back (FR-09)
        this.progress("sync.progress.writing", 0, 0);
        await this.deps.binding.write(docId, {
            draftId,
            articleId: articleId || undefined,
            syncTime: new Date().toISOString(),
            status,
            contentHash: clean.contentHash,
            categoryId: meta.categoryId,
            tagIds: meta.tagIds,
            brief,
            lastError: "",
        });

        this.lastRun = {
            docId,
            markdown: images.markdown,
            failedRefs: images.failed.map((item) => ({ ref: item.ref, assetPath: item.assetPath })),
            meta: input,
            draftId,
        };

        const juejinUrl = articleId ? `https://juejin.cn/post/${articleId}` : draftId ? draftUrl(draftId) : "";

        return {
            ok: true,
            partial: images.failed.length > 0 || clean.degradations.length > 0,
            docId,
            action,
            status,
            title,
            articleId: articleId || undefined,
            draftId,
            juejinUrl,
            imageTotal: images.total,
            imageUploaded: images.uploaded,
            imageFailed: images.failed,
            degradations: clean.degradations,
            warnings,
            brief,
            startedAt,
            elapsedMs: Date.now() - startedMs,
        };
    }

    /* ---------------- retry ---------------- */

    /**
     * Re-upload only the images that failed in the previous run and update the same draft.
     *
     * Falls back to a full sync when there is nothing to retry (e.g. after a restart).
     */
    async retryFailedImages(docId: string): Promise<SyncResult> {
        const last = this.lastRun;
        if (!last || last.docId !== docId || last.failedRefs.length === 0) {
            return this.sync(docId);
        }
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        this.deps.store.patch({ busy: true, docId, status: "syncing", banner: null });
        try {
            // Only local references can be retried; a remote image is skipped by design (P0),
            // so retrying it would just produce a misleading "asset missing" entry.
            const refs = last.failedRefs
                .filter((item) => (item.assetPath ?? "").length > 0)
                .map((item) => ({
                    kind: "local" as const,
                    ref: item.ref,
                    assetPath: item.assetPath,
                }));
            if (refs.length === 0) {
                return this.sync(docId);
            }
            const images = await this.deps.pipeline.process(last.markdown, refs);
            const markdown = images.markdown;
            await this.deps.api.updateDraft(last.draftId, { ...last.meta, markdown });
            const result: SyncResult = {
                ok: true,
                partial: images.failed.length > 0,
                docId,
                action: "updated",
                status: "draft",
                title: last.meta.title,
                draftId: last.draftId,
                juejinUrl: draftUrl(last.draftId),
                imageTotal: images.total,
                imageUploaded: images.uploaded,
                imageFailed: images.failed,
                degradations: [],
                warnings: images.warnings,
                brief: last.meta.briefContent,
                startedAt,
                elapsedMs: Date.now() - startedMs,
            };
            this.applyResult(result);
            return result;
        } catch (error) {
            const issue = toSyncError(error);
            const result = this.blockedResult(docId, startedAt, startedMs, issue);
            this.applyResult(result);
            return result;
        } finally {
            this.deps.store.patch({ busy: false, progress: null });
        }
    }

    /* ---------------- helpers ---------------- */

    private placeholder = (kind: keyof typeof UNSUPPORTED_PLACEHOLDER_KEY): string =>
        this.deps.translate(UNSUPPORTED_PLACEHOLDER_KEY[kind]);

    private progress(stage: string, done: number, total: number): void {
        this.deps.store.patch({ progress: { label: stage, done, total } });
        this.deps.onProgress?.(stage, done, total);
    }

    private composeTitle(settings: SyncSettings, base: string): string {
        const trimmed = base.trim();
        return `${settings.titlePrefix}${trimmed}${settings.titleSuffix}`.trim();
    }

    private titleFromPath(hPath: string): string {
        const parts = hPath.split("/").filter((item) => item.length > 0);
        return parts.length > 0 ? parts[parts.length - 1] : "";
    }

    private async notebookOf(docId: string): Promise<string> {
        try {
            return await this.deps.kernel.getDocNotebook(docId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.warn(`getDocNotebook(${docId}) failed: ${message}`);
            return "";
        }
    }

    /**
     * Resolve category and tags: override → notebook mapping → previous binding → global default.
     */
    private async resolveMeta(
        settings: SyncSettings,
        binding: DocBinding,
        notebook: string,
        overrides: SyncOverrides,
        warnings?: string[],
    ): Promise<{ categoryId: string; tagIds: string[] }> {
        const mapping = notebook ? settings.notebookCategoryMapping[notebook] : undefined;
        let categoryId = overrides.categoryId?.trim() ?? "";
        let tagIds = overrides.tagIds && overrides.tagIds.length > 0 ? [...overrides.tagIds] : [];

        if (!categoryId && mapping?.categoryId) {
            categoryId = mapping.categoryId;
        }
        if (tagIds.length === 0 && mapping?.tagIds && mapping.tagIds.length > 0) {
            tagIds = [...mapping.tagIds];
        }
        if (!categoryId && binding.categoryId) {
            categoryId = binding.categoryId;
        }
        if (tagIds.length === 0 && binding.tagIds && binding.tagIds.length > 0) {
            tagIds = [...binding.tagIds];
        }
        if (!categoryId) {
            categoryId = settings.defaultCategoryId;
        }
        if (tagIds.length === 0) {
            tagIds = [...settings.defaultTagIds];
        }
        // Only warn when the user actually configured per-notebook overrides but this notebook
        // is not among them. With no mapping at all the global defaults are the intended setup,
        // and a warning on every single sync would drown the real ones (failed images).
        const hasMapping = Object.keys(settings.notebookCategoryMapping).length > 0;
        if (warnings && notebook && hasMapping && !mapping) {
            warnings.push("sync.warn.notebookMappingMissing");
        }
        return { categoryId, tagIds };
    }

    private async rememberFailure(docId: string, issue: SyncError): Promise<void> {
        try {
            await this.deps.binding.write(docId, {
                status: "failed",
                lastError: this.deps.translate(issue.i18nKey, issue.params),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.warn(`could not persist failure state: ${message}`);
        }
    }

    private blockedResult(docId: string, startedAt: string, startedMs: number, issue: SyncError): SyncResult {
        return {
            ok: false,
            partial: false,
            docId,
            action: "blocked",
            status: "failed",
            title: "",
            imageTotal: 0,
            imageUploaded: 0,
            imageFailed: [],
            degradations: [],
            warnings: [],
            error: issue.toIssue(),
            startedAt,
            elapsedMs: Date.now() - startedMs,
        };
    }

    /** Reflect the result into the dock store + history. */
    private applyResult(result: SyncResult): void {
        const state = this.deps.store.getState();
        const bannerKind = result.error ? "error" : result.partial ? "warn" : "info";
        const bannerKey = result.error
            ? "plugin.banner.failed"
            : result.status === "published"
              ? "plugin.banner.published"
              : result.status === "imported"
                ? "plugin.banner.imported"
                : "plugin.banner.draft";
        this.deps.store.patch({
            status: result.ok ? result.status : "failed",
            busy: false,
            juejinUrl: result.juejinUrl ?? "",
            lastResult: result,
            banner: { kind: bannerKind, text: this.deps.translate(bannerKey) },
            docTitle: result.title || state.docTitle,
        });
        this.deps.store.pushHistory({
            docId: result.docId,
            docTitle: result.title,
            at: result.startedAt,
            ok: result.ok,
            action: result.action,
            articleId: result.articleId,
            imageFailed: result.imageFailed.length,
            error: result.error ? this.deps.translate(result.error.i18nKey, result.error.params) : undefined,
        });
    }
}

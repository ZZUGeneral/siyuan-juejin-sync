/**
 * Sync result panel (A3 + D4 + P1 retry slot).
 *
 * Rendering order is a hard requirement, not a style choice:
 *  1. **failed images first**, expanded and without a `<details>` wrapper — a user must never
 *     be able to publish while believing the pictures made it (A3);
 *  2. status / action / elapsed;
 *  3. the primary error message (already localized by `core/errors.ts`);
 *  4. image summary, degradations, warnings;
 *  5. actions;
 *  6. a *separate*, collapsed block holding the verbatim upstream answer (D4). Keeping the raw
 *     payload out of the primary flow is what lets us pass upstream text through untouched.
 */
import { Dialog } from "siyuan";
import type { Degradation, DegradationKind, ImageUploadResult, KernelApi, SyncIssue, SyncResult } from "../types";
import { ErrorKind } from "../types";
import { textOf } from "../core/i18n";
import type { Logger } from "../core/logger";
import type { SyncEngine } from "../core/syncEngine";
import { badge, button, details, el, ghostButton, hint, kv, row } from "./components";

/** i18n key of each degradation kind. */
const DEGRADATION_KEY: Record<DegradationKind, string> = {
    "block-attr": "sync.degradation.blockAttr",
    "block-ref": "sync.degradation.blockRef",
    "doc-ref": "sync.degradation.docRef",
    "unsupported-block": "sync.degradation.unsupportedBlock",
    footnote: "sync.degradation.footnote",
    "inline-ext": "sync.degradation.inlineExt",
    "remote-image": "sync.degradation.remoteImage",
};

export interface ResultPanelDeps {
    i18n: Record<string, string>;
    engine: SyncEngine;
    kernel: KernelApi;
    logger: Logger;
}

export class ResultPanel {
    private readonly deps: ResultPanelDeps;

    constructor(deps: ResultPanelDeps) {
        this.deps = deps;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return textOf(this.deps.i18n, key, params);
    }

    /** Show the result in a modal dialog (used right after a sync finishes). */
    open(result: SyncResult): Dialog {
        const dialog = new Dialog({
            title: this.t("sync.result.title"),
            content: '<div class="jjs-root jjs-resultdialog"></div>',
            width: "min(680px, 94vw)",
        });
        const root = dialog.element.querySelector(".jjs-resultdialog");
        if (root instanceof HTMLElement) {
            this.render(root, result, () => dialog.destroy());
        }
        return dialog;
    }

    /**
     * Render into any host (dialog body or dock), replacing its previous content.
     *
     * @param host Container to fill.
     * @param result Snapshot produced by `SyncEngine.sync` / `retryFailedImages`.
     * @param onClose Optional close handler; when present a "close" button is appended.
     */
    render(host: HTMLElement, result: SyncResult, onClose?: () => void): void {
        while (host.firstChild) {
            host.removeChild(host.firstChild);
        }
        host.className = "jjs-result";

        // 1. A3 — pinned, never collapsible.
        if (result.imageFailed.length > 0) {
            host.append(this.buildFailedImages(result.imageFailed));
        }
        // 2. status head.
        host.append(this.buildHead(result));
        // 3. primary error.
        if (result.error) {
            host.append(this.buildError(result.error));
        }
        // 4. summaries.
        if (result.imageTotal > 0) {
            host.append(
                hint(this.t("sync.result.imagesOk", { ok: result.imageUploaded, total: result.imageTotal })),
            );
        }
        if (result.degradations.length > 0) {
            host.append(this.buildDegradations(result.degradations));
        }
        result.warnings.forEach((key) => {
            host.append(hint(this.t(key), "jjs-hint jjs-hint--warn"));
        });
        // 5. actions.
        host.append(this.buildActions(result, host, onClose));
        // 6. D4 — verbatim upstream details, collapsed and separate from the flow above.
        host.append(this.buildRaw(result));
    }

    /**
     * Dock-sized summary of the last run.
     *
     * Deliberately *not* compact when something went wrong: a failed image or a failed run falls
     * back to the full panel, which pins the failed-image list above everything else (A3) and
     * keeps the upstream error visible without a click. The happy path only needs a verdict, the
     * image count and a way into the detail dialog — the dock is 150 px wide and the full panel
     * would bury the sync button.
     */
    renderSummary(host: HTMLElement, result: SyncResult, onDetail: () => void): void {
        if (result.imageFailed.length > 0 || result.error) {
            const body = el("div");
            host.append(body);
            this.render(body, result);
            return;
        }
        // Verdict + image count only. The action badge and the title would repeat the status card
        // sitting directly above this one.
        const verdict = this.verdict(result);
        const images =
            result.imageTotal > 0
                ? hint(this.t("sync.result.imagesOk", { ok: result.imageUploaded, total: result.imageTotal }))
                : null;
        host.append(row([badge(verdict.label, verdict.tone), images], "jjs-result__head"));
        host.append(row([ghostButton(this.t("sync.dock.result.detail"), onDetail)], "jjs-row jjs-row--end"));
    }

    /* ---------------- sections ---------------- */

    /** Badge text + tone describing how the run ended. */
    private verdict(result: SyncResult): { label: string; tone: "ok" | "warn" | "error" } {
        if (result.error) {
            return { label: this.t("sync.result.failed"), tone: "error" };
        }
        if (result.partial) {
            return { label: this.t("sync.result.partial", { n: result.imageFailed.length }), tone: "warn" };
        }
        return { label: this.t("sync.result.ok"), tone: "ok" };
    }

    /** A3: an expanded list of every failed image, no `<details>` in between. */
    private buildFailedImages(failed: ImageUploadResult[]): HTMLElement {
        const block = el("div", { class: "jjs-failed" }, [
            el("div", { class: "jjs-failed__title", text: this.t("sync.result.imageFailedTop", { n: failed.length }) }),
            el("div", { class: "jjs-failed__title", text: this.t("image.failed.list") }),
        ]);
        failed.forEach((item) => {
            const reasonKey = item.reason ?? "image.err.upload";
            const reason = this.t(reasonKey, { ...item.reasonParams, msg: item.reasonParams?.msg ?? "" });
            const label = item.assetPath ?? item.sourceUrl ?? item.ref;
            block.append(el("div", { class: "jjs-failed__item", text: `${label} — ${reason}` }));
        });
        return block;
    }

    private buildHead(result: SyncResult): HTMLElement {
        const verdict = this.verdict(result);
        const head = el("div", { class: "jjs-result__head" }, [
            badge(verdict.label, verdict.tone),
            badge(this.t(`sync.result.action.${result.action}`), "muted"),
            hint(this.t("sync.result.elapsed", { ms: result.elapsedMs })),
        ]);
        if (result.title) {
            head.append(el("div", { class: "jjs-field__label", text: result.title }));
        }
        return head;
    }

    private buildError(issue: SyncIssue): HTMLElement {
        const wrapper = el("div", { class: "jjs-group" });
        wrapper.append(hint(this.t(issue.i18nKey, issue.params), "jjs-hint jjs-hint--error"));
        if (issue.kind === ErrorKind.AUTH_EXPIRED || issue.kind === ErrorKind.NEED_PHONE) {
            wrapper.append(hint(this.t("err.hint.settings"), "jjs-hint"));
        }
        return wrapper;
    }

    private buildDegradations(degradations: Degradation[]): HTMLElement {
        const total = degradations.reduce((sum, item) => sum + item.count, 0);
        const wrapper = el("div", { class: "jjs-group" }, [
            hint(this.t("sync.result.degraded", { n: total }), "jjs-hint jjs-hint--warn"),
        ]);
        const list = el("div", { class: "jjs-list" });
        degradations.forEach((item) => {
            const key = DEGRADATION_KEY[item.kind];
            const sample = item.sample ? ` · ${item.sample}` : "";
            list.append(el("div", { class: "jjs-hint", text: `${this.t(key)} x${item.count}${sample}` }));
        });
        wrapper.append(list);
        return wrapper;
    }

    private buildActions(result: SyncResult, host: HTMLElement, onClose?: () => void): HTMLElement {
        const buttons: HTMLElement[] = [];

        if (result.imageFailed.length > 0) {
            const retry = button(this.t("sync.retry.failedImages"), () => {
                void (async () => {
                    retry.disabled = true;
                    const next = await this.deps.engine.retryFailedImages(result.docId);
                    this.deps.logger.info(`retry finished ok=${next.ok} failed=${next.imageFailed.length}`);
                    this.render(host, next, onClose);
                })();
            });
            buttons.push(retry);
        }
        if (result.juejinUrl) {
            buttons.push(
                button(this.t("sync.result.openJuejin"), () => {
                    window.open(result.juejinUrl, "_blank");
                }),
            );
        }
        if (result.docId) {
            buttons.push(
                button(this.t("sync.result.openDoc"), () => {
                    this.deps.kernel.openDoc(result.docId);
                }),
            );
        }
        if (onClose) {
            buttons.push(button(this.t("common.close"), onClose, { kind: "primary" }));
        }
        return row(buttons, "jjs-row jjs-row--end");
    }

    /** D4: raw upstream payload, verbatim, in its own collapsed block. */
    private buildRaw(result: SyncResult): HTMLElement {
        const raw = result.error?.raw;
        const lines: HTMLElement[] = [
            kv("action", result.action),
            kv("status", result.status),
            kv("elapsed", `${result.elapsedMs}ms`),
            kv("images", `${result.imageUploaded}/${result.imageTotal}`),
        ];
        if (raw) {
            lines.push(
                kv("err_no", String(raw.errNo ?? "")),
                kv("err_msg", raw.errMsg ?? ""),
                kv("http", String(raw.httpStatus ?? "")),
                kv("endpoint", raw.endpoint ?? ""),
                kv("code", String(raw.code ?? "")),
            );
        }
        return details(this.t("err.raw"), lines, false);
    }
}

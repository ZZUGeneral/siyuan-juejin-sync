/**
 * Reverse-import tab (P2, plus A4).
 *
 * Flow: link → parse → fetch preview → notebook + path → confirm.
 *
 * Two behaviours worth noting:
 *  - the degraded notice (`import.degraded.notice`) is rendered **next to the preview**, right
 *    where the user decides, not buried in a log (A4);
 *  - a duplicate import asks for confirmation through the host dialog, using the doc id that
 *    was found by the binding lookup, so "overwrite" is always an explicit choice.
 */
import { confirm as confirmDialog } from "siyuan";
import type { I18nBundle, ImportResult, JuejinArticlePreview, KernelApi, NotebookInfo } from "../types";
import { textOf } from "../core/i18n";
import type { Importer } from "../core/importer";
import type { Logger } from "../core/logger";
import { effectivePathTemplate } from "../core/settings";
import type { SettingsService } from "../core/settings";
import {
    badge,
    button,
    checkbox,
    clear,
    el,
    field,
    hint,
    row,
    selectField,
    textInput,
    type BadgeTone,
} from "./components";

export interface ImportPanelDeps {
    i18n: I18nBundle;
    importer: Importer;
    kernel: KernelApi;
    settings: SettingsService;
    logger: Logger;
    /** Called after every finished import attempt so the dock can refresh. */
    onImported?: (result: ImportResult) => void;
}

export class ImportPanel {
    private readonly deps: ImportPanelDeps;

    constructor(deps: ImportPanelDeps) {
        this.deps = deps;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return textOf(this.deps.i18n, key, params);
    }

    /** Fill `host` with the import form. Safe to call repeatedly. */
    mount(host: HTMLElement): void {
        clear(host);
        host.className = "jjs-root";
        void this.render(host);
    }

    /* ---------------- form ---------------- */

    private async render(host: HTMLElement): Promise<void> {
        const settings = await this.deps.settings.load();
        if (!settings.enableReverseImport) {
            host.append(hint(this.t("import.tab.disabled"), "jjs-hint jjs-hint--warn"));
            return;
        }

        host.append(el("div", { class: "jjs-group__title", text: this.t("import.tab.title") }));

        const notebooks = await this.listNotebooks();
        let articleId = "";
        let preview: JuejinArticlePreview | null = null;
        let notebookId = settings.reverseImportNotebook || notebooks[0]?.id || "";
        let pathTemplate = effectivePathTemplate(settings, this.t("import.path.defaultTemplate"));
        let overwrite = settings.reverseImportOverwrite;

        const statusLine = hint("", "jjs-hint");
        const previewHolder = el("div", { class: "jjs-group" });
        const resultHolder = el("div");

        const linkInput = textInput({
            placeholder: this.t("import.link.placeholder"),
            onInput: (value) => {
                articleId = this.deps.importer.parseArticleId(value);
                statusLine.className = "jjs-hint";
                statusLine.textContent = value.trim().length > 0 && articleId.length === 0 ? this.t("import.parse.invalid") : "";
            },
        });
        host.append(field(this.t("import.link.label"), linkInput));

        const parseButton = button(this.t("import.parse.button"), () => {
            articleId = this.deps.importer.parseArticleId(linkInput.value);
            if (articleId.length === 0) {
                statusLine.className = "jjs-hint jjs-hint--error";
                statusLine.textContent = this.t("import.parse.invalid");
                return;
            }
            linkInput.value = articleId;
            statusLine.className = "jjs-hint";
            statusLine.textContent = articleId;
        });

        const fetchButton = button(this.t("import.fetch.button"), () => {
            void (async () => {
                articleId = this.deps.importer.parseArticleId(linkInput.value);
                if (articleId.length === 0) {
                    statusLine.className = "jjs-hint jjs-hint--error";
                    statusLine.textContent = this.t("import.parse.invalid");
                    return;
                }
                fetchButton.disabled = true;
                statusLine.className = "jjs-hint";
                statusLine.textContent = this.t("import.fetch.fetching");
                try {
                    preview = await this.deps.importer.preview(articleId);
                    this.renderPreview(previewHolder, preview);
                    statusLine.textContent = "";
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.deps.logger.warn(`import preview failed: ${message}`);
                    statusLine.className = "jjs-hint jjs-hint--error";
                    statusLine.textContent = this.t("import.result.failed", { msg: message.slice(0, 160) });
                    preview = null;
                } finally {
                    fetchButton.disabled = false;
                }
            })();
        });
        host.append(row([parseButton, fetchButton]), statusLine);
        host.append(previewHolder);

        /* ---------------- destination ---------------- */
        const notebookSelect = selectField(
            notebooks.map((item) => ({ value: item.id, label: item.name })),
            notebookId,
            (value) => {
                notebookId = value;
            },
        );
        host.append(field(this.t("import.notebook.label"), notebooks.length > 0 ? notebookSelect : hint(this.t("import.err.noNotebook"), "jjs-hint jjs-hint--warn")));

        const pathInput = textInput({
            value: pathTemplate,
            placeholder: this.t("import.path.defaultTemplate"),
            onInput: (value) => {
                pathTemplate = value;
            },
        });
        host.append(field(this.t("import.path.label"), pathInput));

        const overwriteBox = checkbox(this.t("import.overwrite.label"), settings.reverseImportOverwrite, (checked) => {
            overwrite = checked;
        });
        host.append(overwriteBox.root);

        /* ---------------- confirm ---------------- */
        const confirmButton = button(
            this.t("import.confirm.button"),
            () => {
                void (async () => {
                    if (!preview) {
                        statusLine.className = "jjs-hint jjs-hint--error";
                        statusLine.textContent = this.t("import.fetch.button");
                        return;
                    }
                    if (notebookId.length === 0) {
                        statusLine.className = "jjs-hint jjs-hint--error";
                        statusLine.textContent = this.t("import.err.noNotebook");
                        return;
                    }
                    let overwriteNow = overwrite;
                    const existing = await this.deps.importer.findExisting(articleId);
                    if (existing && !overwriteNow) {
                        const accepted = await this.askOverwrite(existing);
                        if (!accepted) {
                            return;
                        }
                        overwriteNow = true;
                    }
                    confirmButton.disabled = true;
                    statusLine.className = "jjs-hint";
                    statusLine.textContent = this.t("common.loading");
                    const result = await this.deps.importer.import({
                        articleId,
                        notebook: notebookId,
                        path: pathTemplate,
                        overwrite: overwriteNow,
                    });
                    confirmButton.disabled = false;
                    statusLine.textContent = "";
                    this.renderResult(resultHolder, result);
                    this.deps.onImported?.(result);
                })();
            },
            { kind: "primary" },
        );
        host.append(row([confirmButton], "jjs-row jjs-row--end"));
        host.append(resultHolder);
    }

    /* ---------------- preview / result ---------------- */

    private renderPreview(host: HTMLElement, preview: JuejinArticlePreview): void {
        clear(host);
        const tone: BadgeTone = preview.origin === "api" ? "ok" : "warn";
        const originKey = preview.origin === "api" ? "import.origin.api" : "import.origin.page";
        host.append(
            el("div", { class: "jjs-result__head" }, [
                badge(this.t(originKey), tone),
                el("div", { class: "jjs-field__label", text: preview.title }),
            ]),
        );
        host.append(hint(this.t("import.preview.words", { n: preview.wordCount })));
        host.append(hint(this.t("import.preview.images", { n: preview.imageCount })));
        preview.warnings.forEach((key) => {
            host.append(hint(this.t(key), "jjs-hint jjs-hint--warn"));
        });
    }

    private renderResult(host: HTMLElement, result: ImportResult): void {
        clear(host);
        const group = el("div", { class: "jjs-group" });
        if (result.ok) {
            group.append(badge(this.t("import.result.ok", { title: result.title }), result.imageFailed.length > 0 ? "warn" : "ok"));
            if (result.imageFailed.length > 0) {
                group.append(hint(this.t("import.result.partial", { n: result.imageFailed.length }), "jjs-hint jjs-hint--warn"));
                const list = el("div", { class: "jjs-list" });
                result.imageFailed.forEach((url) => {
                    list.append(el("div", { class: "jjs-failed__item", text: url }));
                });
                group.append(list);
            }
            if (result.docId) {
                group.append(
                    row(
                        [
                            button(this.t("import.openDoc"), () => {
                                this.deps.kernel.openDoc(result.docId ?? "");
                            }),
                        ],
                        "jjs-row jjs-row--end",
                    ),
                );
            }
        } else {
            const detail = result.error ? this.t(result.error.i18nKey, result.error.params) : "";
            group.append(badge(this.t("import.result.failed", { msg: detail }), "error"));
        }
        result.warnings.forEach((key) => {
            group.append(hint(this.t(key), "jjs-hint jjs-hint--warn"));
        });
        host.append(group);
    }

    /* ---------------- helpers ---------------- */

    private async listNotebooks(): Promise<NotebookInfo[]> {
        try {
            return await this.deps.kernel.listNotebooks();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger.warn(`listNotebooks failed: ${message}`);
            return [];
        }
    }

    /** Ask before touching an existing document. */
    private askOverwrite(docId: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (value: boolean): void => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(value);
            };
            confirmDialog(
                this.t("import.duplicated.title"),
                this.t("import.duplicated.text", { docId }),
                () => finish(true),
                () => finish(false),
                true,
            );
        });
    }
}

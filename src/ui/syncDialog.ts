/**
 * Pre-sync confirmation dialog (FR-05 / FR-13, plus A1 and A6).
 *
 * Five zones, top to bottom:
 *   1. intent card — one sentence answering "what will this sync do?" (never scrolls)
 *   2. notices     — the publish warning / "maybe already published" (never scrolls)
 *   3. body        — two cards: text, then category + tags (the only scroller)
 *   4. details     — tag tools and diagnostics, both collapsed
 *   5. footer      — the gate reason next to the buttons (never scrolls)
 *
 * Everything the user can override before a request leaves the machine lives in ZONE 3: title,
 * excerpt, category, tags. The excerpt rule has a *single* slot (`.jjs-field__rule`) that flips
 * from "the rule" to "out of range" in place, so nothing jumps and the rule is never stated twice.
 *
 * Two hard rules encoded below:
 *  - the confirm button is disabled while any field is invalid, so an illegal payload can
 *    never be submitted from the UI — and the footer gate then says *why* right next to it;
 *  - `publishMode === "publish"` always triggers a second, explicit confirmation (FR-13).
 */
import { Dialog, confirm as confirmDialog } from "siyuan";
import {
    BRIEF_MAX,
    BRIEF_MIN,
    type JuejinApi,
    type JuejinMetaCache,
    type SyncAction,
    type SyncPreview,
    type SyncResult,
    type SyncStatus,
} from "../types";
import { briefState, countChars } from "../core/brief";
import { toSyncError } from "../core/errors";
import { textOf } from "../core/i18n";
import { countNewTags, mergeTags } from "../core/tagPool";
import type { Logger } from "../core/logger";
import type { SettingsService } from "../core/settings";
import type { SyncEngine, SyncOverrides } from "../core/syncEngine";
import {
    badge,
    button,
    chipInput,
    clear,
    details,
    el,
    field,
    ghostButton,
    hint,
    isUnnamedTag,
    kv,
    row,
    selectField,
    textArea,
    textInput,
    type BadgeTone,
} from "./components";
import { stamp } from "./format";

/** Human readable label + badge tone of every dock status. */
const STATUS_LABEL: Record<SyncStatus | "unsynced", { key: string; tone: BadgeTone }> = {
    unsynced: { key: "plugin.banner.unsynced", tone: "muted" },
    draft: { key: "plugin.banner.draft", tone: "ok" },
    published: { key: "plugin.banner.published", tone: "ok" },
    failed: { key: "plugin.banner.failed", tone: "error" },
    imported: { key: "plugin.banner.imported", tone: "info" },
    unknown: { key: "plugin.banner.unknown", tone: "warn" },
};

/**
 * ZONE 1 sentence + tone per outcome.
 *
 * `publish` is not a {@link SyncAction}: it is the mode, and it outranks the action because a
 * public publish is the only irreversible outcome the dialog can announce.
 */
const INTENT: Record<SyncAction | "publish", { key: string; tone: BadgeTone }> = {
    created: { key: "sync.dialog.intent.create", tone: "info" },
    updated: { key: "sync.dialog.intent.update", tone: "ok" },
    skipped: { key: "sync.dialog.intent.skip", tone: "muted" },
    blocked: { key: "sync.dialog.intent.blocked", tone: "error" },
    publish: { key: "sync.dialog.intent.publish", tone: "warn" },
};

export interface SyncDialogDeps {
    i18n: Record<string, string>;
    engine: SyncEngine;
    settings: SettingsService;
    /** Needed for the in-dialog tag search and the "sync tags" reload. */
    api: JuejinApi;
    logger: Logger;
    /** Invoked right after `engine.sync()` resolves, so the caller can open the result panel. */
    onDone: (result: SyncResult) => void;
}

/** The three user-editable fields, kept mutable while the dialog is open. */
interface DraftMeta {
    title: string;
    brief: string;
    categoryId: string;
    tagIds: string[];
}

/**
 * The mounted tag field.
 *
 * `syncStale` re-evaluates the "names are missing" warning from the *current* selection; the field
 * is re-mounted only when the pool changes, so the line cannot be baked in at build time.
 */
interface TagFieldView {
    root: HTMLElement;
    syncStale: () => void;
}

export class SyncDialog {
    private readonly deps: SyncDialogDeps;
    private dialog: Dialog | null = null;

    constructor(deps: SyncDialogDeps) {
        this.deps = deps;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return textOf(this.deps.i18n, key, params);
    }

    /** Open the dialog for one document; failures become a read-only error dialog. */
    async open(docId: string): Promise<void> {
        let preview: SyncPreview;
        try {
            preview = await this.deps.engine.preview(docId);
        } catch (error) {
            this.showFailure(error);
            return;
        }
        const settings = await this.deps.settings.load();
        let meta = await this.deps.settings.loadMeta();

        this.dialog?.destroy();
        const dialog = new Dialog({
            title: this.t("sync.dialog.title"),
            content: '<div class="jjs-root jjs-syncdialog"></div>',
            width: "min(720px, 94vw)",
        });
        this.dialog = dialog;
        const root = dialog.element.querySelector(".jjs-syncdialog");
        if (!(root instanceof HTMLElement)) {
            return;
        }

        const draft: DraftMeta = {
            title: preview.title,
            brief: preview.brief,
            categoryId: preview.categoryId,
            tagIds: [...preview.tagIds],
        };
        const publishing = settings.publishMode === "publish";
        const validate = (): string | null => this.validate(draft);

        /* ---------------- ZONE 1: intent ---------------- */
        root.append(this.buildIntent(preview, publishing));

        /* ---------------- ZONE 2: notices ---------------- */
        if (publishing) {
            // Full width and warning-coloured: the one irreversible action must be unmissable.
            root.append(
                el("div", { class: "jjs-notice jjs-notice--warn" }, [
                    el("div", { class: "jjs-notice__title", text: this.t("sync.dialog.publishTitle") }),
                    el("div", { class: "jjs-notice__body", text: this.t("settings.mode.publishWarn") }),
                ]),
            );
        }
        if (preview.status === "draft") {
            // FR-10②: a publish performed on the website is invisible here, so this is a hint
            // ("maybe"), never an error.
            root.append(
                el("div", { class: "jjs-notice jjs-notice--quiet" }, [
                    el("div", { class: "jjs-notice__body", text: this.t("sync.hint.maybePublished") }),
                ]),
            );
        }

        /* ---------------- ZONE 3: the only scroller ---------------- */
        const body = el("div", { class: "jjs-syncdialog__body" });

        const briefCounter = el("div", { class: "jjs-hint" });
        // One slot for both the standing rule and the out-of-range reason (never two lines).
        const briefRule = el("div", { class: "jjs-field__rule" });

        const titleInput = textInput({
            value: draft.title,
            onInput: (value) => {
                draft.title = value;
                refresh();
            },
        });
        const titleField = field(this.t("sync.dialog.docTitle"), titleInput);

        const briefArea = textArea({
            value: draft.brief,
            rows: 4,
            onInput: (value) => {
                draft.brief = value;
                refresh();
            },
        });
        const briefField = field(this.t("sync.dialog.brief"), briefArea, { suffix: briefCounter });
        briefField.append(briefRule);

        body.append(
            el("div", { class: "jjs-card" }, [
                el("div", { class: "jjs-card__title", text: this.t("sync.dialog.cardBody") }),
                titleField,
                briefField,
            ]),
        );

        /*
         * Both metadata fields live in holders so "sync tags" can re-mount them with fresh data.
         * Rebuilding the whole dialog instead would throw away the title/brief the user already
         * edited, and a full re-mount on every chip toggle would steal focus from the search box.
         */
        const categoryHolder = el("div", { class: "jjs-field-host" });
        const tagHolder = el("div", { class: "jjs-field-host" });
        let categoryFieldEl: HTMLElement | null = null;
        let tagView: TagFieldView | null = null;
        const poolCount = el("span", { class: "jjs-details__aside" });
        /** Every live "sync tags" button; all of them are disabled while a reload runs. */
        const syncButtons: HTMLButtonElement[] = [];
        let reloading = false;

        /**
         * Factory for the "sync tags" affordance.
         *
         * Two of them are on screen (the empty tag field and the tools row), and one more appears
         * whenever the field is re-mounted. Cloning/moving a single node would make the disabled
         * state depend on which copy happened to be current, so each call builds a fresh button.
         */
        const newSyncTagsButton = (): HTMLButtonElement => {
            const node = ghostButton(this.t("sync.dialog.tagRefresh"), () => {
                void reloadTaxonomy();
            });
            node.disabled = reloading;
            syncButtons.push(node);
            return node;
        };

        const mountCategory = (): void => {
            clear(categoryHolder);
            categoryFieldEl = this.buildCategoryField(meta, draft, () => refresh());
            categoryHolder.append(categoryFieldEl);
        };
        const mountTags = (): void => {
            clear(tagHolder);
            tagView = this.buildTagField(meta, draft, () => refresh(), newSyncTagsButton);
            tagHolder.append(tagView.root);
            poolCount.textContent = this.t("sync.dialog.tagPool", { n: (meta?.tags ?? []).length });
        };
        mountCategory();
        mountTags();

        body.append(
            el("div", { class: "jjs-card" }, [
                el("div", { class: "jjs-card__title", text: this.t("sync.dialog.cardMeta") }),
                categoryHolder,
                tagHolder,
            ]),
        );

        /* ---------------- ZONE 4-a: tag tools ---------------- */
        /*
         * Juejin does not expose a browsable tag directory to a non-browser client, so the only
         * way to reach a tag outside the popular page is to read it off a page that uses it.
         * Pasted article links are that input; the tags are merged into the local pool and
         * pre-selected, because the article the user pasted is almost always on-topic.
         */
        const importInput = textInput({ placeholder: this.t("sync.dialog.tagImportPlaceholder") });
        const importButton = ghostButton(this.t("sync.dialog.tagImportAction"), () => {
            void importTags();
        });
        const toolsStatus = hint("", "jjs-hint");

        const importTags = async (): Promise<void> => {
            const value = importInput.value.trim();
            if (value.length === 0) {
                toolsStatus.className = "jjs-hint jjs-hint--error";
                toolsStatus.textContent = this.t("sync.dialog.tagImportInvalid");
                return;
            }
            importButton.disabled = true;
            toolsStatus.className = "jjs-hint";
            toolsStatus.textContent = this.t("sync.dialog.tagImporting");
            try {
                const found = await this.deps.api.fetchArticleTags(value);
                if (found.length === 0) {
                    toolsStatus.className = "jjs-hint jjs-hint--warn";
                    toolsStatus.textContent = this.t("sync.dialog.tagImportEmpty");
                    return;
                }
                const previous = meta?.tags ?? [];
                const added = countNewTags(previous, found);
                meta = {
                    categories: meta?.categories ?? [],
                    tags: mergeTags(previous, found),
                    fetchedAt: new Date().toISOString(),
                    userName: meta?.userName,
                };
                await this.deps.settings.saveMeta(meta);
                const selected = [...draft.tagIds];
                found.forEach((tag) => {
                    if (!selected.includes(tag.id)) {
                        selected.push(tag.id);
                    }
                });
                draft.tagIds = selected;
                mountTags();
                refresh();
                importInput.value = "";
                toolsStatus.textContent = this.t("sync.dialog.tagImported", { n: added });
            } catch (error) {
                toolsStatus.className = "jjs-hint jjs-hint--error";
                const message = error instanceof Error ? error.message : String(error);
                toolsStatus.textContent = this.t("sync.dialog.tagImportFailed", { msg: message.slice(0, 120) });
                this.deps.logger.warn(`tag import failed: ${message}`);
            } finally {
                importButton.disabled = false;
            }
        };

        /**
         * Pull categories + whatever tags the public routes still hand out, then persist them.
         *
         * Upstream only answers with the popular page (~10 tags) and ignores paging/search, so the
         * refresh **merges** instead of replacing: a pool the user widened with imported tags must
         * not shrink back to ten on the next click. The feed is asked as a second source because
         * it still returns real tag objects; a feed failure is not fatal, the popular page stands.
         */
        const reloadTaxonomy = async (): Promise<void> => {
            reloading = true;
            syncButtons.forEach((node) => {
                node.disabled = true;
            });
            toolsStatus.className = "jjs-hint";
            toolsStatus.textContent = this.t("sync.dialog.tagRefreshing");
            try {
                const categories = await this.deps.api.fetchCategories();
                const popular = await this.deps.api.fetchTags();
                let extra: typeof popular = [];
                try {
                    extra = await this.deps.api.fetchFeedTags();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.deps.logger.warn(`feed tag collection skipped: ${message}`);
                }
                const previous = meta?.tags ?? [];
                const tags = mergeTags(previous, [...popular, ...extra]);
                meta = { categories, tags, fetchedAt: new Date().toISOString(), userName: meta?.userName };
                await this.deps.settings.saveMeta(meta);
                mountCategory();
                mountTags();
                /*
                 * Re-mounting changes the *inputs* of validation, not just the DOM: with an empty
                 * `draft.categoryId`, `buildCategoryField()` auto-selects the first category and
                 * writes it back. Without this call the gate would keep saying "choose a category"
                 * and the primary button would stay disabled until the user touched another field.
                 */
                refresh();
                toolsStatus.textContent = this.t("sync.dialog.tagRefreshed", {
                    n: countNewTags(previous, tags),
                    total: tags.length,
                });
            } catch (error) {
                toolsStatus.className = "jjs-hint jjs-hint--error";
                const message = error instanceof Error ? error.message : String(error);
                toolsStatus.textContent = this.t("sync.dialog.tagRefreshFailed", { msg: message.slice(0, 160) });
                this.deps.logger.warn(`tag reload failed: ${message}`);
            } finally {
                reloading = false;
                // Re-enable every copy, including the one a re-mount just created.
                syncButtons.forEach((node) => {
                    node.disabled = false;
                });
            }
        };

        const tagTools = el("details", { class: "jjs-details jjs-details--plain" });
        // An empty pool is the one case where the fix (fetch tags) must not be hidden.
        tagTools.open = (meta?.tags ?? []).length === 0;
        tagTools.append(
            el("summary", { class: "jjs-details__summary" }, [
                el("span", { text: this.t("sync.dialog.tagTools") }),
                poolCount,
            ]),
            el("div", { class: "jjs-details__content" }, [
                hint(this.t("sync.dialog.tagImportHint")),
                el("div", { class: "jjs-import" }, [importInput, importButton]),
                el("div", { class: "jjs-tools__row" }, [newSyncTagsButton(), toolsStatus]),
            ]),
        );
        body.append(tagTools);

        /* ---------------- ZONE 4-b: diagnostics ---------------- */
        const diagnostics = this.buildDiagnostics(preview);
        if (diagnostics) {
            body.append(diagnostics);
        }

        /* ---------------- ZONE 5: footer ---------------- */
        const foot = el("div", { class: "jjs-syncdialog__foot" });
        // Rendered only while something is wrong: a greyed-out button must have its reason nearby.
        const gate = el("div", { class: "jjs-gate" });
        gate.hidden = true;

        const confirmButton = button(
            publishing ? this.t("sync.dialog.confirmPublish") : this.t("sync.dialog.confirm"),
            () => {
                void submit();
            },
            { kind: "primary" },
        );

        const cancelButton = button(this.t("sync.dialog.cancel"), () => {
            dialog.destroy();
            this.dialog = null;
        });

        /**
         * Recompute every derived bit of chrome from `draft`.
         *
         * One function, so the four fields, the counter, the rule slot, the footer gate and the
         * confirm button can never disagree about what is currently valid.
         */
        const refresh = (): void => {
            const length = countChars(draft.brief);
            const inRange = briefState(draft.brief) === "ok";
            briefCounter.textContent = this.t("sync.dialog.briefCounter", { n: length });
            briefCounter.className = inRange ? "jjs-hint" : "jjs-hint jjs-hint--error";
            briefRule.textContent = inRange
                ? this.t("sync.dialog.briefRule")
                : this.t("err.brief.range", { n: length });
            briefRule.className = inRange ? "jjs-field__rule" : "jjs-field__rule jjs-field__rule--error";
            briefField.classList.toggle("jjs-field--invalid", !inRange);
            titleField.classList.toggle("jjs-field--invalid", draft.title.trim().length === 0);
            categoryFieldEl?.classList.toggle("jjs-field--invalid", draft.categoryId.length === 0);
            tagView?.root.classList.toggle("jjs-field--invalid", draft.tagIds.length === 0);
            tagView?.syncStale();
            const issue = validate();
            // The gate wraps the *same* reason the field shows, so the two can never disagree.
            gate.textContent = issue === null ? "" : this.t("sync.dialog.blockedBy", { reason: issue });
            gate.hidden = issue === null;
            confirmButton.disabled = issue !== null;
        };

        const submit = async (): Promise<void> => {
            const issue = validate();
            if (issue !== null) {
                gate.textContent = this.t("sync.dialog.blockedBy", { reason: issue });
                gate.hidden = false;
                return;
            }
            const finalTitle = draft.title.trim();
            const overrides: SyncOverrides = {
                title: finalTitle,
                brief: draft.brief,
                categoryId: draft.categoryId,
                tagIds: [...draft.tagIds],
            };
            if (publishing) {
                const accepted = await this.confirmPublish(finalTitle, preview.docId);
                if (!accepted) {
                    return;
                }
                overrides.confirmedPublish = true;
            }
            dialog.destroy();
            this.dialog = null;
            const result = await this.deps.engine.sync(preview.docId, overrides);
            this.deps.onDone(result);
        };

        foot.append(gate, row([cancelButton, confirmButton], "jjs-row jjs-row--end"));

        root.append(body, foot);
        refresh();
    }

    /* ---------------- zones ---------------- */

    /** ZONE 1: status badge, notebook, one conclusion sentence, optional last-sync time. */
    private buildIntent(preview: SyncPreview, publishing: boolean): HTMLElement {
        const status = STATUS_LABEL[preview.status] ?? STATUS_LABEL.unsynced;
        const intent = publishing ? INTENT.publish : INTENT[preview.action] ?? INTENT.created;
        const card = el("div", { class: `jjs-card jjs-status jjs-status--${intent.tone}` }, [
            el("div", { class: "jjs-status__top" }, [
                badge(this.t(status.key), status.tone),
                el("span", { class: "jjs-status__spacer" }),
                preview.notebook
                    ? el("span", { class: "jjs-status__notebook", text: preview.notebook, title: preview.notebook })
                    : null,
            ]),
            el("div", { class: "jjs-status__title", text: this.t(intent.key) }),
        ]);

        // Only drawn when the record actually holds a stamp: "never synced" would repeat the
        // badge above.
        const last = preview.binding.syncTime;
        if (last) {
            card.append(
                el("div", { class: "jjs-status__meta" }, [
                    el("span", { text: this.t("sync.dock.meta.last", { time: stamp(last) }) }),
                ]),
            );
        }
        return card;
    }

    private buildCategoryField(meta: JuejinMetaCache | null, draft: DraftMeta, onChange: () => void): HTMLElement {
        const categories = meta?.categories ?? [];
        if (categories.length === 0) {
            // No empty `<select>`: the field explains itself instead of rendering a dead control.
            return field(
                this.t("sync.dialog.category"),
                hint(this.t("settings.category.empty"), "jjs-hint jjs-hint--warn"),
            );
        }
        const select = selectField(
            categories.map((item) => ({ value: item.id, label: item.name })),
            draft.categoryId || categories[0].id,
            (value) => {
                draft.categoryId = value;
                onChange();
            },
        );
        if (!draft.categoryId) {
            draft.categoryId = categories[0].id;
        }
        return field(this.t("sync.dialog.category"), select);
    }

    private buildTagField(
        meta: JuejinMetaCache | null,
        draft: DraftMeta,
        onChange: () => void,
        newSyncButton: () => HTMLButtonElement,
    ): TagFieldView {
        const tags = meta?.tags ?? [];
        if (tags.length === 0) {
            // The actionable fix sits in the field, not only inside a collapsed section.
            return {
                root: field(
                    this.t("sync.dialog.tags"),
                    el("div", { class: "jjs-row" }, [
                        hint(this.t("settings.tag.empty"), "jjs-hint jjs-hint--warn"),
                        newSyncButton(),
                    ]),
                    { hint: this.t("sync.dialog.tagImportHint") },
                ),
                syncStale: (): void => undefined,
            };
        }

        const names = new Map(tags.map((item) => [item.id, item.name]));
        const staleLine = hint("", "jjs-hint jjs-hint--warn");
        staleLine.hidden = true;
        const syncStale = (): void => {
            const missing = draft.tagIds.some((id) => isUnnamedTag(names.get(id) ?? ""));
            staleLine.textContent = missing ? this.t("settings.tag.staleNames") : "";
            // Exactly one line, however many names are missing: a wall of warnings would bury the
            // chips it is talking about.
            staleLine.hidden = !missing;
        };

        const chips = chipInput({
            all: tags,
            selected: draft.tagIds,
            searchPlaceholder: this.t("settings.tag.searchPlaceholder"),
            selectedLabel: (count) => this.t("settings.tag.selected", { n: count }),
            emptyLabel: this.t("sync.dialog.needTag"),
            onChange: (selected) => {
                draft.tagIds = selected;
                syncStale();
                onChange();
            },
            // Upstream ignores `key_word` for a non-browser client (see `searchTags`), so this is a
            // best-effort widening, not the primary path: the pool and the import row are.
            onSearch: (keyword) => this.deps.api.searchTags(keyword),
            labels: {
                searching: this.t("settings.tag.searching"),
                empty: this.t("settings.tag.noMatch"),
                failed: this.t("settings.tag.searchFailed"),
                unknown: this.t("settings.tag.unnamed"),
                remove: this.t("sync.dialog.tagRemove"),
            },
        });

        const root = field(this.t("sync.dialog.tags"), chips.root);
        root.append(staleLine);
        syncStale();
        return { root, syncStale };
    }

    /**
     * ZONE 4-b: images / degradations / pipeline warnings, or `null` when there is nothing to say.
     *
     * All three used to sit in the main column, which is why the form kept growing; they are
     * post-hoc information and belong behind one summary line.
     */
    private buildDiagnostics(preview: SyncPreview): HTMLDetailsElement | null {
        const lines: HTMLElement[] = [];
        if (preview.imageTotal > 0) {
            lines.push(hint(this.t("sync.dialog.images", { n: preview.imageTotal })));
        }
        if (preview.degradations.length > 0) {
            const total = preview.degradations.reduce((sum, item) => sum + item.count, 0);
            lines.push(hint(this.t("sync.result.degraded", { n: total })));
        }
        preview.warnings.forEach((key) => {
            lines.push(hint(this.t(key)));
        });
        if (lines.length === 0) {
            return null;
        }
        const node = el("details", { class: "jjs-details jjs-details--plain" });
        node.open = false;
        node.append(
            el("summary", { class: "jjs-details__summary" }, [
                el("span", { text: this.t("sync.dialog.diagnostics", { n: lines.length }) }),
            ]),
            el("div", { class: "jjs-details__content" }, lines),
        );
        return node;
    }

    /* ---------------- validation ---------------- */

    /** `null` means "submittable"; otherwise the localized reason. */
    private validate(draft: DraftMeta): string | null {
        if (draft.title.trim().length === 0) {
            return this.t("sync.dialog.needTitle");
        }
        const length = countChars(draft.brief);
        if (length < BRIEF_MIN || length > BRIEF_MAX) {
            return this.t("err.brief.range", { n: length });
        }
        if (draft.categoryId.length === 0) {
            return this.t("sync.dialog.needCategory");
        }
        if (draft.tagIds.length === 0) {
            return this.t("sync.dialog.needTag");
        }
        return null;
    }

    /* ---------------- second confirmation ---------------- */

    /** FR-13: publishing always asks again, with the final title spelled out. */
    private confirmPublish(title: string, docId: string): Promise<boolean> {
        this.deps.logger.info(`publish confirmation requested for ${docId}`);
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
                this.t("sync.publish.confirmTitle"),
                this.t("sync.publish.confirmText", { title }),
                () => finish(true),
                () => finish(false),
                true,
            );
        });
    }

    /* ---------------- failure ---------------- */

    private showFailure(error: unknown): void {
        const issue = toSyncError(error);
        this.deps.logger.warn(`preview failed: ${issue.message}`);
        const dialog = new Dialog({
            title: this.t("sync.result.title"),
            content: '<div class="jjs-root jjs-syncfail"></div>',
            width: "min(560px, 92vw)",
        });
        const root = dialog.element.querySelector(".jjs-syncfail");
        if (!(root instanceof HTMLElement)) {
            return;
        }
        root.append(
            el("div", { class: "jjs-result__head" }, [badge(this.t("sync.result.failed"), "error")]),
            hint(this.t(issue.i18nKey, issue.params), "jjs-hint jjs-hint--error"),
            details(this.t("err.title"), [
                kv("err_no", String(issue.raw.errNo ?? "")),
                kv("err_msg", issue.raw.errMsg ?? ""),
                kv("http", String(issue.raw.httpStatus ?? "")),
                kv("endpoint", issue.raw.endpoint ?? ""),
            ]),
            row(
                [
                    button(this.t("common.close"), () => dialog.destroy(), { kind: "primary" }),
                ],
                "jjs-row jjs-row--end",
            ),
        );
    }
}

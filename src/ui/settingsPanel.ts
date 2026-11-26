/**
 * Settings panel (FR-01 / FR-02 / FR-12, plus A5 / A6 / A7).
 *
 * Three groups, in this order:
 *   1. account & credential  — risk notice, cookie, probe, clear,
 *   2. sync defaults         — category, tags, publish mode, title affixes, timeouts,
 *   3. advanced / experimental — reverse import, endpoint self-check (collapsed), reset.
 *
 * Two rules worth stating because they are easy to get wrong:
 *  - A7: the storage form line uses the exact approved wording and never claims encryption.
 *  - The probe result is rendered by switching on `CredentialProbe.state`; this panel never
 *    classifies an error itself.
 */
import { Dialog } from "siyuan";
import type { JuejinApi, CredentialProbe, EndpointProbe, SyncSettings } from "../types";
import type { Logger } from "../core/logger";
import { textOf } from "../core/i18n";
import { mergeTags } from "../core/tagPool";
import type { SettingsService } from "../core/settings";
import type { JuejinMetaCache } from "../types";
import {
    badge,
    button,
    checkbox,
    chipInput,
    clear,
    details,
    el,
    field,
    hint,
    isUnnamedTag,
    kv,
    row,
    selectField,
    textInput,
} from "./components";

export interface SettingsPanelDeps {
    i18n: Record<string, string>;
    settings: SettingsService;
    /** Concrete client, so the "test connection" button can probe an unsaved value. */
    api: JuejinApi & { setCredentialOverride?: (sessionId: string | null) => void };
    logger: Logger;
    onSaved?: (settings: SyncSettings) => void;
}

interface PanelState {
    settings: SyncSettings;
    meta: JuejinMetaCache | null;
    sessionInput: string;
    categoryId: string;
    tagIds: string[];
}

/** Mask a credential for display: keep the first 3 characters only. */
function maskValue(value: string): string {
    if (value.length <= 3) {
        return "***";
    }
    return `${value.slice(0, 3)}***`;
}

export class SettingsPanel {
    private readonly deps: SettingsPanelDeps;
    private state: PanelState | null = null;
    private dialog: Dialog | null = null;
    /** Re-renders the "current credential" line after a successful save. */
    private refreshCredentialView?: () => Promise<void>;
    /** The credential input, cleared once the secret is persisted. */
    private sessionInputEl?: HTMLInputElement;

    constructor(deps: SettingsPanelDeps) {
        this.deps = deps;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return textOf(this.deps.i18n, key, params);
    }

    /** Open (or re-open) the settings dialog. */
    async open(): Promise<void> {
        const settings = await this.deps.settings.load();
        const meta = await this.deps.settings.loadMeta();
        const credential = await this.deps.settings.getCredential();
        this.state = {
            settings,
            meta,
            sessionInput: "",
            categoryId: settings.defaultCategoryId,
            tagIds: [...settings.defaultTagIds],
        };
        this.refreshCredentialView = undefined;
        this.sessionInputEl = undefined;

        this.dialog?.destroy();
        const dialog = new Dialog({
            title: this.t("settings.title"),
            content: '<div class="jjs-root jjs-settings"></div>',
            width: "min(820px, 94vw)",
        });
        this.dialog = dialog;
        const root = dialog.element.querySelector(".jjs-settings");
        if (!(root instanceof HTMLElement)) {
            return;
        }
        root.append(
            this.buildAccountGroup(credential),
            this.buildSyncGroup(),
            this.buildAdvancedGroup(),
        );
    }

    /* ---------------- group 1: account & credential ---------------- */

    private buildAccountGroup(credential: Awaited<ReturnType<SettingsService["getCredential"]>>): HTMLElement {
        const state = this.state as PanelState;
        const group = el("div", { class: "jjs-group" }, [el("div", { class: "jjs-group__title", text: this.t("settings.group.account") })]);
        const probeLine = el("div", { class: "jjs-hint" });

        group.append(hint(this.t("settings.risk.notice"), "jjs-hint jjs-hint--warn"));

        const risk = checkbox(this.t("settings.risk.confirm"), state.settings.riskAccepted, (checked) => {
            state.settings = { ...state.settings, riskAccepted: checked };
            saveButton.disabled = !checked;
            if (checked && probeLine.classList.contains("jjs-hint--error")) {
                probeLine.className = "jjs-hint";
                probeLine.textContent = "";
            }
        });
        group.append(risk.root);

        const input = textInput({
            value: "",
            type: "password",
            placeholder: this.t("settings.sessionId.placeholder"),
            onInput: (value) => {
                state.sessionInput = value.trim();
            },
        });
        this.sessionInputEl = input;
        group.append(field(this.t("settings.sessionId.label"), input, { hint: this.t("settings.sessionId.hint") }));

        const storageLine = el("div", { class: "jjs-hint" });
        const renderStorageLine = (current: typeof credential): void => {
            if (!current) {
                storageLine.textContent = this.t("settings.credential.none");
                return;
            }
            const form = current.source === "vault" ? this.t("settings.storage.vault") : this.t("settings.storage.plain");
            const masked = this.t("settings.sessionId.savedMask", { mask: maskValue(current.sessionId) });
            const name = current.userName ? ` · ${current.userName}` : "";
            storageLine.textContent = `${masked}${name} · ${form}`;
        };
        renderStorageLine(credential);
        this.refreshCredentialView = async (): Promise<void> => {
            renderStorageLine(await this.deps.settings.getCredential());
        };
        group.append(storageLine);

        const probeButton = button(this.t("settings.test.button"), () => {
            void (async () => {
                if (!state.settings.riskAccepted) {
                    probeLine.className = "jjs-hint jjs-hint--error";
                    probeLine.textContent = this.t("settings.test.needRisk");
                    return;
                }
                probeButton.disabled = true;
                probeLine.className = "jjs-hint";
                probeLine.textContent = this.t("settings.test.testing");
                const probe = await this.probe(state.sessionInput || null);
                probeButton.disabled = false;
                this.renderProbe(probeLine, probe);
            })();
        });

        const saveButton = button(
            this.t("settings.save.button"),
            () => {
                void this.save(probeLine);
            },
            { kind: "primary" },
        );
        saveButton.disabled = !state.settings.riskAccepted;

        const clearButton = button(
            this.t("settings.credential.clear"),
            () => {
                void (async () => {
                    const vaultRemains = await this.deps.settings.clearCredential();
                    probeLine.className = "jjs-hint";
                    probeLine.textContent = vaultRemains
                        ? `${this.t("settings.credential.cleared")} ${this.t("settings.credential.vaultRemains")}`
                        : this.t("settings.credential.cleared");
                })();
            },
            { kind: "danger" },
        );

        group.append(row([probeButton, saveButton, clearButton], "jjs-row"));
        group.append(probeLine);

        // Endpoint self-check lives in the advanced group (A5), not here.
        return group;
    }

    /** Run a probe, optionally with the value typed into the input. */
    private async probe(sessionId: string | null): Promise<CredentialProbe> {
        const override = sessionId && sessionId.length > 0 ? sessionId : null;
        this.deps.api.setCredentialOverride?.(override);
        try {
            return await this.deps.api.probeCredential();
        } finally {
            this.deps.api.setCredentialOverride?.(null);
        }
    }

    /** Render the three states without classifying anything locally (FR-01). */
    private renderProbe(target: HTMLElement, probe: CredentialProbe): void {
        clear(target);
        if (probe.state === "valid") {
            target.className = "jjs-hint";
            target.append(
                badge(this.t("common.ok"), "ok"),
                document.createTextNode(" "),
                document.createTextNode(this.t("settings.test.ok", { name: probe.user?.userName ?? "" })),
            );
            return;
        }
        if (probe.state === "not-configured") {
            // Nothing was sent: this is not an expired credential and must not say so.
            target.className = "jjs-hint jjs-hint--warn";
            target.append(
                badge(this.t("settings.credential.none"), "warn"),
                document.createTextNode(" "),
                document.createTextNode(this.t("sync.blocked.noCredential")),
            );
            return;
        }
        if (probe.state === "expired") {
            target.className = "jjs-hint jjs-hint--error";
            target.append(
                badge(this.t("settings.credential.clear"), "error"),
                document.createTextNode(" "),
                document.createTextNode(this.t("settings.test.expired")),
            );
        } else {
            target.className = "jjs-hint jjs-hint--warn";
            target.append(
                badge(this.t("settings.probe.unreachable"), "warn"),
                document.createTextNode(" "),
                document.createTextNode(this.t("settings.test.network")),
            );
        }
        target.append(
            details(this.t("err.title"), [
                kv("err_no", String(probe.errNo ?? "")),
                kv("err_msg", probe.errMsg ?? ""),
                kv("http", String(probe.httpStatus ?? "")),
                kv("elapsed", `${probe.elapsedMs}ms`),
            ]),
        );
    }

    /** Persist the settings (and the credential when the user typed a fresh one). */
    private async save(probeLine: HTMLElement): Promise<void> {
        const state = this.state as PanelState;
        if (!state.settings.riskAccepted) {
            probeLine.className = "jjs-hint jjs-hint--error";
            probeLine.textContent = this.t("settings.save.noRisk");
            return;
        }
        try {
            // Settings must be written *before* the credential: `setCredential()` re-reads the
            // risk flag from disk and refuses to store a secret while it is still false, so the
            // old order (credential first) made the very first save fail unconditionally.
            const saved = await this.deps.settings.save({
                ...state.settings,
                defaultCategoryId: state.categoryId,
                defaultTagIds: state.tagIds,
            });
            state.settings = saved;

            if (state.sessionInput.length > 0) {
                await this.deps.settings.setCredential(state.sessionInput);
                const probe = await this.probe(null);
                if (probe.state === "valid") {
                    if (probe.user?.userName) {
                        await this.deps.settings.setCredentialUserName(probe.user.userName);
                    }
                    probeLine.className = "jjs-hint";
                    probeLine.textContent = this.t("settings.save.ok");
                } else {
                    // Keep the real reason (expired / unreachable) visible instead of a generic hint.
                    this.renderProbe(probeLine, probe);
                }
                state.sessionInput = "";
                if (this.sessionInputEl) {
                    this.sessionInputEl.value = "";
                }
                await this.refreshCredentialView?.();
            } else {
                probeLine.className = "jjs-hint";
                probeLine.textContent = this.t("settings.save.ok");
            }
            this.deps.onSaved?.(saved);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            probeLine.className = "jjs-hint jjs-hint--error";
            probeLine.textContent = this.t("settings.save.failed", { msg: message });
        }
    }

    /* ---------------- group 2: sync defaults ---------------- */

    private buildSyncGroup(): HTMLElement {
        const state = this.state as PanelState;
        const group = el("div", { class: "jjs-group" }, [el("div", { class: "jjs-group__title", text: this.t("settings.group.sync") })]);

        const metaLine = el("div", { class: "jjs-hint" });
        const categoryHolder = el("div", { class: "jjs-field__body" });
        const tagHolder = el("div", { class: "jjs-field__body" });

        const renderMeta = (): void => {
            clear(categoryHolder);
            clear(tagHolder);
            const categories = state.meta?.categories ?? [];
            const tags = state.meta?.tags ?? [];
            if (categories.length === 0) {
                categoryHolder.append(hint(this.t("settings.category.empty")));
            } else {
                categoryHolder.append(
                    selectField(
                        categories.map((item) => ({ value: item.id, label: item.name })),
                        state.categoryId,
                        (value) => {
                            state.categoryId = value;
                        },
                    ),
                );
            }
            if (tags.length === 0) {
                tagHolder.append(hint(this.t("settings.tag.empty")));
            } else {
                const chips = chipInput({
                    all: tags,
                    selected: state.tagIds,
                    searchPlaceholder: this.t("settings.tag.searchPlaceholder"),
                    selectedLabel: (count) => this.t("settings.tag.selected", { n: count }),
                    onChange: (selected) => {
                        state.tagIds = selected;
                    },
                    // Same defect as the sync dialog: the cache is a page of popular tags, so the
                    // long tail has to be searched upstream or it cannot be picked at all.
                    onSearch: (keyword) => this.deps.api.searchTags(keyword),
                    labels: {
                        searching: this.t("settings.tag.searching"),
                        empty: this.t("settings.tag.noMatch"),
                        failed: this.t("settings.tag.searchFailed"),
                        // Same "never render a raw id" rule as the sync dialog.
                        unknown: this.t("settings.tag.unnamed"),
                        remove: this.t("sync.dialog.tagRemove"),
                    },
                });
                tagHolder.append(chips.root);
                // Cached meta written by an older build can carry ids in place of names; say so
                // instead of showing a wall of 19-digit numbers with no explanation.
                if (tags.every((item) => isUnnamedTag(item.name))) {
                    tagHolder.append(hint(this.t("settings.tag.staleNames"), "jjs-hint jjs-hint--warn"));
                }
            }
        };
        renderMeta();

        const fetchButton = button(this.t("settings.fetch.button"), () => {
            void (async () => {
                fetchButton.disabled = true;
                metaLine.className = "jjs-hint";
                metaLine.textContent = this.t("settings.fetch.fetching");
                try {
                    const probe = await this.probe(null);
                    if (probe.state !== "valid") {
                        this.renderProbe(metaLine, probe);
                        return;
                    }
                    const categories = await this.deps.api.fetchCategories();
                    const popular = await this.deps.api.fetchTags();
                    let extra: typeof popular = [];
                    try {
                        extra = await this.deps.api.fetchFeedTags();
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        this.deps.logger.warn(`feed tag collection skipped: ${message}`);
                    }
                    // Merge, never replace: the popular page is only ten tags, and a pool the user
                    // has widened (imported tags) must survive a refresh.
                    const tags = mergeTags(state.meta?.tags ?? [], [...popular, ...extra]);
                    state.meta = {
                        categories,
                        tags,
                        fetchedAt: new Date().toISOString(),
                        userName: probe.user?.userName,
                    };
                    await this.deps.settings.saveMeta(state.meta);
                    if (categories.length === 0) {
                        metaLine.className = "jjs-hint jjs-hint--warn";
                        metaLine.textContent = this.t("settings.fetch.emptyGuide");
                    } else {
                        metaLine.className = "jjs-hint";
                        metaLine.textContent = this.t("settings.fetch.ok", { categories: categories.length, tags: tags.length });
                    }
                    if (!state.categoryId && categories.length > 0) {
                        state.categoryId = categories[0].id;
                    }
                    renderMeta();
                } catch (error) {
                    metaLine.className = "jjs-hint jjs-hint--error";
                    const message = error instanceof Error ? error.message : String(error);
                    metaLine.textContent = this.t("settings.fetch.failed", { msg: message.slice(0, 160) });
                    this.deps.logger.warn(`fetch meta failed: ${message}`);
                } finally {
                    fetchButton.disabled = false;
                }
            })();
        });
        group.append(row([fetchButton]), metaLine);

        group.append(field(this.t("settings.category.label"), categoryHolder));
        group.append(field(this.t("settings.tag.label"), tagHolder));

        const modeSelect = selectField(
            [
                { value: "draft", label: this.t("settings.mode.draft") },
                { value: "publish", label: this.t("settings.mode.publish") },
            ],
            state.settings.publishMode,
            (value) => {
                state.settings = { ...state.settings, publishMode: value === "publish" ? "publish" : "draft" };
                modeHint.textContent = this.t("settings.mode.publishWarn");
            },
        );
        const modeHint = hint(this.t("settings.mode.publishWarn"));
        group.append(field(this.t("settings.mode.label"), modeSelect));
        group.append(modeHint);

        const autoUpload = checkbox(this.t("settings.autoUpload.label"), state.settings.autoUploadImages, (checked) => {
            state.settings = { ...state.settings, autoUploadImages: checked };
        });
        group.append(autoUpload.root);
        group.append(hint(this.t("settings.autoUpload.hint")));

        const docMenu = checkbox(this.t("settings.showInDocMenu.label"), state.settings.showInDocMenu, (checked) => {
            state.settings = { ...state.settings, showInDocMenu: checked };
        });
        group.append(docMenu.root);

        const prefix = textInput({
            value: state.settings.titlePrefix,
            onInput: (value) => {
                state.settings = { ...state.settings, titlePrefix: value };
            },
        });
        const suffix = textInput({
            value: state.settings.titleSuffix,
            onInput: (value) => {
                state.settings = { ...state.settings, titleSuffix: value };
            },
        });
        group.append(
            el("div", { class: "jjs-row" }, [
                field(this.t("settings.titlePrefix.label"), prefix),
                field(this.t("settings.titleSuffix.label"), suffix),
            ]),
        );

        const appendLink = checkbox(this.t("settings.appendLink.label"), state.settings.appendLinkToDoc, (checked) => {
            state.settings = { ...state.settings, appendLinkToDoc: checked };
        });
        group.append(appendLink.root);

        const timeout = textInput({
            type: "number",
            value: String(state.settings.syncTimeoutMs),
            onInput: (value) => {
                state.settings = { ...state.settings, syncTimeoutMs: Number(value) || state.settings.syncTimeoutMs };
            },
        });
        const interval = textInput({
            type: "number",
            value: String(state.settings.requestIntervalMs),
            onInput: (value) => {
                state.settings = { ...state.settings, requestIntervalMs: Number(value) || 0 };
            },
        });
        group.append(
            el("div", { class: "jjs-row" }, [
                field(this.t("settings.timeout.label"), timeout),
                field(this.t("settings.interval.label"), interval),
            ]),
        );

        return group;
    }

    /* ---------------- group 3: advanced / experimental ---------------- */

    private buildAdvancedGroup(): HTMLElement {
        const state = this.state as PanelState;
        const group = el("div", { class: "jjs-group" }, [
            el("div", { class: "jjs-group__title", text: this.t("settings.group.advanced") }),
        ]);

        const enableImport = checkbox(
            this.t("settings.enableImport.label"),
            state.settings.enableReverseImport,
            (checked) => {
                state.settings = { ...state.settings, enableReverseImport: checked };
            },
        );
        group.append(enableImport.root);

        const importPath = textInput({
            value: state.settings.reverseImportPathTemplate,
            placeholder: this.t("import.path.defaultTemplate"),
            onInput: (value) => {
                state.settings = { ...state.settings, reverseImportPathTemplate: value };
            },
        });
        group.append(field(this.t("settings.importPath.label"), importPath));

        const overwrite = checkbox(this.t("settings.importOverwrite.label"), state.settings.reverseImportOverwrite, (checked) => {
            state.settings = { ...state.settings, reverseImportOverwrite: checked };
        });
        group.append(overwrite.root);

        // A5: collapsed by default so it never distracts from the normal flow.
        const probeBody = el("div", { class: "jjs-row jjs-row--end" });
        const probeResult = el("div");
        const selfCheck = details(this.t("settings.selfcheck.title"), [probeBody, probeResult], false);
        probeBody.append(
            button(this.t("settings.selfcheck.run"), () => {
                void (async () => {
                    clear(probeResult);
                    probeResult.append(hint(this.t("settings.probe.running")));
                    const probes = await this.deps.api.probeEndpoints();
                    clear(probeResult);
                    /*
                     * A route Juejin genuinely does not have is not a failure of this plugin: the
                     * degraded path is already implemented. Counting it as "unreachable" made a
                     * healthy install read as 11/14 broken, so it is reported separately.
                     */
                    const expectedMissing = probes.filter((item) => item.determinism === "known-missing").length;
                    const okCount = probes.filter((item) => item.reachable).length;
                    const total = probes.length - expectedMissing;
                    const broken = probes.filter((item) => !item.reachable && item.determinism !== "known-missing").length;
                    probeResult.append(
                        broken === 0
                            ? hint(this.t("settings.probe.done", { ok: okCount, total }))
                            : hint(this.t("settings.probe.doneBroken", { ok: okCount, total, bad: broken }), "jjs-hint jjs-hint--warn"),
                    );
                    if (expectedMissing > 0) {
                        probeResult.append(hint(this.t("settings.probe.knownMissingNote", { n: expectedMissing })));
                    }
                    probeResult.append(this.buildProbeTable(probes));
                })();
            }),
        );
        probeResult.append(hint(this.t("settings.selfcheck.empty")));
        group.append(selfCheck);

        group.append(
            row([
                button(this.t("settings.reset.button"), () => {
                    void (async () => {
                        state.settings = await this.deps.settings.reset();
                        this.deps.onSaved?.(state.settings);
                        if (this.dialog) {
                            await this.open();
                        }
                    })();
                }, { kind: "danger" }),
            ], "jjs-row jjs-row--end"),
        );

        return group;
    }

    /** Rows of `name / url / reachable / determinism / observed` (raw, untranslated). */
    private buildProbeTable(probes: EndpointProbe[]): HTMLElement {
        const list = el("div", { class: "jjs-list" });
        probes.forEach((probe) => {
            const expectedMissing = probe.determinism === "known-missing";
            const tone = probe.reachable ? "ok" : expectedMissing ? "muted" : "error";
            const label = probe.reachable
                ? this.t("settings.probe.reachable")
                : expectedMissing
                  ? this.t("settings.probe.knownMissing")
                  : this.t("settings.probe.unreachable");
            const line = el("div", { class: "jjs-row" }, [
                badge(label, tone),
                el("span", { class: "jjs-mono", text: probe.name }),
                el("span", { class: "jjs-mono", text: this.t(`settings.probe.${probe.determinism}`) }),
                el("span", { class: "jjs-mono", text: probe.observed ?? "" }),
            ]);
            line.title = probe.url;
            list.append(line);
        });
        return list;
    }
}

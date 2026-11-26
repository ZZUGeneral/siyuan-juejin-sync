/**
 * Dock panel: the persistent entry point (FR-03).
 *
 * The dock is usually only 150–200 px wide, so the layout is a single column of *cards* rather
 * than a column of loose lines:
 *
 *   status card  → what document is this, what state is it in, when was it last synced
 *   primary verb → one full-width button (sync), disabled reasons are explained by the card
 *   secondary    → refresh / settings, de-emphasised so they never compete with the verb
 *   last result  → compact; falls back to the full panel when an image failed (A3)
 *   history      → collapsed
 *
 * One fact is stated exactly once. The status used to be rendered twice (a banner plus a badge
 * with the *same* sentence), which is what made the old panel feel unclear; the banner is
 * therefore deliberately not drawn here — the card owns the status, and `state.banner` stays
 * available for surfaces that only have room for a single line.
 *
 * The panel never talks to the network: every action is delegated to `index.ts`, which keeps
 * the wiring in one place and the dock testable.
 */
import type { DockStatus, SyncState, SyncStore } from "../core/store";
import { textOf } from "../core/i18n";
import type { I18nBundle } from "../types";
import {
    button,
    clear,
    details,
    el,
    ghostButton,
    hint,
    progressBar,
    type BadgeTone,
} from "./components";
import { stamp } from "./format";
import type { ImportPanel } from "./importPanel";
import type { ResultPanel } from "./resultPanel";

/** Label + tone of each dock status. Kept short: the card has one narrow line to work with. */
const STATUS_LABEL: Record<DockStatus, { key: string; tone: BadgeTone }> = {
    unsynced: { key: "sync.status.unsynced", tone: "muted" },
    syncing: { key: "sync.status.syncing", tone: "info" },
    draft: { key: "sync.status.draft", tone: "ok" },
    published: { key: "sync.status.published", tone: "ok" },
    imported: { key: "sync.status.imported", tone: "info" },
    failed: { key: "sync.status.failed", tone: "error" },
    unknown: { key: "sync.status.unknown", tone: "warn" },
};

export interface DockPanelDeps {
    i18n: I18nBundle;
    store: SyncStore;
    resultPanel: ResultPanel;
    importPanel: ImportPanel;
    /**
     * FR-03① entry toggle: when `false` the sync tab and its actions are hidden. Read lazily on
     * every render, so a settings change takes effect on the next mount without re-creating the
     * dock.
     */
    isSyncEnabled: () => boolean;
    /** FR-03 / `enableReverseImport`: when `false` the import tab is hidden. */
    isImportEnabled: () => boolean;
    onSync: () => void;
    onRefresh: () => void;
    onOpenSettings: () => void;
}

type DockTab = "sync" | "import";

export class DockPanel {
    private readonly deps: DockPanelDeps;
    private tabs: HTMLElement | null = null;
    private content: HTMLElement | null = null;
    private unsubscribe: (() => void) | null = null;
    private active: DockTab = "sync";

    constructor(deps: DockPanelDeps) {
        this.deps = deps;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return textOf(this.deps.i18n, key, params);
    }

    /** Build the panel inside `host`; call once per dock instance. */
    mount(host: HTMLElement): void {
        this.dispose();
        clear(host);
        host.className = "jjs-dock";
        this.tabs = el("div", { class: "jjs-tabs" });
        this.content = el("div", { class: "jjs-dock__content jjs-root" });
        host.append(this.tabs, this.content);
        this.renderTabs();
        this.renderContent();
        this.unsubscribe = this.deps.store.subscribe(() => {
            // Only the sync tab depends on the store; remounting the import form would throw
            // away a half-filled link while the user is working in it.
            if (this.active === "sync") {
                this.renderContent();
            }
        });
    }

    /**
     * Switch to the import tab.
     *
     * @returns `false` when the dock was never mounted (first run or dock hidden), so the caller
     *          can show a hint instead of silently doing nothing.
     */
    focusImport(): boolean {
        if (!this.content) {
            return false;
        }
        if (this.active !== "import") {
            this.active = "import";
            this.renderTabs();
            this.renderContent();
        }
        return true;
    }

    /**
     * Re-render tabs and content after a settings change (FR-03①).
     *
     * Safe before `mount()` (first load) — it becomes a no-op, which is what we want because the
     * initial `mount` will render with the settings already applied.
     */
    refresh(): void {
        if (!this.content) {
            return;
        }
        this.renderTabs();
        this.renderContent();
    }

    /** Detach listeners; safe to call multiple times. */
    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.tabs = null;
        this.content = null;
    }

    /* ---------------- tabs ---------------- */

    private renderTabs(): void {
        if (!this.tabs) {
            return;
        }
        clear(this.tabs);
        const entries: Array<{ id: DockTab; label: string }> = [];
        if (this.deps.isSyncEnabled()) {
            entries.push({ id: "sync", label: this.t("sync.dock.tab.sync") });
        }
        if (this.deps.isImportEnabled()) {
            entries.push({ id: "import", label: this.t("sync.dock.tab.import") });
        }
        if (entries.length === 0) {
            // FR-03①: every entry is switched off — say so instead of showing a dead panel.
            this.tabs.append(hint(this.t("plugin.entry.disabled"), "jjs-hint"));
            return;
        }
        if (!entries.some((entry) => entry.id === this.active)) {
            this.active = entries[0].id;
        }
        entries.forEach((entry) => {
            const active = this.active === entry.id;
            const tab = el("button", {
                class: `jjs-tab${active ? " jjs-tab--active" : ""}`,
                text: entry.label,
                attrs: { type: "button" },
            });
            tab.addEventListener("click", () => {
                if (this.active === entry.id) {
                    return;
                }
                this.active = entry.id;
                this.renderTabs();
                this.renderContent();
            });
            this.tabs?.append(tab);
        });
    }

    private renderContent(): void {
        if (!this.content) {
            return;
        }
        clear(this.content);
        if (this.active === "import" && this.deps.isImportEnabled()) {
            this.deps.importPanel.mount(this.content);
            return;
        }
        if (this.active === "sync" && this.deps.isSyncEnabled()) {
            this.renderSync(this.content);
            return;
        }
        this.content.append(hint(this.t("plugin.entry.disabled"), "jjs-hint"));
    }

    /* ---------------- sync tab ---------------- */

    private renderSync(host: HTMLElement): void {
        const state = this.deps.store.getState();

        host.append(this.buildStatusCard(state));

        // FR-10②: the plugin cannot see a publish performed on the website, so a local "draft"
        // is a hint, not a fact. The dock gets the one-line version; the long explanation stays in
        // the dialog and on the tooltip.
        if (state.status === "draft") {
            const draftHint = hint(this.t("sync.dock.hint.draft"), "jjs-hint jjs-hint--inset");
            draftHint.title = this.t("sync.hint.maybePublished");
            host.append(draftHint);
        }

        host.append(this.buildActions(state));

        const result = state.lastResult;
        if (result) {
            const card = el("div", { class: "jjs-card" }, [
                el("div", { class: "jjs-card__title", text: this.t("sync.dock.result.title") }),
            ]);
            this.deps.resultPanel.renderSummary(card, result, () => {
                this.deps.resultPanel.open(result);
            });
            host.append(card);
        }

        if (state.history.length > 0) {
            host.append(this.buildHistory(state));
        }
    }

    /**
     * The card that answers the three questions a user actually has: which document is bound,
     * what state is it in, and when did that state come from.
     */
    private buildStatusCard(state: SyncState): HTMLElement {
        const status = STATUS_LABEL[state.status] ?? STATUS_LABEL.unsynced;
        const hasDoc = state.docId.length > 0;
        const card = el("div", { class: `jjs-card jjs-status jjs-status--${status.tone}` }, [
            el("div", { class: "jjs-status__top" }, [
                el("span", { class: "jjs-dot" }),
                el("span", { class: "jjs-status__label", text: this.t(status.key) }),
                el("span", { class: "jjs-status__spacer" }),
                // The Juejin entry sits on the status line: it belongs to the state ("a draft
                // exists"), and the meta line below has to stay short enough for a 150 px dock.
                hasDoc && state.juejinUrl.length > 0
                    ? el("button", {
                          class: "jjs-link",
                          text: this.t("sync.dock.openJuejin"),
                          title: state.juejinUrl,
                          attrs: { type: "button" },
                          on: {
                              click: () => {
                                  window.open(state.juejinUrl, "_blank");
                              },
                          },
                      })
                    : null,
            ]),
        ]);

        if (!hasDoc) {
            card.append(el("div", { class: "jjs-status__title", text: this.t("sync.dock.emptyTitle") }));
            card.append(el("div", { class: "jjs-status__meta", text: this.t("sync.dock.emptyHint") }));
            return card;
        }

        // Two lines maximum: a long document title must not push the actions off the panel.
        card.append(
            el("div", {
                class: "jjs-status__title",
                text: state.docTitle || state.docId,
                title: state.docTitle || state.docId,
            }),
        );

        // Only drawn when there is something to say: "not synced yet" would repeat the status
        // word three lines above, and a synced document with a trimmed history must not claim it
        // was never synced.
        const lastAt = this.lastSyncAt(state);
        if (lastAt.length > 0) {
            card.append(
                el("div", { class: "jjs-status__meta" }, [
                    el("span", { text: this.t("sync.dock.meta.last", { time: lastAt }), title: lastAt }),
                ]),
            );
        }

        if (state.busy) {
            const label = state.progress ? this.t(state.progress.label) : this.t("sync.status.syncing");
            card.append(el("div", { class: "jjs-status__busy", text: label }));
            card.append(progressBar(state.progress?.done ?? 0, state.progress?.total ?? 0));
        }

        return card;
    }

    /** Newest sync stamp of *this* document, or `""` when it was never synced. */
    private lastSyncAt(state: SyncState): string {
        const entry = state.history.find((item) => item.docId === state.docId);
        return entry ? stamp(entry.at) : "";
    }

    private buildActions(state: SyncState): HTMLElement {
        const hasDoc = state.docId.length > 0;
        const label = state.busy ? this.t("sync.dock.busyButton") : this.t("sync.dock.syncButton");
        const primary = button(label, () => this.deps.onSync(), {
            kind: "primary",
            class: "jjs-button--block",
        });
        primary.disabled = state.busy || !hasDoc;

        const secondary = el("div", { class: "jjs-actions" }, [
            ghostButton(this.t("sync.dock.refresh"), () => this.deps.onRefresh(), { disabled: state.busy }),
            ghostButton(this.t("sync.dock.settings"), () => this.deps.onOpenSettings()),
        ]);

        return el("div", { class: "jjs-actions-block" }, [primary, secondary]);
    }

    private buildHistory(state: SyncState): HTMLElement {
        const rows = state.history.map((entry) => {
            const tone = entry.ok ? "ok" : "error";
            return el("div", { class: "jjs-history", title: entry.error ?? "" }, [
                el("span", { class: `jjs-dot jjs-dot--${tone}` }),
                el("span", { class: "jjs-history__time", text: stamp(entry.at) }),
                el("span", { class: "jjs-history__title", text: entry.docTitle || entry.docId }),
            ]);
        });
        return details(this.t("sync.history.title"), rows, false);
    }
}

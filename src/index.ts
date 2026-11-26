/**
 * Plugin entry point — the only place that knows about *all* the layers.
 *
 * Responsibilities:
 *  - build the service graph once (settings → api → core → ui),
 *  - register the entry points (dock, commands, document-title menu),
 *  - resolve the document the action should apply to,
 *  - clean up on unload / uninstall.
 *
 * Dependency direction stays one-way: `ui -> core -> api -> types`. `index.ts` is the composition
 * root, so it may import from every layer, but nothing imports from `index.ts`.
 */
import { Plugin, getFrontend, showMessage, type IProtyle, type subMenu } from "siyuan";
import "./ui/styles.scss";
import { KernelClient } from "./api/kernel";
import { draftUrl, JuejinClient } from "./api/juejin";
import { HttpProxy } from "./api/proxy";
import { BindingService } from "./core/binding";
import { createI18n, textOf } from "./core/i18n";
import { Importer } from "./core/importer";
import { ImagePipeline } from "./core/images";
import { createLogger, type Logger } from "./core/logger";
import { rankRecentDocs } from "./core/recentDocs";
import { SettingsService } from "./core/settings";
import { SyncStore, type BannerKind, type SyncState } from "./core/store";
import { SyncEngine } from "./core/syncEngine";
import { IDS, EVENTS, type DocBinding, type SyncResult, type SyncSettings } from "./types";
import { DockPanel } from "./ui/dockPanel";
import { ImportPanel } from "./ui/importPanel";
import { ResultPanel } from "./ui/resultPanel";
import { SettingsPanel } from "./ui/settingsPanel";
import { SyncDialog } from "./ui/syncDialog";

/** Indirection that lets us forward state changes through the untyped custom event name. */
interface EventEmitterLike {
    emit: (type: string, detail?: unknown) => void;
}

/** Detail payload of the `click-editortitleicon` hook we subscribe to. */
interface EditorTitleIconEvent {
    menu: subMenu;
    protyle: IProtyle;
    data?: { id?: string };
}

/** Icon registered with `addIcons`; also referenced by `plugin.json`-independent UI code. */
const ICON_SVG = `<symbol id="iconJuejinSync" viewBox="0 0 32 32">
<path fill="currentColor" d="M16 2.2 3.8 9.3v13.4L16 29.8l12.2-7.1V9.3L16 2.2zm0 3.1 9.1 5.3v10.8L16 26.7l-9.1-5.3V10.6L16 5.3z"/>
<path fill="currentColor" d="M20.7 10.6h-3.1v7.2c0 1.4-.7 2.2-1.9 2.2-1 0-1.7-.6-2-1.6l-2.7 1.1c.6 2.1 2.4 3.4 4.8 3.4 2.9 0 4.9-1.8 4.9-4.8v-7.5z"/>
</symbol>`;

export default class JuejinSyncPlugin extends Plugin {
    private logger!: Logger;
    private settings!: SettingsService;
    private kernelClient!: KernelClient;
    private proxy!: HttpProxy;
    private api!: JuejinClient;
    private binding!: BindingService;
    private pipeline!: ImagePipeline;
    private store!: SyncStore;
    private engine!: SyncEngine;
    private importer!: Importer;

    private settingsPanel!: SettingsPanel;
    private syncDialog!: SyncDialog;
    private resultPanel!: ResultPanel;
    private importPanel!: ImportPanel;
    private dockPanel: DockPanel | null = null;

    /** Document the next action applies to; refreshed by every entry point. */
    private activeDocId = "";
    /** Synchronous mirror of `settings.showInDocMenu`, so the context menu stays synchronous. */
    private showInDocMenu = true;
    /** Mirror of `settings.enableReverseImport`: the import entry is opt-in (FR-03). */
    private enableReverseImport = false;
    /** Guards against persisting the same history entry twice. */
    private lastPersistedStart = "";
    /** Delayed first-paint probe for the already-open document (cleared in `onunload`). */
    private initialDocTimer: number | null = null;

    /* ------------------------------------------------------------------ *
     * lifecycle
     * ------------------------------------------------------------------ */

    override async onload(): Promise<void> {
        this.i18n = createI18n(this.i18n);
        this.logger = createLogger("boot");

        this.settings = new SettingsService({ plugin: this, logger: this.logger });
        this.kernelClient = new KernelClient({ app: this.app, logger: createLogger("kernel") });

        const proxy = new HttpProxy({
            timeoutMs: 30000,
            minIntervalMs: 1000,
            logger: createLogger("proxy"),
        });
        this.proxy = proxy;
        this.api = new JuejinClient({
            getCredential: () => this.settings.getCredential(),
            proxy,
            logger: createLogger("juejin"),
        });
        this.binding = new BindingService({ kernel: this.kernelClient, logger: createLogger("engine") });
        this.pipeline = new ImagePipeline({
            api: this.api,
            kernel: this.kernelClient,
            logger: createLogger("images"),
            uploadEnabled: true,
        });
        this.store = new SyncStore((state) => this.broadcast(state));
        this.engine = new SyncEngine({
            kernel: this.kernelClient,
            api: this.api,
            settings: this.settings,
            binding: this.binding,
            pipeline: this.pipeline,
            store: this.store,
            logger: createLogger("engine"),
            translate: (key, params) => this.t(key, params),
        });
        this.importer = new Importer({
            api: this.api,
            kernel: this.kernelClient,
            binding: this.binding,
            settings: this.settings,
            logger: createLogger("import"),
            translate: (key, params) => this.t(key, params),
            replaceDocContent: (docId, markdown) => this.kernelClient.replaceDocContent(docId, markdown),
        });

        this.resultPanel = new ResultPanel({
            i18n: this.i18n,
            engine: this.engine,
            kernel: this.kernelClient,
            logger: createLogger("ui"),
        });
        this.settingsPanel = new SettingsPanel({
            i18n: this.i18n,
            settings: this.settings,
            api: this.api,
            logger: createLogger("settings"),
            onSaved: (settings) => this.applySettings(settings),
        });
        this.syncDialog = new SyncDialog({
            i18n: this.i18n,
            engine: this.engine,
            settings: this.settings,
            api: this.api,
            logger: createLogger("ui"),
            onDone: (result) => this.handleResult(result),
        });
        this.importPanel = new ImportPanel({
            i18n: this.i18n,
            importer: this.importer,
            kernel: this.kernelClient,
            settings: this.settings,
            logger: createLogger("import"),
            onImported: (result) => this.logger.info(`import finished ok=${result.ok}`),
        });
        this.dockPanel = new DockPanel({
            i18n: this.i18n,
            store: this.store,
            resultPanel: this.resultPanel,
            importPanel: this.importPanel,
            isSyncEnabled: () => this.showInDocMenu,
            isImportEnabled: () => this.enableReverseImport,
            onSync: () => {
                void this.syncDoc(this.activeDocId);
            },
            onRefresh: () => {
                // Resolve from scratch: the cached id can be stale after a reload or a tab switch.
                void this.refreshActiveDoc("");
            },
            onOpenSettings: () => {
                void this.openSettings();
            },
        });

        const initial = await this.settings.load();
        this.applySettings(initial);

        this.addIcons(ICON_SVG);
        this.registerCommands();
        this.registerDock();
        this.logger.info("plugin loaded");
    }

    override async onLayoutReady(): Promise<void> {
        try {
            const history = await this.settings.loadHistory();
            this.store.setHistory(history);
        } catch (error) {
            this.logger.warn(`history restore failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.eventBus.on("click-editortitleicon", this.onEditorTitleIcon);
        this.eventBus.on("switch-protyle", this.onSwitchProtyle);
        /*
         * `switch-protyle` only fires when the user *changes* document, so the document that is
         * already open when the plugin loads never produces an event. Without an explicit probe the
         * dock sits on "open a document first" even though one is right there. Two attempts: the
         * first once the layout is up, the second after the editor has finished rendering.
         */
        void this.refreshActiveDoc("");
        this.initialDocTimer = window.setTimeout(() => {
            if (this.activeDocId.length === 0) {
                void this.refreshActiveDoc("");
            }
        }, 1200);
    }

    override async onunload(): Promise<void> {
        if (this.initialDocTimer !== null) {
            window.clearTimeout(this.initialDocTimer);
            this.initialDocTimer = null;
        }
        this.eventBus.off("click-editortitleicon", this.onEditorTitleIcon);
        this.eventBus.off("switch-protyle", this.onSwitchProtyle);
        this.dockPanel?.dispose();
        this.dockPanel = null;
        this.logger.info("plugin unloaded");
    }

    override async uninstall(): Promise<void> {
        await this.settings.clearAll();
    }

    /* ------------------------------------------------------------------ *
     * registration
     * ------------------------------------------------------------------ */

    private registerCommands(): void {
        // FR-03①: one toggle governs all three entries (menu / command / dock).
        // Commands cannot be un-registered at runtime, so this is read once during `onload`;
        // the settings page tells the user a reload is required.
        if (this.showInDocMenu) {
            this.addCommand({
                langKey: "plugin.cmdSync",
                hotkey: "⌥⌘J",
                callback: () => {
                    void this.syncDoc(this.activeDocId);
                },
                editorCallback: (protyle) => {
                    void this.syncDoc(this.docIdOf(protyle));
                },
            });
        }
        if (this.enableReverseImport) {
            this.addCommand({
                langKey: "plugin.cmdImport",
                callback: () => {
                    this.openImport();
                },
            });
        }
        // Settings stays unconditional: switching every entry off must not lock the user out.
        this.addCommand({
            langKey: "plugin.cmdSettings",
            callback: () => {
                void this.openSettings();
            },
        });
    }

    private registerDock(): void {
        this.addDock({
            id: IDS.DOCK,
            type: IDS.DOCK,
            data: {},
            config: {
                position: "RightBottom",
                size: { width: 320, height: 0 },
                icon: IDS.ICON,
                title: this.t("plugin.dockTitle"),
            },
            init: (custom: { element: Element }) => {
                if (custom.element instanceof HTMLElement) {
                    this.dockPanel?.mount(custom.element);
                }
            },
            destroy: () => {
                this.dockPanel?.dispose();
            },
        });
    }

    /* ------------------------------------------------------------------ *
     * document-title menu
     * ------------------------------------------------------------------ */

    /**
     * Add "sync to Juejin" to the document title menu.
     *
     * Kept synchronous on purpose: the host pops the menu right after the event returns, so an
     * `await` here would append the item too late. `showInDocMenu` is therefore mirrored in a
     * plain field (see {@link applySettings}).
     */
    private onEditorTitleIcon = (event: CustomEvent<EditorTitleIconEvent>): void => {
        if (!this.showInDocMenu) {
            return;
        }
        const docId = event.detail?.data?.id || this.docIdOf(event.detail?.protyle);
        if (!docId) {
            return;
        }
        event.detail.menu.addItem({
            icon: IDS.ICON,
            label: this.t("plugin.menuSync"),
            click: () => {
                void this.syncDoc(docId);
            },
        });
        event.detail.menu.addItem({
            icon: IDS.ICON,
            label: this.t("plugin.menuImport"),
            click: () => {
                this.openImport();
            },
        });
    };

    /**
     * Follow the user from one document to the next so the dock never describes a stale document.
     *
     * `switch-protyle` fires for page switches, tab switches and split-screen focus changes; all of
     * them invalidate the cached binding.
     */
    private onSwitchProtyle = (event: CustomEvent<{ protyle?: IProtyle }>): void => {
        const docId = this.docIdOf(event.detail?.protyle);
        if (docId.length === 0 || docId === this.activeDocId) {
            return;
        }
        this.activeDocId = docId;
        void this.refreshActiveDoc(docId);
    };

    /* ------------------------------------------------------------------ *
     * actions
     * ------------------------------------------------------------------ */

    /** Open the confirmation dialog for `docId` (or the last active document). */
    private async syncDoc(docId: string): Promise<void> {
        let target = docId.length > 0 ? docId : this.activeDocId;
        if (target.length === 0) {
            // Command palette entry can fire before any `switch-protyle`, so resolve on demand.
            target = await this.resolveOpenDoc();
        }
        if (target.length === 0) {
            showMessage(this.t("plugin.banner.noDoc"), 4000, "info");
            return;
        }
        this.activeDocId = target;
        const settings = await this.settings.load();
        if (!settings.riskAccepted) {
            showMessage(this.t("settings.risk.required"), 6000, "info");
            await this.openSettings();
            return;
        }
        const credential = await this.settings.getCredential();
        if (!credential) {
            showMessage(this.t("sync.blocked.noCredential"), 6000, "error");
            await this.openSettings();
            return;
        }
        this.applySettings(settings);
        await this.refreshActiveDoc(target);
        await this.syncDialog.open(target);
    }

    /**
     * Siyuan hook invoked by the gear button in 集市 → 已下载. The base implementation opens
     * nothing, so without this override that entry looks like an empty settings page.
     */
    override openSetting(): void {
        void this.openSettings();
    }

    private async openSettings(): Promise<void> {
        await this.settingsPanel.open();
    }

    /**
     * The import form lives in the dock tab. The dock cannot be opened programmatically, so we
     * switch the panel to that tab and only fall back to a hint when the dock was never mounted
     * (first run, dock hidden). Mobile has no dock at all, hence the explicit message.
     */
    private openImport(): void {
        if (getFrontend() === "mobile") {
            showMessage(this.t("plugin.mobileUnsupported"), 4000, "info");
            return;
        }
        const focused = this.dockPanel?.focusImport() ?? false;
        if (!focused) {
            showMessage(this.t("sync.dock.tab.import"), 4000, "info");
        }
    }

    /** Re-read the binding of a document and mirror it into the dock store. */
    private async refreshActiveDoc(docId: string): Promise<void> {
        // An empty id means "whatever is open": every entry point can call this without first
        // knowing the document, which is what keeps the dock truthful right after a reload.
        const resolved = docId.length > 0 ? docId : await this.resolveOpenDoc();
        if (resolved.length === 0) {
            this.activeDocId = "";
            this.store.resetDocument();
            return;
        }
        this.activeDocId = resolved;
        const binding = await this.binding.read(resolved);
        const title = await this.docTitle(resolved);
        const bannerKey =
            binding.status === "published"
                ? "plugin.banner.published"
                : binding.status === "draft"
                  ? "plugin.banner.draft"
                  : binding.status === "failed"
                    ? "plugin.banner.failed"
                    : binding.status === "unknown"
                      ? "plugin.banner.unknown"
                      : binding.status === "imported"
                        ? "plugin.banner.imported"
                        : "plugin.banner.unsynced";
        const kind: BannerKind = binding.status === "failed" ? "error" : "info";
        this.store.patch({
            docId: resolved,
            docTitle: title,
            status: binding.status ?? "unsynced",
            juejinUrl: this.juejinUrlOf(binding),
            banner: { kind, text: this.t(bannerKey) },
        });
    }

    /** Show the result panel and persist the history entry. */
    private handleResult(result: SyncResult): void {
        this.activeDocId = result.docId || this.activeDocId;
        this.resultPanel.open(result);
        void this.persistHistory(result);
    }

    private async persistHistory(result: SyncResult): Promise<void> {
        if (this.lastPersistedStart === result.startedAt) {
            return;
        }
        this.lastPersistedStart = result.startedAt;
        const [latest] = this.store.getState().history;
        if (!latest) {
            return;
        }
        try {
            await this.settings.pushHistory(latest);
        } catch (error) {
            this.logger.warn(`history save failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /* ------------------------------------------------------------------ *
     * helpers
     * ------------------------------------------------------------------ */

    private t(key: string, params?: Record<string, string | number>): string {
        return textOf(this.i18n, key, params);
    }

    /** Mirror every settings-derived flag into the live services. */
    private applySettings(settings: SyncSettings): void {
        this.showInDocMenu = settings.showInDocMenu;
        this.enableReverseImport = settings.enableReverseImport;
        this.pipeline.configure({
            uploadEnabled: settings.autoUploadImages,
            intervalMs: settings.requestIntervalMs,
        });
        this.proxy.configure({
            timeoutMs: settings.syncTimeoutMs,
            minIntervalMs: settings.requestIntervalMs,
        });
        // Entry toggles are read lazily by the dock, so an explicit re-render makes a saved
        // change visible straight away. Commands still need a reload (see `registerCommands`).
        this.dockPanel?.refresh();
    }

    private juejinUrlOf(binding: DocBinding): string {
        if (binding.articleId) {
            return `https://juejin.cn/post/${binding.articleId}`;
        }
        return binding.draftId ? draftUrl(binding.draftId) : "";
    }

    /**
     * Find the document the user is looking at, for the cases where no event supplies it: plugin
     * just loaded, or the user clicked a dock button without ever switching documents.
     *
     * Reads the DOM (the title element carries the block id) and then *verifies* every candidate
     * against the kernel. The verification is not paranoia — a block id that is not a document, or
     * an id left behind by a closed tab, would otherwise be cached as the sync target.
     */
    private async resolveOpenDoc(): Promise<string> {
        /*
         * Guard: with no editor on screen there is nothing to resolve, and answering anyway would
         * point the sync at a document the user is not looking at.
         */
        if (document.querySelector(".protyle") === null) {
            return "";
        }
        for (const scope of [".layout__wnd--active", ""]) {
            for (const id of this.domDocCandidates(scope)) {
                if (await this.isDocumentBlock(id)) {
                    return id;
                }
            }
        }
        /*
         * No usable DOM id (the title element's attributes are not a public contract). The kernel
         * knows which document was viewed last, so ask it instead — this is what makes the dock
         * correct immediately after a reload, without waiting for a `switch-protyle`.
         */
        try {
            const recent = await this.kernelClient.getRecentDocs(8);
            for (const doc of rankRecentDocs(recent)) {
                if (await this.isDocumentBlock(doc.rootID)) {
                    return doc.rootID;
                }
            }
        } catch (error) {
            this.logger.warn(`getRecentDocs failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return "";
    }

    /** Document ids visible in one layout scope, most specific selector first. */
    private domDocCandidates(scope: string): string[] {
        const selectors = [
            ".protyle-title[data-node-id]",
            ".protyle-title__input[data-node-id]",
            ".protyle-background[data-node-id]",
            '[data-type~="NodeDocument"][data-node-id]',
        ];
        const ids: string[] = [];
        selectors.forEach((selector) => {
            const query = scope.length > 0 ? `${scope} ${selector}` : selector;
            document.querySelectorAll(query).forEach((node) => {
                const id = node.getAttribute("data-node-id") ?? "";
                if (id.length > 0 && !ids.includes(id)) {
                    ids.push(id);
                }
            });
        });
        return ids;
    }

    /** Does this block exist and is it a document (`type = 'd'`)? Never throws. */
    private async isDocumentBlock(blockId: string): Promise<boolean> {
        try {
            const rows = await this.kernelClient.querySql<{ type?: string }>(
                `SELECT type FROM blocks WHERE id = '${blockId.replace(/'/g, "''")}' LIMIT 1`,
            );
            return rows[0]?.type === "d";
        } catch (error) {
            this.logger.warn(`isDocumentBlock(${blockId}) failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    private docIdOf(protyle?: IProtyle): string {
        if (!protyle) {
            return "";
        }
        const fromBackground = protyle.background?.ial?.id ?? "";
        if (fromBackground.length > 0) {
            return fromBackground;
        }
        return protyle.block?.rootID ?? protyle.block?.id ?? "";
    }

    /** Document title via SQL; never throws. */
    private async docTitle(docId: string): Promise<string> {
        try {
            const rows = await this.kernelClient.querySql<{ content?: string }>(
                `SELECT content FROM blocks WHERE id = '${docId.replace(/'/g, "''")}' LIMIT 1`,
            );
            return rows[0]?.content ?? "";
        } catch (error) {
            this.logger.warn(`docTitle(${docId}) failed: ${error instanceof Error ? error.message : String(error)}`);
            return "";
        }
    }

    /** Forward store changes so other windows / components can react (best effort). */
    private broadcast(state: SyncState): void {
        try {
            const emitter = this.eventBus as unknown as EventEmitterLike;
            emitter.emit(EVENTS.STATE_CHANGED, { docId: state.docId, status: state.status, busy: state.busy });
        } catch {
            // The custom event name is not part of the host's typed map; forwarding is optional.
        }
    }
}

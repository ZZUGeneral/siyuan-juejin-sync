/**
 * Minimal observable state container (§1.1) plus the sync history ring buffer.
 *
 * No framework: a `Set<Listener>` and a frozen state object are enough for a dock panel.
 * `index.ts` forwards every change to the plugin event bus so other windows can react.
 */
import { EVENTS, HISTORY_LIMIT, type SyncHistoryEntry, type SyncResult, type SyncStatus } from "../types";

/** Visual severity of the dock banner. */
export type BannerKind = "info" | "warn" | "error";

/** Dock-visible status of the current document. */
export type DockStatus = SyncStatus | "unsynced" | "syncing";

export interface SyncProgress {
    /** i18n key describing the current stage. */
    label: string;
    done: number;
    total: number;
}

export interface Banner {
    kind: BannerKind;
    /** Already localized text. */
    text: string;
}

export interface SyncState {
    docId: string;
    docTitle: string;
    status: DockStatus;
    busy: boolean;
    progress: SyncProgress | null;
    banner: Banner | null;
    juejinUrl: string;
    lastResult: SyncResult | null;
    history: SyncHistoryEntry[];
}

/** Factory for the empty state. */
export function createInitialState(): SyncState {
    return {
        docId: "",
        docTitle: "",
        status: "unsynced",
        busy: false,
        progress: null,
        banner: null,
        juejinUrl: "",
        lastResult: null,
        history: [],
    };
}

export type Listener = (state: SyncState) => void;

/** Tiny observable store. */
export class SyncStore {
    private state: SyncState = createInitialState();
    private readonly listeners = new Set<Listener>();

    constructor(private readonly onChange?: Listener) {}

    getState(): SyncState {
        return this.state;
    }

    /** Shallow merge + notify. */
    patch(patch: Partial<SyncState>): SyncState {
        this.state = { ...this.state, ...patch };
        this.emit();
        return this.state;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Newest-first history, capped at {@link HISTORY_LIMIT}. */
    pushHistory(entry: SyncHistoryEntry): void {
        const history = [entry, ...this.state.history].slice(0, HISTORY_LIMIT);
        this.patch({ history });
    }

    setHistory(history: SyncHistoryEntry[]): void {
        this.patch({ history: history.slice(0, HISTORY_LIMIT) });
    }

    /** Reset everything except the history (used when switching documents). */
    resetDocument(): void {
        this.patch({
            docId: "",
            docTitle: "",
            status: "unsynced",
            busy: false,
            progress: null,
            banner: null,
            juejinUrl: "",
            lastResult: null,
        });
    }

    /** Name of the event emitted on every change. */
    static readonly event = EVENTS.STATE_CHANGED;

    private emit(): void {
        this.listeners.forEach((listener) => {
            try {
                listener(this.state);
            } catch {
                // A broken listener must never break the store.
            }
        });
        this.onChange?.(this.state);
    }
}

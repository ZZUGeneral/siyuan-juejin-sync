/**
 * Tiny DOM helpers. No framework, no virtual DOM — the plugin UI is small enough that plain
 * elements plus a handful of factories stay readable and keep the bundle at ~30 KB.
 *
 * Every factory takes already-localized text: this module never looks up an i18n key.
 */

export interface ElOptions {
    class?: string;
    text?: string;
    title?: string;
    html?: string;
    attrs?: Record<string, string>;
    style?: Partial<CSSStyleDeclaration>;
    on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

/**
 * Create an element.
 *
 * @param tag Tag name.
 * @param options Attributes, text content and listeners.
 * @param children Child nodes or strings (text nodes).
 */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: ElOptions = {},
    children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (options.class) {
        node.className = options.class;
    }
    if (options.text !== undefined) {
        node.textContent = options.text;
    }
    if (options.html !== undefined) {
        node.innerHTML = options.html;
    }
    if (options.title) {
        node.title = options.title;
    }
    if (options.attrs) {
        Object.entries(options.attrs).forEach(([key, value]) => {
            node.setAttribute(key, value);
        });
    }
    if (options.style) {
        Object.assign(node.style, options.style);
    }
    if (options.on) {
        Object.entries(options.on).forEach(([event, handler]) => {
            node.addEventListener(event, handler as EventListener);
        });
    }
    children.forEach((child) => {
        if (child === null || child === undefined) {
            return;
        }
        node.append(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
}

/** Remove every child node. */
export function clear(node: HTMLElement): void {
    while (node.firstChild) {
        node.removeChild(node.firstChild);
    }
}

export type ButtonKind = "primary" | "default" | "danger";

/** Button with the SiYuan block style. */
export function button(
    text: string,
    onClick: () => void,
    options?: { kind?: ButtonKind; disabled?: boolean; class?: string },
): HTMLButtonElement {
    const kind = options?.kind ?? "default";
    const node = el("button", {
        class: `b3-button b3-button--${kind === "default" ? "outline" : kind} jjs-button ${options?.class ?? ""}`.trim(),
        text,
        attrs: { type: "button" },
    });
    node.disabled = options?.disabled ?? false;
    node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!node.disabled) {
            onClick();
        }
    });
    return node;
}

/**
 * Borderless, low-emphasis action.
 *
 * Used for the dock's secondary row: "refresh" and "settings" must be reachable without looking
 * like they carry the same weight as "sync this document".
 */
export function ghostButton(
    text: string,
    onClick: () => void,
    options?: { disabled?: boolean },
): HTMLButtonElement {
    const node = el("button", {
        class: "jjs-ghost",
        text,
        attrs: { type: "button" },
    });
    node.disabled = options?.disabled ?? false;
    node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!node.disabled) {
            onClick();
        }
    });
    return node;
}

/** Small muted paragraph. */
export function hint(text: string, className = "jjs-hint"): HTMLElement {
    return el("div", { class: className, text });
}

/** Label + control + optional hint/counter. */
export function field(labelText: string, control: HTMLElement, options?: { hint?: string; suffix?: HTMLElement }): HTMLElement {
    const head = el("div", { class: "jjs-field__head" }, [
        el("div", { class: "jjs-field__label", text: labelText }),
        options?.suffix ?? null,
    ]);
    const body = el("div", { class: "jjs-field__body" }, [control]);
    const wrapper = el("div", { class: "jjs-field" }, [head, body]);
    if (options?.hint) {
        wrapper.append(hint(options.hint));
    }
    return wrapper;
}

/** Single-line text / password input. */
export function textInput(options: {
    value?: string;
    placeholder?: string;
    type?: "text" | "password" | "number";
    onInput?: (value: string) => void;
}): HTMLInputElement {
    const node = el("input", {
        class: "b3-text-field fn__block jjs-input",
        attrs: {
            type: options.type ?? "text",
            value: options.value ?? "",
            placeholder: options.placeholder ?? "",
            spellcheck: "false",
        },
    });
    node.value = options.value ?? "";
    if (options.onInput) {
        node.addEventListener("input", () => {
            options.onInput?.(node.value);
        });
    }
    return node;
}

/** Multi-line input. */
export function textArea(options: { value?: string; rows?: number; onInput?: (value: string) => void }): HTMLTextAreaElement {
    const node = el("textarea", {
        class: "b3-text-field fn__block jjs-textarea",
        attrs: { rows: String(options.rows ?? 3), spellcheck: "false" },
    });
    node.value = options.value ?? "";
    if (options.onInput) {
        node.addEventListener("input", () => {
            options.onInput?.(node.value);
        });
    }
    return node;
}

/** Checkbox with a clickable label. */
/**
 * Checkbox bound to a label.
 *
 * Deliberately a native checkbox rather than Siyuan's `.b3-switch`: the switch draws its knob
 * with `::after`, which gives a very weak "is it on?" signal here, and the risk confirmation
 * must be unmistakable. `accent-color` keeps it on-theme.
 */
export function checkbox(
    labelText: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
): { root: HTMLElement; input: HTMLInputElement } {
    const input = el("input", { class: "jjs-check", attrs: { type: "checkbox" } });
    input.checked = checked;
    input.addEventListener("change", () => {
        onChange(input.checked);
    });
    const root = el("label", { class: "jjs-checkbox" }, [input, el("span", { class: "jjs-checkbox__text", text: labelText })]);
    return { root, input };
}

/** Native select bound to `{value,label}` options. */
export function selectField(
    options: Array<{ value: string; label: string }>,
    value: string,
    onChange: (value: string) => void,
): HTMLSelectElement {
    const node = el("select", { class: "b3-select fn__block jjs-select" });
    options.forEach((option) => {
        const item = el("option", { text: option.label, attrs: { value: option.value } });
        node.append(item);
    });
    node.value = value;
    node.addEventListener("change", () => {
        onChange(node.value);
    });
    return node;
}

export interface ChipOption {
    id: string;
    name: string;
}

/**
 * A cached name that carries no information: either empty, or the bare numeric id.
 *
 * Older builds of the plugin stored the id in the `name` field, so a real account can still have
 * `{ id: "7148730…", name: "7148730…" }` in its cache. The id stays a valid payload (Juejin
 * accepts it), but it must never be *shown* — it is a primary key, not a label.
 */
export function isUnnamedTag(name: string): boolean {
    const trimmed = name.trim();
    return trimmed.length === 0 || /^\d{10,}$/.test(trimmed);
}

export interface ChipInputOptions {
    all: ChipOption[];
    selected: string[];
    searchPlaceholder: string;
    selectedLabel: (count: number) => string;
    onChange: (selected: string[]) => void;
    maxSuggestions?: number;
    /**
     * Inline text drawn inside the chip row while nothing is selected.
     *
     * Lets the empty tag field explain itself ("select at least one tag") instead of being a blank
     * row that only the footer gate talks about. Not passed by the settings panel, which has no
     * such requirement.
     */
    emptyLabel?: string;
    /**
     * Optional server-side search.
     *
     * The cached list is a *sample*: `query_tag_list` returns one page of popular tags, so a
     * keyword like "kuber" can match nothing locally although the tag exists upstream. When this
     * is provided a debounced query runs and its hits are merged into the local pool, which keeps
     * the picker usable no matter how stale the cache is (A6).
     */
    onSearch?: (keyword: string) => Promise<ChipOption[]>;
    /**
     * Localized copy for the three suggestion-box states, plus the two labels the "no id on
     * screen" rule needs: the placeholder for a nameless tag and the accessible name of the
     * remove affordance.
     */
    labels?: { searching: string; empty: string; failed: string; unknown?: string; remove?: string };
}

/**
 * Search field plus toggleable chips (A6: 700+ tags must stay usable).
 *
 * Matching is case-insensitive against the name and the id; the suggestion list is capped so
 * rendering stays cheap even with thousands of tags. Without `onSearch` this is a pure local
 * filter; with it, an empty result never means "this tag does not exist" by itself.
 *
 * Ids are internals: they are matched on and submitted, but never rendered. A tag whose cached
 * name is missing shows `labels.unknown` with `.jjs-tag-unnamed` and stays selectable.
 */
export function chipInput(options: ChipInputOptions): { root: HTMLElement; getSelected: () => string[] } {
    let selected = [...options.selected];
    const maxSuggestions = options.maxSuggestions ?? 60;

    /** Local cache + everything the server has returned for this picker so far. */
    const pool: ChipOption[] = [...options.all];
    const labels = options.labels ?? { searching: "", empty: "", failed: "" };
    const unknownLabel = labels.unknown ?? "";
    const removeLabel = labels.remove ?? "";
    const emptyLabel = options.emptyLabel ?? "";
    let remote: "idle" | "loading" | "failed" = "idle";
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const chips = el("div", { class: "jjs-chips" });
    const counter = el("div", { class: "jjs-hint" });
    const suggestions = el("div", { class: "jjs-suggestions" });
    const search = textInput({
        placeholder: options.searchPlaceholder,
        onInput: () => {
            renderSuggestions();
            scheduleSearch();
        },
    });

    /**
     * What to draw for one tag.
     *
     * Never the id when a placeholder is available: the last resort (`name || id`) only keeps the
     * chip non-empty for callers that pass no `unknown` label at all.
     */
    const describe = (name: string | undefined, id: string): { text: string; unnamed: boolean } => {
        const raw = name ?? "";
        if (isUnnamedTag(raw)) {
            return { text: unknownLabel.length > 0 ? unknownLabel : raw.length > 0 ? raw : id, unnamed: true };
        }
        return { text: raw, unnamed: false };
    };

    const nameOf = (id: string): string => pool.find((item) => item.id === id)?.name ?? "";

    // The id comparison is the only way to reach a tag that is in the pool: pasting an id still
    // hits, it is simply never echoed back.
    const matchesOf = (keyword: string): ChipOption[] =>
        pool.filter((item) => (keyword ? item.id === keyword || item.name.toLowerCase().includes(keyword) : true));

    /** Merge server hits, keeping the first name seen for an id (the pool wins over the cache). */
    const merge = (found: ChipOption[]): void => {
        const known = new Set(pool.map((item) => item.id));
        found.forEach((item) => {
            if (!known.has(item.id)) {
                known.add(item.id);
                pool.push(item);
            }
        });
    };

    const scheduleSearch = (): void => {
        if (!options.onSearch) {
            return;
        }
        const keyword = search.value.trim();
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (keyword.length === 0) {
            remote = "idle";
            renderSuggestions();
            return;
        }
        // Without the debounce every keystroke becomes a proxied HTTP call.
        timer = setTimeout(() => {
            void runSearch(keyword);
        }, 260);
    };

    const runSearch = async (keyword: string): Promise<void> => {
        const mine = ++sequence;
        remote = "loading";
        renderSuggestions();
        try {
            const found = await options.onSearch!(keyword);
            if (mine !== sequence) {
                return;
            }
            merge(found);
            remote = "idle";
        } catch {
            if (mine !== sequence) {
                return;
            }
            // A failed search must not wipe what is already on screen.
            remote = "failed";
        }
        renderSuggestions();
    };

    const renderChips = (): void => {
        clear(chips);
        selected.forEach((id) => {
            const info = describe(nameOf(id), id);
            const remove = el("span", {
                class: "jjs-chip__x",
                text: "×",
                on: {
                    click: () => {
                        selected = selected.filter((item) => item !== id);
                        renderChips();
                        renderSuggestions();
                        options.onChange([...selected]);
                    },
                },
            });
            // The remove affordance is labelled by its *action*, never by the tag id.
            if (removeLabel.length > 0) {
                remove.title = removeLabel;
                remove.setAttribute("aria-label", removeLabel);
                remove.setAttribute("role", "button");
            }
            chips.append(
                el("span", { class: `jjs-chip${info.unnamed ? " jjs-tag-unnamed" : ""}` }, [
                    el("span", { text: info.text }),
                    remove,
                ]),
            );
        });
        if (selected.length === 0 && emptyLabel.length > 0) {
            chips.append(el("span", { class: "jjs-hint jjs-hint--error", text: emptyLabel }));
        }
        // With nothing selected the chip row already says why; repeating "0 selected" in grey both
        // duplicates the fact and dims the red line next to it. The node stays (CSS reserves its
        // height) so the row does not jump when the first tag is picked.
        counter.textContent = selected.length === 0 ? "" : options.selectedLabel(selected.length);
    };

    const renderSuggestions = (): void => {
        clear(suggestions);
        const keyword = search.value.trim().toLowerCase();
        const matches = matchesOf(keyword).slice(0, maxSuggestions);
        matches.forEach((item) => {
            const active = selected.includes(item.id);
            const info = describe(item.name, item.id);
            const node = el("button", {
                class: `jjs-suggestion${active ? " jjs-suggestion--active" : ""}${info.unnamed ? " jjs-tag-unnamed" : ""}`,
                text: info.text,
                title: info.text,
                attrs: { type: "button" },
            });
            if (active) {
                node.setAttribute("aria-pressed", "true");
            }
            node.addEventListener("click", () => {
                selected = active ? selected.filter((id) => id !== item.id) : [...selected, item.id];
                renderChips();
                renderSuggestions();
                options.onChange([...selected]);
            });
            suggestions.append(node);
        });
        if (matches.length === 0) {
            // Explain the blank box: it used to look like the whole tag bar had collapsed, when
            // in reality the keyword simply was not in the (sampled) cache.
            const text = remote === "loading" ? labels.searching : remote === "failed" ? labels.failed : labels.empty;
            if (text.length > 0) {
                suggestions.append(el("div", { class: "jjs-suggestions__note", text }));
            }
        }
    };

    renderChips();
    renderSuggestions();

    const root = el("div", { class: "jjs-chipinput" }, [chips, counter, search, suggestions]);
    return { root, getSelected: () => [...selected] };
}

export type BadgeTone = "info" | "ok" | "warn" | "error" | "muted";

/** Coloured status pill. */
export function badge(text: string, tone: BadgeTone = "muted"): HTMLElement {
    return el("span", { class: `jjs-badge jjs-badge--${tone}`, text });
}

/** `<details>` block; `open` defaults to `false`. */
export function details(summaryText: string, children: Array<Node | string>, open = false): HTMLDetailsElement {
    const node = el("details", { class: "jjs-details" });
    node.open = open;
    node.append(el("summary", { class: "jjs-details__summary", text: summaryText }));
    children.forEach((child) => node.append(child));
    return node;
}

/** Horizontal flex row. */
export function row(children: Array<Node | string | null | undefined>, className = "jjs-row"): HTMLElement {
    return el("div", { class: className }, children);
}

/** Key/value line used by the technical details block. */
export function kv(key: string, value: string): HTMLElement {
    return el("div", { class: "jjs-kv" }, [
        el("span", { class: "jjs-kv__k", text: key }),
        el("span", { class: "jjs-kv__v", text: value }),
    ]);
}

/** Thin progress bar (P1 slot, already wired to the store). */
export function progressBar(done: number, total: number): HTMLElement {
    const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    return el("div", { class: "jjs-progress" }, [
        el("div", { class: "jjs-progress__bar", style: { width: `${Math.round(ratio * 100)}%` } }),
    ]);
}

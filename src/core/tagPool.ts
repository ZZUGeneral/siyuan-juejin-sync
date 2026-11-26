/**
 * Local tag pool.
 *
 * Why a pool exists at all: Juejin's tag directory cannot be listed exhaustively. Verified on
 * 2026-11-26 against the live routes:
 *  - `query_tag_list` ignores `key_word`, `cursor` and `limit` for a non-browser client and
 *    always answers with the same ten popular tags;
 *  - `search_api/v1/search` and `recommend_cate_feed` answer `err_no: 0` with an empty list;
 *  - cursors echo back unchanged, so paging yields the first page forever.
 *
 * Everything the plugin *can* see (popular tags, tags carried by the public feed, tags imported
 * from an article link) is therefore accumulated locally instead of being overwritten on every
 * refresh. Losing the pool would silently shrink a picker the user had already extended, so the
 * merge is append-only in spirit: existing entries win, new ids are appended.
 */
import type { JuejinTag } from "../types";

/**
 * Hard ceiling of the pool.
 *
 * The picker renders suggestions lazily, but `JuejinMetaCache` is serialised into plugin storage,
 * so an unbounded pool would keep growing the settings blob. 800 is far above what the reachable
 * sources can produce today and still small enough to stay a couple of tens of kilobytes.
 */
export const TAG_POOL_MAX = 800;

/**
 * Union of two tag lists, `existing` first.
 *
 * Duplicate ids keep the **existing** name: a tag the user has already seen keeps the label it
 * was shown with, so a chip does not change its text after a refresh.
 */
export function mergeTags(existing: JuejinTag[], incoming: JuejinTag[]): JuejinTag[] {
    const merged: JuejinTag[] = [];
    const seen = new Set<string>();

    const push = (tag: JuejinTag): void => {
        const id = String(tag.id ?? "").trim();
        const name = String(tag.name ?? "").trim();
        if (!id || seen.has(id) || merged.length >= TAG_POOL_MAX) {
            return;
        }
        seen.add(id);
        merged.push({ id, name: name || id });
    };

    existing.forEach(push);
    incoming.forEach(push);
    return merged;
}

/** Ids present in `fresh` but not in `previous` — used only to report what a refresh added. */
export function countNewTags(previous: JuejinTag[], fresh: JuejinTag[]): number {
    const known = new Set(previous.map((tag) => tag.id));
    const added = new Set<string>();
    fresh.forEach((tag) => {
        if (!known.has(tag.id)) {
            added.add(tag.id);
        }
    });
    return added.size;
}

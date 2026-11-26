/**
 * Picking "the document the user is looking at" from the kernel's recent-document list.
 *
 * Used only as a fallback, when the editor DOM gives us nothing usable (which is the normal case
 * right after a plugin reload, because `switch-protyle` never fires for an already-open document).
 *
 * The two signals are not equivalent:
 *
 *  - `openAt` without `closedAt` means the document still has an open tab. The kernel itself uses
 *    this to distinguish an open document from a closed one.
 *  - `viewedAt` is the last time the document was *shown*. A closed document can easily have a
 *    newer `viewedAt` than an open one (close it, then open something else and close that too), so
 *    "still open" must win before "viewed most recently".
 */
import type { RecentDocRef } from "../types";

/** Is this document still open in a tab? */
export function isOpenDoc(doc: RecentDocRef): boolean {
    return doc.openAt !== undefined && doc.closedAt === undefined;
}

/** Open documents first, then most recently viewed, so `[0]` is the best guess. */
export function rankRecentDocs(docs: RecentDocRef[]): RecentDocRef[] {
    return [...docs]
        .filter((doc) => typeof doc.rootID === "string" && doc.rootID.length > 0)
        .sort((a, b) => {
            const byOpen = Number(isOpenDoc(b)) - Number(isOpenDoc(a));
            if (byOpen !== 0) {
                return byOpen;
            }
            return (b.viewedAt ?? 0) - (a.viewedAt ?? 0);
        });
}

/** Best guess for the current document id, or `""` when the list is empty. */
export function pickRecentDocId(docs: RecentDocRef[]): string {
    return rankRecentDocs(docs)[0]?.rootID ?? "";
}

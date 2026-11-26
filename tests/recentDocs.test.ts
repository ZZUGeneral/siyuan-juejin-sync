/**
 * The dock must describe the document the user is looking at. Right after a plugin reload no
 * `switch-protyle` has fired yet, so the id is derived from the kernel's recent-document list.
 *
 * The ranking matters: preferring "most recently viewed" over "still open" would pick a document
 * the user closed minutes ago, and the sync would target the wrong note.
 */
import { describe, expect, it } from "vitest";
import { isOpenDoc, pickRecentDocId, rankRecentDocs } from "../src/core/recentDocs";
import type { RecentDocRef } from "../src/types";

const open = (rootID: string, viewedAt: number): RecentDocRef => ({ rootID, viewedAt, openAt: viewedAt });
const closed = (rootID: string, viewedAt: number): RecentDocRef => ({
    rootID,
    viewedAt,
    openAt: viewedAt,
    closedAt: viewedAt + 10,
});

describe("recent docs · open tab beats recent view", () => {
    it("picks the open document even when a closed one was viewed later", () => {
        // Exactly the case that made the dock show "open a document first" while one was open.
        const docs = [closed("closed-newer", 200), open("open-older", 100)];
        expect(pickRecentDocId(docs)).toBe("open-older");
    });

    it("falls back to the newest viewed document when nothing is open", () => {
        const docs = [closed("a", 100), closed("b", 300), closed("c", 200)];
        expect(pickRecentDocId(docs)).toBe("b");
    });

    it("treats a missing closedAt as still open", () => {
        expect(isOpenDoc({ rootID: "x", openAt: 1 })).toBe(true);
        expect(isOpenDoc({ rootID: "x", openAt: 1, closedAt: 2 })).toBe(false);
        // No openAt at all: the document was never opened in this workspace session.
        expect(isOpenDoc({ rootID: "x", viewedAt: 5 })).toBe(false);
    });

    it("breaks ties between two open documents by viewedAt", () => {
        const docs = [open("older", 10), open("newer", 20)];
        expect(rankRecentDocs(docs).map((doc) => doc.rootID)).toEqual(["newer", "older"]);
    });
});

describe("recent docs · defensive", () => {
    it("returns an empty id for an empty list", () => {
        expect(pickRecentDocId([])).toBe("");
    });

    it("drops entries without a usable rootID", () => {
        const docs = [
            { rootID: "" },
            { rootID: undefined as unknown as string, viewedAt: 999 },
            open("ok", 1),
        ];
        expect(rankRecentDocs(docs).map((doc) => doc.rootID)).toEqual(["ok"]);
    });

    it("does not mutate the input order", () => {
        const docs = [closed("a", 100), open("b", 50)];
        rankRecentDocs(docs);
        expect(docs.map((doc) => doc.rootID)).toEqual(["a", "b"]);
    });
});

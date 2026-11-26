/**
 * The local tag pool is the only thing standing between the user and a ten-tag picker.
 *
 * Upstream refuses to page or search (see `src/core/tagPool.ts`), so every refresh, import and
 * manual pick has to accumulate. These tests pin the two properties that keep that safe:
 * existing entries win (no label flicker, no lost ids) and the pool never grows unbounded.
 */
import { describe, expect, it } from "vitest";
import { TAG_POOL_MAX, countNewTags, mergeTags } from "../src/core/tagPool";
import type { JuejinTag } from "../src/types";

const tag = (id: string, name = `tag-${id}`): JuejinTag => ({ id, name });

describe("mergeTags", () => {
    it("appends new ids and keeps the existing order", () => {
        const merged = mergeTags([tag("1"), tag("2")], [tag("3"), tag("4")]);

        expect(merged.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
    });

    it("keeps the label the user already saw for a duplicate id", () => {
        // A refresh must not rename a chip the user is looking at.
        const merged = mergeTags([{ id: "1", name: "Kubernetes" }], [{ id: "1", name: "k8s" }]);

        expect(merged).toEqual([{ id: "1", name: "Kubernetes" }]);
    });

    it("is a no-op when the incoming list is a subset", () => {
        const previous = [tag("1"), tag("2"), tag("3")];

        expect(mergeTags(previous, [tag("2")])).toEqual(previous);
    });

    it("drops entries without an id and falls back to the id as a name", () => {
        const merged = mergeTags(
            [],
            [
                { id: "", name: "ghost" },
                { id: " 7 ", name: "" },
            ],
        );

        expect(merged).toEqual([{ id: "7", name: "7" }]);
    });

    it("caps the pool so plugin storage cannot grow without bound", () => {
        const many = Array.from({ length: TAG_POOL_MAX + 50 }, (_, index) => tag(String(index)));

        expect(mergeTags([], many)).toHaveLength(TAG_POOL_MAX);
    });
});

describe("countNewTags", () => {
    it("counts only ids the previous pool did not have", () => {
        expect(countNewTags([tag("1"), tag("2")], [tag("2"), tag("3"), tag("4")])).toBe(2);
    });

    it("counts an id once even when the incoming list repeats it", () => {
        expect(countNewTags([], [tag("1"), tag("1"), tag("1")])).toBe(1);
    });

    it("reports zero for an unchanged pool", () => {
        expect(countNewTags([tag("1")], [tag("1")])).toBe(0);
    });
});

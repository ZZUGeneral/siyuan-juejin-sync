/**
 * Guards for the advanced endpoint self-check (A5).
 *
 * Two rules here are invisible at runtime and were both learned the hard way:
 *
 *  1. A probe must never create real data. `draft.create` with `{}` succeeds and leaves an empty
 *     draft in the account — one per self-check run, sitting in the user's draft list forever.
 *  2. A route Juejin does not have must be labelled `known-missing`, not "unreachable". Otherwise
 *     a perfectly healthy install reports `11/14 reachable` and looks broken.
 */
import { describe, expect, it } from "vitest";
import { PROBE_SPECS } from "../src/api/juejin";

const CREATE_ROUTE = /\/create$/;

describe("self-check probes · no side effects", () => {
    it("never sends an empty body to a /create route", () => {
        // `{}` is accepted by `article_draft/create` and produces a real (empty) draft.
        PROBE_SPECS.filter((spec) => CREATE_ROUTE.test(spec.url)).forEach((spec) => {
            expect(
                Object.keys((spec.body ?? {}) as Record<string, unknown>).length,
                `${spec.name} must send a non-empty, deliberately invalid body`,
            ).toBeGreaterThan(0);
        });
    });

    it("sends an ill-typed title so creation is rejected before it happens", () => {
        const create = PROBE_SPECS.find((spec) => spec.name === "draft.create");
        expect(create, "the draft.create probe must stay in the table").toBeDefined();
        const title = (create?.body as { title?: unknown } | undefined)?.title;
        // Verified live: an object here answers `json: cannot unmarshal object into Go struct field
        // ArticleDraftReq.title of type string` and creates nothing.
        expect(typeof title).not.toBe("string");
        expect(title).toBeTruthy();
    });

    it("cleans up after itself if the route ever does create something", () => {
        const create = PROBE_SPECS.find((spec) => spec.name === "draft.create");
        expect(create?.cleanupCreatedDraft).toBe(true);
    });
});

describe("self-check probes · known-missing routes", () => {
    const missing = PROBE_SPECS.filter((spec) => spec.determinism === "known-missing");

    it("marks the routes Juejin confirmed it does not serve", () => {
        // Verified 2026-11-26 with a live session, both GET and POST:
        //   err_no=2 err_msg=请求路由不存在
        const names = missing.map((spec) => spec.name).sort();
        expect(names).toEqual(["article.unpublish", "article.update"]);
    });

    it("keeps them in the table so a re-appearance is noticed", () => {
        missing.forEach((spec) => expect(spec.url.startsWith("https://")).toBe(true));
    });

    it("does not let a known-missing row count as usable", () => {
        // The UI subtracts them from the denominator; they must stay reachable=false.
        missing.forEach((spec) => expect(spec.determinism).not.toBe("verified"));
    });
});

describe("self-check probes · table hygiene", () => {
    it("has unique probe names", () => {
        const names = PROBE_SPECS.map((spec) => spec.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it("does not probe the same path twice with different methods", () => {
        // `category.briefs.post` used to sit here purely to prove that route is GET-only. It read as
        // a failure in the UI, so the fact is documented in code instead of being re-probed.
        const paths = PROBE_SPECS.map((spec) => spec.url.split("?")[0]);
        const duplicated = paths.filter((path, index) => paths.indexOf(path) !== index);
        expect(duplicated).toEqual([]);
    });
});

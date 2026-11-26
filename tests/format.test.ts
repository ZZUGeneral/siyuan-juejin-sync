/**
 * `format.ts` · the "last sync" stamp.
 *
 * Extracted out of `dockPanel.ts` during the dialog redesign and now shared by two surfaces, so a
 * silent behaviour change would show up in the dock *and* in the confirm dialog at once. The one
 * trap here is time zone: the stored value is ISO 8601 **UTC**, and the old comment-era shortcut
 * (`iso.slice(11, 16)`) renders UTC instead of the clock in the user's menu bar.
 */
import { afterEach, describe, expect, it } from "vitest";
import { stamp } from "../src/ui/format";

/** Node re-reads `TZ` on the next `Date` call, so the process time zone can be pinned per test. */
function withTimeZone(zone: string, run: () => void): void {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
        run();
    } finally {
        if (previous === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = previous;
        }
    }
}

afterEach(() => {
    delete process.env.TZ;
});

describe("stamp() · local-time rendering", () => {
    it("renders a UTC stamp in the local zone as MM-DD HH:mm", () => {
        withTimeZone("Asia/Shanghai", () => {
            expect(stamp("2024-01-02T03:04:05.000Z")).toBe("01-02 11:04");
        });
    });

    it("is zone-dependent — it never slices the raw UTC string", () => {
        // The same instant, two zones. If `stamp` had kept the old `slice(11, 16)` behaviour these
        // two would be identical ("03:04") and the assertion below would fail on either side.
        withTimeZone("America/New_York", () => {
            expect(stamp("2024-01-02T03:04:05.000Z")).toBe("01-01 22:04");
        });
    });

    it("rolls the date over for an instant that is tomorrow locally", () => {
        withTimeZone("Asia/Shanghai", () => {
            expect(stamp("2023-12-31T20:30:00Z")).toBe("01-01 04:30");
        });
    });

    it("treats an explicit +08:00 offset as the same instant as its UTC form", () => {
        const offset = stamp("2024-01-02T11:04:05+08:00");
        const utc = stamp("2024-01-02T03:04:05Z");
        expect(offset).toBe(utc);
    });

    it("zero-pads month, day, hour and minute", () => {
        withTimeZone("UTC", () => {
            expect(stamp("2024-03-04T05:06:07Z")).toBe("03-04 05:06");
        });
    });

    it("accepts a stamp without milliseconds and with a space separator", () => {
        withTimeZone("UTC", () => {
            expect(stamp("2024-01-02T03:04:05Z")).toBe("01-02 03:04");
            expect(stamp("2024-01-02 03:04:05")).toBe("01-02 03:04");
        });
    });
});

describe("stamp() · unparsable input never blanks the line", () => {
    it("falls back to `iso.slice(0, 16)` with the T replaced by a space", () => {
        expect(stamp("2024-13-45T99:99:99Z")).toBe("2024-13-45 99:99");
    });

    it("keeps a short garbage value unchanged", () => {
        expect(stamp("not-a-date")).toBe("not-a-date");
    });

    it("returns an empty string for an empty stamp instead of 'NaN-NaN'", () => {
        expect(stamp("")).toBe("");
    });

    it("never emits NaN for a numeric-looking non-date", () => {
        // 20 characters, so the fallback truncates it and "abc" is all that is dropped.
        expect(stamp("1700000000000abcdef")).toBe("1700000000000abc");
    });
});

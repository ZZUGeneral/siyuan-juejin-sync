/**
 * M1 helper — excerpt (`brief_content`) assembly, see §5.3.
 *
 * Juejin hard-validates 50–100 characters on `brief_content`; outside that range the draft
 * creation is rejected. This module is the **only** place allowed to measure length (D4), and
 * the measurement is **Unicode code points**, never `String.length`:
 *
 * ```text
 * 30 emoji          → code points 30, .length 60   ← `.length` would wrongly say "long enough"
 * 60 CJK characters → code points 60, .length 60   ← identical
 * ```
 *
 * Only the emoji direction produces a *silently too short* value, which is exactly the
 * failure mode that gets the draft rejected. Hence: `Array.from()` everywhere.
 *
 * Assembly (not interception): user input outside the band is trimmed/padded into the target
 * band at submit time, and the dialog shows a live counter without blocking.
 */
import { BRIEF_MAX, BRIEF_MIN, BRIEF_TARGET_MAX, BRIEF_TARGET_MIN } from "../types";
import { stripCodeRegions } from "./markdown";

/** Unicode code point count — the single source of truth for "字数" (§5.3). */
export const countChars = (value: string): number => Array.from(value).length;

/** Slice by code points so surrogate pairs (emoji) are never cut in half. */
export const sliceChars = (value: string, limit: number): string => Array.from(value).slice(0, limit).join("");

export type BriefState = "ok" | "short" | "long";

/** Classify a value against the hard range (50–100). */
export function briefState(value: string): BriefState {
    const length = countChars(value);
    if (length < BRIEF_MIN) {
        return "short";
    }
    if (length > BRIEF_MAX) {
        return "long";
    }
    return "ok";
}

/** Whitespace-normalize without touching the code point sequence. */
function normalize(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

/**
 * Characters a readable cut may end on: whitespace, CJK punctuation, ASCII punctuation, closers.
 *
 * Written as `\uXXXX` escapes on purpose — D3 forbids CJK literals in source, and this is a
 * character class, not user-facing text.
 */
const BRIEF_BOUNDARY = /[\s\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF01\uFF1F,.;:!?\uFF09)\]\u3011\u300B\u300D\u300F"'\u201D\u2019]/;

/**
 * Cut at a readable boundary instead of mid-word (P2-5).
 *
 * A raw code-point cut can land inside a word and leave a trailing space, which makes the
 * output depend on how many times it is fitted. Trimming plus boundary alignment makes the
 * result *idempotent*: a second pass sees a value already inside
 * `[BRIEF_TARGET_MIN, BRIEF_TARGET_MAX]` and returns it unchanged.
 *
 * Falls back to a plain cut when the boundary search would drop below `BRIEF_MIN` — a
 * slightly ugly excerpt is still better than an illegal one.
 */
function sliceAtBoundary(value: string, limit: number): string {
    const chars = Array.from(value);
    if (chars.length <= limit) {
        return chars.join("").trim();
    }
    const head = chars.slice(0, limit);
    let cut = head.length;
    while (cut > 0 && !BRIEF_BOUNDARY.test(head[cut - 1])) {
        cut -= 1;
    }
    if (cut > 0) {
        const candidate = head.slice(0, cut).join("").trim();
        if (countChars(candidate) >= BRIEF_MIN) {
            return candidate;
        }
    }
    return head.join("").trim();
}

/**
 * Convert Markdown to readable plain text (M1 input).
 *
 * Code is dropped entirely: a fenced block would otherwise dominate the excerpt, and its
 * symbols are exactly what we are trying to strip.
 *
 * @param markdown Sanitized body (post S0–S3).
 */
export function plainText(markdown: string): string {
    let text = stripCodeRegions(markdown);
    text = text.replace(/<!--[\s\S]*?-->/g, " ");
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1 ");
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1 ");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, "");
    text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
    text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d+\.)[ \t]+/gm, "");
    // Table separator rows and pipes.
    text = text.replace(/^[ \t|:-]*-[ \t|:-]*$/gm, " ");
    text = text.replace(/\|/g, " ");
    text = text.replace(/\[\^[^\]]*\]/g, "");
    text = text.replace(/==([^=\n]*)==/g, "$1");
    text = text.replace(/[*_~]{1,3}([^*_~\n]*)[*_~]{1,3}/g, "$1");
    text = text.replace(/\$[^$\n]*\$/g, " ");
    return normalize(text.replace(/[ \t]+/g, " "));
}

/**
 * Fit any string into `[50, 100]` code points, targeting the safer `[60, 90]` band.
 *
 * - longer than 100 → cut to 90,
 * - shorter than 60 → append the fallback sentence (or repeat the text itself) until inside,
 * - empty → the fallback alone, padded with itself.
 *
 * @param value Raw excerpt (generated or edited by the user).
 * @param options.fallback Localized filler sentence; keeps the padding readable.
 */
export function fitBrief(value: string, options?: { fallback?: string }): string {
    const fallback = normalize(options?.fallback ?? "");
    let chars = Array.from(normalize(value));

    if (chars.length === 0) {
        if (fallback.length === 0) {
            return "";
        }
        chars = Array.from(fallback);
    }

    if (chars.length > BRIEF_MAX) {
        return sliceAtBoundary(chars.join(""), BRIEF_TARGET_MAX);
    }
    if (chars.length >= BRIEF_TARGET_MIN) {
        return chars.join("");
    }

    const unit = fallback.length > 0 ? fallback : chars.join("");
    let out = chars.join("");
    let guard = 0;
    while (countChars(out) < BRIEF_TARGET_MIN && guard < 200) {
        out = `${out} ${unit}`.trim();
        guard += 1;
    }
    return sliceAtBoundary(out, BRIEF_TARGET_MAX);
}

/**
 * Generate the initial excerpt for a document and fit it into the band.
 *
 * @param markdown Sanitized body.
 * @param options.fallback Localized filler sentence (`sync.brief.fallback`).
 */
export function buildBrief(markdown: string, options?: { fallback?: string }): string {
    return fitBrief(plainText(markdown), options);
}

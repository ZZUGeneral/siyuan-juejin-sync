/**
 * Test stub for the host package `siyuan`.
 *
 * `siyuan@1.3.0` is a **types-only** package (its `exports` map has no runtime entry), so any
 * `import { fetchSyncPost } from "siyuan"` fails to resolve under Vitest's node environment.
 * `vitest.config.ts` aliases `siyuan` to this file, which lets the suite import real runtime
 * modules (`api/proxy.ts`, `api/kernel.ts`, `core/syncEngine.ts`, …) and assert on them.
 *
 * Only the symbols actually imported as **values** are implemented; everything else stays on
 * the type side. Tests that need behaviour override these with `vi.spyOn` / `vi.mock`.
 */
import { vi } from "vitest";

/** Default `fetchSyncPost` answer; every test overrides it. */
export const fetchSyncPost = vi.fn(async () => ({ code: 0, data: {} }));

/** Runtime platform reported to the plugin. Desktop keeps `openTab` on the hot path. */
export const getFrontend = vi.fn(() => "desktop" as const);

export const openTab = vi.fn(async () => undefined);

export const openMobileFileById = vi.fn(() => undefined);

export const showMessage = vi.fn(() => undefined);

export const confirm = vi.fn(async () => true);

/** Minimal stand-ins for the classes the plugin extends / instantiates. */
export class Plugin {}
export class Dialog {}
export class Menu {}
export class Protyle {}
export class Setting {}

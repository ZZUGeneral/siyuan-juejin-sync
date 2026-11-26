/// <reference types="vite/client" />

/**
 * Ambient declarations for non-code modules and host globals.
 *
 * `window.siyuan` itself is declared by the `siyuan` package (see `types/index.d.ts`),
 * which is the single source of truth for the kernel config shape
 * (`config.api.token`, `config.lang`, ...). We must not redeclare it here, otherwise
 * the two declarations would conflict.
 */

declare module "*.scss" {
    const css: string;
    export default css;
}

declare module "*.css" {
    const css: string;
    export default css;
}

declare global {
    /** Set by `vite.config.ts` (`define`) — kept for boot logs. */
    const __JUEJIN_SYNC_VERSION__: string | undefined;
}

export {};

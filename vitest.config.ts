import { defineConfig } from "vitest/config";

/**
 * Unit-test configuration.
 *
 * A plain `node` environment is enough — no DOM, no network, no SiYuan kernel and no Juejin
 * account, which is what lets QA run the whole suite offline.
 *
 * `siyuan` is aliased to `tests/stubs/siyuan.ts` because the published package is types-only
 * (no runtime entry), while `api/proxy.ts` / `api/kernel.ts` import it as a value. The alias
 * is what makes the orchestration layer (`core/syncEngine.ts`) testable at all.
 */
export default defineConfig({
    resolve: {
        alias: {
            siyuan: new URL("./tests/stubs/siyuan.ts", import.meta.url).pathname,
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        reporters: ["default"],
    },
});

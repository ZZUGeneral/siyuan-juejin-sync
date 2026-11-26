import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteStaticCopy, type Target } from "vite-plugin-static-copy";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Build configuration for the SiYuan plugin bundle.
 *
 * The plugin is loaded by the SiYuan host as a CommonJS module named `index.js`,
 * therefore `siyuan` and `process` must stay external (they are injected by the host).
 */
const staticCopyTargets: Target[] = [
    { src: "plugin.json", dest: "." },
    { src: "icon.png", dest: "." },
    { src: "preview.png", dest: "." },
    { src: "README.md", dest: "." },
    { src: "README_zh_CN.md", dest: "." },
    { src: "LICENSE", dest: "." },
    { src: "src/i18n/*.json", dest: "i18n" },
];

export default defineConfig({
    plugins: [
        viteStaticCopy({
            // `silent` keeps the build output focused on errors only.
            silent: true,
            targets: staticCopyTargets,
        }),
    ],
    resolve: {
        alias: {
            "@": `${rootDir}src`,
        },
    },
    build: {
        // SiYuan loads `dist/index.js` directly; keep the bundle readable for QA review.
        minify: false,
        sourcemap: false,
        emptyOutDir: true,
        outDir: "dist",
        target: "es2022",
        lib: {
            entry: `${rootDir}src/index.ts`,
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["siyuan", "process"],
            output: {
                // `exports: "auto"` (default) keeps `module.exports = PluginClass`,
                // which is exactly what the SiYuan host `require()`s.
                assetFileNames: "index.[ext]",
            },
        },
    },
});

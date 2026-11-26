/**
 * 对话框重设计的**加固门禁** —— 补 `tests/syncdialog-ui.test.ts` 判定逻辑的三个缺口。
 *
 * 1. 那条测试只把 `sync.dialog.*` 拿去查 `zh_CN`：`settings.tag.*` / `plugin.banner.*` /
 *    `sync.hint.*` 这些同样由对话框渲染的 key 完全没覆盖，`en_US` 更是没查过。这里按
 *    「调用点真正要的 key」全量核对两个 bundle + 占位符。
 * 2. 门禁行不留空位、页脚按钮不左移、计数器预留 18px 这三条是本次重构的核心视觉承诺，
 *    之前只有源码注释在说，没有断言。
 * 3. `reloadTaxonomy` 重挂字段后必须重算一次 `refresh()`，否则页脚门禁会与字段实际状态分叉。
 *
 * 全部是静态门禁（读源码 + 两个 bundle），被改代码零改动，与项目既有风格一致。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(path: string): string {
    return readFileSync(join(ROOT, path), "utf8");
}

const zh = JSON.parse(read("src/i18n/zh_CN.json")) as Record<string, string>;
const en = JSON.parse(read("src/i18n/en_US.json")) as Record<string, string>;

/**
 * Every i18n key a module actually asks for.
 *
 * Two shapes are used in this codebase: `this.t("key")` calls, and `{ key: "…", tone }` entries in
 * the status/intent maps whose `key` is later handed to `t()`. Both are collected, because a typo
 * in either one renders a raw key in the UI.
 */
function keysUsedBy(path: string): string[] {
    const source = read(path);
    const found = new Set<string>();
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
        found.add(match[1]);
    }
    for (const match of source.matchAll(/\bkey:\s*"([^"]+)"/g)) {
        found.add(match[1]);
    }
    return [...found].sort();
}

function placeholders(value: string): string[] {
    return [...value.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]).sort();
}

const UI_MODULES = [
    "src/ui/syncDialog.ts",
    "src/ui/settingsPanel.ts",
    "src/ui/components.ts",
    "src/ui/dockPanel.ts",
    "src/ui/resultPanel.ts",
    "src/ui/importPanel.ts",
    "src/index.ts",
];

describe("i18n · 每个调用点要的 key 都必须真的存在于两个 bundle", () => {
    const cases = UI_MODULES.map((path) => ({ path, keys: keysUsedBy(path) }));

    it("提取到的 key 数量是可信的（不是正则空转）", () => {
        cases.forEach(({ path, keys }) => {
            if (path === "src/ui/components.ts") {
                // `components.ts` 的设计约定是「只接收已本地化的文本」，所以它必须一个 key 都不查。
                expect(keys).toEqual([]);
                return;
            }
            expect(keys.length, `${path} 一个 key 都没提取到`).toBeGreaterThan(3);
        });
        // 对话框是本次改动的重心，key 数量必须显著多于其它模块。
        const dialog = cases.find((item) => item.path === "src/ui/syncDialog.ts");
        expect(dialog?.keys.length).toBeGreaterThan(50);
    });

    it("没有单边 key（zh_CN / en_US 都查）", () => {
        const missing: string[] = [];
        cases.forEach(({ path, keys }) => {
            keys.forEach((key) => {
                if (!(key in zh)) {
                    missing.push(`${path} → zh_CN 缺 ${key}`);
                }
                if (!(key in en)) {
                    missing.push(`${path} → en_US 缺 ${key}`);
                }
            });
        });
        expect(missing).toEqual([]);
    });

    it("对话框用到的 key 按命名空间分组后仍然零缺失", () => {
        const namespaces = ["sync.dialog.", "settings.tag.", "plugin.banner.", "sync.hint.", "sync.dock.", "err."];
        const keys = keysUsedBy("src/ui/syncDialog.ts");
        namespaces.forEach((namespace) => {
            const group = keys.filter((key) => key.startsWith(namespace));
            expect(group.length, `对话框没有任何 ${namespace}* key`).toBeGreaterThan(0);
            group.forEach((key) => {
                expect(key in zh, `${key} 不在 zh_CN`).toBe(true);
                expect(key in en, `${key} 不在 en_US`).toBe(true);
            });
        });
    });

    it("同一 key 的占位符名在中英两侧完全一致", () => {
        const mismatched: string[] = [];
        cases.forEach(({ keys }) => {
            keys.forEach((key) => {
                if (key in zh && key in en) {
                    const a = placeholders(zh[key]).join(",");
                    const b = placeholders(en[key]).join(",");
                    if (a !== b) {
                        mismatched.push(`${key}: zh=[${a}] en=[${b}]`);
                    }
                }
            });
        });
        expect(mismatched).toEqual([]);
    });

    it("错误模型里的动态 key（`issue.i18nKey`）也都在两个 bundle 里", () => {
        const source = read("src/core/errors.ts");
        const literals = [...source.matchAll(/"((?:err|image|sync|import|common|settings|plugin)\.[a-zA-Z0-9_.]+)"/g)].map(
            (match) => match[1],
        );
        expect(literals.length).toBeGreaterThan(4);
        const missing = [...new Set(literals)].filter((key) => !(key in zh) || !(key in en));
        expect(missing).toEqual([]);
    });

    it("搜索框占位符只有一条生效路径（同值的两个 key 不能同时被引用）", () => {
        // `settings.tag.search` 与 `settings.tag.searchPlaceholder` 目前文案完全相同。真正要防的
        // 不是「谁被用了」，而是「两个都被用」—— 那时改其中一条会出现「改了不生效」。
        const usedBySearch = UI_MODULES.filter((path) => read(path).includes('"settings.tag.search"'));
        const usedByPlaceholder = UI_MODULES.filter((path) => read(path).includes('"settings.tag.searchPlaceholder"'));
        expect(usedBySearch.length + usedByPlaceholder.length, "搜索框占位符没有任何 key 被引用").toBeGreaterThan(0);
        expect(
            usedBySearch.length === 0 || usedByPlaceholder.length === 0,
            `两个同值 key 同时被引用：${[...usedBySearch, ...usedByPlaceholder].join(", ")}`,
        ).toBe(true);
    });
});

describe("样式契约 · 门禁行与页脚的三个承诺", () => {
    const styles = read("src/ui/styles.scss");

    it("门禁行隐藏时不留空位（18px 的空行会把按钮顶偏）", () => {
        expect(styles).toMatch(/\.jjs-gate\[hidden\]\s*\{[^}]*display:\s*none/);
    });

    it("页脚操作行靠右固定，不随门禁行出现与否左右跳", () => {
        expect(styles).toMatch(/\.jjs-syncdialog__foot\s*>\s*\.jjs-row\s*\{[^}]*margin-left:\s*auto/);
    });

    it("「已选 N 个标签」清零时仍预留一行高度（0 选中不留空行、不抖动）", () => {
        expect(styles).toMatch(/\.jjs-chipinput\s*>\s*\.jjs-hint\s*\{[^}]*min-height:\s*18px/);
    });

    it("对话框内的 info 徽章不再用 --b3-theme-primary 写 12px 文字", () => {
        // 浅色主题下 primary 色 12px 小字对比度不足（项目已踩过的坑）。作用域只到对话框，
        // dock / result panel 的外观保持原样。
        const rule = styles.match(/\.jjs-syncdialog\s+\.jjs-status__top\s+\.jjs-badge--info\s*\{([^}]*)\}/);
        expect(rule, "缺少对话框内的 info 徽章文字色覆盖").not.toBeNull();
        expect(rule?.[1]).toContain("--b3-theme-on-surface");
        expect(rule?.[1]).not.toContain("--b3-theme-primary");
    });
});

describe("行为契约 · 标签工具的双按钮与重挂后重算", () => {
    const dialog = read("src/ui/syncDialog.ts");

    it("意图条语气与状态徽章语气是两条独立通道", () => {
        // 卡片色调来自 `intent.tone`（本次动作），徽章色调来自 `STATUS_LABEL[preview.status]`
        // （文档状态）。两者被合并就会出现「同一个动作在两种状态下一模一样」的语义错位。
        expect(dialog).toContain("jjs-status--${intent.tone}");
        expect(dialog).toContain("badge(this.t(status.key), status.tone)");
    });

    it("每个「同步标签」按钮都吃到 reloading 状态", () => {
        expect(dialog).toContain("node.disabled = reloading");
        expect(dialog).toContain("syncButtons.push(node)");
        // 重新挂载会造出新按钮，finally 里必须把整组都放开。
        expect(dialog).toMatch(/finally\s*\{[\s\S]{0,200}syncButtons\.forEach/);
    });

    it("重新拉取标签/分类后必须重算一次 refresh()，否则页脚门禁与字段状态分叉", () => {
        const start = dialog.indexOf("const reloadTaxonomy = async");
        expect(start).toBeGreaterThan(-1);
        const end = dialog.indexOf("const tagTools =", start);
        const body = dialog.slice(start, end === -1 ? undefined : end);
        // 重挂的字段会改写 draft.categoryId（空分类时自动选第一项），门禁和主按钮必须跟着变。
        expect(body).toContain("mountCategory()");
        expect(body).toContain("refresh()");
    });
});

describe("stamp() 抽取 · dock 不再自带实现", () => {
    it("dockPanel 从 ./format 引入 stamp", () => {
        expect(read("src/ui/dockPanel.ts")).toMatch(/import\s*\{\s*stamp\s*\}\s*from\s*"\.\/format"/);
    });

    it("全仓只有 format.ts 定义 stamp", () => {
        const definitions = ["src/ui/dockPanel.ts", "src/ui/syncDialog.ts", "src/ui/format.ts"].filter((path) =>
            /function stamp\s*\(/.test(read(path)),
        );
        expect(definitions).toEqual(["src/ui/format.ts"]);
    });
});

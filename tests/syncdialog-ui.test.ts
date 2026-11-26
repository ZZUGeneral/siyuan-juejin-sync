/**
 * 对话框重设计（v2）的静态门禁。
 *
 * 与 `hardConstraints.test.ts` 同样的思路：被投诉过的问题（标签并排显示 19 位 ID、12 个同级信息块、
 * 校验红字离按钮很远、规则行与错误行重复两遍）在行为测试里看不见 —— 它们只在源码文本里成立。
 * 这里用 grep 把四条设计决策钉死，本文件被测代码零改动，只读源码 + 两个 bundle。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(path: string): string {
    return readFileSync(join(ROOT, path), "utf8");
}

const componentsSource = read("src/ui/components.ts");
const dialogSource = read("src/ui/syncDialog.ts");
const stylesSource = read("src/ui/styles.scss");
const zh = JSON.parse(read("src/i18n/zh_CN.json")) as Record<string, string>;
const en = JSON.parse(read("src/i18n/en_US.json")) as Record<string, string>;

describe("标签区 · ID 只参与匹配，永不渲染", () => {
    it("suggestion 里没有 id 节点，样式也已删除", () => {
        expect(componentsSource).not.toContain("jjs-suggestion__id");
        expect(stylesSource).not.toContain(".jjs-suggestion__id");
    });

    it("chip / suggestion 的 title 不再是 id", () => {
        // 只有 `title: id` / `attrs: { title: item.id }` 这两种写法会把主键塞进可见属性。
        expect(componentsSource).not.toMatch(/title:\s*id\b/);
        expect(componentsSource).not.toMatch(/title:\s*item\.id\b/);
        expect(componentsSource).toContain("jjs-tag-unnamed");
    });

    it("无名标签判定与文案接入都在控件里", () => {
        expect(componentsSource).toContain("export function isUnnamedTag");
        expect(componentsSource).toMatch(/\^\\d\{10,\}\$/);
        expect(componentsSource).toContain("labels.unknown");
    });

    it("按 ID 精确匹配的能力保留（只是不展示）", () => {
        expect(componentsSource).toContain("item.id === keyword");
    });

    it("两个调用点都传了 unknown / remove 文案", () => {
        ["src/ui/syncDialog.ts", "src/ui/settingsPanel.ts"].forEach((file) => {
            const source = read(file);
            expect(source).toContain("settings.tag.unnamed");
            expect(source).toContain("sync.dialog.tagRemove");
        });
    });

    it("两个 bundle 的过期名称提示都不再提「显示为 ID」", () => {
        expect(zh["settings.tag.staleNames"]).not.toMatch(/\bID\b/);
        expect(en["settings.tag.staleNames"].toLowerCase()).not.toMatch(/\bid(s)?\b/);
        expect(zh["settings.tag.unnamed"]).toBe("未命名标签");
        expect(en["settings.tag.unnamed"]).toBe("Unnamed tag");
    });
});

describe("对话框 · 五区骨架与滚动契约", () => {
    it("意图条 / 正文滚动容器 / 页脚都在", () => {
        ["jjs-status__notebook", "jjs-syncdialog__body", "jjs-syncdialog__foot"].forEach((name) => {
            expect(dialogSource).toContain(name);
        });
    });

    it("只有一个滚动容器，页脚不参与滚动", () => {
        const body = stylesSource.slice(stylesSource.indexOf(".jjs-syncdialog__body {"), stylesSource.indexOf(".jjs-syncdialog__foot {"));
        expect(body).toContain("overflow-y: auto");
        expect(body).toContain("min-height: 0");
        const foot = stylesSource.slice(stylesSource.indexOf(".jjs-syncdialog__foot {"), stylesSource.indexOf("/* Roomier cards"));
        expect(foot).toContain("flex: 0 0 auto");
    });

    it("两张卡片 + 两个折叠区，不再是 12 个同级 group", () => {
        expect(dialogSource).toContain("jjs-details--plain");
        expect(dialogSource).not.toContain('class: "jjs-group"');
        expect(dialogSource).not.toContain("jjs-group__title");
    });

    it("发布模式：整宽警示 + 主按钮改文案，二次确认不变", () => {
        expect(dialogSource).toContain("jjs-notice--warn");
        expect(dialogSource).toContain("sync.dialog.publishTitle");
        expect(dialogSource).toContain("sync.dialog.confirmPublish");
        expect(dialogSource).toContain("this.confirmPublish(");
    });
});

describe("校验失败 · 原因贴近按钮，字段只加边框", () => {
    it("页脚有门禁行，且复用一个 key", () => {
        expect(dialogSource).toContain("jjs-gate");
        expect(dialogSource).toContain("sync.dialog.blockedBy");
    });

    it("摘要的规则行与错误行是同一个节点", () => {
        expect(dialogSource).toContain("jjs-field__rule");
        // 同一节点切换类名，而不是额外 append 一行错误。
        expect(stylesSource).toContain(".jjs-field__rule--error");
        expect(dialogSource).toMatch(/briefRule\.className/);
    });

    it("非法字段只用直接子控件选择器（否则标签搜索框会被误标红）", () => {
        expect(stylesSource).toContain(".jjs-field--invalid > .jjs-field__body > .jjs-input");
        expect(stylesSource).not.toMatch(/\.jjs-field--invalid\s+\.jjs-/);
    });
});

describe("文案 · 新增 key 中英对称且占位符一致", () => {
    const added = [
        "sync.dialog.intent.create",
        "sync.dialog.intent.update",
        "sync.dialog.intent.skip",
        "sync.dialog.intent.publish",
        "sync.dialog.intent.blocked",
        "sync.dialog.publishTitle",
        "sync.dialog.briefRule",
        "sync.dialog.diagnostics",
        "sync.dialog.tagTools",
        "sync.dialog.confirmPublish",
        "sync.dialog.blockedBy",
        "sync.dialog.tagRemove",
        "settings.tag.unnamed",
        "sync.dialog.cardBody",
        "sync.dialog.cardMeta",
    ];

    it("两个 bundle 都有这些 key", () => {
        added.forEach((key) => {
            expect(zh[key], key).toBeTruthy();
            expect(en[key], key).toBeTruthy();
        });
    });

    it("dialog 里用到的 key 都真的存在于 bundle", () => {
        const used = [...dialogSource.matchAll(/"(sync\.dialog\.[a-zA-Z.]+)"/g)].map((match) => match[1]);
        const missing = [...new Set(used)].filter((key) => !(key in zh)).sort();
        expect(missing).toEqual([]);
    });
});

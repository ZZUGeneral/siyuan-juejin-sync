# 「确认同步信息」对话框 · UI 重设计规格

> 文件：`docs/ui/syncdialog-spec.md`
> 对应实现：`src/ui/syncDialog.ts`（结构）、`src/ui/components.ts`（控件）、`src/ui/styles.scss`（样式）
> 配套视觉稿：`docs/ui/syncdialog-mockup.html`
> 状态：设计提案，等实现方评审。**本文件不改动 `src/`。**

---

## 0. 一句话目标

**把 12 个同级信息块压缩成「一个结论 → 两张卡 → 一条操作栏」，让用户在 2 秒内知道「这次要做什么、内容对不对、为什么点不了」。**

用户在这个对话框里只做 3 件事：

1. **确认这次动作的结果** —— 新建草稿？更新草稿？内容没变？还是直接公开？（决定他要不要点下去）
2. **核对即将发出去的四项元数据** —— 标题、摘要、分类、标签。
3. **点「开始同步」，或一眼看出它为什么灰着** —— 不需要滚动、不需要推测。

现状被投诉的 6 个问题与本次设计的对应解法：

| # | 现状问题 | 本设计的解法 |
|---|---|---|
| 1 | 12 块视觉权重相同，像调试面板 | 四级强调层级 + 只有 2 张卡片，其余全是辅助文字或折叠区 |
| 2 | 「这次会做什么」要自己拼；发布模式只有一行橙字 | 顶部**意图条**（14px 结论句 + 语气色）；发布模式升级为**整宽警示卡**；主按钮在发布模式改文案为「立即发布」 |
| 3 | 标签技术工具占据表单中段 | 「同步标签」与「粘贴文章链接导入」收进**折叠区**「找不到需要的标签？」，默认收起 |
| 4 | 诊断信息与录入信息混在一列，越滚越长 | 图片数 / 降级 / 流水线警告全部收进底部**折叠区**「同步说明（N）」 |
| 5 | 校验红字离按钮很远 | 页脚**固定**，原因行与按钮同行、贴在其左侧 |
| 6 | 50–100 字规则只在标签里 | 摘要字段下方**常驻**规则行 + 右上实时计数（仅越界时变红） |

---

## 1. 新布局分区

自上而下 5 个区（ZONE 1 意图 / ZONE 2 警示 / ZONE 3 录入 / ZONE 4 折叠 / ZONE 5 操作）。**只有 ZONE 3–4 一起滚动，ZONE 1–2 与 ZONE 5 常驻。**

```
┌──────────────────────────────────────────────────────────────────────┐ ─┐
│  确认同步信息                                                   ×    │  │ 思源 Dialog 自带标题
├──────────────────────────────────────────────────────────────────────┤  │
│ ╔══════════════════════════════════════════════════════════════════╗ │  │
│ ║ ▌[未同步]                                      技术团队笔记本    ║ │  │ ZONE 1
│ ║ ▌本次将新建一篇草稿，不会公开                                    ║ │  │ 意图条（固定）
│ ╚══════════════════════════════════════════════════════════════════╝ │  │
│ ┌──────────────────────────────────────────────────────────────────┐ │  │
│ │ 发布会立即公开到掘金                                             │ │  │ ZONE 2
│ │ 直接发布会把内容立即公开到掘金，每次同步都会二次确认             │ │  │ 发布警示（仅 publish）
│ └──────────────────────────────────────────────────────────────────┘ │  │
├──────────────────────────────────────────────────────────────────────┤  │
│ ┌─ 正文 ───────────────────────────────────────────────────────────┐ │  │
│ │ 标题                                                             │ │  │
│ │ [ 我的思源插件终于能发掘金了_____________________________ ]      │ │  │
│ │                                                                  │ │  │
│ │ 摘要                                                    62/100   │ │  │ ZONE 3
│ │ [ 这篇记录我把思源笔记里的文档同步到掘金草稿的全过程… ]          │ │  │ 录入卡 ×2
│ │ [ （textarea 4 行）                                     ]        │ │  │ （可滚动）
│ │ 50–100 字，不足或超出都无法同步                                  │ │  │
│ └──────────────────────────────────────────────────────────────────┘ │  │
│ ┌─ 分类与标签 ─────────────────────────────────────────────────────┐ │  │
│ │ 分类                                                             │ │  │
│ │ [ 前端 ▾ ]                                                       │ │  │
│ │ 标签                                              已选 2 个标签  │ │  │
│ │ [前端 ×] [TypeScript ×]                                          │ │  │
│ │ [ 搜索标签_____________________________________________ ]        │ │  │
│ │ ┌ 建议列表（默认展开，6 个/滚动）───────────────────────────────┐│ │  │
│ │ │ [前端] [TypeScript] [Vue.js] [Vite] [CSS] [性能优化]          ││ │  │
│ │ └───────────────────────────────────────────────────────────────┘│ │  │
│ └──────────────────────────────────────────────────────────────────┘ │  │
│ ▸ 找不到需要的标签？                                                  │  │ ZONE 4
│ ▸ 同步说明（3）                                                       │  │ 折叠 ×2
├──────────────────────────────────────────────────────────────────────┤  │
│ 无法同步：请至少选择一个标签                    [ 取消 ] [ 开始同步 ] │  │ ZONE 5 页脚（固定）
└──────────────────────────────────────────────────────────────────────┘ ─┘
```

### 分区职责表

| 区 | 用途 | 放什么 | 为什么必须在这个位置 | 强调级别 |
|---|---|---|---|---|
| **ZONE 1 意图条** | 回答「这次到底会做什么」 | 3px 语气色左边条 + 状态徽章（右上：所属笔记本）+ 一句结论（14px/600）+ 上次同步时间 | 决策信息必须在**第一眼**位置，且不随内容滚走 | **L1**（仅次于发布警示） |
| **ZONE 2 发布警示** | 唯一的不可逆动作提示 | 警告底 + 粗体标题「发布会立即公开到掘金」+ 一行正文（复用 `settings.mode.publishWarn`） | 紧贴意图条，与「点击按钮」之间没有任何其他内容；草稿模式下此区**不出现**（改由意图条承担） | **L0**（最高） |
| **ZONE 3 录入卡 ×2** | 用户唯一要动手的地方 | 卡 A「正文」：标题 + 摘要（含规则行、计数）。卡 B「分类与标签」：分类 select + 标签选择器 | 意图已确认后才需要动手；两张卡 = 两个心理分组，不再是 5 个并列字段 | **L2**（卡片容器） |
| **ZONE 4 折叠区 ×2** | 收纳低频与诊断信息 | ①「找不到需要的标签？」：同步标签按钮 + 粘贴链接导入 + 池大小 + 刷新/导入结果；②「同步说明（N）」：图片转存数、降级、流水线警告 | 全部是**可选/事后**信息，放最后且收起；打开会向下推内容，但页脚固定不受影响 | **L4**（最弱，仅标题可点） |
| **ZONE 5 操作栏** | 提交 / 取消 / 解释为什么不能提交 | 左：门禁原因（错误色，带 `!` 圆点）；右：`取消`（次级）、`开始同步`/`立即发布`（主） | 与按钮同行，视线不需移动即读到原因；`position` 上不滚动 | **L1**（主按钮）+ **L0**（原因行出现时） |

### 结构骨架（DOM 顺序，供实现参考）

```
.jjs-root.jjs-syncdialog
├── .jjs-card.jjs-status.jjs-status--{tone}      ← ZONE 1（复用 dock 的状态卡）
│   ├── .jjs-status__top   [.jjs-badge--…] [.jjs-status__spacer] [.jjs-status__notebook]
│   ├── .jjs-status__title                       ← 意图结论句（新 key）
│   └── .jjs-status__meta                        ← 上次同步时间（无记录时整行不渲染）
├── .jjs-notice.jjs-notice--warn                 ← ZONE 2（仅 publish）
│   ├── .jjs-notice__title
│   └── .jjs-notice__body
├── .jjs-syncdialog__body                        ← ZONE 3 滚动容器
│   ├── .jjs-card  (正文)
│   │   ├── .jjs-card__title
│   │   ├── .jjs-field            (标题)
│   │   └── .jjs-field            (摘要 + .jjs-field__rule + 计数 + 就近错误)
│   ├── .jjs-card  (分类与标签)
│   │   ├── .jjs-card__title
│   │   ├── .jjs-field-host       (分类，可重挂)
│   │   └── .jjs-field-host       (标签，可重挂；内含 .jjs-chipinput)
│   ├── details.jjs-details.jjs-details--plain   ← ZONE 4-a（标签工具）
│   └── details.jjs-details.jjs-details--plain   ← ZONE 4-b（同步说明）
└── .jjs-syncdialog__foot                        ← ZONE 5
    ├── .jjs-gate
    └── .jjs-row.jjs-row--end  [取消][开始同步]
```

**滚动契约（硬要求）**：思源 `Dialog` 自身不滚 body。

```scss
.jjs-syncdialog { max-height: calc(100vh - 220px); }
.jjs-syncdialog__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
.jjs-syncdialog__foot { flex: 0 0 auto; border-top: 1px solid var(--b3-border-color); padding-top: 12px; background: var(--b3-theme-background); }
```

内容短时对话框自动矮（body 无固定高度）；内容长时只有 `__body` 滚，页脚常驻。

---

## 2. 视觉层级规则

### 2.1 容器：卡片 / 分隔线 / 纯文字

| 用法 | 规则 |
|---|---|
| **卡片**（`--b3-theme-surface` 底 + 1px `--b3-border-color` + `--b3-border-radius`） | 只给 **3 个**东西：意图条、正文卡、分类与标签卡。`.jjs-notice` 提示条是「通栏提示」不算卡片。整屏卡片数 ≤ 3，这是「不再像调试面板」的硬约束 |
| **警示卡**（`--b3-card-warning-background` 底 + `--b3-card-warning-color` 边框与标题） | 只给发布模式，**全宽、不缩进**，用户无法忽略 |
| **分隔线**（1px `--b3-border-color`） | 只有一条：页脚上边。其余分组靠 **间距** 而不是线 |
| **纯文字** | 所有辅助说明、计数、池大小、折叠区内的结果提示，一律 12px `--b3-theme-on-surface-variant`，不再单独包盒子 |

对话框内 `.jjs-card` 用更宽松的内边距覆盖（不影响 dock）：

```scss
.jjs-syncdialog .jjs-card { padding: 16px; gap: 12px; }
```

### 2.2 字号与颜色 token

| 层级 | 用途 | 字号 / 字重 | 颜色 token |
|---|---|---|---|
| T1 | 意图结论句 | 14px / 600 / 行高 1.45 | `--b3-theme-on-background` |
| T2 | 卡片标题（正文 / 分类与标签） | 12px / 600 / 字距 .02em | `--b3-theme-on-surface`，opacity .65 |
| T3 | 字段标签 | 13px / 500 | `--b3-theme-on-surface` |
| T4 | 输入值 / 正文 | 13px / 400 | `--b3-theme-on-background` |
| T5 | 辅助（规则行、计数、池大小、上次同步） | 12px / 400 / 行高 1.5 | `--b3-theme-on-surface-variant`，opacity .75 |
| T6 | 徽章 / 折叠区标题 | 11–12px / 500 | 按 badge 语气；折叠区用 `--b3-theme-on-surface` |
| 语气-警告 | 发布警示标题与正文、`--warn` 提示 | 12–13px | `--b3-card-warning-color` / `--b3-card-warning-background` |
| 语气-错误 | 门禁原因、字段错误、越界计数 | 12px / 500 | `--b3-card-error-color`（底色用 `--b3-card-error-background`） |
| 语气-成功/主色 | 意图条左侧语气条、状态徽章、「已同步」 | — | `--b3-card-success-color` / `--b3-theme-primary` |

**控件细节**

- 标题 `input`、摘要 `textarea`、分类 `select` 统一 13px / 行高 1.5（textarea 1.65），内边距 6px 9px，圆角 `--b3-border-radius`，底色 `--b3-theme-surface`，边框 1px `--b3-border-color`。
- **摘要 textarea 不再用等宽字体**（现状 `--b3-font-family-code`）：等宽 + 12px 是「调试面板」观感的主要来源之一，摘要不是代码。
- 摘要字段的规则行与错误行**共用同一槽位**（`.jjs-field__rule`）：合规时显示 `sync.dialog.briefRule`，越界时同一行**就地**换成 `err.brief.range` 并转错误色 —— 不新增一行，因此不会推挤布局、也不会出现「规则 + 错误」两行重复。

**禁用做法（会被评审打回）**

- 任何硬编码色值、`#xxx`、`rgba()` 字面量（除 `var(..., fallback)` 的既有兜底）。
- 用 `--b3-theme-primary` 写 12px 小字（浅色主题下对比度不足，dock 已踩过这个坑）。
- 一屏出现第 4 张卡片。
- 用彩色文字段落（一行橙字）表示「不可逆」——必须是整宽警示卡。

### 2.3 间距刻度

元素之间的间距只允许这 5 个值：**4 / 8 / 12 / 16 / 24**。（控件**内部**内边距不属于此刻度，见 2.2 控件细节：6px 9px。）

| 位置 | 值 |
|---|---|
| 字段标签 ↔ 控件 | 8 |
| 控件 ↔ 规则行/错误行 | 4 |
| 卡片内元素之间 | 12（`.jjs-card.gap` 12） |
| 卡片之间（ZONE 3 内） | 12 |
| 大区之间（ZONE1↔2↔3↔4↔5） | 16（根 gap 从 12 提到 16） |
| 卡片内边距 | 16 |
| 页脚上内边距 | 12，门禁行 ↔ 按钮间距 12 |
| 折叠区标题 ↔ 内容 | 8 |

行高统一 1.45–1.5；不用 1.2 之类的紧行高（中文会挤）。

---

## 3. 状态设计

八个状态（4 个动作态 + 4 个异常/辅助态）；每个态只允许通过以下三个旋钮表达差异：**意图条语气（tone）/ 是否出现警示卡 / 页脚门禁行与按钮状态**。

| # | 状态 | 视觉差异 | 文案（key） |
|---|---|---|---|
| ① | **新建草稿** | 意图条 tone=`info`（`--b3-theme-primary` 左条）；徽章 `未同步` muted；主按钮「开始同步」可用 | 结论 `sync.dialog.intent.create`「本次将新建一篇草稿，不会公开」；徽章 `plugin.banner.unsynced` |
| ② | **更新已有草稿** | 意图条 tone=`ok`（`--b3-card-success-color`）；徽章 `草稿已同步` ok；`__meta` 追加「上次同步 2 天前」；若 `status==="draft"` 额外加一条 `.jjs-notice--quiet` 提示（见下） | 结论 `sync.dialog.intent.update`；徽章 `plugin.banner.draft`；时间复用 `sync.dock.meta.last`；提示 `sync.hint.maybePublished` |
| ③ | **内容未变化** | 意图条 tone=`muted`（`--b3-theme-on-surface-variant` 左条，结论句同样用中性色）；结论句用中性色；主按钮文案不变但下方门禁行可选提示「内容未变化」；**不加任何红色** | 结论 `sync.dialog.intent.skip` |
| ④ | **发布模式** | 意图条 tone=`warn`（`--b3-card-warning-color`）；结论句 `sync.dialog.intent.publish`；**ZONE 2 警示卡出现**：警告底、粗体标题、正文一行；主按钮文案改为「立即发布」，保持 primary；按钮点击后仍走 FR-13 二次确认（行为不变） | 警示标题 `sync.dialog.publishTitle`；正文 `settings.mode.publishWarn`；结论 `sync.dialog.intent.publish`；按钮 `sync.dialog.confirmPublish` |
| ⑤ | **校验失败** | ① 页脚左侧出现 `.jjs-gate`（错误色 + `!` 圆点，文案 = `sync.dialog.blockedBy` 包住 `validate()` 返回的第一处原因）；② 主按钮 `disabled`（`--b3-theme-surface-lighter` 底 + 弱化文字 + `cursor:not-allowed`）；③ **所有当前非法的字段**加 `.jjs-field--invalid`（仅给字段内部直接子控件加 1px `--b3-card-error-color` 边框，不加第二套文字）；④ 摘要越界时同一槽位的规则行就地转红并换成 `err.brief.range`，计数器同时转红；⑤ 标签为空时 chips 行内就地显示 `sync.dialog.needTag`。**门禁行与字段内文案复用同一个 key，不允许两套说法** | 前缀 `sync.dialog.blockedBy`；原因复用 `sync.dialog.needTitle` / `err.brief.range` / `sync.dialog.needCategory` / `sync.dialog.needTag` |
| ⑥ | **分类/标签为空** | 不画空 select / 空列表，改为**字段级空态**：字段标签保持，控件位置放一行 warn 文字 + 一个可执行动作。分类空 → 提示去设置页；标签空 → 提示点「同步标签」或导入文章链接（同步标签按钮此时**在空态行内可见**，不只藏在折叠区） | 分类 `settings.category.empty`；标签 `settings.tag.empty` + `sync.dialog.tagImportHint` |
| ⑦ | **标签刷新中 / 成功 / 失败** | 三段式状态行，位于折叠区「找不到需要的标签？」内、按钮右侧（12px）：刷新中 = 中性 + 按钮 disabled；成功 = 中性色文字（可加 `--b3-card-success-color` 前缀小圆点，非必需）；失败 = 错误色，取前 160 字符。**不新增 Toast，不改按钮尺寸**（避免布局跳动：给状态行预留 `min-height: 18px`） | `sync.dialog.tagRefreshing` / `sync.dialog.tagRefreshed` / `sync.dialog.tagRefreshFailed` |
| ⑧ | **标签搜索中 / 无匹配 / 搜索失败** | 建议列表内的一行 `.jjs-suggestions__note`（保留现有三态逻辑）：搜索中 = 中性 + 「搜索中…」；无匹配 = 中性 + 「没有匹配的标签」；搜索失败 = 错误色 + 「标签搜索失败，请稍后重试」。**三态都必须出现文字**，不允许空白框 | `settings.tag.searching` / `settings.tag.noMatch` / `settings.tag.searchFailed` |

**态叠加规则**：④（发布）+ ⑤（校验失败）可同时成立 —— 警示卡保留，主按钮 disabled，门禁行说原因。此时**不许**把警示卡换成错误卡：颜色语义不同（不可逆 ≠ 出错）。

`.jjs-notice--quiet`（非阻断提示，用于 `sync.hint.maybePublished`）：只画 1px `--b3-border-color` 边框 + `--b3-theme-surface-lighter` 底，文字用 `--b3-theme-on-surface`，无图标底色。放在意图条正下方、录入卡之前。

---

## 4. 标签区规格（含「不显示 ID」）

### 4.1 结论

**ID 是内部主键，不是信息。** 界面上任何位置都不出现 19 位数字串；ID 仅保留在匹配逻辑与提交载荷里。

### 4.2 逐项处理

| 位置 | 现状 | 改为 |
|---|---|---|
| **建议项（`jjs-suggestion`）** | `名称` + `.jjs-suggestion__id`（19 位数字）并排 | **只显示名称**；删除 `.jjs-suggestion__id` 节点与样式 |
| 建议项 `title` 属性 | 当前设置为 `item.id` | 改为 `item.name`（仅当名称被截断时才有意义）；已选中的建议项用 `aria-pressed="true"`，不加 `title` |
| **已选 chip** | `名称` + `×`，`×` 的 `title` 是 ID | `名称` + `×`；`×` 的 `title` / `aria-label` 用 `sync.dialog.tagRemove`「移除标签」。chip 本体不加 `title` |
| **搜索框占位** | `settings.tag.searchPlaceholder` =「搜索标签名称或 ID」 | `settings.tag.searchPlaceholder` 的值改为「搜索标签」（不再承诺按 ID 搜，但能力保留） |
| **按 ID 精确匹配** | `matchesOf` 里 `item.id === keyword` | **保留**。内部能力不变：粘贴 19 位 ID 仍能命中，只是界面上不提示、不回显 ID |
| **池大小计数** | `共 ${n} 个可用标签` 12px 灰字，挂在字段下方 | 收进折叠区标题右侧，或作为字段辅助行保留（择一，见待确认项）。视觉上不再出现在标签选择器与建议列表之间 |

### 4.3 名称缺失（历史缓存把 id 当 name 存过）

判定：`name.trim() === ""` 或 `/^\d{10,}$/.test(name)` → 视为 **无名标签**。

渲染规则：

- `nameOf(id)` 不再回退成 `id` 本身，而是回退到占位文案 `settings.tag.unnamed`「未命名标签（建议重新拉取）」。
- 该 chip / 建议项追加 `.jjs-tag-unnamed`：文字 `--b3-theme-on-surface-variant` + `font-style: italic`，不换颜色（避免整片红）。
- 无名标签**仍可选中、仍可提交**（id 是有效载荷，掘金端认 ID），只是用户看不见名字。
- 字段级提示：只要当前选中集合里存在无名标签，字段下方追加一行 warn：`settings.tag.staleNames`（已有 key，「标签名称未取到（当前显示为 ID），请重新点击…」）。若该 key 文案同时提到"显示为 ID"，需同步改写为不含 ID 的表述（见第 8 节待确认项）。
- 字段级 warn 行只出现**一次**（不论有几个无名标签），避免一片「未命名」把卡片刷屏。

### 4.4 选择器布局

```
标签                                          已选 2 个标签
[前端 ×] [TypeScript ×]                                   ← chips 换行
[ 搜索标签_____________________________ ]                  ← 全宽输入
┌──────────────────────────────────────────────────────┐
│ [前端] [TypeScript] [Vue.js] [Vite] [CSS] [性能优化] │   ← 建议池，max-height 148px 内滚
└──────────────────────────────────────────────────────┘
```

- 建议池默认展开（不搜索时展示池内前 N 个），`max-height: 148px`，`overflow-y:auto`；池子几百个也不撑高对话框。
- **0 选中时 chips 行不空着**：行内渲染 `.jjs-hint.jjs-hint--error` + `sync.dialog.needTag`「请至少选择一个标签」，选中第一个标签即消失。这样「空的标签区」自己会解释自己，而不是只靠底部那条红色门禁行。
- 标签字段没有「单一控件」可以画红框，因此它的 `.jjs-field--invalid` 表现为**上述 chips 行红字**，不给搜索框加红边（加了会被读成「搜索框填错了」）。
- 已选 chip 行 `min-height: 24px`（0 选中时不塌陷）。
- A6 约束不变：本地过滤 + 远端搜索合并，搜索中/无匹配/搜索失败三态文案齐全。

---

## 5. 底部操作区规格

```
┌──────────────────────────────────────────────────────────────┐
│ ! 无法同步：请至少选择一个标签        [ 取消 ]  [ 开始同步 ] │
└──────────────────────────────────────────────────────────────┘
   ↑ flex:1，可折行                    ↑ outline   ↑ primary
```

| 元素 | 规格 |
|---|---|
| 容器 | 页脚，`border-top` 1px `--b3-border-color`，`padding-top: 12px`，`display:flex; align-items:center; gap:12px`，不参与滚动 |
| 门禁行 `.jjs-gate` | `flex: 1 1 auto; min-width: 0`；12px/500；`--b3-card-error-color`；`!` 圆点用 CSS `::before`（14×14 圆，`--b3-card-error-background` 底 + 错误色字）——**不用 SVG、不用字体图标**；无问题时整行不渲染（`display:none`，不留 18px 空位） |
| 「取消」 | `b3-button--outline` + `.jjs-button`，次级权重；永远可用（同步中除外，本次不改） |
| 主按钮 | `b3-button--primary`；文案 = 草稿/更新/未变化 → `sync.dialog.confirm`「开始同步」，发布模式 → `sync.dialog.confirmPublish`「立即发布」；`min-width: 96px` 防止文案切换导致布局跳动。**发布模式仍用主题主色**（不改成警示橙）：不可逆的信号由整宽警示卡 + 意图句 + 按钮文案三重承担，按钮再变橙会与警示卡争夺注意力，且主题主色是唯一「可点击主操作」的颜色语义 |
| 禁用态 | `disabled` 属性 + 不改颜色 token（由 `.b3-button` 自带），额外加 `cursor: not-allowed`；**禁用时仍然显示门禁行**，这是本设计的核心：按钮灰 = 旁边有原因 |
| 错误提示位置 | 只允许两类：① `.jjs-gate`（第一处问题，紧贴按钮）② 字段**既有槽位**（摘要的规则行、空的 chips 行），复用同一个 key，**不新增独立错误节点**。不允许第三类（例如对话框顶部再堆一条） |
| 发布模式二次确认 | 行为不变：`settings.publishMode === "publish"` 且点击确认 → 必弹 `confirmDialog`，文案含最终标题（FR-13） |

---

## 6. 文案表（新增 key，13 条）

中英**必须对称**（`tests/i18n-consistency.test.ts` 校验键集与占位符一致）。

| # | key | zh_CN | en_US |
|---|---|---|---|
| 1 | `sync.dialog.intent.create` | 本次将新建一篇草稿，不会公开 | A new draft will be created — nothing goes public |
| 2 | `sync.dialog.intent.update` | 本次将更新已有草稿 | The existing draft will be updated |
| 3 | `sync.dialog.intent.skip` | 内容未变化，本次不会提交 | Nothing changed — nothing will be submitted |
| 4 | `sync.dialog.intent.publish` | 本次会直接公开发布 | This will publish publicly, right now |
| 5 | `sync.dialog.intent.blocked` | 本次同步已中止，不会提交 | Aborted — nothing will be submitted |
| 6 | `sync.dialog.publishTitle` | 发布会立即公开到掘金 | Publishing goes public on Juejin immediately |
| 7 | `sync.dialog.briefRule` | 50–100 字，不足或超出都无法同步 | 50–100 characters; sync stays disabled outside that range |
| 8 | `sync.dialog.diagnostics` | 同步说明（${n}） | Sync details (${n}) |
| 9 | `sync.dialog.tagTools` | 找不到需要的标签？ | Can't find the tag you need? |
| 10 | `sync.dialog.confirmPublish` | 立即发布 | Publish now |
| 11 | `sync.dialog.blockedBy` | 无法同步：${reason} | Can't sync: ${reason} |
| 12 | `sync.dialog.tagRemove` | 移除标签 | Remove tag |
| 13 | `settings.tag.unnamed` | 未命名标签（建议重新拉取） | Unnamed tag (fetch again to fix) |

**复用（不新增）**：`sync.dialog.title / docTitle / brief / briefCounter / category / tags / confirm / cancel / needTitle / needCategory / needTag / tagRefresh / tagRefreshing / tagRefreshed / tagRefreshFailed / tagImportHint / tagImportPlaceholder / tagImportAction / tagImporting / tagImported / tagImportEmpty / tagImportInvalid / tagImportFailed / images`、`sync.action.*`、`plugin.banner.*`、`settings.mode.publishWarn / draft`、`settings.category.empty`、`settings.tag.empty / search / searching / noMatch / searchFailed / selected / staleNames`、`sync.hint.maybePublished`、`sync.result.degraded`、`sync.dock.meta.last`、`err.brief.range`。

**可能变为未使用**：`sync.dialog.mode`（「同步模式」标签）、`sync.dialog.tagPool`（若池大小收进折叠区）。实现时先保留 key（删 key 需同步两个 bundle + 测试）。

**占位符注意**：`sync.dialog.diagnostics` 用 `${n}`，`sync.dialog.blockedBy` 用 `${reason}` —— 两个 bundle 必须完全一致。

---

## 7. 类名清单

### 7.1 新增

| 类名 | 职责 |
|---|---|
| `.jjs-syncdialog__body` | ZONE 3+4 的滚动容器：`flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding-right:4px` |
| `.jjs-syncdialog__foot` | ZONE 5 页脚：`flex:0 0 auto`，上边框分隔线，`padding-top:12px`，底色 `--b3-theme-background`（避免滚动内容透出） |
| `.jjs-notice` | 提示条基础：1px 边框 + `--b3-border-radius` + `padding:12px`，flex 列，`gap:4px` |
| `.jjs-notice--warn` | 发布警示：`--b3-card-warning-background` 底、`--b3-card-warning-color` 边框/文字、**左 3px 同色实心条**（`border-left-width:3px`） |
| `.jjs-notice--quiet` | 非阻断提示（可能已在网页端发布）：`--b3-theme-surface-lighter` 底 + `--b3-border-color` 边框，文字 `--b3-theme-on-surface`，无左条 |
| `.jjs-notice__title` | 提示卡标题：13px / 600 / 行高 1.45 |
| `.jjs-notice__body` | 提示卡正文：12px / 400 / 行高 1.5 / 允许折行（`overflow-wrap:anywhere`） |
| `.jjs-status__notebook` | 意图条右上角的所属笔记本：12px / `--b3-theme-on-surface-variant` / opacity .8；窄屏时允许折行到标题下方（`flex-wrap`） |
| `.jjs-field__rule` | 摘要字段的常驻规则/错误槽位：12px / 行高 1.5 / `--b3-theme-on-surface-variant` / opacity .75；`margin-top: -4px` 让行距回到 4px 刻度 |
| `.jjs-field__rule--error` | 越界态：`--b3-card-error-color`、opacity 1、字重 500。与 `.jjs-field__rule` 同一节点切换，不新增 DOM 行 |
| `.jjs-field--invalid` | 字段错误强调：作用于 `.jjs-field`，**只给 `.jjs-field__body` 的直接子控件**（`.jjs-input/.jjs-textarea/.jjs-select`）加 `--b3-card-error-color` 边框。**绝不**用后代选择器——否则标签选择器内部的搜索框会被标红，看起来像「搜索框填错了」。**所有非法字段都标**（让用户一次看全要改哪些），文字原因只出现在 `.jjs-gate`（第一处）、摘要规则槽、以及标签为空时的 chips 行 |
| `.jjs-gate` | 页脚门禁原因行：12px/500，`--b3-card-error-color`，`flex:1 1 auto; min-width:0`，`display:flex; gap:6px; align-items:flex-start` |
| `.jjs-gate::before` | CSS 画的 `!` 标记：14×14 圆、`--b3-card-error-background` 底、错误色字、`flex:0 0 auto`、`font-size:11px; line-height:14px; text-align:center` |
| `.jjs-details--plain` | 折叠区「无外框」变体：去掉 1px 边框与底色，只留 `padding:2px 0`、标题加 `▸/▾`（用 `::marker` 或 `summary` 默认三角），用于标签工具与同步说明，避免第 4、5 张卡片 |
| `.jjs-tag-unnamed` | 无名标签：作用于 `.jjs-chip` / `.jjs-suggestion`，`font-style:italic` + `--b3-theme-on-surface-variant`；可与其他修饰类叠加 |

### 7.2 复用（不改名、不加新类）

`.jjs-card` / `.jjs-card__title`（卡片与卡标题）、`.jjs-status` / `.jjs-status--{ok,info,warn,error,muted}` / `.jjs-status__top` / `.jjs-status__label` / `.jjs-status__title` / `.jjs-status__meta` / `.jjs-status__spacer`（意图条整套）、`.jjs-field` / `.jjs-field__head` / `.jjs-field__body` / `.jjs-field__label` / `.jjs-field-host`、`.jjs-hint` / `.jjs-hint--warn` / `.jjs-hint--error`、`.jjs-chipinput` / `.jjs-chips` / `.jjs-chip` / `.jjs-chip__x` / `.jjs-suggestions` / `.jjs-suggestion` / `.jjs-suggestion--active` / `.jjs-suggestions__note`、`.jjs-row` / `.jjs-row--end`、`.jjs-button`、`.jjs-ghost`、`.jjs-badge--*`、`.jjs-details` / `.jjs-details__summary`、`.jjs-import`。

### 7.3 可删除 / 停用

| 类名 | 处理 |
|---|---|
| `.jjs-suggestion__id` | **删除**（样式 + DOM 节点）。第 4 节的核心改动 |
| `.jjs-group`（在对话框内） | 停用。对话框不再用「平铺 group」，分组由 `.jjs-card` 承担；`.jjs-group` 保留给其他面板 |
| `.jjs-group__title` | 停用（对话框内），由 `.jjs-card__title` 承担 |
| `.jjs-list`（对话框内） | 停用。流水线警告并入「同步说明」折叠区，用 `.jjs-hint` 逐行即可 |
| `.jjs-hint--warn` 用于发布模式段落 | 停用该用法（改由 `.jjs-notice--warn`）。`.jjs-hint--warn` 本身保留 |

### 7.4 落地顺序建议（给实现方）

1. 先搭骨架：`__body` / `__foot` / 根 gap 16 / 卡片内边距覆盖（不动任何文案，改完即可验收「不再整体滚动」）。
2. 再换头部：`.jjs-group` → `.jjs-status` 意图条 + `.jjs-notice--warn`（文案接入新 key）。
3. 再合并字段：标题 + 摘要进「正文」卡，分类 + 标签进第二卡。
4. 最后收折叠区：标签工具、同步说明；同时删 `.jjs-suggestion__id` 与无名标签占位。

---

## 8. 待确认项（3 条）

1. **「共 N 个可用标签」放哪里？** 现在挂在标签字段下方，属于「诊断味」信息。方案 A：收进「找不到需要的标签？」折叠区标题右侧（更干净，但用户不知道池子多大）；方案 B：留在字段辅助行（信息更全，但 ZONE 3 又多一行灰字）。我倾向 A，需产品/实现方确认。若选 A，`sync.dialog.tagPool` 不再出现在主视线内。

2. **`settings.tag.staleNames` 现有文案含「当前显示为 ID」**，与新规则（永不显示 ID）矛盾。需要同步改写为例如「部分标签名称未取到，已显示为「未命名标签」，请重新点击「同步标签」」。这会改动**已有 key 的中英文案**（不是新增 key），且设置页也在用，需确认是否允许一改两处。

3. **发布模式主按钮改文案为「立即发布」**是否会与既有验收脚本/文档中的「开始同步」描述冲突？行为（FR-13 二次确认）不变，只是标签不同。若评审要求按钮文案恒定，则回到统一「开始同步」，靠警示卡与意图句承担不可逆提示（视觉上会弱一档）。

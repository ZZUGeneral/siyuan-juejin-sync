# TEST-REPORT：siyuan-juejin-sync

| 项 | 内容 |
| --- | --- |
| 文档版本 | v1.0（QA 独立验证，第 1–2 轮合并输出） |
| 作者 | 严过关（QA 工程师） |
| 验证对象 | T1–T5 全部实现（`src/` 27 个文件 / 8 464 行，其中 24 个 `.ts`） |
| 验证环境 | Node v24 · npm（本机无 pnpm）· 思源内核 3.8.12 @ `127.0.0.1:6806`（实测可达）· **无掘金账号凭证** |
| 上游依据 | `docs/PRD.md`（439 行）· `docs/ARCHITECTURE.md` v1.2（1 452 行） |
| 结论（一句话） | **P0 代码级验收通过，可交付工程验证；但"真实联调"整段仍未验证，P0 不可声明为"已验证可用"** |

---

## 1. 基线复核（反驳式复核，先自己跑）

工程师自述「构建绿、83 测试全绿」。实测复核结论：**成立，但覆盖面被高估**。

| 检查 | 命令 | 实测结果 | 与工程师自述是否一致 |
| --- | --- | --- | --- |
| 类型检查 | `npm run check`（`tsc --noEmit`） | 通过，0 error | ✅ |
| 构建 | `npm run build` | 通过，`dist/index.js` 203.24 kB（gzip 52.10 kB）、`dist/index.css` 7.02 kB、26 modules | ✅ |
| 产物 | `dist/` | `index.js` / `index.css` / `plugin.json` / `icon.png` / `preview.png` / `i18n/zh_CN.json` / `i18n/en_US.json` 均在 | ✅ |
| 单测（基线） | `npm test` | **4 files / 83 tests passed**，304 ms | ✅ 数字一致 |
| 单测（补测后） | `npm test` | **14 files / 360 tests passed**，835 ms | 新增 277 |

> 基线 83 个测试的真实分布：`sign` 24 / `markdown` 25 / `brief` 18 / `i18n` 16。**`syncEngine`、`errors`、`images`、`settings`、`importer`、`binding`、`store`、`proxy`、`kernel`、`juejin` 十个模块的测试数为 0**——而 FR-08/FR-10/D1/D2 这几条最容易做错的验收标准全部落在这十个模块里。

### 1.1 现有 83 个测试的质量评价

**好的部分（真材实料，不是凑数）**：

- `sign.test.ts` 用的是**公开标准向量**（FIPS 180-4 / RFC 4231 / CRC32 `123456789`），不是自证型断言；SigV4 做成结构断言而非"录制黄金值"，注释里说明了理由——这个取舍是对的。
- `markdown.test.ts` 有三份 fixture，其中 `sample-3.md` 是**故意合成**的（真实导出已不含 IAL/块引用），说明作者知道"今天的样本干净 ≠ 规则可以省"。
- `i18n.test.ts` 除了 key 差集，还做了「源码零 CJK 扫描」和「源码引用的 key 必须在 bundle 中存在」——后者是很容易漏的一条。

**空洞 / 覆盖不足清单**（按补测价值排序）：

| # | 覆盖缺口 | 为什么危险 |
| --- | --- | --- |
| G1 | **`syncEngine` 0 测试** | FR-10 防重、D1/D2、`contentHash` 时机全靠它。83 个测试全绿也完全不能证明"连续同步 3 次只有 1 篇文章" |
| G2 | **`errors` 0 测试** | 错误 Cookie 被判成"网络不可达"就是产品级事故（用户去查 Wi-Fi） |
| G3 | **`images` 0 测试** | D1「关闭上传必须产出失败项」、D2「预检失败不抛错」都没有任何断言 |
| G4 | **`settings` 0 测试** | 凭证是否可能漏进 `settings` 主存储、`riskAccepted` 门禁，没有任何机器保证 |
| G5 | 无"静态硬约束"门禁 | D1/D2/D4/A3/A7/硬约束①③ 都写在文档里，**没有任何一条被自动检查**。工程师日后加一行 `if (!preflight.ok) return;` 全部测试仍绿 |
| G6 | `i18n` 只校验 key 集合，不校验**英文包是否真是英文** | 把中文值粘进 `en_US.json` 能通过全部 16 个测试 |
| G7 | `i18n` 不校验**插值占位符一一对应** | zh 有 `${n}`、en 漏掉 → 英文界面渲染出 "Degraded  places" |
| G8 | `brief` 缺 49 / 50 / 100 / 101 精确边界与「30 emoji 补齐后不劈开代理对」 | 边界值才是被服务端拒绝的那一档 |
| G9 | `importer` 0 测试（P2，但 FR-22 链接解析、FR-25 `{{title}}` 注入非法文件名属"用户内容进路径"） | 路径穿越 / 非法文件名 |
| G10 | 空断言/自证断言 | 未发现 `expect(true).toBe(true)` 之类。少量断言偏弱（如 `expect(output.markdown.length).toBeGreaterThan(0)`），但都有更强的邻居断言兜底，可接受 |
| G11 | UI 层（`ui/*` 1 900 行）0 测试 | 无 jsdom 环境；A3/A5/A7 只能做源码级静态断言 + 人工核对，已在 §4 说明 |

---

## 2. 本轮做了什么

### 2.1 测试基础设施（1 处配置 + 1 个 stub，均不在 `src/`）

`siyuan@1.3.0` 是**纯类型包**（`exports` 没有 runtime 入口），而 `api/proxy.ts` / `api/kernel.ts` 以**值**的方式 `import { fetchSyncPost }`。因此任何试图 `import` 编排层的测试在 node 环境都会解析失败——这正是 `syncEngine` 长期 0 测试的根因。

修复方式（不触碰 `src/`）：

- 新增 `tests/stubs/siyuan.ts`：只实现被值引用的 6 个符号（`fetchSyncPost` / `getFrontend` / `openTab` / `openMobileFileById` / `showMessage` / `confirm`）+ 4 个占位 class。
- `vitest.config.ts` 增加 `resolve.alias.siyuan → tests/stubs/siyuan.ts`。

副作用（正面）：`api/proxy.ts` 也随之可测，于是「代理 `code != 0` → `NETWORK`」这条可以在**真实 `HttpProxy` 代码**上端到端验证，而不是只测 `mapProxyError` 映射表。

### 2.2 新增测试清单（10 个文件 / **277 个测试**）

| 文件 | 测试数 | 目标 | 对应 T-项 |
| --- | --- | --- | --- |
| `tests/syncEngine.test.ts` | 22 | 编排层：防重、预检不阻断、D1、图片失败、hash 时机、元信息、publish 二次确认、并发、preview | **T-A T-B T-C T-E** |
| `tests/errors.test.ts` | 28 | 错误分类表 + `HttpProxy` 契约（headers 数组、4xx 不是 HTTP error、base64、日志脱 URL query） | **T-D** |
| `tests/images.test.ts` | 18 | `preflight` 永不抛、`process` 只换 URL、单图失败继续、D1 关闭上传、remote/data、进度 | **T-C D1 D2** |
| `tests/markdown-edges.test.ts` | 28 | IAL 正则不误伤、CRLF/BOM、引用降级、**代码围栏内图片不上传**、hash 语义 | **T-F T-E** |
| `tests/brief-boundary.test.ts` | 36 | 0/1/49/50/51/99/100/101/500 码点、30/200 emoji 不劈代理对、幂等性 | **T-G** |
| `tests/settings.test.ts` | 26 | 设置归一化、**凭证不进 settings**、`riskAccepted` 门禁、vault 优先级、clear/uninstall、历史环形缓冲、`maskSecret` | 硬约束（凭证） |
| `tests/importer.test.ts` | 46 | 链接三形态、`{{title}}` 非法文件名/穿越、页面降级 A4、图片回迁、重复导入 | P2 / FR-22/25/27 |
| `tests/i18n-consistency.test.ts` | 16 | **英文包无 CJK**、占位符一一对应、`textOf` 降级、A7 措辞 | **T-H** |
| `tests/hardConstraints.test.ts` | 48 | 静态门禁：D1/D2/D4/A3/A7/硬约束①③/A2/D3 | **§3 全表** |
| `tests/knownDeviations.test.ts` | 9 | 把 §5 的缺陷**固化为可回归断言**（当前行为锁定，修好即红） | 缺陷回归 |

结果：**277 / 277 通过**；`tsc --noEmit` 0 error；`vite build` 绿。合计 **360 / 360 通过**。

> 说明：`knownDeviations.test.ts` 断的是"当前实际行为"，不是"应当行为"。它的用途是让缺陷在代码里留痕——谁改了就立刻看到这条测试变红，从而兑现报告里的建议。

### 2.3 真实环境只读实测（补强"未验证"的边界）

在不写入用户数据的前提下，对内核契约做了实测（只读接口）：

| 实测 | 结果 | 对应实现 | 判定 |
| --- | --- | --- | --- |
| `POST /api/system/version` | `3.8.12` | — | 环境与文档一致 |
| `POST /api/notebook/lsNotebooks` | `data.notebooks[].{id,name}` | `kernel.ts:253-261` 解析一致 | ✅ 契约相符 |
| `POST /api/export/exportMdContent` | `data.{content,hPath}`，content **确以 `---\ntitle: …\n---` 开头** | `kernel.ts:127-133`；S0 的前提 | ✅ 契约相符，S0 前提成立 |
| `POST /api/block/getBlockInfo` | `data.box` = 笔记本 id | `kernel.ts:264-267`（`getDocNotebook`） | ✅ 契约相符 |
| 用**真实导出**（2 916 字符）跑 `sanitize()` | 2 806 字符，`warnings=[]`、`degradations=[]`、`imageRefs=[]`、`title="问题记录"` | S0–S5 | ✅ 真实数据无残留 |

---

## 3. 硬约束逐条核查表

> 判定口径：**通过** = 有可复现的机器验证；**不通过** = 实测/静态核对有违；**未验证** = 需要真实凭证或真机，禁止标记为通过。

### 3.1 已决策项 D1–D4

| # | 要求 | 判定 | 证据 |
| --- | --- | --- | --- |
| **D1-a** | 图片阶段被 `syncEngine` **无条件调用** | ✅ 通过 | `syncEngine.ts:171-188`（`preflight` 与 `process` 均在主流程直线上，无 `if` 守卫）；`hardConstraints.test.ts`「calls preflight and process unconditionally」 |
| **D1-b** | `autoUploadImages=false` 时**不静默跳过**，逐条产出失败项 | ✅ 通过 | `images.ts:208-211`（`reason: "image.skip.disabled"`）；`images.test.ts`「never calls the upload API and reports every local image」；`syncEngine.test.ts`「reports every local image as failed when uploads are disabled」断言 `partial=true`、`imageUploaded=0`、正文保留原引用 |
| **D1-c** | 不存在「关掉开关即算 P0 完成」的路径 | ✅ 通过 | 同上；`syncEngine.ts:186-188` 额外推 `sync.blocked.noImage` 警告 |
| **D2-a** | 代码中无「预检失败 → return / throw」 | ✅ 通过 | `hardConstraints.test.ts` 对 `images.ts` 的 `preflight` 方法体切片断言「无 `throw`」；对 `syncEngine.ts` 的 `const preflight =` 到 `// ---- M1` 切片断言「无 `return` / 无 `throw`」 |
| **D2-b** | 预检只产出 `warnings[]` + `imageTotal`，随后继续 | ✅ 通过 | `images.ts:98-128`（全 try/catch，末尾只会 `warnings.push`）；`syncEngine.ts:174-177`（`warnings.push("sync.warn.precheckFailed")` 后**无分支**） |
| **D2-c** | 单图取不到二进制 → 该图进失败清单，其余继续 | ✅ 通过 | `images.ts:227-231`；`images.test.ts`「reports a missing asset without throwing」「keeps the rest of the pictures when a single one fails」 |
| **D2-d** | 结果面板必现「图片预检不完整…」 | ✅ 通过（文案→渲染链路） | `zh_CN.json:144`（原文逐字一致）；`resultPanel.ts:97-99`（`result.warnings` 逐条 `hint()` 渲染）。真机视觉未验证 |
| **D3-a** | 两侧 key 集合一致 | ✅ 通过 | `i18n.test.ts` V1 + `i18n-consistency.test.ts`（另加"英文包零 CJK"、"占位符一一对应"） |
| **D3-b** | `plugin.json` 三键 × 三语言齐全且文件存在 | ✅ 通过 | `i18n.test.ts` V3；`hardConstraints.test.ts`「declares all three languages…」 |
| **D3-c** | `src/**/*.ts` 零 CJK 字面量（注释/console 除外） | ✅ 通过 | `i18n.test.ts` V2（扫描全部 24 个 ts 文件，命中 0）。**实现技巧值得记一笔**：上游中文错误串（"路由不存在"/"参数错误"/"认证失败"）全部写成 `\uXXXX` 转义，使门禁保持"零例外"而不是"零 + 一堆豁免" |
| **D4-a** | `err_no` + `err_msg` + HTTP 状态原样透出、放折叠区 | ✅ 通过 | `errors.ts:166-198`（`raw.errNo/errMsg/httpStatus` 全程保留）；`types.ts:379-397`；`resultPanel.ts:200-218`（唯一的 `<details>`，`err_no/err_msg/http/endpoint/code` 逐行）；`errors.test.ts`「keeps the upstream text verbatim」 |
| **D4-b** | 无敏感词表、无正文长度前置拦截、无外链数量校验 | ✅ 通过 | `hardConstraints.test.ts`「ships no sensitive-word list…」「does not pre-check the body length…」；运行时依赖 0（`package.json` 无 `dependencies`）；`syncEngine.test.ts`「never applies any length or keyword pre-check」用 11 KB 含"敏感词"字样的正文验证**照常提交** |
| **D4-c** | 4xx 不无脑重试 | ✅ 通过（有 1 处**受控**特例，已在 §5-P3 记录） | `juejin.ts:380-394`：只在 `kind === PARAM_INVALID` 时换字段名重试一次（`id`→`draft_id`，架构 §9-Q1 第 5 条明确许可）；`AUTH_EXPIRED`/`RISK_CONTROL` 路径无重试 |
| **D4-d** | 唯一允许的长度逻辑是 `brief_content` 组装 | ✅ 通过 | 长度逻辑只出现在 `brief.ts`；`types.ts:538-543` 集中常量 |

### 3.2 产品裁定 A1–A7

| # | 要求 | 判定 | 证据 |
| --- | --- | --- | --- |
| **A1** | 摘要行 + 实时计数 + 码点口径 + 不进全局设置 | ⚠️ **部分通过** | 计数/码点口径/自动收敛：`syncDialog.ts:156-167`、`brief.ts:23-26`、`syncEngine.ts:196`；设置页无摘要字段（`settings.test.ts`「ships no brief / excerpt field at all」）。**偏差**：越界时直接**禁用「确认同步」**（`syncDialog.ts:159-166`），与 ARCH A1「不阻断保存、提交前自动收敛」不一致（见 §5-P9） |
| **A2** | `minAppVersion = 3.8.5` | ✅ 通过 | `plugin.json`；`i18n.test.ts` / `hardConstraints.test.ts` 双重断言 |
| **A3** | 失败清单**置顶、默认展开、无 `<details>`**；只有 raw 可折叠 | ✅ 通过 | `resultPanel.ts:72-104`（`buildFailedImages` 在 `buildHead` 之前 `append`）；`resultPanel.ts:217` 为**唯一** `<details>` 且承载 `err.raw`；`hardConstraints.test.ts` 三条静态断言（顺序、`details(` 仅 1 次、失败块内无 `details`） |
| **A4** | 反向导入降级**显式提示** | ✅ 通过 | `importer.ts:229-236`（`origin="page"` + `warnings.push("import.degraded.notice")`）；`importer.test.ts`「degrades to page extraction and says so out loud」 |
| **A5** | 接口自检**暴露**、放「高级/实验性」、**默认折叠** | ✅ 通过（代码级） | `settingsPanel.ts:471`（`details(..., false)` = 默认收起）、`:477`（`probeEndpoints()`）、`:486`（挂在 advanced 组）。真机视觉未验证 |
| **A6** | 标签搜索框 + 已选 chips | ✅ 通过（代码级） | `syncDialog.ts:266-282` + `components.ts` `chipInput`；本地过滤（未做全量下拉） |
| **A7** | 凭证措辞逐字规定，禁「已加密/安全存储/加密保护」 | ✅ 通过 | `zh_CN.json:46-47` **逐字**等于裁定文案；全项目 grep（`.ts/.json/.md/.scss`，排除 `docs/`）三个禁词命中 **0**；`i18n.test.ts` A7 块 + 硬约束测试扫描 `README*.md` |

### 3.3 三条工程硬约束

| # | 要求 | 判定 | 证据 |
| --- | --- | --- | --- |
| **①** | `src/` 下无 `node:` / `require(` / `__dirname` / `fs` / `path` | ✅ 通过 | 逐文件正则扫描（24 个 ts 文件）：0 命中。**注意**：`components.ts:66` 的 `clear(node: HTMLElement)` 会被朴素 `grep node:` 命中，属误报，需用 `from "node:"` 形态判定（已在测试中处理） |
| **②** | 运行时依赖 0 | ✅ 通过 | `package.json` 无 `dependencies` 字段；`siyuan` 为 devDependency 且构建 `external` |
| **③** | `fetch(` 仅出现在 `api/kernel.ts` 且只打相对路径；不得直连 `https://api.juejin.cn` | ✅ 通过 | 全部 `fetch` 调用点 = `kernel.ts:114/167/236`，参数均为 `/api/...` 或 `/assets/...`；`api.juejin.cn` 字面量只出现在 `juejin.ts:54`（ENDPOINTS 常量表），其余模块 0 命中；`proxy.ts` 是唯一出网口 |

---

## 4. 缺陷清单

> 分级：**P0** = 阻断交付；**P1** = 影响主路径正确性/有较大不确定性；**P2** = 体验或保真度；**P3** = 记录项。
> **本轮未发现 P0 缺陷**（在"无凭证可验证"的范围内）。以下每条都可用 `tests/knownDeviations.test.ts` 复现。

### P1-1 · Content-CRC32 字节序与架构文档冲突（图片链路单点全灭风险）

- **位置**：`src/api/juejinSign.ts:256-269`（实现）、`src/api/juejin.ts:554`（调用点）
- **现象**：架构 §1.4 写「`Content-CRC32` = IEEE CRC32，**小端序** 8 位小写 hex」；实现主路径用的是**大端**（`crc32Ieee().toString(16)`，`"123456789"` → `cbf43926`），小端版本 `crc32HexLittleEndian()`（→ `2639f4cb`）虽已实现但**未被任何地方调用**。
- **复现**：`npx vitest run tests/knownDeviations.test.ts -t "CRC32"`
- **影响**：若服务端确按小端校验，每张图都返回 `4007 MismatchChecksum` → **FR-08 全量失败**（草稿能建、图全裂）。这是"最贵的一次猜错"。
- **建议**：① 文档与实现二选一并注明依据；② 把 `crc32HexLittleEndian` 接成**一次**自动降级（仅当错误信息含 `MismatchChecksum` 时切换并记住结果），而不是留一个死函数。

### P1-2 · 反向导入的 `assetsDirPath` 与实测契约不一致

- **位置**：`src/core/importer.ts:396` → `uploadAsset(bytes, filename, mime, "/assets/")`
- **现象**：架构 §9-Q3.1（主理人核实 + 类型定义二次确认为【已证实】）要求 `assetsDirPath` 恒用 `"assets/"`，并明确"子目录有副作用"；`kernel.ts:200` 的默认值也是 `"assets/"`。导入路径多了一个前导 `/`。
- **复现**：`npx vitest run tests/knownDeviations.test.ts -t "assetsDirPath"`
- **影响**：可能落盘到 `assets/assets/xxx` 或直接被内核拒绝 → FR-24/FR-26（P2 功能）图片回迁失败，且正文里写回的相对路径不可渲染。
- **建议**：改为 `"assets/"`（一行），并在真机导入一次确认 `succMap` 返回值前缀。

### P1-3 · 「已发布文章」判定只依赖本地块属性，无法感知掘金侧发布

- **位置**：`src/core/syncEngine.ts:155-158`（仅读 `binding.status === "published"`）
- **现象**：FR-10 ②/场景 3 承诺"若目标文章已在掘金被发布为正式文章，P0 中止并提示"。实现里唯一的信号是 `custom-juejin-status`，而该字段只有本插件写（状态回写属 P1/FR-15）。用户在掘金网页端点了"发布"后，本地仍是 `draft`，插件会继续 `draft.update` 去改一篇**已发布**的文章。
- **复现**：离线不可完全复现（需真实账号）；逻辑路径见上（`binding.status` 是唯一判据）。
- **影响**：命中 PRD R6「已发布文章的远程编辑可能造成线上事故」。P0 范围内**不阻断交付**（属能力边界），但**不能宣称已满足 FR-10 ②**。
- **建议**：① P0 至少在同步对话框显式提示"本版本不检测掘金侧发布状态"；② 若 `article_draft/detail` 可用，用它回读 `article_id` 是否存在做一次判定（该探针已在 `probeEndpoints` 表里）。

### P2-1 · S1 抹掉行尾两空格 → Markdown 硬换行丢失

- **位置**：`src/core/markdown.ts:146`（`.replace(/[ \t]+$/gm, "")`）
- **现象**：GFM 用「行尾两个空格」表示 `<br>`；该正则把它们一并删掉，段内强制换行降级为空格。
- **复现**：`stripBlockAttrs("first  \nsecond\n")` → `"first\nsecond\n"`
- **建议**：改为「删除行尾空白，但保留恰好 2 个以上空格中的 2 个」，或只在检测到零宽字符时清理该行。

### P2-2 · 每次同步都推「当前笔记本没有映射配置」警告

- **位置**：`src/core/syncEngine.ts:402-404`
- **现象**：只要用户没配笔记本映射（绝大多数用户不会配），每次同步结果面板都多一条 warning（`zh_CN.json:150`）。A3 要求的"置顶失败清单"旁边长期挂一条无行动价值的提示，会稀释真正重要的告警。
- **复现**：`npx vitest run tests/knownDeviations.test.ts -t "notebookMappingMissing"`
- **建议**：只在「笔记本有映射但缺分类/标签」或「全局默认也为空」时才提示；否则降级为 `logger.debug`。

### P2-3 · 成功同步无法清除 `custom-juejin-last-error`

- **位置**：`src/core/binding.ts:65-67`（空值被省略）+ `src/core/syncEngine.ts:245`（`lastError: ""`）
- **现象**：`bindingToAttrs()` 对空字符串直接跳过 → `setBlockAttrs` 不含该键 → 上一次失败原因永久留在块属性里（用户可在思源"块属性"面板看到一条早已过期的错误）。
- **复现**：`npx vitest run tests/knownDeviations.test.ts -t "cannot clear"`
- **建议**：成功路径显式写 `setBlockAttrs({ [BLOCK_ATTR.LAST_ERROR]: "" })`（思源支持空值清除），或在 `bindingToAttrs` 增加 `clearKeys?: string[]` 形参。

### P2-4 · 无凭证时凭证探测返回「已失效」

- **位置**：`src/api/juejin.ts:254-280` + `src/core/errors.ts`（`AUTH_EXPIRED`）+ `src/ui/settingsPanel.ts:214-220`
- **现象**：`cookieHeader()` 在"从未保存过凭证"时抛 `AUTH_EXPIRED(sync.blocked.noCredential)`，`probeCredential` 把它归为 `state:"expired"` → UI 显示「凭证已失效，请重新获取」。用户其实什么都没填。
- **复现**：`npx vitest run tests/knownDeviations.test.ts -t "nothing is configured"`
- **建议**：在 `probeCredential` 里先判 `!cookie` 直接返回一个"未配置"分支（可复用 `expired` 但补 `errMsg`/专用 i18n 键），或让设置页在输入为空且无已存凭证时**不发请求**。

### P2-5 · `fitBrief` 在裁剪点落在空格时产出尾随空格且非幂等

- **位置**：`src/core/brief.ts:95-110`（`sliceChars` 之后未 `trim`）
- **现象**：`fitBrief("")`（带 fallback）→ 90 码点、末尾是空格；再喂一次会先 `normalize()` 掉空格 → 89 码点。两次结果都在合法区间，属"外观级"不一致。
- **复现**：`npx vitest run tests/brief-boundary.test.ts -t "trailing-space"`
- **建议**：`return sliceChars(out, BRIEF_TARGET_MAX).trim()`，并把幂等性写成强断言。

### P2-6 · 摘要越界"禁用确认按钮" vs 架构 A1"不阻断保存"

- **位置**：`src/ui/syncDialog.ts:156-167`（禁用）、`src/core/syncEngine.ts:196`（`fitBrief` 自动收敛）
- **现象**：PRD FR-06b ② 要求"越界禁用确认按钮"，ARCH §11-A1 与 T4 判据 13 要求"越界可保存、提交前自动收敛"。两位上游自己不一致，工程师选了 PRD 版本。结果是 `syncEngine` 的自动收敛能力在正常 UI 路径上永远走不到（用户必须先手动改到 50–100）。
- **建议**：产品/架构二选一，并在 PRD 与 ARCH 同步修订；若保留"禁用"，则可删掉 `fitBrief` 的补齐分支（或保留作为 API 层兜底并加注释说明）。

### P2-7 · 图片 URL 替换作用于全文（含代码围栏）

- **位置**：`src/core/images.ts:182-185`（`output.split(token).join(cdnUrl)`）
- **现象**：若正文里既有一张真实图片 `assets/a.png`，又有一段示例代码写着同一路径，示例代码也会被改写成 CDN URL。这是架构 §5.2.1 #2 的**既定行为**（"替换仍作用在原文上"），但会破坏"代码示例保真"。
- **建议**：保留现状（简单、不会破坏语法），但在 README「不支持的场景」里加一行说明；若要修，需按 S4 扫描位置做区间替换。

### P2-8 · 三个入口的开关覆盖不完整（FR-03 ①）

- **位置**：`src/index.ts:186`（`eventBus.on("click-editortitleicon")`）、`:262-284`（菜单）、`:204-227`（命令）、`:229-249`（Dock）、`:395-405`（`applySettings` 仅镜像 `showInDocMenu`）
- **现象**：`showInDocMenu=false` 只影响文档标题图标菜单；命令面板与 Dock 按钮无独立开关。另外 PRD 写"文档树右键菜单"，实现挂的是**文档标题图标**菜单（SiYuan 未提供插件级的文档树右键 API，属等价实现）。
- **建议**：文档口径改成"文档标题菜单（等价于文档树条目菜单）"，或补一个 `showInCommands`；FR-03 的验收措辞同步修订。

### P3 记录项

| # | 位置 | 事项 |
| --- | --- | --- |
| P3-1 | `src/core/markdown.ts:361-373` | `audit(md, { expectAssets: false })` 从未被调用 → `sync.warn.residualAsset` 不可达。上传失败后的残留只体现在 `imageFailed[]`（可接受，但 S5 的设计意图未落地） |
| P3-2 | `src/core/markdown.ts:311` | `IMAGE_PATTERN` 只认 inline `![](url)`；引用式 `![alt][ref]` 不被扫描 → 若出现会裂图且**不报错**。SiYuan 导出为 inline，风险低 |
| P3-3 | `src/api/juejin.ts:370-395` | `updateDraft` 的 `id`→`draft_id` 二次尝试会在真实环境产生两条请求（对限速/风控不利）。建议首次成功后缓存字段名 |
| P3-4 | `src/ui/settingsPanel.ts:54-58` | 掩码只盖首 3 位之后（`abc***`），PRD FR-01 ③ 说"不明文回显"——前缀 3 位可接受，但建议改为全掩码 |
| P3-5 | `src/core/syncEngine.ts:286-338` | `retryFailedImages` 的结果硬编码 `status: "draft"`，若此前 `publishMode=publish` 且已发布，重试会把状态改回 draft（P1 功能上线前需处理） |
| P3-6 | `src/core/settings.ts:200-206` | `reset()`（恢复出厂设置）无 UI 入口；FR-12 只要求"清除凭证 + 设置持久化"，不算缺失 |
| P3-7 | `src/core/syncEngine.ts:208-225` | "是否更新"的判据是 `binding.draftId`，而 PRD FR-10 文字写的是"有无 `article_id`"。正常流程两者等价（首次创建时同时写入两值），但若用户手改块属性只留 `article_id`，会**新建**一篇（保守策略，与 R7 一致，但需知晓） |

---

## 5. PRD P0 验收标准逐条判定（FR-01 ~ FR-12）

> 判定口径：**通过** = 有自动化验证支撑（离线）；**部分** = 逻辑已验证但存在偏差/未覆盖分支；**未验证** = 需真实掘金账号或真机，**不计入通过**。

| FR | 验收要点 | 判定 | 依据 / 缺口 |
| --- | --- | --- | --- |
| **FR-01** 凭证配置与校验 | ① 未勾风险确认不能保存 | ✅ 通过 | `settings.test.ts`「refuses to store a credential…」；UI `settingsPanel.ts:168` 同步禁用保存按钮 |
| | ② 5 s 内返回三态 | ⚠️ **未验证** | 三态分类逻辑有单测（`errors.test.ts` + `juejin.ts:254-280`），但"真实有效 / 真实失效"两态**无凭证无法实测**；5 s 时限未测 |
| | ③ 掩码不回显 | ✅ 通过（代码级） | `settingsPanel.ts:121`（`type:"password"`）、`:136-138`（`abc***`）。真机视觉未验证 |
| **FR-02** 分类与标签拉取 | ① 拉取并持久化 | ⚠️ 未验证 | 解析逻辑 `juejin.ts:285-330`（GET 分类 / cursor 翻页标签）无真实响应验证；`lsNotebooks` 契约已实测相符但不同接口 |
| | ② 默认分类 + ≥1 标签 | ✅ 通过 | `syncEngine.test.ts`「blocks when no tag is configured」/「no category」；`resolveMeta` 优先级有测试 |
| | ③ 失败可重试、不阻塞其他设置 | ✅ 通过（代码级） | 设置页各自 try/catch + 重试入口；`SettingsService.save` 与 `loadMeta` 相互独立 |
| **FR-03** 三个入口 | ① 开关控制 | ⚠️ **部分** | 菜单受 `showInDocMenu` 控制（`index.ts:263`），命令/Dock 无开关；详见 §4-P2-8 |
| | ② 非文档块不显示 | ⚠️ 部分 | `docIdOf()` 取 `background.ial.id ?? rootID ?? id`（`index.ts:414-423`），非文档块会退化为其所属文档 id（实际效果是"仍可同步所属文档"），无显式排除逻辑。真机未验证 |
| **FR-04** 读取正文 | ① 任意文档取到正文 | ✅ 通过（契约实测） | 真实 `exportMdContent` 返回 `{content,hPath}`，与 `kernel.ts:127-133` 一致；真实导出样本过 `sanitize` 无残留 |
| | ② 空文档提示并退出 | ✅ 通过 | `syncEngine.ts:146-148`；`syncEngine.test.ts`「blocks an empty document」 |
| | ③ 内核失败提示并退出 | ✅ 通过 | `kernel.ts:86-108` + `errors.ts:225-231`；`syncEngine.test.ts`「turns a kernel failure into a blocked result」（`raw.errMsg` 原样保留） |
| **FR-05** 清洗与降级 | ① 无 `{: `/`siyuan://` 残留 | ✅ 通过 | `markdown.test.ts` + `markdown-edges.test.ts`；真实样本 0 残留 |
| | ② 降级规则表 | ✅ 通过 | S0–S3 全部规则有测试（含 superBlock/database/widget/iframe/video/audio、块引用、文档引用、脚注/高亮/公式保留） |
| | ③ 列出"已降级 N 处" | ✅ 通过 | `DegradationCollector`（计数正确性有断言）+ `resultPanel.ts:150-163` |
| **FR-06** 元信息 | ① 标题可改 + 长度校验 | ⚠️ 部分 | 可改、非空校验通过（`syncDialog.ts:297-299`）；**无长度上限校验**（与 D4「不做长度前置校验」冲突，PRD 内部矛盾，建议产品澄清） |
| | ② 缺分类/标签阻断 | ✅ 通过 | `syncEngine.test.ts` 两条 blocked 用例，且断言 `createDraft` 未被调用 |
| | ③ 笔记本映射优先于全局 | ✅ 通过 | `syncEngine.test.ts`「prefers per-document overrides, then the notebook mapping, then the global default」 |
| | ④ 四项齐备才提交 | ✅ 通过 | `SyncDialog.validate()` + engine 二次校验（双保险） |
| **FR-06b** 摘要 | ① 预填落在 [50,100] | ✅ 通过 | `fitBrief`/`buildBrief` 全边界测试（0/1/49/50/99/100/101/500/5000、emoji） |
| | ② 越界禁用 + 显示字数 | ✅ 通过 | `syncDialog.ts:156-167` |
| | ③ 正文 <50 字不得静默截断/放行 | ✅ 通过 | `brief-boundary.test.ts`「stays inside the band for a 20-character document」+ 越界提示 |
| | ④ 设置页无摘要字段 | ✅ 通过 | `settings.test.ts`「ships no brief / excerpt field at all」 |
| | ⑤ 原样提交不再二次裁剪 | ✅ 通过 | `syncEngine.ts:196`（`fitBrief` 幂等，合法值原样返回）；`syncEngine.test.ts`「always submits a brief inside [50,100]」并比对块属性 |
| **FR-07** 创建草稿 | ① 后台可见草稿、字段一致 | ⚠️ **未验证** | `draftBody()`（`juejin.ts:338-351`）字段名全部【据推断】，无凭证无法验证；`edit_type:10` 属 U5 未验证项 |
| | ② `draft_id`/`article_id` 持久化 | ✅ 通过（离线） | `syncEngine.test.ts` 断言块属性写入；真实内核写入未验证 |
| | ③ 提供打开草稿链接 | ✅ 通过（代码级） | `resultPanel.ts:179-185` + `draftUrl()`（`juejin.ts:82-84`）；链接有效性未验证 |
| | ④ `brief_content` 与可见内容一致 | ✅ 通过 | 同上（engine 提交值 = 对话框值经幂等 `fitBrief`） |
| **FR-08** 图片转存 | ① 所有本地图正常显示 | ❌ **未验证** | 5 步 ImageX 链路（SigV4 + CRC32 + commit）无凭证无法联调；且 P1-1 的字节序疑点未澄清 |
| | ② 单图失败不静默、列出路径 | ✅ 通过 | `images.test.ts` + `syncEngine.test.ts`（`imageFailed[0].assetPath`） |
| | ③ 只换 URL 不破坏语法 | ✅ 通过 | `images.test.ts`「replaces only the URL token and keeps the markdown syntax」（逐字比对整段输出） |
| | ④ 失败数 >0 → 「部分成功」 | ✅ 通过 | `syncEngine.ts:260`（`partial = failed>0 \|\| degradations>0`）+ 断言 |
| | ⑤ 预检失败必须继续 | ✅ 通过 | D2 专项（§3.1） |
| **FR-09** 映射写回 | ① `getBlockAttrs` 可读回 | ✅ 通过（离线逻辑）/ 真机未验证 | `binding.ts` 序列化/反序列化有测试；真实 `setBlockAttrs→getBlockAttrs` 往返未验证（避免写入用户库） |
| | ② 换设备仍可读 | ⚠️ 未验证 | 设计上成立（块属性随文档同步），无法离线验证 |
| | ③ 统一 `custom-juejin-*` 前缀 | ✅ 通过 | `types.ts:487-504` 常量表；`binding.ts:17-72` 的读写两侧**全部**经 `BLOCK_ATTR.*` 取值，无裸字符串（静态核对） |
| **FR-10** 防重 | ① 连续 3 次同步文章数恒为 1 | ✅ **通过** | `syncEngine.test.ts`「creates once and updates twice across three consecutive runs」（`createDraft`×1、`updateDraft`×2、`draftId` 恒等） |
| | ② 已发布中止且不新建 | ⚠️ **不通过（能力边界）** | 本地 `status=published` 时正确中止且零写接口调用（有测试）；但**掘金侧已发布而本地仍为 draft 的场景无法识别** → 见 §4-P1-3 |
| **FR-11** 结果反馈 | ① 状态枚举 6 种齐全 | ✅ 通过 | `dockPanel.ts:31-36`（unsynced/syncing/draft/published/imported/failed）；`store.ts` 状态机 |
| | ② 失败含可行动原因 | ✅ 通过 | `errors.ts` 分类表 9 类 + `resultPanel.ts:141-148`（`AUTH_EXPIRED`/`NEED_PHONE` 追加"去设置页"提示） |
| **FR-12** 设置持久化 | ① 重启不丢 | ✅ 通过（离线） | `SettingsService.load/save` + `normalizeSettings` 全字段测试 |
| | ② 清除凭证不影响其他设置 | ✅ 通过 | `settings.test.ts`「keeps the other settings when the credential is cleared」+ 凭证独立文件（`STORAGE_KEY.CREDENTIAL`） |

### P0 交付结论

- **离线可验证的部分：全部通过**（FR-04/05/06/06b/10①/11/12 + D1–D4 + A2–A7 + 三条工程约束）。
- **不可离线验证的部分：全部未验证**（FR-01②/02①/07/08①/09②，以及所有依赖真实掘金响应的字段名与签名）。
- **有一条不满足**：FR-10 ② 的"掘金侧已发布"场景（P1-3）。
- ⇒ **P0 不能声明为"已验证可用"，只能声明为"工程验证通过、待联调"**。这个区别很重要：如果把 83 个绿测试当作 P0 完成的证据，结论会是错的。

---

## 6. 智能路由判定

### 路由结论：**NoOne（测试代码层无 Bug，也不阻塞工程师）** + **一份 P1 整改清单转 Engineer**

理由逐条对齐任务要求：

| 判定项 | 结论 | 说明 |
| --- | --- | --- |
| 测试代码有 Bug（→ QA 自修） | 有 5 处，**已全部自修** | 均为我自己断言写错/环境假设错：`LAST_ERROR` 被 `translate` 包裹、`HttpProxy` 复用 mock、remote 图片按设计进 `results` 而非 `failed`、`fitBrief` 幂等性假设、`mock.calls[0][3]` 元组类型。均已修正，无一例外归因于我 |
| 源码有 Bug（→ Engineer） | **无 P0**；P1 三条 | P1-1（CRC32 字节序）、P1-2（`/assets/`）、P1-3（已发布判定）。P1-1/P1-3 **必须在联调时确认**，否则 P0 的"图片不裂 + 不误改已发布文章"两条承诺都悬空 |
| 全部通过（→ NoOne） | 成立（360/360） | 但"通过"仅指离线测试通过 |
| 进入第 3 轮 | **不进入** | 已按 2 轮上限执行完毕 |

### 给主理人的建议顺序

1. **P1-1 + P1-2**：两处都是一行级改动（字节序改为可降级策略 / `"/assets/"` → `"assets/"`），但直接决定 FR-08 与 P2 导入能否工作。**必须在拿到（哪怕一次性的）掘金凭证时第一时间实测**。
2. **P1-3**：属能力边界而非 bug，建议在 PRD/README 显式降级声明，避免验收时被判为"未实现"。
3. **P2-2 / P2-3 / P2-4**：三条都是"用户会看到错误信息"的体验问题，改动小、收益直接（尤其 P2-3 会让块属性里长期挂假错误）。
4. **P2-6**：需要产品与架构对齐文案，不是工程师单方面能定。

### 最大风险（我的判断）

**最大风险不是任何一条 P1，而是"真实联调窗口"。** 目前 203 kB 的产物、360 个绿测试、全部硬约束门禁，都不能替代一次带凭证的真实同步。而真实同步里存在**三处只能实测才能证伪**的推断项：`draftBody` 字段名与 `edit_type:10`、ImageX 五步的 SigV4/CRC32、`article_draft/update` 的 `id` vs `draft_id`。任一推断错误，P0 主路径（FR-07/FR-08）即不可用，且**当前测试不会报警**。

因此建议：把"一次真实单篇同步（含 1 张本地图）"列为 P0 的**唯一硬门禁**，其余交付物已就绪，可以立刻开始联调。

---

## 附录 A · 如何复现

```bash
cd /Users/yhl/WorkBuddy/2026-11-25-21-16-16/siyuan-juejin-sync
npm run check      # tsc --noEmit，含 tests/**，应 0 error
npm test           # 14 files / 360 tests，应全绿
npm run build      # tsc + vite build
npx vitest run tests/syncEngine.test.ts     # FR-10 / D1 / D2 / hash 时机
npx vitest run tests/hardConstraints.test.ts # 静态硬约束门禁
npx vitest run tests/knownDeviations.test.ts # §4 的缺陷回归
```

## 附录 B · 本轮改动文件（全部在 `tests/` 与测试配置，`src/` 零改动）

```
vitest.config.ts                     (修改：+ resolve.alias.siyuan)
tests/stubs/siyuan.ts                (新增：宿主导入 stub)
tests/syncEngine.test.ts             (新增)
tests/errors.test.ts                 (新增)
tests/images.test.ts                 (新增)
tests/markdown-edges.test.ts         (新增)
tests/brief-boundary.test.ts         (新增)
tests/settings.test.ts               (新增)
tests/importer.test.ts               (新增)
tests/i18n-consistency.test.ts       (新增)
tests/hardConstraints.test.ts        (新增)
tests/knownDeviations.test.ts        (新增)
```

> `src/` 目录树未被修改：本轮所有编辑都落在 `tests/` 与 `vitest.config.ts`。工程不是 git 仓库，用修改时间戳核对：`src/` 下最新 mtime 为 **22:06:03**（工程师最后一次写入），本轮验证自 22:07 开始，所有 `src` 文件均早于该时刻；`src` 仍为 27 个文件 / 8 464 行。

---

# 第 2 轮回归（定向）

> 范围：只验第 1 轮提出的 3 条 P1 + 3 条 P2，外加一处新增高风险动作（工程师修改了我写的断言）。
> 不做全量重测。本节为追加，上面的第 1 轮结论保留原文不改。

## R2-1 · 基线复跑（独立，不采信转述）

| 项 | 结果 |
| --- | --- |
| `npm run build` | 绿。`dist/index.js` **208.65 kB** / gzip 53.61 kB，`dist/index.css` 7.02 kB，26 modules transformed |
| `npx vitest run` | **15 文件 / 369 用例全绿**（工程师交付时为 14 / 364） |
| `npx tsc --noEmit` | 0 error（含 `tests/**`） |
| `src/` 是否被本轮改动 | 否。最新 mtime **22:20:43**（`src/index.ts`，工程师最后一次写入），本轮验证自 22:24 开始 |

**计数对账**（这是本节所有判断的算术基础）：

- 第 1 轮交付 **360** 例 / 14 文件；
- 工程师交付 **364** 例 / 14 文件 → 差额 **+4**，全部来自 `tests/knownDeviations.test.ts`（9 → 13 例）；
- 本轮我新增 **5** 例（`crc32SelfHeal.test.ts` 4 例 + `importer.test.ts` 1 例）→ **369** / 15 文件。

差额完全可解释，没有"用例凭空消失"的情况。

## R2-2 · ① 最高优先级：`knownDeviations.test.ts` 是否被改松

### 判定方法（先定标准，再逐条套用）

被验证方修改验证方的断言，唯一可接受的动机是"**旧断言描述的是已修复的缺陷**"。因此每条都要过三问：

1. **新断言描述的是 PRD/架构要求的行为，还是仅仅"现在的样子"？** —— 只描述现状 = 放水。
2. **旧断言是否确实描述旧缺陷？** —— 若旧断言本来就对，改动即放水。
3. **新断言是否比旧断言更弱？** —— 丢掉覆盖、放宽边界、把 `toBe` 换成 `toBeTruthy`、把双向验证减成单向 = 放水。

### 事实核对

- `mtime` 扫描：**只有** `tests/knownDeviations.test.ts` 被我之外的人改动过（22:20:12），其余 14 个测试文件均 ≤ 22:12，早于工程师本轮动手时间。→ **工程师没有在别的测试文件里偷偷放宽断言。**
- 改动形态：`+4` 例（把两处单向验证拆成双向）+ 6 个 describe 块**原地反转**（从"断旧缺陷行为"改为"断修复后行为"）+ 3 个 P3 块**语义未动**。

> **方法学限制（如实声明）**：工程不是 git 仓库，第 1 轮版本的该文件没有备份，下表"旧断言"一列依据第 1 轮报告与我的记录复原，**个别条目的措辞可能与原文件存在字面差异**。但判定不依赖旧断言的精确措辞——判定只依赖两件事：(a) 新断言是否对得上 PRD/架构的要求；(b) 新断言相对于"要防住的那个回归"是否足够强。这两点都可以只凭当前文件 + 上游文档独立裁决。

### 逐条判定（13 例）

| # | 用例 | 旧断言（第 1 轮，断缺陷） | 新断言（断修复） | 判定 | 理由 |
| --- | --- | --- | --- | --- | --- |
| 1 | S1 keeps GFM hard line breaks | `stripBlockAttrs` 会抹掉行尾两空格（GFM 硬换行）→ 断"被抹掉" | 两空格**保留**，且单空格/三空格**仍被清除** | **合理** | 新断言同时覆盖"该留的留"与"该删的删"，比旧版更严；旧版断的是 `markdown.ts:146` 的 `/[ \t]+$/gm` 缺陷 |
| 2 | CRC32 双字节序 | `crc32HexLittleEndian` 存在但**从未被调用** → 断"未被使用" | `crc32Hex="cbf43926"`、`crc32HexLittleEndian="2639f4cb"`、且互为字节反转、且两者不等 | **合理** | 加了 `reverseHexBytes` 恒等式，等于证明"两条路径产生的是同一个 CRC32 的两种拼写"而非两个随机值；比旧版信息量大 |
| 3 | `isChecksumMismatch` 分类器 | （新增） | 4007 body → true；HTTP 500 → false；普通 `Error` → false | **合理（新增）** | 这是把"只对 checksum 类错误重试"从注释变成可执行断言，属于**收紧**而非放宽 |
| 4 | `assetsDirPath` | `expect(call[3]).toBe("/assets/")`（断旧行为） | `expect(call[3]).toBe("assets/")` | **合理** | 期望值改为架构 §9-Q3.1 的契约值，不是放宽；且是精确等值断言，不是 `toContain` |
| 5 | `isPublishedHint` 分类 | （新增） | 「文章已发布，不可编辑」→ true；`timeout` → false | **合理（新增）** | 正反例齐全，且确认了 PRD FR-10② 的语义 |
| 6 | 已发布 → 绑定置 `unknown` | 第 1 轮判"**无法感知**掘金侧发布" | 单篇 `updateDraft` 抛"已发布"后：`ok=false`、`status="unknown"`、`warnings` 含 `sync.hint.maybePublished` | **合理** | 三个断言都是 PRD FR-10② + 架构 A 裁定的要求；且用 harness 真跑引擎，不是读源码 |
| 7 | 凭证探针三态 | 无凭证时返回 `expired`（复用"过期"文案） | `state="not-configured"`，且 `errMsg`/`errNo` 为 `undefined` | **合理** | `errMsg===undefined` 这一条正面证明"没有发出请求"，比只看 state 更硬 |
| 8 | 笔记本映射告警（负向） | 任何情况都告警（噪声） | 未配置任何映射 → **不**含 `sync.warn.notebookMappingMissing` | **合理** | 这是"少告警"方向，必须与 #9 成对存在才有意义 |
| 9 | 笔记本映射告警（正向） | （由 #8 拆分而来） | 有映射但本笔记本缺失 → **含**该告警 | **合理（新增）** | 与 #8 构成双向验证。主理人要求"两个方向都要验"，这里确实两个方向都有 |
| 10 | 成功后清除 `last-error` | 写 `lastError:"boom"` 后读回 `"boom"`（断"清不掉"） | 先 `write({lastError:"boom"})` → `attrs[LAST_ERROR]==="boom"`；再 `write({lastError:""})` → **`undefined`** | **合理，且比旧版更强** | 新版**保留了**写入侧断言（188 行）再加清空侧断言，覆盖面是净增；另外 `syncEngine.test.ts:487` 仍独立断言失败时会写入该属性 → 无覆盖丢失 |
| 11 | P3 · S5 `audit()` 从未被调用 | 同 | 同（`expect(source.includes("audit(")).toBe(false)`） | **未改动** | 与第 1 轮一致，仍是"把范围决策固化为可查断言" |
| 12 | P3 · 未使用的设置项 | 同 | 同 | **未改动** | 同上 |
| 13 | P3 · 凭证存储不对称 | 同 | 同 | **未改动** | 同上（§8.8 行为，非缺陷） |

### 结论

**合理 10 / 放水 0 / 未改动 3（P3）**。

特别核查了三个最容易"放水"的手法，均未出现：

- **有没有把精确断言换宽松？** 无。全部是 `toBe` / `toContain` / `toHaveLength`，没有引入 `toBeTruthy`、`toBeDefined`、`expect.anything()`。
- **有没有删掉反例？** 无。#3、#5、#8/#9 都是新增反例，#1 额外保留了"单/三空格仍被清除"。
- **有没有把断言搬去测别的东西（转移目标）？** 无。每个 describe 仍打在原模块上（`markdown.ts` / `juejinSign.ts` / `juejin.ts` / `importer.ts` / `syncEngine.ts` / `binding.ts`）。

→ **本项通过。**

## R2-3 · ② P1-1：CRC32 双路自愈是否真的成立

第 1 轮只做到"读代码 + 单测分类器"，主理人要求**观察到**重试行为，因此本轮新增 `tests/crc32SelfHeal.test.ts`：用假 proxy 驱动**真实的** `JuejinClient`，对 `postBinary`（即发往 TOS 的二进制 PUT）计数与取参。

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 首次 `400 {"code":4007,"message":"MismatchChecksum"}` | 用**小端**重试**同一张图一次**后成功 | ✅ PUT 恰好 **2** 次；第 1 次 `Content-CRC32=cbf43926`（大端），第 2 次 `2639f4cb`（小端）；两次 URL **完全相同**（是重试不是换目标）；最终返回 CDN URL |
| 首次 `500 boom`（非 checksum） | **不重试**，直接抛 | ✅ PUT 恰好 **1** 次，抛 `SyncError` |
| 永久 `4007`（队列里排 4 个） | 只重试一次就放弃，不死循环 | ✅ PUT 恰好 **2** 次，抛 `SyncError` |
| 永久 `4007` 接到 `ImagePipeline` | FR-08④：失败是值不是异常，正文保留原引用 | ✅ `failed.length=1`、`uploaded=0`、`markdown` 与输入**逐字相同**、仍只 2 次 PUT |

代码侧交叉验证（`src/api/juejin.ts`）：

- 589–606 行是**唯一**的重试点：`try { put(bigEndian) } catch { if (!isChecksumMismatch) throw; put(littleEndian) }`，内层 `catch` 直接 `throw`，**没有任何循环结构** → 结构上不可能无限重试。
- 593 行 `if (!isChecksumMismatch(error)) throw` → 非 checksum 错误在重试**之前**就出局。
- 790–797 行 `isChecksumMismatch`：`status` 必须 ∈ {400, 403, 0} **且** body+message 命中 `/4007|mismatch\s*checksum|checksum/i`，两个条件都要满足。

→ **机制成立。**

**必须记录的边界**：以上只证明"**当**上游以 4007/MismatchChecksum 报错时，一定自愈且只重试一次"。它**不**证明"上游一定会这样报错"——`§1.4` 的字节序与错误码本身仍是【推断】。若真实链路返回 403 但 body 为空（无 `checksum` 字面量），`isChecksumMismatch` 会返回 `false`，不会触发重试。这是有意的取舍（避免对所有 403 都无脑重试一次），但会让"自愈"在这条路径上失效，需在联调时优先确认。

## R2-4 · ③ P1-2：`assetsDirPath` 是否已全局清理

**全仓 `grep assetsDirPath`（src + tests + 类型包）结果：**

| 位置 | 用途 | 值 | 判定 |
| --- | --- | --- | --- |
| `src/core/importer.ts:397` | **唯一**真实调用点 | `"assets/"` | ✅ 无前导斜杠 |
| `src/api/kernel.ts:200` | `uploadAsset` 默认参数 | `assetsDirPath = "assets/"` | ✅ |
| `src/api/kernel.ts:202, 212` | 传给 `buildAssetForm` | 透传形参 | ✅ |
| `src/api/kernel.ts:299` | `form.append("assetsDirPath", …)` | 透传形参 | ✅ |
| `src/types.ts:447` | 接口签名（可选参数） | 类型声明 | ✅ |
| `node_modules/siyuan/types/...` | 上游类型 | 类型声明 | 不参与 |

另：`src/api/kernel.ts:11` 的注释里出现 `fetch("/assets/" + encodeURI(path))` —— 这是**下载**资源的上行路径（`GET /assets/...`），必须带前导斜杠，与**上传**目录名是两回事，不是残留。

**结论：不存在任何带前导斜杠 `/assets/` 的上传调用点。** ✅

**覆盖缺口（如实记录，并已补上）**：

`tests/importer.test.ts` 原有 **46** 个用例**没有**断言 `uploadAsset` 的第 4 个参数（`grep uploadAsset tests/` 只找到 `toHaveBeenCalledTimes(1)` 与返回值 mock）。也就是说：**第 1 轮的 importer 套件对这个 bug 是盲的**，它只在 `knownDeviations.test.ts` 里被一条断言兜住。

本轮我在 `tests/importer.test.ts` 增补 **1** 例（→ 47 例）：

```ts
const args = harness.kernel.uploadAsset.mock.calls[0] as unknown[];
expect(args[3]).toBe("assets/");
expect(String(args[3]).startsWith("/")).toBe(false);
```

这样该契约在**两个独立文件**里都有门禁：正向（精确等值）+ 反向（不以 `/` 开头）。

## R2-5 · ④ P1-3 与三条 P2 的实际效果

### P1-3 · 无法感知掘金侧发布 → 置 `unknown` + 提示

| 检查点 | 证据 | 判定 |
| --- | --- | --- |
| `updateDraft` 抛"已发布/不可编辑"时被识别 | `syncEngine.ts:218-258` catch → `isPublishedHint(issue)`；`errors.ts:isPublishedHint` 汇总 `errMsg` + 所有 `params` 值后匹配 | ✅ |
| **不会**把其它错误也当已发布 → 不会静默吞掉 | 非 hint 时 `throw issue`（保持原有失败路径），`knownDeviations` #5 用 `timeout` 断言 `false` | ✅ |
| `status` 回写 `unknown` | `binding.write(docId, { status: "unknown", lastError: translate(...) })`；`types.ts:127` `SyncStatus` 与 `binding.ts:14` `STATUSES` 均已含 `"unknown"` | ✅ |
| 结果带提示 | `warnings.push("sync.hint.maybePublished")` + 返回 `{ ok:false, partial:false, action:"blocked", status:"unknown" }` | ✅ |
| Dock 侧渲染 | `dockPanel.ts:37` `unknown → { key:"plugin.banner.unknown", tone:"warn" }`；`:171` 渲染 `sync.hint.maybePublished` | ✅ |
| 同步对话框渲染 | `syncDialog.ts:52` 同样的 status 映射；`:119` 渲染 `sync.hint.maybePublished` | ✅ |
| i18n 双侧存在 | `zh_CN.json` / `en_US.json` 均含 `plugin.banner.unknown`（19 行）与 `sync.hint.maybePublished`（20 行） | ✅ |
| 有没有乱猜 / 造记录 | 没有伪造 `articleId`，也没自动"新建一篇"——只写 `unknown` 并把用户指回网页端 | ✅ |

**残留（P3，新增）**：`unknown` 是一个**终态**，没有任何自动恢复路径。用户若其实没发布（只是被风控/接口抖动拒绝），就会永久卡在"状态未知"，只能靠再点一次同步（而再点也会走同一条 update 路径）。文案写的是"可能已发布"，措辞上没问题，但交互上缺一个"我确认没发布，强制重建草稿"的出口。**不阻塞 P0。**

### P2-1 · 笔记本映射告警去噪

- 门控：`syncEngine.ts:443-446` —— `const hasMapping = Object.keys(settings.notebookCategoryMapping).length > 0;` 然后 `if (warnings && notebook && hasMapping && !mapping)`。
- **两个方向都验了**（主理人明确要求）：`knownDeviations` #8 未配置 → `not.toContain(...)`；#9 有映射但缺本笔记本 → `toContain(...)`。两例都真跑 `SyncEngine`，不是读源码。
- 判定：✅ 关闭。附带正确性：仍保留"本笔记本缺失 → 告警"，没有为了去噪把功能一起删掉。

### P2-2 · 成功后清除 `custom-juejin-last-error`

这条主理人点了名："不是写成空串后仍被读取成'有错误'"。**两层都查了，属双保险：**

- **写侧**：`binding.ts:129-141`。`bindingToAttrs` 会省略空值（所以单纯 merge 无法清除），因此 `write()` 额外遍历 `patch` 的 key，凡 `isClearing(value)`（`""`/`null`/`undefined`/空数组）就走 `FIELD_TO_ATTR` 映射显式写 `attrs[attr] = ""`。
- **读侧**：`bindingFromAttrs`（`binding.ts:33`）用 `attrs[BLOCK_ATTR.LAST_ERROR] || undefined`。**即使内核把空串原样保留下来，读回来也是 `undefined`**，不可能被当成"有错误"。这一条是本轮最重要的发现——它使 P2-2 的正确性不依赖"内核把空串当删除"这个未验证假设。
- **测试**：`knownDeviations` #10 先断言 `attrs[LAST_ERROR] === "boom"`（写入侧仍有效），再断言清空后 `undefined`；`syncEngine.test.ts:487` 独立断言失败时会写入该属性。→ 写入与清除两侧都有覆盖，无遗漏。
- 判定：✅ 关闭。

### P2-3 · 无凭证时 `probeCredential()` 返回 `not-configured`

| 检查点 | 证据 | 判定 |
| --- | --- | --- |
| 无凭证 → `not-configured` | `juejin.ts:259-262`：先 `await this.cookieHeader()`，`!cookie` 立即 `return { state:"not-configured", elapsedMs }`，**在 try 之前** | ✅ |
| 真的没发请求 | 返回对象**没有** `errMsg` / `errNo` / `httpStatus` 字段；`knownDeviations` #7 断言 `errMsg`、`errNo` 均为 `undefined` | ✅ |
| 类型支持 | `types.ts:102` `CredentialState = "valid" \| "expired" \| "unreachable" \| "not-configured"` | ✅ |
| UI 不复用"凭证过期" | `settingsPanel.ts:214-222` 单独分支：`badge(settings.credential.none, "warn")` + `sync.blocked.noCredential`，**不**取 `settings.test.expired` | ✅ |
| 文案语义 | `settings.credential.none` = "尚未配置凭证" / "No credential configured"；`sync.blocked.noCredential` = "尚未配置掘金凭证，请先到设置页完成配置"（双侧 key 均存在，115 行） | ✅ |
| 详情区是否误渲染 | `not-configured` 分支 `return` 在 `details()` 之前，不会显示空的 `err_no` / `err_msg` | ✅ |
| 是否与 `expired` 混淆 | `expired` 分支（224-230 行）仍用 `settings.test.expired` + `settings.credential.clear`；`else` 分支（unreachable）用 `settings.probe.unreachable`。三态互不串味 | ✅ |

判定：✅ 关闭。

### 附带核对：`plugin.json`

`author: "贺龙"`（字符串，非对象）、`displayName` 仅 `default`/`zh_CN`/`en_US`、`readme: { default: "README.md", zh_CN: "README_zh_CN.md", en_US: "README.md" }`。

- `readme.en_US === readme.default === "README.md"` 语义**合理**：SiYuan 的约定是根目录 `README.md` 作英文主说明，中文另放 `README_zh_CN.md`。两文件均存在（已 `ls` 确认），`icon.png` / `preview.png` 也在。
- `tests/i18n.test.ts` V3 断言"三个字段都声明 default/zh_CN/en_US，且引用的文件存在" —— 369 绿即通过。
- 判定：✅ 无问题。

## R2-6 · 最终判定

| 维度 | 判定 | 依据 |
| --- | --- | --- |
| **P0 可交付性** | **可交付（离线层，带 1 条 ⚠️）** | 15 文件 / 369 例全绿；构建绿；`tsc` 0 error；48 条静态硬约束门禁（D1/D2/D3/D4/A3/A7/硬约束①③）全过；P0 主路径（FR-01~FR-12）的离线逻辑均有行为测试。**唯一 ⚠️：FR-03① 三入口开关只覆盖菜单（= P2-8 未修复）** |
| **P1 是否全部关闭** | **3 / 3 全部关闭** | P1-1 CRC32 自愈（观察级证据）；P1-2 `assetsDirPath`（全仓无残留 + 双文件门禁）；P1-3 感知掘金侧发布（`unknown` + 双侧提示 + 双侧 i18n） |
| **P2 是否全部关闭** | **未全部关闭：8 条中 4 条已修复并复验，3 条未修复（未排期），1 条待上游裁定** | 见下方 R2-6.1 |
| **knownDeviations 断言审查** | **合理 10 / 放水 0 / 未改动 3** | 见 R2-2 |
| **剩余缺陷** | **P2 未关闭 3 条 + 待裁定 1 条；P3 4 条** | 见 R2-6.1 / R2-6.2 |
| **仍未验证** | 一切需要**真实掘金凭证**的项（§3 表中标「未验证」的 12 项），本轮环境仍无凭证，一条都未升级为「通过」 | 环境事实未变 |

### R2-6.1 · P2 逐条状态（第 1 轮共 8 条，本轮实测复核，不采信"已修"声明）

| 编号 | 问题 | 本轮实测 | 状态 |
| --- | --- | --- | --- |
| P2-1 | S1 抹掉行尾两空格 → GFM 硬换行丢失 | `knownDeviations` #1 断言两空格保留、单/三空格仍清除，**通过** | ✅ 已修复 |
| P2-2 | 每次都推「笔记本没有映射配置」告警 | `knownDeviations` #8/#9 双向通过；门控 `hasMapping` 存在 | ✅ 已修复 |
| P2-3 | 成功同步无法清除 `custom-juejin-last-error` | 写侧 `""` + 读侧 `\|\| undefined` 双保险，测试通过 | ✅ 已修复 |
| P2-4 | 无凭证时探针返回「已失效」 | `not-configured` 三态，UI 用 `settings.credential.none`，测试通过 | ✅ 已修复 |
| P2-5 | `fitBrief` 裁剪点落空格 → 尾随空格且非幂等 | `tests/brief-boundary.test.ts:103` 仍只能用 `.trim()` 比较才相等 → **artefact 仍在** | ❌ **未修复**（未排期） |
| P2-6 | 摘要越界「禁用确认按钮」vs 架构 A1「不阻断保存」 | PRD FR-06b② 与 ARCH §11-A1 原文冲突，两边均未改 | ⏸ **待上游裁定**（非代码缺陷） |
| P2-7 | 图片 URL 替换作用于全文（含代码围栏） | `images.ts:182-185` 仍是 `output.split(token).join(cdnUrl)` 全文替换 | ❌ **未修复**（未排期，风险已被 T-F 大幅降低） |
| P2-8 | 三入口开关覆盖不完整（FR-03①） | `index.ts:263` 仅菜单受 `showInDocMenu` 控制；`addCommand`（205/215/221）与 Dock 仍无开关 | ❌ **未修复**（未排期） |

> **P2-7 的风险已显著下降**：`markdown.ts` 的 `IMAGE_PATTERN` 只从**非代码区**扫描（`stripCodeRegions`），围栏内的 `![](…)` 不进 `imageRefs`，因此围栏内不会产生待替换 token。仅当"围栏里恰好出现与真实图片完全相同的字符串"时才可能被误替换，属理论边界。
>
> **这 3 条未修复的 P2 都不在本轮授权修复范围内**（主理人只派了 3 条 P1 + 3 条 P2，其中 P2 为映射告警 / last-error / 探针三态，对应上表 P2-2/2-3/2-4）。它们不阻塞 P0，但**不应被读成"P2 已清零"**。
>
> **P2-8 需要单独提示**：FR-03 是 PRD 的 P0 需求，其①「开关控制」目前只覆盖三个入口中的一个。第 1 轮把它评为 P2（因为另外两个入口本身可用，只是关不掉），本轮维持该评级，但这是 P0 需求表里唯一带 ⚠️ 的一行，建议发布说明中明示。

### R2-6.2 · P3 剩余清单（不阻塞发布）

1. **S5 `audit(..., {expectAssets:false})` 无调用点** —— `sync.warn.residualAsset` 不可达，图片残留只能从 `imageFailed[]` 看。
2. **P1 专用设置项暴露给 P0 用户** —— 增加认知负担，无功能危害。
3. **凭证存储不对称**（vault 存在时仍写 plugin storage）—— 属 §8.8 既定行为，非缺陷。
4. **（新增）`SyncStatus = "unknown"` 是终态** —— 用户没有"强制按未发布处理"的出口，只能反复点同步。

## R2-7 · 剩余风险（按严重度降序）

**R1（最高）· 三处【推断】契约无法被 369 个绿测试证伪。**
`draftBody` 字段名与 `edit_type:10`、ImageX 五步的 SigV4 + CRC32、`article_draft/update` 的 `id` vs `draft_id`。任一推断错误，P0 主路径（FR-07/FR-08）即不可用，而当前套件**不会报警**。缓解建议不变：把"一次带凭证的真实单篇同步（含 1 张本地图）"列为 P0 唯一硬门禁。

**R2 · CRC32 自愈的**触发条件**仍是推断。**
本轮已证明"收到 4007/MismatchChecksum 就一定自愈、只重试一次、非 checksum 不重试"。但若真实链路以"403 + 空 body"拒绝，`isChecksumMismatch` 返回 `false`，自愈不触发。这是为避免"所有 403 都重试"而做的有意取舍，联调时应第一个确认。

**R3 · `unknown` 状态可能误报。**
风控拒绝、接口抖动与"真的已发布"共用同一句提示。文案已用"可能"限定，但用户会被引去网页端确认——属可接受的成本，不是错误。

**R4 · 三条未排期的 P2 + FR-03① 的部分满足。**
P2-8（三入口开关只覆盖菜单）是 P0 需求 FR-03 里唯一带 ⚠️ 的一行：用户无法把 Dock 图标或命令从界面上关掉。P2-5（摘要尾随空格）与 P2-7（全文替换）影响面小且已被其它机制减轻。三条都不阻塞发布，但**发布说明应如实写明**，不要笼统宣称"P2 已清零"。

**R5 · 环境覆盖。**
只在思源 3.8.12 / Node 24 上验证；`minAppVersion: "3.8.5"` 的下限未实测（`saveData` 双参签名、`assetsDirPath` 行为均按 3.8.5+ 假设）。

## R2-8 · 本轮改动（`src/` 零改动）

```
tests/crc32SelfHeal.test.ts   (新增 4 例：CRC32 自愈的行为级证据)
tests/importer.test.ts        (新增 1 例：assetsDirPath 第 4 参门禁，46 → 47)
docs/TEST-REPORT.md           (追加本节)
```

`src/` 未被修改：`find src -newermt "22:22"` 为空，最新 mtime 22:20:43（工程师最后一次写入），本轮验证自 22:24 开始。`src/` 仍为 27 个文件（24 个 `.ts`）/ 7 784 行 `.ts`。

**我没有修改 `tests/knownDeviations.test.ts` 的任何一条断言**——那是被审查对象，改动会使审查失去意义。

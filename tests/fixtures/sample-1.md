---
title: siyuan-dsh-notes 插件推广博客
date: 2026-11-25T09:38:41+08:00
lastmod: 2026-11-25T09:38:41+08:00
---

# siyuan-dsh-notes 插件推广博客

# 把思源笔记接进 AI 助手：siyuan-dsh-notes 插件发布

> 让 DeepSeek Harness 直接读、写、检索你的思源笔记——不需要复制粘贴，不需要导出，AI 自己动手。

---

你用思源笔记积累了上百篇文档、几千个块，但每次想让 AI 帮你整理、查找、补充笔记时，还是要手动复制粘贴——把内容从思源搬到聊天框，再把 AI 的输出搬回去。

**siyuan-dsh-notes** 就是解决这个问题的：一个 DeepSeek Harness 插件，让 AI 直接操作你的思源笔记内核。

## 它做了什么

插件连上你的思源内核（本地 ​`127.0.0.1:6806`），向 AI 暴露 17 个工具——AI 能像你一样列出笔记本、搜索文档、读取内容、创建和编辑笔记，甚至删除。所有操作都在对话里完成：你说「帮我在 AI 笔记本里记下今天讨论的要点」，AI 调工具，写好，回你一句「记好了」。

## 17 个工具，按需开启

工具分成四组，安装后默认只开「读取」和「日记」两组——**写操作和删除需要手动打开**，避免 AI 误改你的笔记。

|分组|工具|说明|
| -----------| ------------------------------------| -------------------------------------------------------------------------------|
|📖 读取|`list_notebooks`​ ​`list_docs`​ ​`search`​ ​`read_doc`​ ​`get_child_blocks`​ ​`get_block_attrs`​ ​`sql`|列出笔记本、浏览目录树、全文搜索、读 Markdown、查看子块、读属性、执行只读 SQL|
|✏️ 写入|`create_doc`​ ​`append_block`​ ​`insert_block`​ ​`update_block`​ ​`set_block_attrs`​ ​`move_doc`​ ​`rename_doc`|新建文档、追加/插入/更新块、设属性、移动、重命名|
|📅 日记|`daily_note`|读今天的日记，或往里面追加一段|
|⚠️ 删除|`delete_block`​ ​`remove_doc`|删块（需确认）、删文档（整篇移入思源回收站，需二次确认）|

底层调了思源内核的 **19 个 API 端点**，覆盖笔记本、文档树、块操作、属性、SQL 查询、全文搜索、导出和系统探测。

## 不止工具：设置页 + 侧边抽屉

安装后，DSH 的设置页会多出一个「思源笔记」条目：

- **连接状态**实时显示：连上了显示内核版本，连不上告诉你为什么
- **Token 管理**：填入、保存到系统凭据库（不写配置文件）、验证、清除，整个过程不回显
- **默认笔记本**：从你的真实笔记本列表里选，AI 省略 ​`notebook` 参数时自动用它
- **工具开关**：17 个工具逐组、逐条独立控制，中英文双语名称 + 一句话说明

聊天界面右上角多了一个思源图标按钮，点开是**侧边抽屉**：

- 切换笔记本
- 全文搜索
- 浏览文档目录（支持进入子文档 / 返回上级）
- 实时预览 Markdown（一键复制）
- 设为当前默认笔记本

抽屉和 AI 工具共享同一个配置和连接状态——你在设置页配好 Token，抽屉立刻就能用。

## 安全设计

几个刻意做的选择：

- **Token 不进文件**。存在系统凭据库里，设置页只显示「已配置」/「未配置」和来源，永不回显值。日志、工具返回、错误信息里也都不会泄露。
- **不内置任何默认 Token**。没配 Token 时，所有工具直接拒绝，不会以匿名身份访问思源。
- **写操作默认关闭**。安装后只开 8 个工具（7 个读 + 日记），写入和删除需要用户主动去设置页打开。
- **删除前双重确认**。​`delete_block`​ 必须传 ​`confirm: true`​，删文档会提示改用 ​`remove_doc`（避免调错接口导致假成功）。
- **SQL 只读**。​`siyuan_sql`​ 只允许单条 ​`SELECT`，语句中间的分号直接拒绝——哪怕分号藏在字符串字面量里。

## 安装

```bash
npm i siyuan-dsh-notes --registry=https://registry.npmjs.org
```

然后在 DSH 的插件管理里启用 ​`siyuan-notes`​，或在 profile 的 ​`cordis.patch.yml` 中手动加入。

前提：思源内核在线（桌面端开着就行），默认地址 ​`http://127.0.0.1:6806`。

## 技术细节

- **Host 端**（Node.js）：1600 行，​`export function apply(ctx)`​ 注入 ​`tools`​ 和 ​`webServer`​ 两个服务；工具按配置动态注册/卸载；设置路由走 ​`webServer.register` 自建前缀
- **Client 端**（浏览器）：960 行，React 组件（无 JSX，纯 ​`createElement`​）；注册到 ​`settings.section`​、​`settings.section.icon`​、​`conversation.session.header.utilities`​、​`shell.overlay` 四个 Slot
- **测试**：Host 端有假宿主 harness（55 条断言，覆盖注册面、设置路由、只读工具、写入闭环、删除复核、卸载清理）；Client 端有 smoke 测试（校验 4 个 Slot 注册 + 17 个工具文案全覆盖）
- **协议**：所有请求 POST JSON，响应 ​`{ok, value}`​ 或 ​`{ok: false, error: {message}}`

## 路线图

目前覆盖了思源内核 80+ 个 API 里最高频的 19 个。有意没做的是：

- `file/*`​ 与 ​`network/forwardProxy`：风险太大，等于让 AI 读写文件系统或代发 HTTP
- `av/*`（属性视图）：参数结构复杂，会让工具面膨胀到 30+，AI 选错概率上升

后续优先考虑的是：

- `move_block`​ / ​`prepend_block`：补齐块操作
- `fold_block`：展开/折叠，配合大纲视图
- `upload_asset`：往笔记里插入图片和文件
- `export/pandoc`：把笔记导出为 PDF/Word
- 属性视图的只读子集：读表、筛行

---

**GitHub**: [ZZUGeneral/siyuan-dsh-notes](https://github.com/ZZUGeneral/siyuan-dsh-notes)  
**npm**: [siyuan-dsh-notes](https://www.npmjs.com/package/siyuan-dsh-notes)  
**DeepSeek Harness**: [deepseek.com/harness](https://deepseek.com/harness)  
**思源笔记**: [b3log.org/siyuan](https://b3log.org/siyuan)

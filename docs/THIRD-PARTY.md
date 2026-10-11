# 内置的第三方包

这些包**不是** ToonFlow 主仓的产物，是用户桌面版数据目录里额外安装的第三方包，按产品要求内置进本插件。

| 包 | 内置位置 | 大小 | SHA256（前 16 位） | 来源 |
|---|---|---|---|---|
| `webEpisodeEditorProNode.umd.js`（剪辑台 Pro） | `apps/toonflow/build/nodes/` | 1376.4 KB | `51C8A312B402EA1B…` | `%LOCALAPPDATA%\local.toonflow.desktop\stable\data\nodes\` |
| `videoComposer.tool.js`（本地成片工具） | `apps/toonflow/build/tools/` | 54.2 KB | `75220A6D39634515…` | `%LOCALAPPDATA%\local.toonflow.desktop\stable\data\tools\` |
| `novelToTxt.tool.js`（小说转 TXT/Markdown，v1.3.0） | `apps/toonflow/build/tools/` | 3736.3 KB | `F2C3DB79BC1E66B6…` | 同上 |
| 技能 `animal-pawnshop-marketing`（v1.0.0，1 个文件，无作者信息） | `apps/toonflow/build/skills/` | 7.6 KB | — | `%LOCALAPPDATA%\local.toonflow.desktop\stable\data\skills\` |
| 技能 `koc-video`（v8.7.1，7 个文件，`exported-by: MiniMax-hub`） | 同上 | 44.8 KB | — | 同上 |
| 技能 `minimax-h3-prompt-optimizer`（4 个文件，无作者信息） | 同上 | 36.4 KB | — | 同上 |

技能是文件夹，与桌面版逐文件比对 SHA256 一致（2026-10-10）。在 VibeDev 主会话里以 `film-<名字>` 出现（`/film-koc-video` 等）。`koc-video` 标注来自 MiniMax-hub，许可同样待确认。

## 不再提供的内置工具

`askUser`、`browser`、`webFetch`、`webSearch` 是内置 agent 用的，VibeDev 主会话有对应能力（`ask_user_question`、侧栏浏览器、`web_fetch`、`web_search`）。组装时不再打包；工作台启动时删除老数据目录里作者为 Toonflow 的那份，用户自己装的同名工具保留。

三者都与 ToonFlow 的 `*.tool.js` / `*.umd.js` 头部契约一致（`/*! toonflowTool:{…} */`），且**不引用**任何 `@toonflow/*`、`@vibedev-film/*`、`toonflowNodes`、`toonflowCanvas`、`x-toonflow-*`，所以技术标识改名（B 类）不影响它们。

内置后的分发：`film.ts` 现在按 `build/{tools,nodes}` 内容算版本串传给 `createApp`，构建变化会把内置节点/工具整体重新播种到用户数据目录（只匹配内置文件名，用户自装的包不动）。

## 发布前的两件事

1. **来源与许可证确认**：2026-10-11 由产品负责人确认拥有这些包的再分发权，随 0.5.0 公开发布。主仓 MIT 不代替这些包各自的许可：它们是压缩分发产物（不是可维护源码），**不对外宣称与主仓同许可**。
2. **在新宿主的真实运行验收**：宿主契约串已核对（见上），但"能不能真的跑起来、每个功能是否正常"仍需在真实工作台里逐个试用——这属于 **C 类契约串**范围，需要人工过一遍。

## 处理方式

- 原始文件**提交在本仓库** `vendor/toonflow-extras/{nodes,tools}/`，`scripts/assemble-app.mjs` 在组装时把它们覆盖到 `apps/toonflow/build/{nodes,tools}/`；
  这样「重新组装」不会再把它们弄丢（此前只存在于未纳入版本管理的组装目录里）。
- 对比确认：桌面版数据目录、ToonFlow 构建目录、本仓库 `vendor/` 三处的 SHA256 完全一致（见上表）。
- **不修改**这些文件的内部内容（改了就无法判断与上游的差异）；
- 升级时重新抄一遍，并更新本文件的哈希与来源。

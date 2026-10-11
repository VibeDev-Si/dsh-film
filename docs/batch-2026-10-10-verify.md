# 本批验证记录（界面清理 + 从项目目录直接进画布）

时间：2026-10-10 09:0x–09:2x（Asia/Taipei）。分支：插件 `main`（`e47e548` 之后），fork `codex/vibedev-account-gateway`（`1727433`）。

## 改了什么（按用户清单）

1. 画布内**帮助按钮整块删除**：模板里的 tooltip/popover、两个外链（飞书使用教程、需求/BUG 反馈表）、"加入交流群""商务合作"两项与其二维码弹窗，以及 `helpVisible`/`contactVisible`/`contactType`/`contacts`/`showContact()` 与 `.helpMenu`/`.contactContent` 样式，全部删除并清掉不再使用的图标导入（`IconHelp/IconBook/IconBug/IconBrandWechat/IconBriefcase`、`QRCode`）。
2. 设置 → 界面设置：删"语言"与"外观模式"两个入口；外观改为**固定跟随宿主系统**（`uiSettings.theme` 恒为 `system`，旧配置里的 `light/dark` 不再生效）。
3. 语言资源只保留中文（简/繁）与 English：删除 `packages/i18n/src/locales/` 与 `elementPlus/` 下 18 种语言包（各 1 份，共 36 个文件），`Locale` 类型、`supportedLocales`、`catalogs`、`elementLocales` 同步收紧，`languageFlags.svg` 从 16 面旗缩到 2 面（`cn`/`us`，flag-icons 授权声明保留）。
4. "设备互联"隐藏：首页头部按钮、设置侧栏入口、引导（hello）页按钮；组件与共享状态保留备用。
5. "个性化"入口隐藏；**关闭自动记忆**：`apps/server/src/utils/personalization.ts` 的 `isMemoryEnabled()` 恒返回 false —— 一处改动同时关掉系统提示词里的记忆自动注入、`memory` 工具注册与工具内兜底拦截；历史记忆文件保留在磁盘但不再读取。
6. 插件市场：删"网页版市场""开发者文档"两个外链。
7. 从项目目录直接进画布：见 `docs/project-directory.md`；画布内"退出项目"按钮与其确认弹窗删除（只留设置按钮）。
8. 内置桌面版多装的两个第三方包：改为提交在 `vendor/toonflow-extras/`，`scripts/assemble-app.mjs` 组装时自动并入 `apps/toonflow/build/{nodes,tools}/`；三处 SHA256 一致（见 `docs/THIRD-PARTY.md`）。

顺带修掉两个本轮撞到的真实缺陷（都不是本批功能引入）：

- `packages/i18n/src/vite.ts` 的 `i18nPlugin` 在 Windows 下用 `/apps/web/src/` 匹配 Vite 传入的**反斜杠绝对路径**，导致整个 web 应用的翻译标记在构建时被漏掉；改为先统一分隔符再匹配（另加 277 个 web 源文件的命中探测确认转换确实在跑）。
- `apps/web/src/lib/anonymousData.ts` 在账号托管模式下提前 `return`（`undefined`），不符合 `app.onUnmount` 的回调签名，web 类型检查失败；改为返回空清理函数。

## 验证证据（真实执行输出）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| fork web 类型检查 | `bun run --filter '@toonflow/web' typecheck` | 通过（先前报 `main.ts(60,17)` 的那处已修） |
| fork server 类型检查 | `bun run --filter '@toonflow/server' typecheck` | 通过 |
| i18n 类型检查 | `bun run --filter '@toonflow/i18n' typecheck` | 通过 |
| 插件类型检查 | `npm run typecheck` | 通过（含 `dsh-agent` 运行时类型合并后读取会话 `cwd`） |
| 插件测试 | `npm test` | 9 个文件通过 / 1 跳过；**48 通过 / 1 跳过**（新增 `tests/frame-address.spec.ts` 4 项、`packaged.spec.ts` 新增"直接进画布"整条链） |
| fork 全量构建 | `bun run build && bun run build:nodes` | 通过（web 1011 个产物文件，nodes 8 个内置节点 + 组装时并入的第三方节点） |
| 组装 | `node scripts/assemble-app.mjs <fork>` | 154.6 MB，并打印"内置第三方包 build/nodes/webEpisodeEditorProNode.umd.js"与"build/tools/videoComposer.tool.js" |
| 打包 | `npm pack` | `dsh-film-studio-0.1.0.tgz`，1076 个文件，解包 162.7 MB |
| 产物自检 | `node scripts/verify-package.mjs dsh-film-studio-0.1.0.tgz` | 就绪 / 401 / 303 全通过 |
| 安装目录刷新 + 自检 | `robocopy` 后 `node scripts/verify-package.mjs C:\vdp-wt\dsh-film-studio-install` | 155.1 MB / 1076 文件，就绪 / 401 / 303 全通过 |

## "直接进画布"端到端验证覆盖的情形

`tests/packaged.spec.ts` 用**真实打包产物**（自带 bun 运行时）跑一遍，逐条断言：

| 情形 | 期望 | 实测 |
| --- | --- | --- |
| 目录不存在 | 建目录 + 写标记 + 写 `画布1.json`（内容与"新增项目"一致），返回 `createdDirectory: true` | 通过 |
| 再开同一个目录 | 复用，不新建、不改动，`notices` 为空 | 通过 |
| 普通代码项目（含 `package.json`、`src/`） | 只多出我们的两个文件，用户文件字节不变 | 通过 |
| 同名但不是我们的（用户自己的 `.vibedev-film.json`、`画布1.json`） | 用户文件一字不改；我们的标记退到 `.vibedev-film.json.vibedev-film`，画布退到 `画布2.json`，并有 1 条提示（不报错） | 通过 |
| 目录里已有真画布（`分镜.json`） | 复用该画布，不创建 `画布1.json` | 通过 |
| 不带目录 | 链接回到工作台自己的页面（`?filmAccess=…`，无 `film` 参数） | 通过 |
| 链接形态 | `open(dir)` 返回的链接带 `film=<绝对路径>`；`frameAddress()` 把会话令牌搬到路径形式后仍保留该参数（4 项单测） | 通过 |

## 未做 / 需要用户决定

- 首页（项目列表）本身保留（"新建/导入项目"仍在那里）；从项目目录打开这条路不再经过它。
- 两个第三方包的**许可证与再分发条件仍未确认**（`docs/THIRD-PARTY.md` 记为欠账）；改名批（C 类）尚未动它们。
- 技术标识改名（第 7 项）仍留在 `feat/technical-rename` 分支未合并，等这批验收后单独跑。

## 附：技术标识改名已合并（同日随后一轮）

- 合并：`--no-ff` 合并 `feat/technical-rename`（`a925ebc`）→ 合并提交 `b8bb5d2`；回退点标签 `pre-technical-rename`（`d00d75d`）。
- 内容：44 个工作区包 `@toonflow/*` → `@vibedev-film/*`、329 个文件；**运行时契约串未改**。
- 合并时手工处理两处：`apps/web/src/pages/film/opening.vue` 与 `apps/server/src/routes/workspaces/filmPrepare.ts` 的导入改成新包名（改名提交不认识这两个新文件）；`.github/workflows/debug.yml` 里裸写的 `@toonflow/file` 改名（脚本没覆盖 YAML）。
- 验证：`bun install` 重建链接；`@vibedev-film/web`、`@vibedev-film/server` 类型检查通过；`bun run build`、`bun run build:nodes` 全绿；`build/server/film.js` 里 `@toonflow/` 出现 0 次；重新组装后两个内置第三方包与桌面原件**逐字节一致**；`tests/packaged.spec.ts` 3 项全通过（真产物启动 + 直接进画布目录矩阵）。
- 与改名**无关**的两个既有 typecheck 失败（在合并前的 `pre-technical-rename` 上独立复现）：`@toonflow/node-image-generation` 的 `index.vue(159,30) TS2339`，以及 `apps/desktop` 缺 `electrobun/main` 类型声明。两处 `build` 均正常，不影响 Film 产物。
- 回退手册：fork `docs/rollback-technical-rename.md`（三种粒度 + 回退后必须重跑的三项验证）。

## 附：自检脚本收尾修干净（同日再一轮）

原先 `scripts/verify-package.mjs` 在校验项全部通过后仍可能以 exit 1 结束：`process.exit()` 与子进程 stdio 管道关闭在同一 tick 里竞争，触发 libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（Windows，`win/async.c:94`）。

改法：不再用 `process.exit()` 硬退 —— 杀子进程后 `lines.close()`、销毁两条管道、摘掉监听，等 `exit` 事件（最多 5s），清理临时目录改为 `maxRetries` 重试且失败只提示不判定失败，然后用 **`process.exitCode`** 让事件循环自然排空；另加一个 `unref()` 的 10s 看门狗，只在句柄真的卡住时强制退出（并打印"收尾超时"）。

验证（同一产物、连续多轮）：

| 轮次 | 退出码 |
| --- | --- |
| 安装目录第 1–3 次 | 0 / 0 / 0 |
| 故意删掉 `build/server/film.js` | 1（并打印"缺少 Film 入口"） |
| 恢复后再跑 | 0 |
| 打包产物（tarball） | 0 |
| 在安装目录里 `node scripts\verify-package.mjs`（自检脚本已随安装目录提供） | 0 |

## 附：内置包"永远不更新"的既有缺陷（同日再一轮）

验收前发现一个会让本轮内置白做的既有缺陷：`apps/server/src/film.ts` 调 `createApp` 时**没有传 `pluginRevision`**，而 `initializePlugins` 的逻辑是"只要 `data/{nodes,tools}/initialized` 存在且 revision 为 undefined 就直接返回"。结果是**内置节点/工具在用户第一次运行之后永远不再随新构建更新**，插件内置的两个第三方包也就永远进不到已有数据目录里（你机器上的 `~/.vibedev/film-studio/data/{nodes,tools}` 正是这个状态，里面没有它们）。

改法（fork `a6b8651`）：`film.ts` 按 `build/tools` 与 `build/nodes` 的内容算一个 sha256 版本串传给 `createApp`。构建变了 → 整体重新播种一次并把版本串写进标记；过滤规则只匹配内置文件名（`*.tool.js`、`*.umd.js`），**用户自己安装的包不在同步范围内**。

- 需要一次人工触发：删掉已有的空标记（`data/{nodes,tools}/initialized`），下次启动即同步。已对真实数据目录执行并核对：`nodes` 10 个（含 `webEpisodeEditorProNode.umd.js`）、`tools` 12 个（含 `videoComposer.tool.js`），标记内容变为版本串。
- 新增端到端测试 `packaged.spec.ts` → "re-seeds the built-in nodes and tools into a data directory that was initialized before"：预置空标记 + 旧版 `videoNode.umd.js` + 用户自装 `mine.tool.js`，启动后断言两个内置包到位、旧内置文件被更新、用户自装文件一字节未变。插件测试总计 **49 通过 / 1 跳过**。

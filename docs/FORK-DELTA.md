# FORK-DELTA：ToonFlow 上游改动记录

本文件记录我们相对 **ToonFlow 上游** 的改动，供跟版与交接使用。上游仓库
`https://github.com/HBAI-Ltd/Toonflow-app`，基线提交 `2c7fb257affb65777110fe4c6e60cd3c09187d9b`
（提交信息：修复浏览器工具环境变量获取问题）。分支：`codex/vibedev-account-gateway`。

## 跟版策略

- **只挑上游修复，不整体 rebase**：上游更新时，按本文件的清单判断冲突面；我们的改动集中在"账号托管模式"和"Film 入口"两处，尽量不碰画布/导演台/文档等业务代码。
- 改上游文件时**只做最小侵入**（多数是加一个 `isFilmAccountMode()` 分支或换一个数据来源），便于后续用 diff 对照重放。
- 我们的文件（新增）与上游文件（改动）分开列，减少跟版时的判断成本。

## 新增文件（上游没有）

| 文件 | 作用 |
| --- | --- |
| `apps/server/src/film.ts` | Film 入口：要求 `FILM_ACCOUNT_MODE=1` 与 `TOONFLOW_DATA_DIR`，根目录取 `FILM_APP_ROOT`（默认仓库根），监听 `127.0.0.1:0` 并打印 `{"filmReady":"http://127.0.0.1:<port>"}` 供宿主读取 |
| `apps/server/src/lib/filmAccess.ts` | 页面会话闸门：`FILM_WEB_TOKEN`（64 位十六进制）换 HttpOnly + SameSite=Strict Cookie，其余请求无 Cookie 401、跨源 403 |
| `apps/server/src/utils/film/gateway.ts` | 桥接客户端：校验回环 `FILM_BRIDGE_URL` 与 64 位令牌，调用宿主 `/catalog`、`/media/{image,video}`、`/task/:id`；把网关目录投影成三个合成文本供应商（按协议）与 ToonFlow 媒体模型；设置投影时清空 `apiKey`、占位 `apiUrl` |
| `apps/web/src/components/settings/panels/filmAccount.vue` | 账号托管模式下的"文本模型"说明面板 |
| `apps/server/src/routes/workspaces/filmPrepare.ts` | `POST /api/workspaces/film/prepare`：从项目目录直接进画布前的"准备"（建目录、写标记与第一张画布、绝不覆盖同名但不是我们的文件） |
| `apps/web/src/pages/film/opening.vue` | 入口页：带 `directory` 时先准备目录，成功进画布，失败提示并回首页 |

## 改动文件（最小侵入）

| 文件 | 改动 |
| --- | --- |
| `apps/server/scripts/build.ts` | 除了 `src/index.ts`，额外产出 `build/server/film.js`（同一套 `--target=bun` 参数） |
| `apps/server/src/app.ts` | Film 模式：先挂 `filmAccess()`；`/api/providers` 一律 403（模型归账号插件） |
| `apps/server/src/utils.ts` | 暴露 `u.film`（供各路由读取投影设置与桥接） |
| `apps/server/src/utils/ai/index.ts` | `getConfiguredModel`/`listAiModels` 变 async，Film 模式改读桥接目录；模型上限优先用网关声明 |
| `apps/server/src/utils/ai/initialize.ts` | Film 模式跳过供应商模型刷新 |
| `apps/server/src/utils/conf/index.ts` | Film 模式不写入种子供应商 |
| `apps/server/src/utils/media/generation.ts` | Film 模式图片/视频走桥接 |
| `apps/server/src/routes/settings/{get,save}.ts` | 读取时投影（去凭据）、保存时剔除 `customProviders`/`mediaProviderConfigs`/`filmAccountManaged`/`filmAccountMessage` |
| `apps/server/src/routes/{ai/models.ts,ai/generate.ts,workspaces/files/reveal.ts,workspaces/selectDirectory.ts,agents/a2a/save.ts}` | 与账号托管模式配套的小改动 |
| `apps/server/src/agent/runtime/model.ts`、`apps/server/src/utils/workspace/index.ts` | 同上 |
| `apps/web/src/components/settings/index.vue` | 账号托管时换"文本模型"面板，隐藏"媒体模型/开发者" |
| `apps/web/src/types/components.d.ts` | 面板类型登记 |
| `apps/web/src/main.ts` | `?film=<项目目录>`（或 `#/workspace?directory=`）在路由创建前改写成 `#/film/open?directory=…`，实现"从项目目录直接进画布" |
| `apps/web/src/router/index.ts` | 新增 `/film/open` 入口路由 |
| `apps/web/src/lib/anonymousData.ts` | 账号托管模式不启动采集；提前返回空清理函数以满足 `app.onUnmount` 的签名 |
| `apps/web/src/pages/workspace/panels/canvas/components/canvasControls.vue` | 删除画布内的帮助按钮及其外链、联系方式弹窗 |
| `apps/web/src/pages/workspace/components/workspaceMenu.vue` | 隐藏"退出项目"按钮与其确认弹窗 |
| `apps/web/src/components/settings/panels/ui.vue`、`apps/web/src/stores/settings.ts` | 删除"语言/外观模式"入口；外观固定跟随系统（旧配置里的 light/dark 一律忽略） |
| `apps/web/src/components/settings/panels/pluginMarket/index.vue` | 删除"网页版市场/开发者文档"外链 |
| `apps/web/src/pages/home/index.vue`、`pages/hello/index.vue` | 隐藏"设备互联"入口（设置面板入口同步隐藏，组件保留） |
| `packages/i18n/src/{index,elementPlus,vite}.ts`、`locales/`、`elementPlus/` | 语言资源只保留中文（简/繁）与 English；修 `i18nPlugin` 在 Windows 下因反斜杠路径漏掉整个 web 应用的问题 |

## 技术标识改名（已合并，2026-10-10）

工作区包名 `@toonflow/*` → `@vibedev-film/*`（44 个包、329 个文件），**运行时契约串一律未改**：
`window.toonflowNodes`、`toonflowTiptapHost`、`toonflowCanvas`、`x-toonflow-workspace`、`FILM_*`、`TOONFLOW_DATA_DIR`、数据目录与文件名全部保留。

- 影响本插件的两处：fork 的构建过滤器改成 `@vibedev-film/web` / `@vibedev-film/server`（根 `package.json`），组装脚本产出的目录布局没有变化。
- 因此**第三方节点/工具包不需要改名或兼容层**（它们按 `window.toonflowNodes.<名>` 注册，注册名与宿主读取名都没变）；内置的两个包已核对与桌面原件逐字节一致。
- 回退点：fork 标签 `pre-technical-rename`（`d00d75d`），合并提交 `b8bb5d2`；完整回退手册见 fork 仓库 `docs/rollback-technical-rename.md`。
- 遗留（不阻塞，未做）：`bun.lock` 已由 `bun install` 重新生成；`AGENTS.md`、若干 `readme.md` 里的旧包名说明文字仍写着 `@toonflow/*`（仅文档）。

## 与上游不兼容的注意事项

- 我们**不修改** `toonflow` 的技术标识（包名、文件格式、插件 ID、协议），改名只在界面文案层面；上游升级时应保持这一点。
- `apps/server/src/index.ts`（桌面/服务器主入口，端口写死 3000）**未改动**；Film 走自己的 `film.js`，两者可共存。
- 上游若把服务端从 Bun 迁到 Node，`runtime.ts` 的运行时候选顺序（随包运行时 → 宿主自身 → bun）可以自然切换到宿主自身，无需改桥接协议。
- 界面资源：`packages/i18n` 已删掉除中文与 English 之外的语言包；`src/assets/languageFlags.svg` 只留 `cn`/`us` 两面旗（授权声明保留）。上游若新增语言，需要同时补回字典、Element Plus 包、Day.js 包与旗帜。

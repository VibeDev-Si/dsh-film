# Film Studio 计划与现状

更新：2026-10-10。范围以 ToonFlow 主工程的 `docs/filmHandoff.md`（2026-10-10 修订版）为准，本文只记录本仓库的实施状态。

## 1. 来源目录（原型，已本地提交）

| 目录 | 角色 | 分支 / 提交 |
| --- | --- | --- |
| `C:\vdp-wt\film-toonflow-gateway` | 产品主体：ToonFlow 改造版（账号托管模式、Film 入口、页面闸门、模型桥接） | `codex/vibedev-account-gateway` @ `716d5de` |
| `C:\vdp-wt\dsh-film-next` | 宿主壳原型：拉起 ToonFlow、私有桥接、启动路由与工具 | `codex/toonflow-account-bridge` @ `ed5090b` |
| `C:\vdp-wt\dsh-vibedev-film-bridge` | 账号插件补丁：`vibedevGateway` 宿主服务（接口版本 1） | `codex/film-account-bridge` @ `1e2928a` |

三处都只做了本地提交，**都没有推送**（第三个属于账号插件仓库，等 US 网关就绪随 0.3.0 发布）。

## 2. 首版范围（2026-10-10 修订）

- **不接入旧编剧模块**：不迁移旧编剧界面、`story_*` 工具、`film/story/` 专用存储与结构化关系系统，不建立第二套剧本正文或双向同步。旧项目与旧代码保留、不删除、不自动转换。
- 剧本与分镜正文由 **ToonFlow 自己的 Agent** 编写，经现有文本节点工具保存；生成节点接收本段的执行提示词。只在聊天里输出文字不算写进画布。
- 旧编剧的结构化关系、版本校验与下游影响追踪，只有在长篇／多集／反复修订的真实需求出现后再评估。
- 我们不新增写作功能、不批量改写 Skill；先验证 ToonFlow 现有写作链路在账号接入后是否可用，有缺口再按确认范围补。

## 3. 本仓库形态

```
src/            宿主侧（index.ts 插件注册、runtime.ts 启动、bridge.ts 私有桥接、contracts.ts 账号服务类型）
src/client/     浏览器侧（index.ts 侧栏标签注册、TabBody.tsx 工作台框架）
apps/toonflow/  组装进来的 ToonFlow（build/{server,web,tools,nodes,ext,providers,skills} + runtime/bun）
scripts/assemble-app.mjs  从 ToonFlow 构建目录组装 apps/toonflow/
cordis.patch.yml
docs/{plan.md,FORK-DELTA.md}
```

模型只有一条路径：ToonFlow 的节点、内置 Agent 与宿主 Agent 都经 `vibedevGateway`/`vibedevMedia`；页面与配置里不落任何凭据。

## 4. 实施状态

### 阶段一：工程定型

- [x] 插件骨架：`package.json`（`dsh.bundle.patch` + `dsh.client`）、`cordis.patch.yml`、`src/`→`lib/`、客户端 tsdown 构建、`vitest`、`tsconfig`。
- [x] 运行时不依赖用户 Bun：**随包带 Bun 运行时**（ToonFlow 服务端真的用 `Bun.Transpiler`、`Bun.Image`、`Bun.hash` 等）；候选顺序 随包运行时 → 宿主自身 → `bun`。
- [x] ToonFlow 产物组装（`scripts/assemble-app.mjs`，合计 169.2 MB，其中 `runtime/bun` 112.2 MB）；`apps/toonflow/` 不入库但打进 tarball。
- [x] `FORK-DELTA.md`：上游基线 `2c7fb257`、新增/改动文件清单、跟版策略。
- [x] **FFmpeg 依赖核对**：ToonFlow **不随包带 FFmpeg**。`@toonflow/ffmpeg` 的模式是 `auto | download | system`：先看目标目录里有没有下好的可执行文件，再找 `PATH` 上的 `ffmpeg/ffprobe`，都没有就按 `catalog.ts` 的源下载（npmmirror 优先，其后是 ffmpeg-static `b6.1.1` 的一串 GitHub 代理）。**结论**：插件不必打包 FFmpeg，但要接受"首次使用可能需要联网下载"，并在验收里覆盖"机器上已有 FFmpeg"和"需要下载"两种情况。
- [x] 构建入口成文并可复现：两步 —— ToonFlow 侧 `bun run build && bun run build:nodes`，插件侧 `node scripts/assemble-app.mjs <toonflow-directory>`（**不设默认路径**，缺参数就明确报错，避免依赖某个开发者机器）。实测：删掉 `apps/toonflow/` 后重新组装得到同一套产物（合计 169.2 MB），打包应用测试随即通过。
- [ ] 发布前把 peer `@vibedev-si/dsh-vibedev` 由 `>=0.2.7` 收紧到 `>=0.3.0`。

### 阶段二：能安装、能打开

- [x] 可见入口：右侧栏标签 + 引导页条目（`src/client/index.ts`），标签体 `POST /api/dsh-film-studio/open` 取链接后内嵌工作台（服务端无 X-Frame-Options/CSP，可内嵌）。
- [x] 生命周期（第一批）：标签卸载时调 `POST /api/dsh-film-studio/close` 停掉子进程；`stop()` 之后再次 `open()` 会**用新端口重新拉起**；插件卸载走 `dispose()`，之后 `open()` 明确拒绝。打包应用测试已覆盖「开→停→再开（端口不同）→卸载后拒绝」。
- [x] 生命周期（第二批）：启动失败**带上服务端最后几行输出**（做脱敏与截断：Bearer、32 位以上十六进制都替换掉）；连续失败按 0.5/1/2/4/5 秒退避，达到 4 次后进入 60 秒冷却并给出可读提示。策略与脱敏是纯函数，有单测。
- [x] 生命周期（第三批·日志）：每次启动在 `<数据目录>/logs/session-<时间戳>.log` 记录**服务端 stderr 与就绪行**（只记服务端自身输出，不记页面请求），并按名称保留最新 5 个、删除更早的；日志打不开不影响启动。
- [x] 生命周期（第三批·单实例锁）：数据目录里写 `session.lock`（含 pid、实例 id、启动时间）；**同一数据目录被另一个实例占用时明确拒绝**并给出进程号与处理办法；进程已死的锁自动接管；只有锁的主人才能删锁；锁被解析失败时按"无锁"处理，避免坏文件把用户永久挡住。打包应用测试覆盖「第二个窗口被拒 → 第一个停止后第二个接管 → 死进程的锁被忽略」。
- [ ] 生命周期（第四批）：宿主界面上的"停止"按钮（当前只有标签卸载与插件卸载会停）。
- [x] **本地安装产物已有**：`npm pack` 得到 `dsh-film-studio-0.1.0.tgz`，**55.7 MB 压缩 / 177.4 MB 解包 / 1109 个文件**，关键文件齐全（`package.json`、`cordis.patch.yml`、`lib/`、`client/client.js`、`apps/toonflow/build/server/film.js`、`build/web/index.html`、`runtime/bun.exe`），且**没有**把 `src/`、`tests/`、`scripts/`、`docs/` 打进包里。
- [x] 数据落位（已核对）：**项目/工作区目录由用户在界面里选**（film 模式下 `isLocalWorkspaceRequest` 直接用请求带来的目录），插件自身数据在 `TOONFLOW_DATA_DIR`（默认 `~/.vibedev/film-studio/data`，即 nodes/tools/ext/skills/agents 与配置的落点），两者不混；默认不碰旧 Film 与已安装 ToonFlow 的目录。
- [ ] 独立环境安装验收：把开发源码目录移开后仍能启动。
- [ ] 启动失败的用户可读提示（已覆盖"产物缺失/账号插件未启用/启动超时"三类，需在真实宿主里复核措辞）。

### 阶段三：真实账号与模型

- [ ] 与账号插件维护者确认正式接口与能力版本（不靠手写断言或包版本号猜能力）。
- [ ] 登录/退出/切换账号/令牌续期/缺账号插件/接口版本不匹配/空模型列表。
- [ ] 真实文本流 + 一轮真实的 ToonFlow 内置 Agent 工具执行。
- [ ] 一个真实短片项目走完 ToonFlow 现有写作链路：写剧本→存文本节点→只改指定场次→拆分镜写入画布→为片段准备提示词→保存关闭再打开；核对正文可编辑、未指定内容未被误改、片段提示词从本段 0 秒计时。
- [ ] 图片/视频目录与选项按网关实际能力显示（参考素材、首尾帧、全能参考、时长、比例、清晰度、费用提示）。
- [ ] 授权范围内的真实生成；结果可预览/播放/保存/重开。
- [ ] 失败路径：余额不足、限流、断网、取消、超时、重启恢复；**提交结果不确定绝不重发**。
- [ ] 音频按账号服务实际接口开放，没有就明确不可用。
- [ ] DSH 与 VibeDev-next 分别记录验收矩阵。

### 阶段四：扩展生态与宿主 Agent

- [ ] 梳理 ToonFlow 的 Skill/工具/节点/扩展/MCP 注册方式并保留边界。
- [ ] 明确 DSH Agent 与 ToonFlow 内置 Agent 的分工，避免重复生成或互相覆盖任务状态。
- [ ] 优先通过公开工具/MCP 让宿主 Agent 操作当前项目与画布，不重写画布系统。
- [ ] 第三方节点包（剪辑台 Pro、`videoComposer.tool.js`）**先不打包**，逐包记录来源与许可证后再定分发方式。

### 阶段五：产品化与发布

- [ ] 名称/图标/文案/主题统一为 Film，深浅色齐全。
- [ ] 启动、画布缩放拖拽、内存、媒体预览与生成期间响应的实测数据（没有测量不宣称更快）。
- [ ] 本地预览与用户验收 → 再准备市场分发、账号插件配套版本、更新说明与回滚方式。

## 5. 已知边界（不要误判）

- 原型测试使用模拟账号与媒体响应，**没有**真实登录、真实付费生成，也没有完成 DSH / VibeDev-next 的安装验收。
- 桥接与节点的任务归属映射只存在内存中，重启后的重新关联尚未验收。
- 音频生成在原型里未开放（账号宿主服务当时没有音频方法）。
- 打包体积约 170 MB（Bun 运行时 112 MB）；优化（如首次安装下载运行时）留到产品化阶段。

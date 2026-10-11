# VibeDev Film（`dsh-film-studio`）

**VibeDev Film 工作台**：在 DSH / VibeDev 的右侧栏提供影视工作台（小说→剧本→画布→导演台→剪辑），
模型与媒体生成统一走 **VibeDev 账号插件**（文本用宿主自身的 `llm` 服务，媒体用 `vibedevMedia`），
用户不需要填写任何模型 API Key。

运行主体是 **ToonFlow 改造版**（上游 ToonFlow，MIT 许可；本产品保留其版权与许可声明，用户可见品牌已改为 VibeDev Film）。
ToonFlow 的改造在其自己的仓库（见 `docs/plan.md`），构建产物进入本仓库的 `apps/toonflow/`。

## 目标形态（单插件）

```
lib/            宿主侧：启动/关闭工作台运行时、私有桥接、工具与路由、任务
client/         客户端：侧栏入口
apps/toonflow/  已构建的 ToonFlow（web 产物 + server bundle + nodes/tools/ext/skills）
skills/         Film 相关 Skill
locale/         文案
cordis.patch.yml 插件装配
```

原则：

- **不依赖用户机器上的 Bun 或外部源码目录**：用宿主自带运行时启动 ToonFlow 服务。
- **只有一条模型路径**：文本/图片/视频都经账号插件；插件不保存、不转发任何凭据到页面。
- **数据落位明确**：插件数据在宿主应用数据目录下，项目目录由用户选择，默认与旧 Film、已安装 ToonFlow 隔离。
- **旧 Film 继续可用**：本插件以不同包名并行存在，验收通过后再谈替换与迁移。

## 现状

- `0.1.0` 目标：**干净环境可安装、从可见入口打开 ToonFlow 工作台**，并完成真实账号下的文本/图片/视频各一次生成验收。
- 已有原型（宿主壳 + 桥接 + 账号补丁）不在本仓库，见 `docs/plan.md` 的“来源目录”。

## 开发

见 `docs/plan.md` 的构建与验收章节（待随第一批代码补齐）。

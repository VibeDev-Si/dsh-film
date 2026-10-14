# dsh-film · VibeDev 影视工作台

在 DeepSeek Harness 和 VibeDev 的右侧栏打开画布式影视工作台：小说拆解、剧本、分镜画布、图片 / 视频 / 音频生成、导演台、剪辑成片。所有模型和费用都走 **VibeDev 账号**（`@vibedev-si/dsh-vibedev`），不需要填写任何模型 API Key。

[English](#english)

## 0.5.0：换成新的工作台

从 0.5.0 起，`dsh-film` 是基于 ToonFlow 的画布式工作台，取代 0.4.0 及更早的旧工作台。在 VibeDev 生态（插件中心）里更新即可，配置条目仍是 `dsh-film`；旧工作台的项目文件不会被删除，也不会自动转换。

- **支持 Windows x64、macOS Apple 芯片 arm64 和 Intel x64**：Bun 1.3.13 以平台可选依赖随插件安装（`@oven/bun-windows-x64`、`@oven/bun-darwin-aarch64`、`@oven/bun-darwin-x64`），npm 和 pnpm 只安装当前平台对应的包，用户不用另外安装 Bun。
- **需要 VibeDev 账号插件**：图片和视频生成需要 0.2.7 及以上；音频生成（音乐、播客、语音）需要 **0.3.1 及以上**。

## 生成节点的费用

图片、视频、音频生成节点会在发送键左边显示预计费用，悬停可以看到计算方式。价格来自你的 VibeDev 账号（已按账号倍率换算），实际以 VibeDev 扣费为准，失败的任务不扣费。

| 节点 | 显示 |
| --- | --- |
| 图片 | 按张计费，例如 `¥0.10`；尺寸档位有单独价格时按所选尺寸算 |
| 视频（按次） | 例如 `¥2.00` |
| 视频（按秒） | 单价 × 所选时长（按所选分辨率），例如 `约 ¥4.95`；接了参考视频时显示「起」，参考视频的时长另计 |
| 音乐、播客 | 按次，例如 `¥0.50` |
| 语音 | 按原始秒计费，例如 `¥0.015/原始秒`；按服务商返回的原始时长结算，生成后节点上分开显示播放时长和计费原始时长 |
| 未定价 | 虚线框的「未定价」，表示目录没有给出价格，**不代表免费** |

## 音频生成节点

使用 VibeDev 音频模型时，节点只显示所选模型声明的参数：

- **音乐**：提示词，以及歌词、曲风、情绪、人声；
- **播客**：话题，以及网页链接（只给链接也可以）；
- **语音**：提示词就是要朗读的原文；可以连音频节点作为参考音色，数量、时长和格式按模型要求检查；输出格式和采样率只列模型支持的组合，例如 WAV 和 MP3 各有自己的采样率。

一次点击就是一次生成：页面刷新或断线后，节点会接着跟进同一个任务，不会重复生成；结果已经出来、只是费用还在结算时，结果照常保存。

## 第三方内容

- 工作台主体来自 [ToonFlow](https://github.com/HBAI-Ltd/Toonflow-app)（MIT），许可文本见 `licenses/ToonFlow-LICENSE.txt`。
- 内置的剪辑台 Pro 节点、本地成片工具、小说转 TXT 工具和三个技能，来源见 `docs/THIRD-PARTY.md`。

## 开发

工作台（ToonFlow 的 VibeDev 分支）的源码在私有仓库 [VibeDev-Si/dsh-film-studio](https://github.com/VibeDev-Si/dsh-film-studio) 的 `workbench` 分支；每个发布用到的提交打 `dsh-film-v<版本>` 标签。

```sh
npm install
node scripts/assemble-app.mjs <工作台检出目录>           # 工作台里先执行 bun run build && bun run build:nodes
npm run typecheck && npm test
npm pack                                               # dsh-film-<版本>.tgz
node scripts/verify-package.mjs dsh-film-<版本>.tgz      # 用打好的包启动一次，确认能起来、页面有门禁、来源已发布
```

源码集成测试读取 `FILM_TEST_SOURCE`，请将它设为已构建的工作台检出目录；未设置时只跳过该源码集成用例。测试使用本地模型与媒体服务模拟，不需要账号密钥，也不会提交付费生成。

`assemble-app.mjs` 把工作台的来源提交写进 `apps/toonflow/SOURCE.json`，并拒绝有未提交改动或提交未推送到 `dsh-film-studio` 的工作台；本地调试可加 `--unreleased`，但这样组装的包 `verify-package.mjs` 不放行（调试时可加 `--allow-unreleased`）。

`node scripts/install-app.mjs <安装目录> [包根目录或 .tgz]` 会在暂存目录检查 Web 资源与本机 Bun 运行时；没有内置运行时时先安装生产依赖，验证通过后才替换原安装。`npm run check:browser` 可使用 macOS 的 Chrome 或 Edge，并从插件依赖解析 Bun。

发布顺序：

1. 工作台：提交，推送到 `dsh-film-studio` 的 `workbench` 分支，构建（`bun run build && bun run build:nodes`）。
2. 本仓库：组装、`npm version <版本> --no-git-tag-version`、测试、打包、`verify-package` 通过。
3. 工作台打标签 `dsh-film-v<版本>` 并推送；本仓库提交、打 `v<版本>` 标签并推送。
4. 建 GitHub Release 并附上同版本的 `dsh-film-<版本>.tgz`，工作流用 OIDC 发到 npm（`.github/workflows/publish.yml`），核对 npm 上的包与本地包逐字节一致。npm 有时要十几分钟才能读到新版本；确认步骤超时就等它出现后重跑失败的任务（`gh run rerun <id> --failed`），不要重新发布。
5. 同步国内镜像：`PUT https://registry-direct.npmmirror.com/-/package/dsh-film/syncs`，确认 npmmirror 上的 integrity 与 npm 一致。VibeDev 用户通过这个镜像安装和更新插件。

原型阶段的内部记录在 `docs/`。

---

## English

**dsh-film** opens a canvas film workbench in the right sidebar of DeepSeek Harness and VibeDev: novel breakdown, script, storyboard canvas, image / video / audio generation, director desk and editing. Every model and charge goes through the VibeDev account (`@vibedev-si/dsh-vibedev`); no model API keys are needed.

**0.5.0** replaces the earlier workbench (0.4.0 and before) with the ToonFlow-based canvas. Update it from the VibeDev Plugin Center; the profile entry stays `dsh-film`. Projects of the old workbench are kept, not converted. Windows x64, macOS Apple silicon arm64 and Intel x64 are supported. Bun 1.3.13 is installed with the plugin as a platform-specific optional dependency (`@oven/bun-windows-x64`, `@oven/bun-darwin-aarch64`, or `@oven/bun-darwin-x64`); npm and pnpm install the package for the current platform. Image and video generation need the account plugin 0.2.7 or later; audio (music, podcasts, speech) needs 0.3.1 or later.

**Cost beside the send button**: the image, video and audio nodes show the expected cost to the left of the send button, with how it is reached on hover. Images per image (by size bucket when one has its own price); video per generation, or per second × the chosen duration at the chosen resolution (`约`, plus `起` when reference videos add their length); music and podcasts per generation; speech per second of original audio (playback and billed lengths are shown apart once it ran). A model the catalog gives no price is shown as "未定价" (not priced), never as free. Prices are the account's selling prices; the VibeDev receipt is the charge, and failed tasks are not charged.

**Audio node**: with a VibeDev audio model the node shows only the fields that model declares (music: lyrics, genre, mood, voice; podcast: a web page; speech: reference voices, and only the format / sample rate pairs the model offers). One click is one generation: after a reload or a dropped connection the node picks up the same task, and a result whose charge is still settling is kept, never generated again.

**Third-party content**: the workbench is based on [ToonFlow](https://github.com/HBAI-Ltd/Toonflow-app) (MIT, see `licenses/ToonFlow-LICENSE.txt`); the bundled editor node, tools and skills are listed in `docs/THIRD-PARTY.md`.

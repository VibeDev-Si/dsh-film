# 宿主 agent 操作工作台，与媒体画廊"加入画布"（2026-10-10）

## 1. 宿主会话里的 agent 能不能操作画布

**以前不能。** 插件只给了 agent `film_studio_open`（返回一个链接）和 `film_write_prompt`。fork 里本来有一整套给外部 agent 的工作台工具（读状态、打开项目、画布节点的增删连、生成图片/视频/音频、剪辑成片、小说转文本、文档读写…），由打开着的页面经 SSE 控制连接执行；但在影视模式下这条连接要求开启 MCP 并配置令牌，所以从来没有连上过。

**现在：**

| 工具 | 作用 |
| --- | --- |
| `film_studio_open` | 在**调用它的那个对话**的右侧栏打开（或切到前面）影视工作台；等页面就绪再返回（`ready`）。说明里写明"用户要做短剧/漫剧/视频/分镜/剧本时先调用它" |
| `film_tools` | 列出工作台能做的操作和使用说明；带 `name` 时给出该操作的完整参数 |
| `film_call` | 执行一个工作台操作（`name` + `args`，可选 `target`） |

可用操作 39 个（总 47 个，去掉了 `runAgent` 以及宿主自己就有的 `read`/`write`/`edit`/`ls`/`web_fetch`/`web_search`/`browser`），包括 `getAppState`、`openProject`、`switchPanel`、文档读写、`getCanvas`、`addNode`、`connectNodes`、`nodeTools`（节点自带函数）、`arrangeCanvas`、`listMediaModels`、`generateImage`/`generateVideo`/`generateAudio`、`videoComposer`、`convertNovelToTxt`、`ffmpeg`/`ffprobe`、`workspaceFiles` 等。

链路：DSH 工具（宿主）→ 插件持有的控制令牌 `FILM_CONTROL_TOKEN` → 工作台 `/api/film/agent/{tools,call}` → 控制连接 → 打开着的页面执行 → 结果原路返回。

- 页面在影视模式下凭宿主签发的会话连控制通道，不需要 MCP 令牌；外部 MCP 端口仍然关闭。
- `/api/film/agent` 只认控制令牌：页面会话拿不到它（测试：页面会话访问 → 403）。

### 用户切到别的标签页 / 别的对话时还能不能用

**能。** 工作台标签页是 `keepMounted`：隐藏、切会话、换停靠位置都不卸载，页面和它的控制连接一直在；agent 本身在宿主进程里运行，与用户正在看哪个对话无关。只有用户 **× 掉标签页**后页面才不在了，这时 `film_call` 会提示"先调用 film_studio_open"。

`film_studio_open` 要在别的对话里打开时，不会把用户拉过去：标签页在那个对话**下次显示时**打开。

### 为什么不用 better-sidebar 的 `sidebar_open`

`sidebar_open` 只能打开文件、文件夹或网页。拿它打开工作台链接，会落进侧栏浏览器的沙箱 iframe，没有存盘、租约这些标签页行为。`film_studio_open` 用的是宿主侧栏自己的 `openTab`，打开的是真正的工作台标签页。

## 2. 媒体画廊多选"加入画布"

- 画廊（`@vibedev-si/dsh-media-viewer` 0.1.4）：「多选」→ 点选 / Shift 连选 / 全选 → 「加入画布（N）」。网页文件不能加入，多选时置灰。
- 两个插件只靠一个页面事件联系：`window` 上的 `vibedev-film:add-media`，`detail = { paths, sessionId, respond }`。工作台收到后同步把 `detail.accepted` 设为 `true`；画廊发现仍为 `false`，就提示"请先安装并启用影视工作台"。
- 工作台：优先找同一对话里打开着的画布，没有就先在这个对话里打开工作台（最多等 45 秒）。
- 文件由工作台服务端直接复制进 `assets/<节点id>/`（与画布"上传"同一位置，大视频不经过浏览器内存）；已经在项目里的文件直接引用、不复制。复制完在当前视口中央排成网格节点，整批是一次撤销，然后立即写盘。

## 验证

| 项 | 结果 |
| --- | --- |
| `npm test`（插件） | 10 文件通过 / 1 跳过；**57 通过 / 1 跳过** |
| 新增：导入媒体 | 外部图片复制进 `assets/<节点id>/` 且内容一致；项目内文件直接引用；网页被拒 |
| 新增：控制令牌 | 页面会话访问 `/api/film/agent/tools` → 403；宿主拿到操作列表，不含 `runAgent` 与重复的通用工具 |
| 新增：页面控制往返 | 页面凭会话连上控制通道 → `getAppState` 列出这个页面 → `switchPanel` 下发到页面、页面回结果、agent 拿到结果 |
| 新增：打开请求推送 | 等待中的页面立即收到；页面重连前的请求保留到下次轮询且不重复；超时、取消、卸载时都正常结束 |
| 画廊 `npm test` | 原有路由与主题测试 + 4 项"加入画布"事件约定 |

# 影视项目放在哪：工作区下的 VibeDev Film 文件夹

产品要求：VibeDev 的对话已经指定了工作区，从侧栏打开影视工作台时**直接进入这个工作区的画布**，不再要求用户另找一个空文件夹。
工作区经常是一个正在用的目录（代码仓库、资料文件夹），所以项目放在工作区下的**专属文件夹**里：工作区根目录除了这个文件夹，不会多出任何东西。
用户也可能自己建过同名但不是我们内容的文件夹或文件，下面的规则同时兼容这些情况。

实现位置（都已落地，本文描述与代码一致）：

| 环节 | 位置 |
|---|---|
| 标签页拿到会话工作区 | 插件 `src/client/TabBody.tsx`：`useSessions(s => s.byId[sessionId]?.cwd)`（与宿主"文件"侧栏同一取法），连同标签页 id（租约）发给 `POST /api/dsh-film-studio/open` |
| 工作区放进链接 | 插件 `src/runtime.ts` 的 `open(query, lease)`：链接按每次调用生成，形如 `/s/<token>/?filmWorkspace=<绝对路径>&filmHost=<宿主源>`；不同标签页互不串用 |
| 入口改写 | fork `apps/web/src/main.ts`：`?filmWorkspace=` → `#/film/open?workspace=…`，并预取画布模块 |
| 打开/新建项目 | fork `apps/server/src/routes/workspaces/filmPrepare.ts`（`POST /api/workspaces/film/prepare`） |
| 进入画布 | fork `apps/web/src/pages/film/opening.vue` |
| 项目中心 | fork `apps/server/src/routes/workspaces/filmProjects.ts`（`POST /api/workspaces/film/projects`）+ `apps/web/src/pages/home/index.vue` |

## 我们的结构

- 项目文件夹：默认 `VibeDev Film`（新建时可以起别的名字），里面是：
  - `.vibedev-film.json` —— 标记，`{ schema: 1, app: "vibedev-film-studio", createdAt }`；
  - `画布1.json` —— 第一张空画布 `{ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }`。
- "是我们的"只认**标记**或**有效画布**（能解析出 `toonflowCanvas: true` 且有 `nodes`/`edges` 数组）；名字相同不算。
- 运行时目录（`assets/`、`.agent/` 等）由应用按需创建，不在这一步预建。

## 判定顺序（打开当前工作区的项目）

设 `W` = 会话工作区，`P` = `W/VibeDev Film`。

0. 这个工作区上次打开的项目还在、还在 `W` 里、还是我们的 → 直接回到它。
1. **老项目**：`W` 根目录本身就有有效画布或我们的标记（以前直接建在根目录的）→ `W` 就是项目，不再建子文件夹。
2. `P` **不存在** → 新建 `P`，写标记与 `画布1.json`。
3. `P` **是我们的** → 复用，不改动任何内容。
4. `P` **是空文件夹**（系统生成的 `desktop.ini`、`Thumbs.db`、`.DS_Store` 不算内容）→ 接管，写标记与 `画布1.json`。
5. `P` **存在但不是我们的**（别人的文件夹，或一个同名文件）→ **一个字都不动**，依次试 `VibeDev Film (2)`、`(3)`…，用第一个可用的；界面一行提示，不报错。

新建项目：同样的规则，只是文件夹名换成用户起的名字（只能是一层合法文件夹名）；同名的已经是影视项目就直接打开它。
导入项目：用户选的文件夹本身是影视项目就直接打开；否则把它当作工作区，按上面的规则在里面打开/新建。

## 不允许的行为

- 不因为工作区非空而报错，或要求用户先选一个空文件夹；
- 不覆盖、不合并、不删除、不重命名用户既有的任何文件或文件夹；
- 不往工作区根目录写任何文件（老项目本来就在根目录的除外，那是复用）；
- 同名但不是我们的不当作错误，只提示。

## 项目中心

这台电脑上的全部影视项目，按路径去重：

- 宿主登记的每一个 VibeDev 工作区（`workspaceRegistry.list()`，经插件的私有桥 `GET /workspaces` 提供）：工作区下的 `VibeDev Film`、`VibeDev Film (N)`，以及根目录老项目；
- 手动导入的项目（页面记住，放在 VibeDev 工作区之外的）；
- 桌面版 ToonFlow 的项目列表（`%LOCALAPPDATA%/local.toonflow.desktop/<通道>/data/settings.json`），方便迁移。

只读，不创建也不修改文件。画布顶栏的"项目中心"按钮回到这里，不弹确认，离开工作区时照常存盘。

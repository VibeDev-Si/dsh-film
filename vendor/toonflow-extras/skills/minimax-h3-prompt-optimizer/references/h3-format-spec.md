# MiniMax H3 官方格式规范与词表

整合自 MiniMax H3 官方手册、官方提示词指南及社区实测。正文叙述用中文写（H3 的 Qwen3-VL 32B 编码器原生支持中英双语，中文稳定可读）；仅字段名、镜头结构、运镜动词、保留词、说话人标签等格式元素保留英文；台词、歌词、屏幕文字保留原语言（用英文双引号引住）。

## 模型规格速查

| 项 | 值 |
|---|---|
| 模型 | 33B dense single-stream Omni Transformer（API ID: MiniMax-H3，即 Hailuo 3.0） |
| 分辨率 | 768P 或 2K（2K = 短边 1440px，如 2560×1440）。无 1080P 档、无 4K |
| 时长 | 4–15 整数秒，默认 5（部分平台下限 5） |
| 帧率 / 音频 | 24fps 固定；音频 32kHz 立体声，与画面同一遍生成 |
| 画幅 | adaptive、21:9、16:9、4:3、1:1、3:4、9:16；纯文生必须给具体比例 |
| 参考上限 | 9 图 + 3 视频 + 3 音频，单次最多 12 个文件；音频不能是唯一参考 |
| 模式互斥 | I2VA 与 reference 模式互斥；FL2VA 只用两图锚点 |
| 音频语言 | 稳定支持 11 种：中、英、法、德、意、日、韩、葡、俄、西、阿拉伯 |
| 提示词上限 | 7000 字符/条 |
| 参数面 | 提示词层无 seed、无 negative prompt、无 guidance/step（CFG-distilled），散文否定有效；本地 ComfyUI 工作流的 seed/采样器/LoRA 等属节点级参数，不进提示词正文 |

## Base 三字段格式

```
integrated_multimodal_description: [Shot 1] 风格与初始构图。主体外貌/位置/动作/运镜。说话人 (S1) 与 <d>[语言] 台词</d>。[Shot 2] At 00:SS.mmm, 镜头切到新信息。
overall_soundscape: 环境声、物理动作声、非语言人声。
non_diegetic_music: 乐器、节奏、动态变化，或 N/A。
```

### 各 Base 任务首行对齐指令（句式保留英文，含义用中文说明）

- **T2VA**：无对齐行，直接开始。
- **I2VA**：首行 `For the target video, at 0.00 seconds, <Picture 1> from [Shot 1] is fully referenced.`（目标视频 0.00 秒完全参考 <Picture 1>）——锚定风格/身份/服装/构图/空间后写连续发展。
- **FL2VA**：`Picture 1 from [Shot 1] aligns to 0.00 seconds; Picture 2 from the actual final [Shot N] aligns to the exact S.SS-second end time.`（首帧对 0 秒、尾帧对精确结束时间）——写两帧间姿势/物体状态/构图/光照/运镜的可见变化路径。
- **L2VA**：`<Picture 1> from the actual final [Shot N] aligns to the exact S.SS-second end time.`（仅终帧锚定）——推断合理前态，一切变化收敛到终帧。

## Full-Reference 六字段格式

按顺序写完整六个 section，删掉不用的标签但**不删 required section**。

```
subject_definitions:
<Subject 1> 是 [可复用视觉内容]，来自 <Picture 1>，保留 [身份特征]。
<Video 1> 承担 [编辑/延续/结构角色]（如适用）。
<Audio 1> 为 <Subject 1> (S1) 提供 [copy/reference 角色]（如适用）。

summary:
[任务类型标签 + 主要参考关系，一段话]

retention_analysis:
[每个视觉/音频参考如何被保留/迁移/复制/松散跟随]

detailed_description:
[逐镜头按播放顺序；在参考标签生效处插入 <Subject N>/<Picture N>/<Video N>/<Audio N>]

overall_soundscape:
[环境声与物理动作声，含音频复制/参考关系]

non_diegetic_music:
[配乐及与参考音频的关系，或 N/A]
```

### 参考标签语义

| 标签 | 含义 |
|---|---|
| `<Subject N>` | 从资产中提取的可复用内容单位：人、物、场景、服装、道具、界面、风格、动作、姿势、效果。描述的是"用进目标片的内容"，不是上传文件本身 |
| `<Picture N>` | 图片本身作为具体首帧/关键帧/尾帧/编辑关键帧/构图锚点/分镜方案 |
| `<Video N>` | 源视频整体被直接编辑/延续，或提供全局镜头/剪辑/节奏/计时结构；**也可承担纯动作/姿态迁移角色**（见下方"动作迁移句式"） |
| `<Audio N>` | 被积极使用的音频信号：整段/部分复制，或参考音色/音乐/词/效果/节拍/节奏/连贯性 |

判定规则：
- 图片只定义角色/产品/场景/服装/风格 → 在 Subject 定义里引图，不单列 Picture。
- 只有图片本身锚定某帧或提供明确分镜/构图时才单列 Picture。
- 视频承担整体结构角色（编辑/延续/剪辑结构/运镜路径/节奏/计时）才单列 Video。
- 音频有主动复制/参考角色才定义；视频带声不等于要 Audio 标签。
- 一个 Subject 可同时组合：图给外观 + 视频给动作 + 音频给音色，逐个说明来源贡献。

### 动作迁移句式（外观与动作分离）

姿态控制无独立参数，全靠参考语义。**身份取图、动作取视频**，reference 模式显式声明（句式保留英文）：

```
Use Image 1 for the subject's appearance and identity.
Use Video 1 for the body movement only.
The subject from Image 1 performs the same movement as Video 1,
in a plain studio with soft even lighting, full body in frame.
```

- 不写"body movement only"，H3 可能把参考视频的角色外观一起搬来。
- `retention_analysis` 用 `attribute_transfer` 声明动作迁移：`Video 1 的身体动作、节奏与走位被 attribute_transfer 到 <Subject 1>，保留表演时序但不复制画面。`（语义级跟随，非骨骼级锁定；骨骼级走工作流 Fun ControlNet）
- 旋转/复杂运镜锁不住背景时，在提示词内声明中间帧锚定：`At 00:05.000, the composition aligns to <Picture 2>.` 时间戳递增、不超总时长。

### 任务类型标签（summary 用，可 + 组合）

`keyframe completion`（图是精确帧锚点）/ `reference generation`（资产引导但不直接编辑延续）/ `video editing`（源视频被直接修改）/ `video continuation`（从源视频续写扩展）/ `audio reuse`（整段/部分复制同一音频信号）/ `audio reference`（只跟音色/词/节拍不复制）。

### 保留词表（retention_analysis）

视觉：`fully_preserved`（列具体不变特征）/ `partially_preserved`（写明改了哪部分）/ `attribute_transfer`（迁移动作/风格/姿势/构图/效果到不同目标主体）/ `weak_reference`（仅类别/氛围/构图家族相似）。
音频：`fully_copy`（整段复制为最终轨）/ `partially_copy`（复制部分时间范围或层，或增删改替换）/ `reference`（跟音色/节拍/音乐风格/词/质感，不复制信号）/ `weak_reference`。

## 运镜词表（写进句子，不用括号）

| 意图 | 词汇 | 变化 |
|---|---|---|
| 变焦（机身不动） | Zoom In / Zoom Out | 焦距变化 |
| 纵深移动 | Push In / Pull Out | 机身向主体靠近/远离 |
| 水平移动 | Truck Left / Truck Right | 机身整体横移 |
| 垂直移动 | Pedestal Up / Pedestal Down | 机身升降 |
| 原地旋转 | Pan Left / Pan Right / Tilt Up / Tilt Down | 机身不动、镜头水平/垂直旋转 |
| 环绕 | Arc Shot | 沿曲线路径绕主体 |
| 跟随 | Tracking Shot | 随运动主体并保持关系 |
| 主观视角 | POV | 采用主体所见 |
| 轴向旋转 | Roll Clockwise / Roll Counterclockwise | 绕镜头轴旋转 |
| 不稳定 | Shake Slightly / Shake Strongly | 受控抖动 |
| 静止 | Static Shot | 位置与镜头不动（H3 默认漂移，锁帧必写） |

幅度：`with small amplitude`（克制、保构图）/ `with large amplitude`（揭示更多空间或重构构图）/ 中幅省略。
速度：`at slow speed`（缓慢、有时间检查细节）/ `at fast speed`（快速揭示或有力过渡）/ 常速省略。

## 说话人与对白标签

- 说话人按发声顺序编号 (S1)、(S2)、…，后续镜头复用同一 ID。
- 说话人身份、语气、动作写在标签外。
- `<d>` 内只放语言标签 + 精确原文，如 `<d>[Chinese] 别怕，我不碰你。</d>`。
- V.O.：声明 off-screen，可见角色嘴唇闭合。
- `<scenetrans>`：一句话跨镜头延续时用；`<cutoff>`：视频在中段截断时用。
- 多角色共说：`(S1,S2)`。
- 屏幕文字：英文双引号引住原文，不翻译不改写，如 `红色霓虹灯牌写着 "OPEN"`。

## 常见失败模式（官方手册点名的）

1. 所有内容揉成一团无分段段落——三块/六块结构必拆。
2. 提示词过短（纯文生低于"外貌+场景+动作+风格"下限）。
3. 抽象隐喻词替代画面直述（写"都市忧郁氛围"不如写"雨夜霓虹在她皮衣上的反光"）。
4. 屏幕文字要求与画面不符或要求翻译。
5. 要配乐又写 `non_diegetic_music: N/A`（自相矛盾）。
6. 描述结局先于开始（打乱时间轴）。

---
name: minimax-h3-prompt-optimizer
description: >-
  MiniMax H3（Hailuo 3.0）视频提示词的写作、优化与质检。把一份短剧分镜/参考生成提示词（summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music 等）改写成 H3 能稳定读取的高质量提示词，或从零起草。适用场景：写一条 H3 的 T2VA/I2VA/FL2VA/L2VA 提示词；把已有分镜脚本转成 H3 官方格式；优化动作/表情/运镜/音频描述（动作物理化、表情变化链、运镜类型+幅度+速度自然语句、说话人 (S1) 绑定、声音三层分离、prose negation 负面约束）；**口型对准专项：台词进 &lt;d&gt; 引号、一句一镜、Closing Beat 收尾动作、无对白锁嘴、音频参考修剪与时长匹配**；诊断"生成出来动作不对/表情僵硬/口型乱/口型漂移/声音变画外音/角色漂移/镜头切错"等 H3 失败问题。配合 ComfyUI MiniMax H3 工作流、MiniMax 平台、fal 或 Hailuo AI 使用。只要任务出现"MiniMax H3 / H3 提示词 / Hailuo 03 / 导演台提示词 / reference generation / retention_analysis / non_diegetic_music / overall_soundscape / 口型 / 对嘴 / lip sync"等任意一项即触发。
license: 内部方法论，整合自 MiniMax H3 官方手册、官方提示词指南与社区（fal / Pixo / minimaxh3.co / X 创作者）实测经验。
---

# MiniMax H3 提示词写作与优化手册

把短剧分镜或一段参考生成提示词，改写成 H3 能稳定读取、动作表情到位、音画可控的高质量提示词。H3 是 33B 全模态 Omni Transformer：同一遍扩散同时出 768P/2K 视频 + 32kHz 立体声音频，24fps，单条 4–15 秒，正文上限 7000 字符。**提示词层无 seed、无 negative prompt 参数（官方平台 API 与参考模式均如此，用散文式否定代替）；本地 ComfyUI 导演台工作流另有 seed/采样器/LoRA 等节点级参数，属工作流层，不进提示词正文。**

## 核心矛盾

H3 是"按提示词字面执行的时间线生成器"：它把提示词当**时间轴**读，按顺序生成；没有见过的括号指令会失效；写抽象情绪词等于把表演交给模型猜。所有规则都从这一点出发：**把抽象意图翻译成模型可执行的物理/镜头/声音指令，并写进正确的位置。**

## 语言策略（中文优先）

H3 的文本编码器（Qwen3-VL 32B）原生支持中英双语，正文用中文写完全可读，稳定性和英文一致。统一规则：

- **叙述语言用中文**：风格、主体、环境、动作、表情、运镜意图、配乐描述全部用中文写。
- **格式元素保留英文**（这是 H3 的格式标识，不能翻译）：字段名（`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music` / `subject_definitions` / `summary` / `retention_analysis` / `detailed_description`）、镜头结构（`[Shot 1]`、`[Shot N] At MM:SS.mmm`）、运镜动词（Push In / Truck Left / Arc Shot / Static Shot 等）、保留词（fully_preserved / partially_preserved / attribute_transfer / weak_reference / fully_copy / reference 等）、说话人标签（(S1)/(S2)）、`<d>[语言]`、`<scenetrans>`、`<cutoff>`。
- **固定指令句式保留英文**（官方/社区验证过 H3 稳定识别的整句指令，与字段名同类，不算违反中文优先）：对齐行（`For the target video, at 0.00 seconds, <Picture 1> from [Shot 1] is fully referenced.` 等四类）、动作迁移句（`Use Image 1 for the subject's appearance and identity. Use Video 1 for the body movement only.`）。中文注释跟在英文句后，正文其余叙述仍用中文。
- **台词、歌词、屏幕文字保留原语言**，用英文双引号引住：`(S1)：<d>[Chinese] 别怕，我不碰你。</d>`、`灯牌写着 "OPEN"`。
- 量级：中文叙述按 350–500 字量级，英文按 350–500 词，不超 7000 字符。

## 先分任务类型，再选格式

| 任务 | 结构 | 判断依据 |
|---|---|---|
| Base：T2VA / I2VA / FL2VA / L2VA | 三字段：`integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music` | 图只作首帧/尾帧锚点，不定义可复用主体 |
| Full-Reference：reference generation 等 | 六字段：`subject_definitions` + `summary` + `retention_analysis` + `detailed_description` + `overall_soundscape` + `non_diegetic_music` | 上传资产用于复用/迁移身份、场景、风格、动作、音频 |

Base 三字段格式：

```
integrated_multimodal_description: [Shot 1] 风格与初始构图。主体身份、位置、动作、运镜。说话人 (S1) 与 <d>[语言] 台词</d>。[Shot 2] At 00:SS.mmm, 镜头切到新信息。
overall_soundscape: 环境声、物理动作声、非语言人声。
non_diegetic_music: 配乐的乐器、节奏、动态变化，或 N/A。
```

Full-Reference 六字段格式（重点优化对象，用户现有格式缺 `subject_definitions`）：

```
subject_definitions: <Subject 1> 是 [可复用视觉内容]，来自 <Picture 1>，保留 [身份特征]。
summary: 任务类型 + 主要参考关系，一段话。
retention_analysis: 每个参考如何被保留/迁移/复制/松散跟随。
detailed_description: 逐镜头按播放顺序写，插入参考标签生效点。350–500 英文词为典型量。
overall_soundscape: 环境声 + 物理动作声（含音频复制/参考关系）。
non_diegetic_music: 配乐及与参考音频的关系，或 N/A。
```

## 五条贯穿硬规则（每条都违反必出问题）

1. **运镜写成自然语言动作，不用括号指令。** Hailuo 02 时代的 `[Push in]` 在 H3 失效。运镜 = 类型 + 幅度 + 速度，用中文叙述但运镜动词保留英文词表：`镜头以小幅、慢速向她的上半身推近（Push In）`。幅度：`小幅`/`大幅`（中幅省略）；速度：`慢速`/`快速`（常速省略）。类型词表见 `references/h3-format-spec.md`。想锁死画面必须写 `镜头固定（Static Shot）`——H3 默认会漂移。

2. **时间是硬结构。** `[Shot 1]` 不写时间戳；后续每个镜头写 `[Shot N] At MM:SS.mmm`，严格递增、不超出总时长。切镜必须带来新信息（新主体/空间/状态/视点/时间）；只变距离或角度时用运镜代替切镜。动作按发生顺序写，别倒叙（模型会按提示词排序生成）。

3. **抽象情绪/动作必须物理化。** AI 渲染不了"引诱""暧昧""悲伤"，要写成可观测的物理表现 + 变化链：目光焦点与停留、眼睑开合、嘴角弧度变化、呼吸、手部微动作、重心与肩线。非说话角色也要给情绪指令，否则变雕像。对照表见 `references/action-expression-playbook.md`。

4. **说话人用 (S1)/(S2) 绑定，台词放 <d> 标签。** 说话人身份、音色、动作写在标签外；`<d>` 内只放语言标签 + 原词。跨镜头续说用 `<scenetrans>`，视频中途被截断用 `<cutoff>`。V.O. 必须声明 off-screen 且可见角色嘴唇闭合。**无对白场景必须显式写"无台词、嘴闭合"**，否则 H3 默认让人物开口。

5. **声音写进三层，各归其位。** 镜头同步声（门响、杯碰、现场台词）写进时间线正文；环境声与物理动作声汇总到 `overall_soundscape`；配乐写 `non_diegetic_music`（用乐器+节奏+动态描述，不用抽象情绪词）。不要重复，不要互相矛盾（要了配乐又写 N/A 是官方列出的失败模式）。

6. **机位用空间关系写，不写抽象电影术语。** 写清"机位在哪、朝哪拍、主体面朝哪、背景是什么"四要素之一二即可（社区短剧方法论通用）。例如 `机位在她四分之三侧前方、齐胸高度，她面朝镜头，背景是露台栏杆与城市灯火`——比"正反打""过肩拍"更不会被误读。背景是验证机位对错的锚点：转机位后背景应随之变化，否则模型会画串。

## 口型对准专项（lip-sync）

H3 音画同遍生成，口型天生比"后期配音"类模型准，但长台词/快语速/多人重叠会崩。**在生成层把口型喂对，能解决 80% 的口型问题，零成本**：

1. **台词必须写进提示词引号内。** 台词放 `<d>` 且绑说话人 (S1)，H3 会"边说边动嘴"；台词不在提示词里 = 声音变画外音、嘴不会动。
2. **一句一镜，长句拆开。** 每个镜头最多一句台词（`<d>` 内一句）；超过一句就拆成多个镜头/多个 quote，别写一整段长台词——长句是口型漂移的第一诱因。
3. **台词结束给 Closing Beat（收尾动作）。** 说完后接一个视觉动作（转头看别处、放下杯子、垂眼），否则嘴会在台词结束后继续动。写法：`说完后她垂下目光，嘴唇闭合，看向画外。`
4. **无对白场景必须显式锁嘴。** 写"无台词，嘴唇全程闭合"，H3 默认会让人物开口。
5. **音频参考锁音色+音素（最多 3 条）。** 喂干净人声录音（`<Audio N>` + reference 标签），生成角色用那个声音说话，音素和嘴形天然对齐。
6. **修剪参考音频到目标片段、时长匹配视频。** 起止各留一点静默余量；修剪后音频长度与视频时长匹配，生成器靠它对齐音素与嘴形。
7. **声音描述符控制节奏。** 写清语气/节奏（"低沉地、缓慢地说"），影响发音的节奏感，间接稳口型。
8. **构图比时长重要（对白戏必读）。** 口型精度与景别强相关：中近景/特写时口型读得准，远景/大全景或主体很小时不值得赌口型。写对白戏优先给中近景；口型是重头戏的镜头，别把主体放很远。

## 姿态与动作控制（pose & motion）

H3 提示词层没有独立姿态参数，姿态控制全部发生在**参考资产 + 提示词语义**层；骨骼级硬控制（DWPose/Fun ControlNet）属工作流节点操作，不在本 skill 范围（需要时在 ComfyUI 里做，提示词里不用写）。提示词层只需写对两件事：**动作从哪来、怎么声明迁移**。

1. **动作迁移句式（外观与动作分离）。** Reference 模式下，身份取图、动作取视频：`Use Image 1 for the subject's appearance and identity. Use Video 1 for the body movement only. The subject from Image 1 performs the same movement as Video 1.` 图给外貌，视频只给动作——不写这句，H3 会把参考视频的角色外观一起搬过来。
2. **`attribute_transfer` 声明动作迁移。** `retention_analysis` 里写动作迁移用 `attribute_transfer`：`Video 1 的身体动作、节奏与走位被 attribute_transfer 到 <Subject 1>，保留表演时序但不复制画面。` 这是语义级跟随（动作大方向可控）；如需骨骼级锁定，提示词层做不到，请走工作流层 Fun ControlNet（节点操作）。
3. **每个动作说清"谁、做什么、幅度、速度、结束态"。** 姿态控制提示词同样吃"类型+幅度+速度+结束状态"：`她以小幅、慢速转身，停住时四分之三侧脸朝镜头，目光落向画外。`
4. **复杂运镜/旋转机位加中间帧锚定。** 旋转运镜时单张背景参考锁不住地面朝向（社区实测），在提示词里显式声明中间帧生效点：`At 00:05.000, the composition aligns to <Picture 2>.` 时间戳递增、不超总时长。
5. **多角色同框逐个给动作指令。** 姿态会互相污染，群戏里给每个入画角色独立的动作句，别只描述主角。

## 每类任务的写作要点

- **T2VA**：无对齐行，`[Shot 1]` 开头写风格 + 初始构图 + 主体外貌位置 + 环境光照 + 第一个动作。纯文本下限：主体外貌 + 场景细节 + 动作 + 风格，缺一层都会劣化。
- **I2VA**：首行写 `For the target video, at 0.00 seconds, <Picture 1> from [Shot 1] is fully referenced.`（目标视频 0.00 秒完全参考 <Picture 1>）——把风格/身份/服装/构图/空间锚定到图，再写连续发展。
- **FL2VA**：`Picture 1 from [Shot 1] aligns to 0.00 seconds; Picture 2 from the actual final [Shot N] aligns to the exact S.SS-second end time.`（首帧对 0 秒、尾帧对精确结束时间）——写两张锚点之间可观测的姿势/物体状态/构图/光照/运镜路径。
- **L2VA**：`<Picture 1> from the actual final [Shot N] aligns to the exact S.SS-second end time.`（仅终帧锚定）——推断合理前态，让一切变化收敛到终帧。
- **reference generation**：先 `subject_definitions` 定义每个 `<Subject N>`（人/物/场景/服装/道具/风格/动作/姿势/效果）及其来源资产，再 `summary` 标注任务类型（reference generation + 其他，用 + 组合），`retention_analysis` 用保留词表，最后 `detailed_description` 逐镜头插入标签生效点。

## 保留词表（retention_analysis 专用）

视觉：`fully_preserved`（列具体不变特征）/ `partially_preserved`（写明改了哪部分）/ `attribute_transfer`（迁移动作/风格/姿势/构图）/ `weak_reference`（仅类别级相似）。音频：`fully_copy` / `partially_copy` / `reference`（跟音色/节拍/风格不复制信号）/ `weak_reference`。

## 负面约束（prose negation）

H3 无 negative prompt 参数，但散文式否定很有效。在 detailed_description 末尾或独立一行用中文写：`无溶解转场、无流体形变。不要出现多余的中文文字、乱码或错别字。整片保持她右手里的香槟杯和金色刺绣不变。` 逐条自问：AI 最可能多画什么/少画什么/动哪个道具/改哪件衣服。

三类必锁：
- **台词提到的物品 ≠ 画面物品。** 台词里说"我记得那把枪"，但画面不该出现枪——显式排除：`对话中提到枪，但画面上不出现任何枪支。`
- **不想要的配乐必须显式说"无配乐"**（官方失败模式：没写想要的音乐却冒出来音乐）。要配乐就写清乐器+节奏+动态，不要又写 `non_diegetic_music: N/A`。
- **不该出现的角色/人群**：`镜头内不出现任何其他人，只有她一人。`

## 常见失败诊断

| 现象 | 原因与修复 |
|---|---|
| 动作不对/顺序乱 | 动作没按时间写、一个镜头塞了多个主变化。拆成逐镜头逐 beat，每镜头一个主变化 + 结束状态 |
| 表情僵硬/雕像 | 抽象情绪词未物理化、非说话角色没给情绪。补目光/眼睑/嘴角/呼吸/手部微动作 |
| 口型乱动/漂移 | 无对白没写嘴闭合、对白没绑 (S1)、台词没放 <d>；长句未拆镜；台词后没给 Closing Beat。见"口型对准专项" |
| 声音变画外音、嘴不动 | 台词没写进提示词引号内；或用了不匹配的加速 LoRA。台词必须进 `<d>`；加速 LoRA 优先选口型适配版（如 drbaph INT8） |
| 角色漂移/换装 | reference 标签语义不稳、retention 没列具体特征、服装状态变化未声明 |
| 镜头乱切/变幻灯片 | 时间戳缺失或没递增、把距离变化写成切镜。用运镜代替，`[Shot N] At MM:SS.mmm` 递增 |
| 想要锁帧结果在动 | 没写"镜头固定（Static Shot）" |
| 音乐不对 | 用抽象词写配乐、或 audio 字段互相矛盾。写乐器+节奏+动态，或 N/A |

## 写完自检清单（交付前逐项过）

- [ ] 任务类型判断正确，用了对应格式（Base 三字段 / Full-Reference 六字段）？
- [ ] reference generation 类是否补齐了 `subject_definitions`？
- [ ] 运镜是"类型+幅度+速度"自然语句，没有括号指令；想锁帧写了 `holds a static shot`；**机位写了空间关系（机位在哪/朝哪拍/主体面朝哪/背景是什么）**？
- [ ] `[Shot 1]` 无时间戳，后续镜头时间戳严格递增不超总时长？
- [ ] 所有动作按时间顺序，每个镜头一个主变化 + 结束状态？
- [ ] 表情/情绪全部物理化，非说话角色有情绪指令？
- [ ] 台词在 <d> 内且绑了 (S1)；无对白场景显式写了嘴闭合；**每镜最多一句台词，长句已拆镜；台词后有 Closing Beat（收尾动作）；有音频参考时已修剪时长并匹配视频**（口型专项）？
- [ ] **姿态/动作：外观与动作已分离声明（Image 外观 / Video 动作）；动作迁移用了 attribute_transfer；每个动作含幅度/速度/结束态；复杂运镜声明了中间帧锚定**（姿态专项）？
- [ ] 声音三层各归其位：同步声在时间线、环境声在 soundscape、配乐在 music？
- [ ] 屏幕文字用英文双引号引住原文，未翻译？
- [ ] prose negation 锁了：道具/服装/多余文字/过渡方式/口型；**台词提到的物品已确认画面不出现在画面中**？
- [ ] 正文叙述用中文写（仅字段名/运镜动词/保留词/时间戳等格式元素保留英文）；长度在 350–500 词量级、不超 7000 字符？
- [ ] 终极标准：**逐镜头脑补一遍，每个镜头都能看到画面、听到声音、知道镜头怎么动？**

深挖读 `references/h3-format-spec.md`（完整格式规范与词表）、`references/action-expression-playbook.md`（动作/表情/运镜细化对照表）、`references/short-drama-templates.md`（短剧常用分镜模板）。

# 视频生成质量审查（2026-10-08）

> **范围更正（同日追加）**：本文最初同时检查普通项目与 importStudio 导入试制入口。59、61 的 Picture 错绑只证明导入/人工参考顺序入口的缺陷，不能作为普通项目“重生三天，我囤爆整个海洋”视频质量差的主因。用户要求按 `http://localhost:50188/#/project` 的正常流程审查后，已另写 [普通项目视频审查](D:/Toonflow-app-master/docs/project-flow-audit-2026-10-08-video.md)。普通项目 16、17、24 的冻结参考计划与真实提交文件逐槽 SHA256 全部一致，且英文语言快照等于 MP4 内嵌提交 prompt；普通项目结论以新报告为准。本文保留用于其他入口缺陷复核。

## 审查范围与证据

本次只读审查 `data/db2.sqlite`（SQLite `mode=ro`）、源码、现存本地视频、ComfyUI GET 接口；没有提交生成任务，没有修改业务代码、模型、提示词、资产选择或数据库。只新增本报告和抽帧证据。未发现工作区根、src、D 盘根的 AGENTS.md。现存 Git 修改已保留。

查看主项目 3 个成功视频（16、17、24）和导入试制项目 3 个成功视频（59、61、62）。主项目没有已选 `videoId/selectVideoId`，这些是成功候选，不能称为用户已验收视频。抽帧是空间、动作、风格审查，尚未听辨音轨，不给对白准确率或口型同步通过结论。

证据目录：`docs/quality-audit-2026-10-08-media/`。

- `h3-reference-order-evidence.json`：59、61 的保存参考计划、提交 prompt、完整 MP4 内嵌 Comfy 图、每张真实上传图片的 SHA256，以及其对应原资产。
- `video-{16,17,24,59,61,62}-frames.jpg`：每片 7 个均匀时间样本，按行从左至右。最后黑格是拼图未填满，不是视频黑帧。
- `video-{59,61,62}-end.jpg`：分别为约 6.463、7.88、5.047 秒的尾帧。
- `video-*-evidence.json`：抽帧对应视频元数据与 prompt。主项目实际使用 en-US 语言快照，不能用当前中文基础 prompt 解释英文视频。

## 1. 已证明的直接代码问题：保存的 Picture 顺序在供应商中再次排序

严重程度：P0。它能直接解释试制中“已经有开头参考图，仍出现爬栏/人物站位错误”等问题的一部分。

路由按冻结的 `o_h3ReferencePlan` 恢复上传顺序：

- `src/routes/production/workbench/batchGenerateVideo.ts:110–127`。
- `src/utils/h3ReferencePlan.ts:118–135` 校验当前资产集合和图片路径后，按 `plan.slots.map` 保留顺序。

但供应商 `data/vendor/comfyui_local.ts:273–277` 的 `prepareH3Config()` 又按资产类型排序，角色在场景前。`comfyVideoRequest()` 在 425 行调用它，然后 431–435 行按新顺序上传、构图。`nativeH3Graph():369–374` 把重排后的数组对应到 `ref_images.ref_image_0..N`，没有重写 prompt 中的 Picture 编号。

59、61 是已经发生的实例。两个视频的保存计划均为：

| prompt/计划中的槽位 | 保存源 | assetId | 实际提交给 H3 的图片 |
|---|---|---:|---|
| Picture 1 | Ava 已悬挂栏外的开头状态锚点 | 351 | Ava 人物设计图（本应 Picture 2） |
| Picture 2 | Ava 人物设计图 | 349 | Madison 人物设计图（本应 Picture 3） |
| Picture 3 | Madison 人物设计图 | 350 | 开头状态锚点（本应 Picture 1） |
| Picture 4 | 倾斜邮轮环境 | 348 | 倾斜邮轮环境 |

这是文件级验证：MP4 的 `format.tags.prompt` 保留真实提交图；`LoadImage` 引用的文件现在仍在 `D:/new_comfyui/input`；上传文件的 SHA256 与原资产文件完全一致。因此并非依靠文件名或主观目测推断。Picture 数量仍然是 4，已有的数量、连续编号检查无法发现该错误。

影响范围：导入项目、自定义/人工顺序、将场景或关键帧放在角色前的已冻结计划均有风险。自动 prompt 写入链目前也按角色优先排序，因此该问题不能直接归因到所有老视频。

修复建议：冻结 plan 是唯一顺序权威；供应商不得按类型排序，也不得静默过滤一个已编号 Picture 后继续执行。生成 prompt 之前可以规划顺序，保存之后各层严格保序。给供应商传入每槽的稳定 slotId/assetId/hash，用相同标识编译、上传和验收图顺序。测试必须包含 `[scene-anchor, role-A, role-B, scene]`，逐图断言内容，而不仅检查张数或图字符串中是否存在 `ref_image_0`。

## 2. 实际输出仍与所要求的动作、状态不符

下表判断依据都是对应视频真实提交 prompt，而不是今天的基础 prompt 或模板。

| 视频 | 要求 | 抽帧可复核的表现 | 结论 |
|---|---|---|---|
| 主项目 16，10.125s | 一开始就是 Madison 近景，随后两个切点 5s/7s，先后掰开右手/左手 | 开头先使用完整邮轮远景，在均匀样本的约前 3 秒可见整船与小人物，随后才进入双人/手部画面 | 指定近景开场被环境建立镜头代替；切点和情节负载执行不稳定 |
| 主项目 17，6.583s | 2s 落水；4s 鲨鱼扑向有衣物覆盖的受伤腿；接触被气泡、暗影遮挡 | 同一片内同时执行落下、远景落水、水下转场、鲨鱼近距张口；样本中的姿态从直立悬挂转为水下弯膝，鲨鱼近距到达腿部 | 事件负载很高，是值得拆分测试的候选；仅凭这组稀疏帧不能判定所有接触/姿态转换错误。本片要求隐蔽接触，不能把“未清晰展示伤口”列为错误 |
| 主项目 24，9.417s | 一个连续镜头，绕人物小幅弧形移动，手机保持正在通话/读取界面 | 手机姿势基本稳定，前后样本从侧面到正面、背景也改变；这组缩略图中的手机文字不可读 | 简单读手机动作比复杂掰指稳定；是否暗中切镜、精确 UI 字样是否正确尚需逐帧原尺寸核验，不能把稀疏截图直接当成失败证据。人物原图本身接近自然比例，视频接近真实人物不能单独判定为风格错误 |
| 试制 59，6.583s | Ava 已在栏外；身体始终在甲板平面以下；明确禁止抬膝、向上爬栏 | 约 1–3s 样本明显出现抬膝、身体上移、近似爬栏动作 | 已发生的动作违背；同时有第 1 节参考错绑 |
| 试制 61，8s | Madison 逐指掰开；最后仅剩一指 | 尾帧 7.88s 仍是一只戴手套的手整掌握栏，未建立最后一指接触状态 | 规定结束状态未落实；同时有参考错绑。手部细节不是“描述得更多”即可保证 |
| 试制 62，5.167s | 延续“仅最后一指”，放手、重力下落开始，保持甲板上下关系 | 开头又回到双手强握、屈膝姿态；最后 5.047s 确实双手张开、身体下移出框 | 下坠开始已发生，不能称为整片未坠落；问题主要在与上一片结束状态不接、开头地理/受力不一致 |

试制 59/61/62 的 prompt 较短，分别约 371/364/298 个英文词，但错误仍然出现。因此“缩短所有 prompt”不是充分解法。主项目 16/17 同时承载多镜头、手指接触、重力、环境与对白，会更难执行；应该基于动作可控性划分制作单元，并明确可验证的首末状态。

## 3. 流程缺口：语义参考被当成精确首末状态控制

`videoPromptGeneration.ts:232–269`、`h3PromptContext.ts:26–41` 用资产图和 `videoDesc/duration` 构建 H3 文本事实。分镜图没有送给 H3，供应商在 `comfyui_local.ts:274–276` 再次过滤 sourceType=storyboard。这样做避免分镜图覆盖人物身份，但也丢失了分镜面板中已设计的姿势/站位。

当前 `nativeH3Graph()` 仅连接 `MiniMaxH3ReferenceToVideo` 的 `ref_images`，没有 `MiniMaxH3AddGuide`，没有独立 keyframeId/frameIdx/startState/endState。62 也没有载入 61 的尾帧或上一片视频，因此“延续最后一指”主要靠文字。导入图中虽然把 Picture 1 称为 first-frame anchor，仍是一个语义参考槽位；文字不会把它自动编译为时间轴约束。

本机 `/object_info` 确认 `MiniMaxH3AddGuide` 已安装。[Comfy 官方多帧参考模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_multiframe_reference.json)明确区分语义 refs 与带 frame_idx 的 guide。本次阅读源文件也确认独立 guide 节点有时间索引。

设计建议：参考图应有明确角色：身份、服装/材质、环境、构图/起始帧、结束帧、动作。人物整张设计图仍保留为一个 Picture，满足现有一人一张参考的规则；构图/首末帧由独立时间轴 guide 接口控制。先修排序，再尝试 guide。不能假定加 guide 就一定成功，也不能自动用错误候选尾帧继续生产；首末帧应经过人审。

## 4. 流程缺口：生成成功代表文件产出，没有质量验收

`batchGenerateVideo.ts:170–171` 在保存 MP4 后直接设“生成成功”。`src/utils/videoQuality.ts:8–24` 仅执行 ffprobe 读取宽高、fps、码率、codec、duration；ffprobe 失败还直接返回空对象。它不检查帧是否可解码、人物身份、衣服、动作实现、规定起止状态、台词正确、口型或声画连续性。

数据库目前 62 个视频记录：55 个成功、7 个失败。55 个成功中有 1 个宽度等元数据为空；不是视觉通过率 55/62。59、61 的上述严重问题仍被标“生成成功”。

`src/utils/h3SemanticReview.ts` 定义了审查指令/解析器，但 `rg` 在 `src/` 找不到运行调用者。`videoPromptGeneration.ts:310–321` 实际执行的是结构、引用绑定、语言检查。`checkVideoPrompt.ts:19–30` 只是轮询数据库状态，并非语义质量审查。这一工具存在和对应测试通过不能等同于生产链已执行审查。

建议：文件产出与画面验收分开。自动检查仅承担可证实的基础项（解码、黑帧、重复帧、目标时长、首末关键帧等）；AI 图像/音频审查给出带时间码证据的候选问题，人明确选择通过/退回。保留已完成视频历史。先选 3–5 个代表片形成验收集，才能判断改动有没有改善。

## 5. 质量参数与可重复实验

本机运行核验：8188 在线，8189 未监听；ComfyUI 0.39.2，RTX 5090 D；queue running=0/pending=0，本次 history 为空。因此实际老任务以 MP4 内嵌图为证据。

6 个抽查视频的内嵌图均为：

- Ref2VA `minimax_h3_ref2va_pruned_int8_convrot.safetensors`。
- 文本编码器 `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`，视频 VAE fp16、音频 VAE fp32。
- 1344×768、24fps、20 步 `res_multistep` + `simple`。
- `ref_image_size=match`，没有 LoRA 节点。低质量不能归因于启用了 Turbo。
- 不同随机 seed。当前 `comfyui_local.ts:359` 总是 Math.random，UI/VideoConfig 没有稳定 seed 可供一次只变一个变量。MP4 内嵌 seed 仍可还原老实验。

现在的角色图整体较大：主项目上传长板 3328×1248，被 match 按目标像素面积缩到约 1664×608。每个约 832 宽的面板只余约 400 宽，人物脸在全身面板中更小。试制 Ava 1122×1402 也整体缩小。这是节点源码的确定行为，不代表已经证明它是所有脸变差的主因。

[Comfy 官方节点源码](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py)与本机源码 `nodes_minimax_h3.py:300–312` 明确采用 match 像素面积缩放；max 保留至 2048 短边，并说明会慢数倍。[官方节点文档](https://github.com/Comfy-Org/docs/blob/main/built-in-nodes/MiniMaxH3ReferenceToVideo.mdx)提供相同语义。

固定 seed、相同图、相同 prompt，建议顺序：

1. A/B 仅修引用顺序，先验证这一个代码 bug 对 59/61 的改善。
2. A/B `match` 与 `max`，比较脸/服装细节、空间动作、显存、耗时；不拆人物整图占更多槽位。
3. A/B 20 与 25 步、simple 与 beta/normal，保持其余条件一致。[官方教程](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-native.mdx)建议增加至如 25 步以改善运动；官方 r2v 模板注释建议参考较重时比较 beta/normal。官方默认仍为 simple20，不能保证任何一个替代一定更好。
4. 最后测试首末 guide，使用已验收关键帧评估接续和重力方向。不要同时修改图、文、seed、步数和 sampler 后笼统宣布改善。

这些是候选优化实验，不是已经验证的修复结果。未运行新视频生成；对应自动测试由主审查代理执行，本分项没有重复运行测试。

## 6. 优先级

先修冻结参考顺序（已证明 bug），再完善可复核的参考 manifest/seed/质量状态。随后制作代表性单片验收集，依次对身份细节、可执行的动作拆分、关键帧控制做受控实验。当前六段 H3 prompt 结构与官方 full-reference 指南一致，不能仅凭历史笔记把六段结构本身列为 bug；模板中的大量文字规则也不能替代引用顺序和实际输出验收。

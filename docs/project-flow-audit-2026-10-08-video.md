# 普通项目视频生成流程审查（2026-10-08）

审查对象是 `http://localhost:50188/#/project` 中的普通项目“重生三天，我囤爆整个海洋”（1790665121730），进入剧本、production/workbench、生成视频的正常流程。importStudio 试制视频 59、61、62 不作为本项目根因证据。本报告只读业务源码、SQLite `mode=ro`、本地现存媒体与 ComfyUI GET；没有生成视频，没有更改业务代码、数据库、模型、资产或提示词，没有运行测试套件。

本项目现有 25 条视频记录：19 条“生成成功”、6 条“生成失败”。没有轨道写入 `videoId/selectVideoId`，因此这里检查的是成功候选，并非已经由用户选定、验收通过的视频。抽样选取 16（双人栏杆戏）、17（坠海与鲨鱼）、24（公寓电话）三种动作负载。现存视频保存了真实 ComfyUI 提交图，可与冻结参考计划、语言快照和上传文件逐一交叉核验。

## 可复核证据

- [normal-project-reference-evidence.json](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-project-reference-evidence.json)：三片冻结计划每槽的 assetId/type/path/hash、MP4 中的 LoadImage、实际上传文件 hash、真实提交 prompt、完整 graph。
- [normal-project-video-metrics.json](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-project-video-metrics.json)：时长、音视频格式、prompt 字数、Shot 指令及画面变化候选时点。
- [normal-project-duration-evidence.json](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-project-duration-evidence.json)：首两段的规划时长、实际帧数、ffprobe 时长、完整历史提交 graph/prompt。
- [video-16-frames.jpg](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/video-16-frames.jpg)、[video-17-frames.jpg](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/video-17-frames.jpg)、[video-24-frames.jpg](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/video-24-frames.jpg)：每片 7 个均匀样本，按行从左到右；最后一格黑色是未填满拼图，不是视频黑帧。
- 精确时点全尺寸图：[16 的 1 秒](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-video-16-1s.jpg)、[16 的 4.8 秒](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-video-16-4.8s.jpg)、[17 的 4.2 秒](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-video-17-4.2s.jpg)、[17 的 6.35 秒](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-video-17-6.35s.jpg)、[24 的 0.3 秒](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-video-24-0.3s.jpg)、[24 的 8.7 秒](D:/Toonflow-app-master/docs/quality-audit-2026-10-08-media/normal-video-24-8.7s.jpg)。

没有听辨音轨，故不对对白是否逐字正确、声线一致或口型同步给通过/失败结论。音轨确实存在：H.264 1344×768、24 fps；AAC 32 kHz 双声道。缩略图不可读文字不等同于生成文字错误。场景变化阈值检测只给候选，不能代替逐帧剪辑判断。

## 1. 先排除三个容易误判的原因

### 当前后端确实运行源码，供应商实际读取 data/vendor/comfyui_local.ts

10588 监听进程 PID 14676，进程命令为 Node 加载 tsx preflight/loader，入口 `--inspect src/app.ts`；50188 监听 PID 22544 是 `Toonflow-web-master/node_modules/vite/bin/vite.js --host`。当前入口不是 `data/serve/app.js` 打包服务。

[src/utils/ai.ts:128](D:/Toonflow-app-master/src/utils/ai.ts:128) 每次取 `u.vendor.getCode(id)`，经 sucrase 转 TypeScript 后在 VM 内执行；[src/utils/vendor.ts:15](D:/Toonflow-app-master/src/utils/vendor.ts:15) 的 `getCode()` 直接读 `getPath("vendor")/{id}.ts`，非 Electron 开发路径由 [getPath.ts:4](D:/Toonflow-app-master/src/utils/getPath.ts:4) 指向当前工作目录的 `data`。因此当前 ComfyUI 供应商执行的源文件是 `data/vendor/comfyui_local.ts`。该文件当次 SHA256 为 `5d706db14263258cf456f38e5f9ac41b984e018be2223778336604a32dad3386`。

`src/lib/vendor.json` 是数据库初始化/迁移种子，`scripts/vendor2json.ts` 和 `scripts/build.ts` 用于构建，不是当前视频请求优先读取的供应商正文。现有供应商 version 2.1 不满足 `fixDB.ts` 中 `<2.1` 的旧版覆盖条件。修供应商必须核验当前 TS 文件及实际请求，不应仅编辑迁移 JSON 或旧 bundle。

### 普通项目抽样参考图没有错绑

| 视频 | 保存计划与真实 H3 Picture 顺序 | 文件核验 | prompt 核验 |
|---|---|---|---|
| 16 | 202 Ava 雨夜坠海 → 205 Madison 雨夜弃船 → 5 倾斜邮轮 | 3 槽均 byte SHA256 一致 | en-US 快照完全等于 graph node5 prompt |
| 17 | 202 Ava → 5 倾斜邮轮 → 6 水下 → 215 咬腿剪影帧 | 4 槽均一致 | 完全一致 |
| 24 | 204 Ava 清晨便服 → 7 艾娃公寓 → 213 通话联络页 | 3 槽均一致 | 完全一致 |

普通 writer 在 [videoPromptGeneration.ts:238](D:/Toonflow-app-master/src/utils/videoPromptGeneration.ts:238) 就把资产按 role → scene → tool 排列。供应商 [comfyui_local.ts:273](D:/Toonflow-app-master/data/vendor/comfyui_local.ts:273) 虽然再次排序，但这三片的输入已经是该顺序，结果没有改变。冻结参考计划由正常路由恢复，上传图片确实进入 `MiniMaxH3ReferenceToVideo` 的 `ref_images.ref_image_0..N`，也没有漏接多图。

另一个入口把开头画面放在 Picture1 时，二次排序会破坏语义编号；这是独立代码缺陷，已在旧报告用导入样本证明。应修复供应商保序，但不能用它解释普通项目这三片的结果。

### 没有偷偷走 Turbo，也不是当前错误读取了中文旧 prompt

三片真实图均使用 Ref2VA：`minimax_h3_ref2va_pruned_int8_convrot.safetensors`、`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`、video fp16 VAE/audio fp32 VAE；20 steps，`res_multistep`，`simple`，`ref_image_size=match`，1344×768，24 fps。没有 LoRA 节点，没有 Turbo LoRA，没有 guide 节点。种子分别为 2310270408804917、7188996842046729、4183750473803623。

16、24 的当前中文基础 prompt 与实际视频的英文 prompt 不同，这是语言版本，不是漏更新错误：对应 `o_videoLanguage` 的 en-US 快照与实际提交 prompt 逐字一致。评价英文视频必须基于该历史快照。现用 H3 六段结构也符合当前官方参考生成指南，不能把历史“自由格式”偏好当作当前故障。[MiniMax 官方参考提示词指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)

## 2. 已观察到的画面问题与输入负载

### 视频 16：指定近景开场被邮轮远景替代

真实提交的 Shot1 要求 Madison 侧面中近景，并强调只表现局部甲板边缘；然而 1 秒帧是完整邮轮巨大远景，人物很小，悬挂的 Ava 和 Madison 难以承担戏剧焦点。随后才进入近处双人/手部画面。4.8 秒帧中两只抓栏的手和栏内 Madison 可辨，但这不能抵消已丢失的开场构图。

这不是参考顺序错了，而是背景参考的完整船体构图与文字要求的局部近景在竞争，且图没有提供指定时点的近景状态锚点。对应 prompt 总长 1152 英文词，`detailed_description` 541 词，10 秒内有三个正式 Shot，另含手部细动作、说话、两只手先后释放、雨浪和相机切换。实际画面变化候选为 4.75、6.542、7.667 秒；第三 Shot 内自身还有切换措辞，所以不能仅数阈值候选就断言多切了一镜。

改善优先级：先在导演/分镜层确定“开场必须看谁、多近、手与栏杆初态、结束状态”，把一个连续状态变化编译成一个可执行镜头。需要精确开场时使用经过审查的镜头画面作 timeline guide，而不是期待一张完整邮轮设计图同时承担空间介绍和近景构图。不要只向已有千词 prompt 追加更多禁止句。

### 视频 17：6 秒分配三个物理场景与接触事件，资产还混入受害者

提交 prompt 有三个 Shot：约 0–2 秒释放/坠落，2–4 秒水面落水，4 秒以后水下鲨鱼到腿部。总长 1146 词，`detailed_description` 510 词。它同时要求重力、失去抓握、水面撞击、相机从船上转入水下、服装/伤腿持续、鲨鱼接近、遮挡接触及泡沫收尾。4.2 秒帧确实出现穿完整衣裤的 Ava、水下船体和张口鲨鱼；不能写成“鲨鱼完全没出现”或“人物衣裤完全丢失”。6.35 秒是暗影与泡沫遮挡，也不能据此证明全片没有最终黑场。

实际资产 215 是 2048×2048 的鲨鱼咬人画面，鲨口同时包含裸露人腿。生成 prompt 不得不解释“参考中的人腿不属于鲨鱼，目标仍需完整裤装与蓝色包扎”。这是确认存在的输入语义冲突：一张标作工具/生物的参考还定义了另一个人的身体、受害姿态和接触构图。尚无受控重生成，因此“删掉人腿一定改善输出”是待验证假设，不是已证明因果。

改善优先级：把鲨鱼身份设计与咬腿剧情画面分开；资产参考只定义鲨鱼本体和外形，剧情状态由目标人物的镜头画面定义。导演可把坠落、入水、水下威胁安排为独立镜头，或选择一次连续动作，不应在两秒区间里塞入多个运动约束。将复杂接触视为需要人工检查的高风险候选，而不是通过格式检查就进入批量生成。

### 视频 24：简单电话动作相对稳定，不能把自然比例直接判成错误风格

本片只有一个正式 Shot，约 9 秒，`detailed_description` 272 词。样本中手机握持与人物服装较稳定，相机从侧面走向正面。全尺寸 8.7 秒帧可见自然比例面部和灰色家居衣；其 204 参考板本身也是自然比例、细皮肤、接近真实材质的人物。仅凭视频“接近真实人物”不能证明供应商忽视了参考。

这意味着项目若希望更明显的国漫人物设计，必须先选定并验收统一的角色造型基准。当前项目标签 `realistic_3d_anime` 与“半写实”的文字可以覆盖较大范围，缺少可视的风格通过标准。风格问题既可能来自源资产本身，也可能来自渲染；应固定同一资产和 seed，分别测试明确造型标准/视频渲染表述，不要盲目换模型。

## 3. 上游画面在视频链中没有成为明确的可执行状态

[videoPromptGeneration.ts:78](D:/Toonflow-app-master/src/utils/videoPromptGeneration.ts:78) 虽读取分镜 `prompt/filePath/track/duration`，但 H3 的 `pictureSourceItems` 在 238–245 行仅包含资产；293–299 行给 writer 的视觉图也只有这些资产。H3 的 `buildH3PromptInput()` 在 [h3PromptContext.ts:26](D:/Toonflow-app-master/src/utils/h3PromptContext.ts:26) 把分镜压成 `id/duration/videoDesc` 文本，没有独立结构化的景别、轴线、人物位置、startState/endState、关键动作和接触关系。

所以用户即使在分镜面板看过一张构图，普通 H3 writer 不会自动把它作为实际参考或 timeline 约束传下去。代码注释称分镜图为“text-only composition guidance”，但该 H3 输入真正传递的是 `videoDesc` 文字，并非分镜图自身的像素、其图像 prompt 或已验收构图状态。供应商还在 [comfyui_local.ts:275](D:/Toonflow-app-master/data/vendor/comfyui_local.ts:275) 过滤 sourceType=storyboard。

这是一项真实流程设计缺口，但不能宣称“给H3塞所有分镜图”必然更好：普通设计图承担角色/场景外观，镜头起始图承担空间/姿态，两者需要不同角色。当前安装有 `MiniMaxH3AddGuide`，当前提交图没有接入。官方多帧模板区分语义 reference 与 `frame_idx` timeline guide；仅把某张图片叫“开头锚点”并不能让普通 reference 自动锚定第一帧。[ComfyUI 官方多帧模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_multiframe_reference.json)

建议让导演/分镜输出形成一个镜头契约：开场景别与布局、有效角色状态、单一动作目标、结束状态、转场、对白预算。用户确认的镜头画面可显式编译为 guide；角色整张四视图继续作为一个身份槽，保持既有资产历史和用户整板偏好。重生成时只对选定候选产生新版本，不能覆盖现有完成视频。

## 4. 角色参考本身含剧情姿态，完整四视图进入模型时又被缩小

202 的雨夜 Ava 参考板 3328×1248，脸特写及前/侧/背视图均带栏杆/抓握场景，而不是纯角色的中性视图；205 为相同宽板。于是角色身份、衣服状态、抓栏姿态在一个槽里混合。源图中存在这些内容是确认事实，它对动作持续的贡献需要 A/B 证明。

当前 `ref_image_size=match` 写死在 [comfyui_local.ts:356](D:/Toonflow-app-master/data/vendor/comfyui_local.ts:356)。原生 H3 节点按目标面积缩小该宽板，3328×1248 到约 1664×608；四个区域平均约 416 像素宽，身体视图中的脸更小。因此“原文件几千像素”不代表身份细节按原分辨率进入模型。这是节点源码计算确认的压缩，不是画面身份错误的充分证明。[ComfyUI H3 原生节点](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py)

建议保持整张角色板一个槽；先确保整板中脸/前后身体的比例和视觉一致性、背景简洁、角色设计不依赖剧情接触物。把 `match/max` 作为显式可选质量参数，用固定种子验证脸、服装、身份稳定和显存/速度。官方节点说明 `max` 能保留更多参考细节但更慢；不能承诺切到 max 就解决镜头执行。[官方 Ref2Video 节点说明](https://github.com/Comfy-Org/docs/blob/main/built-in-nodes/MiniMaxH3ReferenceToVideo.mdx)

## 5. 成功状态只表示文件产生，缺少可执行性和成片质量检查

[videoPromptGeneration.ts:314](D:/Toonflow-app-master/src/utils/videoPromptGeneration.ts:314) 检查六段契约、Picture/Subject 绑定、非对白语言等。它们很有价值，但没有验证 2 秒动作是否可实现、源图混入另一人物、剧情接触关系或最终画面是否执行。[h3SemanticReview.ts:8](D:/Toonflow-app-master/src/utils/h3SemanticReview.ts:8) 有语义审查提示词，当前 `src` 搜索只有定义，没有调用链。

[batchGenerateVideo.ts:171](D:/Toonflow-app-master/src/routes/production/workbench/batchGenerateVideo.ts:171) / [generateVideo.ts:158](D:/Toonflow-app-master/src/routes/production/workbench/generateVideo.ts:158) 在供应商返回文件后写“生成成功”。[videoQuality.ts:8](D:/Toonflow-app-master/src/utils/videoQuality.ts:8) 的 `inspectVideoQuality()` 只执行 ffprobe，保存分辨率、fps、bitrate、codec、实际时长；异常还返回 `{}`。它不判断脸、服装、构图、动作、镜头切点、台词或口型。正常项目 19 个成功文件元数据齐全，不能把 catch 分支当作这 19 片具体故障，但状态语义确实没有“画质通过”的含义。

建议区分文件完成、待检查、已选用；完成后自动抽起止/动作关键时点，检查目标人物、开场构图、衣服、核心动作和时长；对白片另对完整句子和说话人做核验。语义审查应在提示词生成前检查故事/状态可执行性，并查看实际参考；不要把审核只做成更严格的字符串重试。对复杂动作提供待确认标记和人工对比，不自动把低质量候选设为选用。

## 6. 规划时长、UI 可选时长和实际帧数没有统一

当前 prompt writer [videoPromptGeneration.ts:259](D:/Toonflow-app-master/src/utils/videoPromptGeneration.ts:259) 使用 track.duration/分镜总时长，H3 允许 4–15 秒且拒绝自动截短。供应商给 UI 的时长枚举却是 [comfyui_local.ts:74](D:/Toonflow-app-master/data/vendor/comfyui_local.ts:74) 的 5–15 秒。原生构图在 346–348 行先向上取整秒，再对齐 `17k+5` 帧；因此目标 6 秒实际 158 帧/24=6.583 秒，目标 9 秒为226帧/24=9.417秒。这是正常 latent 帧结构带来的量化，不应称为 H3 任意忽略时长。

首段 track1790715565974 的 duration=4，video1 历史提交 prompt 明确 four-second，但提交图 length=124，最终5.167秒；目标5秒的 video2 同样124帧。用户 UI 当前显示5秒与这一历史结果相符。这证明三处时长不同步，可能使节奏被伸长；不能只依据今日源码认定当次供应商最低5，因为今日 nativeGraph 的4秒应编译为107帧、4.458秒，历史124意味着当时实际 config/上游选择或旧逻辑已到5秒。没有当次请求体则不能再缩小归因。

建议在生成 prompt 之前统一计算 `plannedDuration/requestedDuration/frameCount/actualCompiledDuration`，UI 显示实际预期时长；提示词切点与对白预算基于最终编译时长，剪辑层保留源规划时长。必要时成片裁切到明确片长并验证音频句尾，不能靠模型承诺4秒来消除底层帧量化。

## 7. 参数优化应做有控制的实验，不能取代流程修复

当前20步是官方普通质量路径，不是已证明“步数太低”。官方说明可以增加至25步尝试更高质量动作；参考较重时 `beta/normal` scheduler 也值得比较。保持不启用 Turbo LoRA。这些是 A/B 候选，不是已确认修复。[官方 H3 原生教程](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-native.mdx)、[官方 R2V 模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_r2v.json)

当前 [comfyui_local.ts:359](D:/Toonflow-app-master/data/vendor/comfyui_local.ts:359) 每次随机 seed，没有供普通请求固定 seed 的参数；虽然 MP4 会保留 seed，却缺少一键精确复现实验。建议先持久化并允许复用完整生成 manifest：供应商正文版本/hash、模型、节点/参数、参考顺序与hash、语言prompt快照、seed、实际帧数。一次只改一个变量：先解决镜头契约/参考语义，再比较 match/max，最后比较20/25步或scheduler，并按相同画面标准验收。

## 优先改造顺序与验收

1. **先定义能被生成器执行的镜头。** 视频16应保住近景开场、两个人在栏杆两侧的位置和释放动作；17应降低两秒内的物理转换负载。验收看指定时点与关键状态，不以prompt格式通过代替。
2. **统一源资产设计与参考职责。** 角色板去除抓栏等剧情接触姿态的强绑定；鲨鱼本体不含受害者肢体；明确可视风格基准。保持整板一个身份槽，增加精确构图时单独接 guide。
3. **打通分镜面板到视频的状态契约。** 当前正常H3链只消费videoDesc与资产图；让已确认构图/起止状态可追踪并可编译，避免面板画面与成片各自解释剧情。
4. **统一时长与完成/选用状态。** 给出最终帧长、对白预算和可验证检查；保留历史候选与语言版本。
5. **再做固定seed的质量参数实验。** match/max、20/25步、scheduler分别对照，记录身份、动作、构图、时间与显存，不能一次全改后把随机差异当提升。

本次已经确认的是正常项目链路与真实输入、视频16近景开场执行失败、资产混入剧情姿态/受害者、面板未形成H3像素/状态约束、成功状态只含元数据、时长不同步。对资产修改、guide、max与步数的改善效果尚未生成验证，因此不声称质量问题已修复。

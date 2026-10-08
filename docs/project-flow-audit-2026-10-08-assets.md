# 指定项目正常流程：资产分项审查（2026-10-08）

本轮限定到用户指定的 `http://localhost:50188/#/project`。根审查代理通过浏览器确认项目列表显示“重生三天，我囤爆整个海洋”，点击进入 `#/script`，项目 ID 为 `1790665121730`。本分项的代码、数据库与成图样本只关联这个项目，不使用 importStudio 或其他验收项目解释当前效果。

本轮只读业务源码与 SQLite（`mode=ro`），没有触发提取、图片生成、模型调用或资产保存；只新增此报告，并给上一资产报告加入范围更正。已存在的图像是历史产物；当前源码规则和旧图片实际表现分开陈述，不能仅凭现在的代码推断旧图是怎样失败的。

## 从项目页面真正可以进入的资产流程

项目工作台导航在 `D:\Toonflow-app-master\Toonflow-web-master\src\pages\workbench\index.vue:96`–`:100` 提供剧本管理、角色场景、生产与资产中心。前三者构成本轮主链，资产中心是可达的辅助入口。

| 当前项目入口 | 实际处理 | 父图/状态/风格如何进入 | 分类 |
| --- | --- | --- | --- |
| `#/script` → 提取资产 | UI `views/script/index.vue:226` 调用 `/script/extractAssets`，提取基础实体与剧集关联 | `scriptAssetExtraction` 先发现，后生成描述、视觉设计及原文来源。提取系统使用共享 asset_visual_design Skill 和项目画风名 | 基础实体发现；不是衍生图片生成 |
| `#/cornerScape` → AI润色 / 批量提示词 | `/assetsGenerate/polishAssetsPrompt` 或 `batchPolishAssetsPrompt` | 查询当前数据库描述；已有基础选图以 actualReference 进入提示词作者/审核；加载项目 `prefix.md + art_character/art_scene/art_prop` | 文字设计与事实审核 |
| `#/cornerScape` → 单张 / 批量图片 | `/assetsGenerate/generateAssets` 或 `batchGenerateImageAssets` | 只列基础资产；该页面单张明确发 `base64:""`，批量不提交参考。人物先按 facts 生成正面，再扩头像/侧面/背面；场景和道具按所选普通模型生成 | 首次基础视觉设计；没有父状态参考 |
| `#/production` → Agent 分析衍生 | `run_sub_agent_derive_assets` → `add_deriveAsset` | 以基础 `assetsId` 建立状态、描述与剧集关联，类型从父资产继承。当前 Skill 要求状态变化、启用条件和互斥关系 | 同人/同场景状态分析 |
| `#/production` → Agent 生成衍生 | `generate_deriveAsset` → `generateDeriveAsset` socket → store → `/production/assets/batchGenerateAssetsImage` | 先快照父/旧选图，再读取父身份和目标状态；加载 `art_character_derivative`/`art_scene_derivative`；把父完整选图与**目标完整 prompt**发给项目普通 Qwen 图生图 | 父身份继承后的状态编辑 |
| `#/production` → 点击衍生卡片手工编辑 | `assets.vue` → editImage → `/production/editImage/generateFlowImage` → `/production/assets/updateAssetsUrl` | 默认连入父图与已保存衍生 prompt；使用项目模型/质量/比例，用户可以手改参考和 prompt，再明确保存 | 可达的手工修正入口 |

关键边界：`D:\Toonflow-app-master\src\routes\cornerScape\getAllAssets.ts:33` 只查 `assetsId=null`。因此正常 cornerScape 页面不是“拿父图生成新状态”的入口；上一报告中的四视图带参考条件问题不能用来解释此页的当前图片。

生产衍生链的实际连接证据：

- `src\agents\productionAgent\index.ts:225`–`:247` 注册衍生分析/生成子 Agent。
- `src\agents\productionAgent\tools.ts:389`–`:410` 的 `generate_deriveAsset` 发 socket 请求。
- `Toonflow-web-master\src\stores\productionAgent.ts:274`–`:292` 将该操作发到生产资产批量路由。
- `src\routes\production\assets\batchGenerateAssetsImage.ts:139`–`:156` 明确将父图和完整目标状态 prompt 发给普通图生图；没有把状态 facts 丢掉。
- 手工路径 `Toonflow-web-master\src\views\production\node\assets.vue:103`–`:108` 带父图进入画布，`editImage/generatedNode.vue:181`–`:187` 把参考和当前 prompt 一起提交。

## 基础与衍生模型不同：应如何判断

当前项目配置为普通 Qwen 图片模型、4K、`realistic_3d_anime`。基础人物通过 `src\utils\assetImageModel.ts:6`–`:17` 固定选专用四视图；生产衍生使用项目模型。对于“首次生成完整人物设计”与“依据父图编辑新状态”，这是可以成立的功能分工，**模型不同本身不是生成缺陷**。

需要评估的设计取舍是：普通 Qwen 同时编辑整张四栏板，视角一致性和身份稳定性是否达到要求。现存 202–204 的模型记录支持它们用了普通 Qwen，但不足以证明历史成图就是当前路由版本产生的，更不能把它们归因于专用四视图有参考时跳过 front 的条件行为。

真实可见的 UI 契约问题是：cornerScape 的模型选择初始显示项目普通模型（`views/cornerScape/index.vue:298`），人物实际由解析器固定改成专用四视图。如果这是产品既定策略，应让界面直接显示“人物使用专用四视图”；如果承诺可以选择人物模型，就应尊重所选模型。此问题影响对生成方式的理解，不直接证明图像美感差。

## 当前正常流程中的确定缺陷

### 1. 衍生描述更新绕过版本链，旧 prompt / 旧图可能仍被视为当前

`D:\Toonflow-app-master\src\agents\productionAgent\tools.ts:245`–`:250` 更新已有衍生时直接写入 `describe`，没有调用 `saveDescription`。因此 `descriptionVersion` 不增加，旧 prompt 和选图没有标为待更新。

这与基础资产描述刷新使用的版本机制不一致：`src\utils\assetDescriptionVersion.ts:34`–`:50` 保存新描述会增加版本并标记 prompt 待更新，而 stale 判断在 `:24`–`:29` 只依赖版本。

影响：用户在生产对话中修改“湿衣、便服、伤腿”等目标，若尚未重新生成图片，页面和下游可能继续使用旧图而不显示设定已变化。不能用当前全部版本为 0 来证明衍生状态内容未变化。

建议：衍生新增/更新与基础描述共用版本保存入口；更新描述保留旧图，但明确旧 prompt / 图需要重做。验证一次已有衍生的描述修改，必须看到版本增加和 stale 提示，而不是自动重生成。

### 2. 手工衍生采用只替换 imageId，当前项目已有指纹与选图不一致的真实记录

`D:\Toonflow-app-master\src\routes\production\assets\updateAssetsUrl.ts:18`–`:23` 新建 `o_image` 时仅保存路径、状态、assetsId，然后更新 `flowId/imageId`。它没有记录 type/model/resolution，也没有同步角色指纹、图片描述版本与角色布局元数据。

当前项目资产 205“雨夜弃船”的选图为 `imageId=230`，路径是 `1790665121730/workFlow/2e9bd00d-f8f2-47b7-8e2f-5273a8236971.jpg`；其 `o_image.type/model/resolution` 都是 null。直接读取文件计算 SHA256，发现资产的 `referenceFingerprint` **不等于** 当前选图的真实 SHA256。对照资产 1、202、203、204 均匹配。

这不是审美猜测，是可达手工保存路径与当前选图元数据的实际不一致。还不能仅凭历史记录断言 image230 当时一定由今天版本保存，但今天该路由同样没有维护这些字段。

建议：手工采用复用统一资产选图事务，把选图 ID、实际文件尺寸、模型/生成记录、描述版本和角色指纹一起保存。保留原候选和用户选择，不强加新的审批。验证同一衍生先自动生成再手工采用：选图文件 hash、资产 fingerprint、版本与 image 记录应同时对齐。

### 3. 角色别名没有程序级归一化，指定项目已有同人两个身份

当前项目资产 92“维克多·凯恩”和 123“维克多”都为基础身份；123 的描述明确写“全名维克多·凯恩”，两份设计却分别为深色发和灰金发，关联到不同剧集。这会影响后续实际引用的人物连续性。

当前提取代码在 `D:\Toonflow-app-master\src\utils\scriptAssetExtraction.ts:79` 冻结初始资产列表，`:94` 每批都传该初始列表，`:109` 仅以类型和完整名称匹配。上一轮内存数据库复现了跨批别名形成两个父身份。

范围：这是当前数据缺陷与当前代码保障缺口；没有历史生成版本证据，不能声称今天的提取器必然制造了旧重复。建议先建立规范名/别名/共同身份目录，审阅两个已存在人物的保留方案后重建关联，保留旧图与已生成视频。

### 4. 普通 Qwen 的 4K 选项没有额外原生像素

`D:\Toonflow-app-master\data\vendor\comfyui_local.ts:152` 将 1K 映射为最长边 1024，其余质量都映射为 2048。因此项目场景/道具选择 2K 和 4K 没有像素差异。专用人物四视图的尺寸分支在 `comfyui_qwen21_fourview.ts:131`，其整板与每视角分辨率应分开说明。

生产图生图还使用参考编码器返回的画布（`comfyui_local.ts:167`–`:177`），因此不能只按项目质量字段猜最终尺寸；应看真实图片 metadata。此问题影响清晰度承诺，不能代替面部设计、造型和导演质量的审查。

## 质量设计缺口：不等同于已确认程序故障

### 当前选图与文字设计之间没有成图质量闭环

提示词作者确实使用视觉手册及旧图做文本审核（`src\utils\assetPromptGeneration.ts:147`–`:162`），但成图 `reviewAssetImage` 没有生产调用。自动采用是现有策略，相关针对测试明确以“不调用 reviewer”作为期望行为。

因此现有“描述版本一致”“ready”“已完成”不能证明脸型吸引力、四栏衣装一致、动画化程度或场景美感通过。可先增加可解释的候选质量检查与简单回退，优先人工确认主角和主场景；不必把昂贵审核或审批强加给每次生成。

### 正常首次设计主要依赖文字画风，未建立项目视觉样本锚点

cornerScape 只传当前 prompt，没有风格图。当前视觉手册明确要求半写实三维国漫；图像本身则仍可在真人 CG、柔化动画脸和摄影环境之间变化。已实看本项目艾娃、麦迪逊、维拉、公寓，基本四视图结构成立，审美和渲染统一程度不足属于人工视觉判断。

建议先在同项目上选择少量角色和场景建立统一美术样本，明确脸部抽象程度、造型剪影、材质与布光，再做受控 A/B。首次正面决定后续全板质量，应该有机会先看正面候选，而不是只看最终宽板是否成功返回。

### 旧衍生资产里存在镜头瞬时效果，不能直接归咎当前 Skill

本项目已存在“闪回叠影”“咬腿剪影帧”“日期页”等衍生。这些更像镜头/界面状态，容易把分镜细节过度资产化。当前 `production_execution_derive_assets.md` 已要求把短时动作留在镜头层，并说明不创建衍生道具；不能据此断言当前规则还会生成相同旧结果。

改进应先区分需要稳定外形的身份/状态与镜头效果，针对现存项目建立清楚使用范围；不要以整改为由删除已完成图或重做整剧。

## 本轮结论的边界

- 入口可达性由工作台菜单、UI调用、socket、store和对应后端代码共同核对；项目选择来自本轮根代理浏览器确认。
- 历史图只用于说明指定项目当前可见效果与数据一致性，不能反推今日代码的生成结果。
- 专用四视图“给旧front而丢目标facts”不列为本项目正常 cornerScape 或生产衍生链的主要原因。
- 目前最直接应先修的是衍生描述版本和手工选图元数据，其次处理实际重复人物；模型链和美术方案需要受控成图对比才能判断优化收益。
- 未触发任何生成，没有修改后的真实 A/B，所以不能说视频或人物质量已经改善。

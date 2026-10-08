# 普通项目流程：导演、分镜表、面板复查（2026-10-08）

## 明确范围

入口是 `http://localhost:50188/#/project`，正常打开项目“重生三天，我囤爆整个海洋”，projectId=1790665121730，进入 `#/script` 后通过同一项目菜单进入资产库和 `#/production`。本报告不分析批量导入中心、importStudio 或其他验收/导入项目。父审查者负责浏览器实走，本报告核对当前源码、该普通项目真实数据库及 Agent 历史记录。

全程业务只读；生产数据库以 `readonly:true` 打开，不触发生成，不改变现存任务/候选/视频。新增内容只有本报告与旧审查报告的范围说明。

## 真实入口和调用链

| 普通页面操作 | 当前代码与后端路径 | 传入内容、产物 |
|---|---|---|
| 打开项目 | `views/project/index.vue:92-120` | 验证图片/视频模型，118 行保存 project，脚本型项目进入 `/script` |
| 查看/编辑单集 | `views/script/index.vue:134`；`components/editScript.vue:110` | `getScrptApi` 读取 o_script；`updateScript` 修改普通剧本和关联资产 |
| 提取选中集资产 | `views/script/index.vue:226-230` → `src/routes/script/extractAssets.ts:65-67` → `scriptAssetExtraction.ts:72` | 使用 o_script.content 完整正文，发现资产并设计基础外观，写 o_assets/o_scriptAssets |
| 进入生产并选集 | `views/production/index.vue:284-313` → `stores/productionAgent.ts:236` | `/production/getFlowData` 读取剧本、导演计划、表及真实 o_storyboard；同一 projectId 与 episodeId |
| 开始制作/生成导演/写表等聊天 | `rightChatBox/index.vue:115/139` → `useChat` → `/socket/productionAgent` 的 chat | server `productionAgent.ts:438-463` 建任务，`runDecisionAI` 根据指令选择子 Agent |
| 导演规划 | `agents/productionAgent/index.ts:250-266` | 完整 o_script.content、项目画幅/题材、程序对白/屏幕文字/预算、已有计划；输出 XML → saveDirectorPlan 事实核对、事务写回和读回 |
| 首次/缺场分镜表 | `index.ts:306-348` | 后端确定 taskId/场数/下一缺场；本场全文＋程序事实＋前场末尾 800 字，模型另读完整计划和资产；逐场 XML 校验提交 |
| 已有场次返修 | `index.ts:360-391` → `storyboardRevisionTool` → `storyboardRevision.ts` | 本场旧稿、原文、预算、修订要求；只读生成 → expectedRevision/hash 事务 → 总表/面板同步、旧词失效、保留视频 |
| 监制审核 | `index.ts:395-401` | 监制主 Skill＋简短派发文字，靠 get_flowData 分别读取当前 script/plan/table/assets；输出自由文本审核结论 |
| 写面板 | `index.ts:284-294` → `tools.ts:466` → Socket addStoryboard → `stores/productionAgent.ts:186` → `/production/storyboard/batchAddStoryboardInfo` | 多参按片段、首帧按镜头，新增 o_storyboard 和资产关联；仅验证写入归属/ID/幂等，没有编译后证明表与面板一致 |
| 生成面板图 | `tools.ts:425` → Socket generateStoryboard → `stores/productionAgent.ts:243` → `/production/storyboard/batchGenerateImage` | 读面板 prompt，按关联顺序取选定资产图片，调用项目图片模型 |
| 人工改导演/总表 | `node/scriptPlan.vue:89-94` / `node/storyboardTable.vue:89-94` → store.setFlowData → `/production/saveFlowData` | UI 先替换文本并关窗；HTTP 没走 AI 修订校验/面板同步链 |
| 人工改面板 | `node/storyboard.vue:438-444` → `/production/storyboard/editStoryboardInfo` | 只改 prompt/videoDesc，不改总表、时长/资产关系或旧视频词状态 |

这些入口都属于正常项目；没有 importStudio 前置条件。普通项目生成 H3 多参视频前的 director/table/panel 即以上链路。

## 上轮发现是否在正常项目可触发

| 上轮编号 | 在本普通项目的可达性 | 本轮结论 |
|---|---|---|
| D1 跨说话人对白顺序丢失 | 正常表生成、AI返修提交均调用相同 validator | 确认；按 speaker 聚合不能证明全局先后顺序 |
| D2 一秒超长对白仍通过 | 同上 | 确认；Skill 估算要求没有保存校验实现 |
| D3 人工面板修改不失效旧词 | production 面板“编辑”直接调用该 HTTP | 确认；当前已有 12 块面板可走该入口，未实际修改 |
| D4 人工总表编辑绕过同步 | 总表节点“编辑”调用 setFlowData explicit writeFields | 确认；内容变化删除旧 progress，但旧面板、词和视频仍在 |
| D5 分镜图缺图压缩顺序 | 普通面板生成图按钮/Agent 图片工具走相同 route | 确认；当前第1集采用直接多参，平时不需要图；强制生成/其他首帧项目会走这里 |
| D6 逐镜首帧面板不能总表返修 | 项目改为首帧模式后按标准契约写逐镜面板 | 条件可达；当前项目 H3 多参/整片段面板不会因该原因失败，不列为本集实际现象 |
| D7 表修订后面板缓存不刷新 | 普通 production 接收同一 committed 事件 | 确认；表/progress 会刷新，面板数组不刷新，Agent 面板读取仍依赖它 |

第 1 集真实 12 块面板 shouldGenerateImage=0、prompt 空属于多参模式设计，不是“分镜图片生成失败”。但没有先验构图给用户确认复杂动作的效果，是制作质量缺口。

第 2 集工作区 JSON 中一块 id13/8 秒旧副本，不能当真实面板；真实 o_storyboard 该集 0 条，正常 getFlowData 会重建为空。旧报告已明确区分。

## 新确认：第 60 集维护附录直接污染导演事实

数据库该集名称“第七号核心”，完整 content=3554 字符。其中戏剧正文 956 字符，尾部以“第一季终局 Story Bible Update”开始的维护附录 2598 字符。附录含：第一季闭环、主要人物状态、Open Hooks、升级表、知识状态关键表、长线连更规则。

### 当前代码造成的实际结果

1. [screenplay.ts](D:/Toonflow-app-master/src/agents/productionAgent/screenplay.ts:39)39–49 行只按场景标题切片，最后一场一直切到 script.length；所有附录因此进入 Sc3。
2. [screenplay.ts](D:/Toonflow-app-master/src/agents/productionAgent/screenplay.ts:22)22–35 行把一个短文本行＋下行标点句当作人名对白。对该集真实数据复现：

| 第 60 集 Sc3 | 仅戏剧正文 | 当前完整 content 解析 |
|---|---:|---:|
| 场正文长度 | 481 | 3085 |
| 口播条数 | 2 | 12 |
| 口播字数（程序口径） | 12 | 178 |
| 时长预算（来源） | 35 秒 | 35 秒 |

新增假说话人包括“已完成的第一季闭环”“第一季开放钩子 Open Hooks”“第二季接口”“长线连更写作规则”；实际角色也被迫“说出”维护状态，例如艾娃“已失去前世时间线优势。”、科尔“海兽王候选同步完成过100%，但重新建立自主意识。”。

3. [directorPlanContext.ts](D:/Toonflow-app-master/src/agents/productionAgent/directorPlanContext.ts:47)直接注入完整原文，并把上述受污染结果放进程序事实。Skill 要求沿用后端统计；[directorPlan.ts](D:/Toonflow-app-master/src/agents/productionAgent/directorPlan.ts:20)保存也对同一错误事实核验。模型即使正确识别附录，按真实 2 句填表也可能被程序拒绝；为了通过程序可能把维护条目当对白。
4. 普通提取入口 [scriptAssetExtraction.ts](D:/Toonflow-app-master/src/utils/scriptAssetExtraction.ts:77)77–94 行发现阶段把 full content 传给模型；[同文件](D:/Toonflow-app-master/src/utils/scriptAssetExtraction.ts:29)29–34 行生成证据编号也包含附录。长期资料中的未出场人物/后续设定可能被误认为本集制作资产或基础状态。

边界：第 60 集目前没有 productionAgent 工作区，未生成过本轮导演稿。当前该集只有 9 条资产关联，没有因为附录就绑定维克多等全部维护人物；因此资产问题是确认输入未区分、后续有风险，不能声称已经错误提取了所有附录资产。导演事实错误是当前真实输入上的纯函数复现，已确认。

建议保留原始来源，把制作正文、全季 bible/context、作者维护说明明确分区；戏剧解析/覆盖/台词计时只针对 scene body，跨集知识与长期状态独立作为上下文。资产发现只选择本集实际可见/有制作需求的内容；基础设计可读取已确认 bible，但不得把 future state 当 default。不要直接删除附录或硬编码排除几个标题后宣称支持所有剧本格式。

## 当前监制实际拿到了什么

普通项目第 2 集最近的监制 runId=`78b05044-5ca5-4b50-8683-26d71da0f642`，数据库工具日志确认依次读取 storyboardTable、script、assets、scriptPlan；assets 返回 6 个元素，首元素字段只有 id/name/type/desc/derive，没有 src、参考图像或 prompt。

这和当前前端代码 [productionAgent.ts](D:/Toonflow-app-master/Toonflow-web-master/src/stores/productionAgent.ts:108)108–126 行主动删图片 src、资产 prompt、分镜 prompt 完全一致。监制实际审的是文字，不是所选图与成片。

历史本集曾有审核围绕“冷白”删词给 C/A，这只是历史证据，不把历史模型结果说成今天新 Skill 重跑结果。不过本轮查看现行文件发现相关冲突仍存在（如下），所以也不能说规则已经全部修完。

## 当前设计约束压缩了电影表达空间

当前 [production_agent_supervision.md](D:/Toonflow-app-master/data/skills/production_agent_supervision.md:156)156 行允许来源中的天气、屏幕亮起和回溯特效；同一文件 [231–235 行](D:/Toonflow-app-master/data/skills/production_agent_supervision.md:231)却仍要求扫描“光/影/阴影/明暗/侧光…”命中即严重、删除光影词。今天通用技法 [storyboard_table_techniques.md](D:/Toonflow-app-master/data/skills/production_skills/storyboard_table_techniques.md:75)75 行又要求不要按“光/影”关键词删除事实。

当前分镜主 Skill [production_execution_storyboard_table.md](D:/Toonflow-app-master/data/skills/production_execution_storyboard_table.md:33)要求渲染方式沿当前真实角色图，不从目录/故事添加国漫、卡通等标签、不额外灯光色调；当前画风分镜技法 [director_storyboard_table_style.md](D:/Toonflow-app-master/data/skills/art_skills/realistic_3d_anime/driector_skills/director_storyboard_table_style.md:7)7 行也作相同限制。第1集库内 Sc1/Sc3 的前言实际写了“不描写屏幕/界面/光源二次映亮脸部与环境”，与限制方向一致。

这种设计原本是防止身份漂移、乱改参考和夸张的灯光方案，但现在同时抹去剧情动机的动态照明以及导演可控的电影表达。参考图质量欠佳时，锁定参考图渲染方式也会继续传播不佳风格。它们是当前质量设计原因之一；还未做受控成片实验，不能声称绝对造成每一段坏视频。

建议将身份/五官/服装稳定参考，与项目明确采用的目标渲染风格分离；场景光源保持连续，允许符合来源/真实光源/既定电影风格的照明表现；新增状态需要衍生资产可以保留，但取消“光/影单字即严重”的机械审核。不要把选用国漫三维、真实材质、电影光照误当作每镜新增人物外貌。

另有契约残留：通用 [storyboard_table_techniques.md](D:/Toonflow-app-master/data/skills/production_skills/storyboard_table_techniques.md:100)100–115 行仍教 action/orientation/spatialRelation 独立列；主 Skill 与 validator 强制 7 列，把动作和空间纳入画面描述。主契约虽有优先级，激活手册后仍增加模型理解负担和重试概率，应统一同一字段口径。

## 普通流程返修闭环仍不是确定的质量门

- 首次生成后是否派发监制、是否进入面板，主要靠决策模型遵守 Skill；监制输出没有与当前 revision 绑定的结构评分和批准结果。
- [socket/productionAgent.ts](D:/Toonflow-app-master/src/socket/routes/productionAgent.ts:317)317–346 行处理明确“按最新导演计划重新生成全部分镜”时，直接归档→generateRebuiltStoryboard→完成 run，没有执行监制子 Agent。提示语会如实说还需复核，但不能称自动全流程质量闭环。
- 面板新增 HTTP 没验证 sourceRevision/审核结果/镜头源 ID；人工表与面板改动另走旁路。

建议把“生成完整”“程序事实可行”“语义审核”“图片审核”“用户采用”保存为来源版本绑定的明确结果；正常首次生成和重建复用相同后处理。面板从明确采用的镜头结构由确定性代码编译，缺少必要源版本/参考时反馈缺项，不让多层自由文本把问题反复传递。

## 优先顺序

1. 先处理普通剧本正文与维护附录的分区，修对白解析和源事件顺序/时长，防止后端硬性强迫错误事实。
2. 统一普通 production 的 AI返修、人工总表修改、面板修改与引用/旧词失效链；确保修正会进入后续视频输入。
3. 统一现行 Skill 的光照、渲染和字段契约；角色身份、目标画风和照明表达分别保存明确依据。
4. 为普通项目角色/关键场景/复杂动作加入真实图与少量成片验收；文字监制不能替代视觉证据，增加长描述不能替代明确构图和状态链。

本轮只增加范围核对与 EP60 原数据上的纯函数复现；不重复发起上轮已通过的21项测试，不触发生成或更新页面内容。

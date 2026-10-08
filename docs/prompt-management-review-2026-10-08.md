# 四项管理提示词审查与优化

本次核对的是 `http://localhost:50188/#/project` 设置中的事件提取、剧本资产提取、视频提示词生成和音色绑定，以及它们实际读取规则、调用模型和保存结果的代码。四项默认规则已经更新、写入本地数据库，并在刷新后的管理页面显示。主要改善是消除任务和字段冲突、区分事实与设计补全、保留人物行动与镜头意图，并使管理页的视频通用规则真正传入 H3。

这四项不单独决定导演规划、分镜表和分镜面板。那些阶段继续由生产 Agent 的上下文与各自 Skill 控制；完整画面设计也要依赖人物设计、美术规则、参考图及最终生成模型。这里的修复不能证明已有图片或视频已经变好。

## 实际使用关系

| 管理项 | 实际调用位置 | 本次确认的职责 |
| --- | --- | --- |
| 事件提取 | `src/utils/cleanNovel.ts` | 当前小说章节变为七字段事件摘要，供剧本流程读取 |
| 剧本资产提取 | `src/routes/script/extractAssets.ts`、`src/utils/scriptAssetExtraction.ts` | 先发现与复用资产，再按来源整理单个资产的描述与设计 |
| 视频提示词生成 | `src/utils/videoPromptGeneration.ts` | 管理共同内容准则；模型专用文件负责输出格式、参考标签与时间戳 |
| 音色绑定 | `src/routes/cornerScape/batchBindAudio.ts` | 从本项目已上传的音频组中按文字描述选择候选，并保存绑定 |

管理页面保存自定义内容到 `o_prompt.useData`，显示和运行均优先采用非空 `useData`，其次采用 `data`。审查开始时四项 `useData` 均为 NULL，实际使用旧默认。此次只更新默认，保留记录 ID、名称、类型与自定义内容的优先级。

当前数据库 `o_novel` 和音频资产、角色音色绑定均为空。因此事件提取与音色绑定的缺陷是确认的规则或代码问题，不能据此断言它们已经造成当前项目的视频问题。

## 四项问题与修改

### 事件提取

旧模板把核心事件限制在 30–60 字，并要求多条平行线选对主角影响最大的一条。这容易将事实提取提前变为改编压缩，损失另一条剧情线、行动原因与尚未完成的状态。它只看到当前章，却要求判定主角弧线；情绪和信息密度还被硬映射为 25–60 秒，容易把粗略估计误当作下游制作时长。

新规则继续输出原有七字段，保留枚举和秒单位，但要求先保留因果、独立平行事件、人物说法与未决状态。只给当前章时允许写“中（主线待确认）”；时间仅为低置信改编初估，不按情绪固定分档。两个短示例分别覆盖未答复的借款与未核实的称述。

代码原来将整段系统提示词 `JSON.stringify` 后传入模型，并把删除 think 块后的任意回复作为事件。现在系统文本原样传递，章节元数据与 JSON 字符串正文在独立用户消息中作为来源数据。七字段、章节编号、关系/密度枚举、秒数和情绪标签通过校验才返回成功；拒绝文本、额外说明、错误结构、空正文及 0 秒无剧情结果走现有错误回调。兼容旧的小数秒与半角理由括号。

完整新稿：[eventExtraction.md](/D:/Toonflow-app-master/data/modelPrompt/system/eventExtraction.md)。格式校验不验证事实真伪，仍需文字样例与后续剧情核对。

### 剧本资产提取

旧管理模板要求一次输出 `assetsList`、中文描述和英文关键词 prompt；现在真实工具却分为 `newAssets/existingAssetRefs` 与单资产 `describe/scriptFacts/visualDesign/conflicts` 两阶段。旧稿还要求性别、英文以 young man/woman 开头、统一字数、提取所有具名角色和地点，容易使未知年龄、性别或陪衬获得虚构造型。

新规则让当前工具 schema 决定本轮字段。发现阶段先判断是否需要独立制作，再匹配已有身份；完整造型留到设计阶段。原文事实、可见设计补全和后续绘图提示词分别处理，真实 `sourceRef` 由模型选择，原句仍由服务器复制。背景朋友、只在奖励列表出现的对象和未呈现的订购物件不因出现名词而建资产；在场但未成交的关键道具可以提取，却不能写成主角已经拥有。

六组正反例覆盖背景配角、仅被提及的资产、未成交道具、别名复用、互斥场景状态和来源引用。画风与具体美型设计继续由选定视觉 Skill 提供，管理模板不再植入统一古装或示例外观。

代码以前拒绝两个空数组并强制重试，会与筛选规则冲突。现在 schema 合法的空发现结果可成功结束，不进入设计或写入资产；缺工具和非法结果仍按原有两次上限失败。重新提取所选剧本时会重建其资产关联，空结果会清除那些剧本的旧关联，但保留资产实体、描述、已选图片和历史。

完整新稿：[scriptAssetExtraction.md](/D:/Toonflow-app-master/data/modelPrompt/system/scriptAssetExtraction.md)。跨批次新身份/简称的统一仍有改进空间，本次没有扩改该机制。

### 视频提示词生成

旧管理模板约 20982 字符，包含模型路由和大量重复示例，还沿用按顿号拆十二字段、`prop` 类型和自行推算图号等规则。当前输入的 `videoDesc` 可以是七列表格，真实道具类型是 `tool`，参考序号则由实际上传槽位决定。旧规则中的强制连续镜头、全景变环境建立镜头、统一一秒下限也会改变分镜意图。

更关键的是，当前 H3 会先读 `minimaxH3Multi-referenceMode.md`，原来的管理项只是备用。只改数据库文字不能影响这条真实调用链。

现在管理项改为约 1681 字符的共同内容准则：保留演员、动作对象、左右关系、对白、先后与结果；按起始状态、接触/运动、结果/反应写可见行动；逐镜保留景别、构图、运镜和明确切镜。角色图负责身份与衣装，项目视频规则负责渲染媒介与光照，分镜负责镜头和行动。四视图的白底、排版、重复人物不能进入视频画面。

`composeVideoPromptPolicy` 将管理规则与选中模型模板合并，明确共同规则负责来源事实与有效槽位，模型模板负责其输出结构和语法。H3 继续用其专用六段格式、实际 Picture 顺序与当前画风规则。自定义管理规则到达真实 H3 写作请求的路径已由单条与批量接口隔离测试验证。其他模型的专用模板仍有各自规则，尚未逐模型做真实生成对照。

完整新稿：[videoPromptGeneration.md](/D:/Toonflow-app-master/data/modelPrompt/system/videoPromptGeneration.md)。这轮使管理项参与当前 H3，但没有重新生成、替换已有视频。

### 音色绑定

旧稿只有性别、年龄、性格三条匹配规则，没有区分稳定声线与临时表演情绪。模型实际只看到候选音频组的 ID、名称和描述，没有试听音频，也没有自动获得供应商音色目录或录音语言能力。

新规则先比较有证据的语言、口音与说话者要求，再比较稳定声音年龄、音高、质感、共鸣和清晰度；人格与职业只辅助。愤怒、惊恐、伤病或衣装状态不意味着更换声线。缺少信息视为未知，不能声称听过录音。同一角色最多选择一个，多个角色仍可复用同一候选。

工具契约明确为候选数字 ID 或 null。代码约束候选成员，核对恰好一次有效工具调用，并等待模型完整响应后才提交。无匹配、缺工具、重复调用、虚构 ID 或模型错误保留旧绑定，以现有失败状态提示；成功替换与完成状态放进同一事务，插入失败会回滚。模板走统一系统入口，目标与候选使用独立 JSON 来源数据。

完整新稿：[audioBindPrompt.md](/D:/Toonflow-app-master/data/modelPrompt/system/audioBindPrompt.md)。状态子资产自动继承父角色音色、音频子样本/语言元数据和实际录音可用性仍是单独的代码与数据议题。

## 网上资料中采用的做法

| 一手资料 | 本次采用 | 未照搬的部分 |
| --- | --- | --- |
| [Qwen Image 2.1 官方重写提示词](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_t2i.txt) | 分开已确定与开放内容；用位置、可见材料和明确光源描述画面，避免用评价词代替画面 | 固定长篇长度、替简短输入大量补造内容、它自己的 JSON 与比例字段 |
| [MiniMax H3 官方全参考指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) | 参考标签的用途与一致性，按播放顺序落实构图、行动、镜头和声音 | 不将 H3 语法套到其他模型；不将参考关系替代人物行动 |
| [Microsoft GraphRAG 领域适配说明](https://www.microsoft.com/en-us/research/blog/graphrag-auto-tuning-provides-rapid-adaptation-to-new-domains/) | 用实际领域的代表性示例明确边界 | 本项目不需要提取所有实体或复制其分隔符、关系协议 |
| [Qwen 工具调用文档](https://qwen.readthedocs.io/en/latest/framework/function_call.html) | 工具描述与真实 schema 统一字段契约 | 不新增第二套 ReAct 文本输出协议 |
| [ElevenLabs 官方 Voice Design](https://elevenlabs.io/docs/eleven-creative/voices/voice-design) | 声音属性、语言/口音、表达情绪分别判断 | 当前功能是已有候选绑定，不是调用服务新建声音；不能把未提供的声音特征当成已知 |

这些借鉴是针对本项目的实现选择，不是外部文档已经证明本项目视频会改善。

## 默认维护与保存

四项默认统一存放于 `data/modelPrompt/system`。新数据库初始化、既有数据库启动同步与事件/音色默认回退共用读取入口，避免 initDB 与 fixDB 的内嵌版本相互覆盖。

Node 和桌面开发从仓库读取默认，安装包从当前安装资源读取；旧 userData 文件不遮蔽新版默认。专用模型文件合并保留既有用户文件，管理自定义内容仍由 `useData` 优先控制。开发模式缺文件和安装升级读取旧默认的条件均已做隔离验证。

本次原四项数据库内容保存在 [before-db-prompts.json](/D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08/before-db-prompts.json)，修改前源代码位于同目录 `before-source`。源码备份使用 `.ts.bak` 后缀，避免被 TypeScript 当成项目代码编译。当前有效内容及哈希保存于 [after-prompt-checks.json](/D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08/after-prompt-checks.json)。四项均与当前默认文件一致，刷新后的管理页面也显示新稿。

## 验证与实际边界

- 150 项针对性测试全部通过，覆盖模板更新与自定义保留、桌面默认路径、事件格式、空资产结果、音色候选与事务保护、H3 调用和参考/语言隔离。日志：[targeted-tests.log](/D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08/targeted-tests.log)。
- 后端与桌面入口通过 esbuild 只编译检查，没有写入运行包。[bundle-check.json](/D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08/bundle-check.json)。
- 全项目 `tsc --noEmit` 仍未通过，包含已有备份目录、评测脚本 CommonJS/import.meta、图片轮询类型、前端路径配置等错误；不能把本次针对性测试结果称为全项目类型检查通过。[typecheck.log](/D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08/typecheck.log)。
- 四次真实本地事件文字对照使用当前 QWEN3.8:27b，温度 0.3、seed 42、think=false；同一案例的输入和参数一致，四份回复均正常结束并通过七字段校验。来源与哈希：[评测清单](/D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08/local-text-evaluation/event-extraction-manifest.json)。

| 文字案例 | 旧稿实际表现 | 新稿实际表现 | 判断 |
| --- | --- | --- | --- |
| 借款待答复与仓库被锁的平行线 | 两线均保留，但“已读未回复”写成“被无视”，加入无全书依据的“伏笔埋设” | 写“未获答复”，保留尚未联系与两线未汇合 | 新稿表述更准确；两稿均未单独写明资金尚未取得 |
| 未证实的保险箱称述与章末维护指令 | 保留称述未证实，未把被提及人物列为出场；未执行附文命令 | 明确“计划…尚未行动”和“主线待确认”，同样未执行附文命令 | 两者均有正确表现，不能宣称旧稿全面失效 |

样本仅覆盖两个事件场景，不构成视觉质量评测。资产、图片、已有视频与导演工作区未重生成或替换；本次八类生产表的前后行数与内容哈希一致，[生产数据核对](/D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08/after-production-digests.json)。下一次实际制作应重点观察角色身份与状态、动作因果、景别和切镜、对白与时长、最终材质及光照，分别定位文字计划偏差与视频模型执行偏差。

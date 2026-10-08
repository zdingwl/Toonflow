# 导演规划、分镜表与分镜面板质量审查（2026-10-08）

## 范围与证据

范围补充：本报告的导演/分镜数据库证据来自普通项目 1790665121730（项目页“重生三天，我囤爆整个海洋”）的 production 工作区，没有使用批量导入视频的 importStudio 数据。按用户补充的 `http://localhost:50188/#/project` 入口复查后的普通项目调用路径、缺陷可达性及第 60 集维护附录污染，见 `docs/project-flow-audit-2026-10-08-directing.md`；后者是本范围的进一步审查。

审查当前工作区源码、未提交差异、现有 Skills、今日导演优化文档及隔离评估稿；`data/db2.sqlite` 全程以 better-sqlite3 `readonly:true` 打开。未修改业务源码、数据库或任务，未发起文本/图片/视频生成。数据库样本是项目 1790665121730 的第 1、2 集。相关 21 项现有测试全部通过，另做纯函数反例检查。

这份审查把程序缺陷、制作设计缺口和人工审片判断分开。测试通过只能说明现有测试覆盖到的行为正确，不能证明好看、动作可执行或成片合格。

## 当前流程与真实样本

`productionAgent` 决策层派发：导演规划 → 衍生资产分析/图片 → 按场生成分镜表 → 监制文本审核 → 写入分镜面板 → 可选分镜图；视频工作台另行生成视频。导演计划和分镜表使用服务端事务写入、读回；面板新增与图片发起仍通过 Socket 回调前端，由前端调用 HTTP。

| 当前数据 | 第 1 集 | 第 2 集 |
|---|---:|---:|
| 分镜表 revision | 14 | 5 |
| 逐场完整状态 | 3/3，hash 匹配 | 3/3，hash 匹配 |
| 镜头数量 | 9 + 9 + 19 = 37 | 6 + 10 + 11 = 27 |
| 制作时长 | 25 + 22 + 62.5 = 109.5 秒 | 28 + 39 + 28 = 95 秒 |
| 当前纯程序校验 | 3 场全部通过 | 3 场全部通过 |
| 真实 o_storyboard | 12 条 | 0 条 |
| 面板图片要求 | 12 条均 shouldGenerateImage=0，prompt 空 | 尚无真实面板 |
| 导演计划形态 | 统计表、注意事项、过渡 | 统计表、注意事项、过渡 |

第 1 集走直接多参考视频路线：面板是一整片段的镜头表，未要求先生成分镜图。不能因为面板图为空就判断流程失败，也不能因此说有可供导演预览的场景构图。第 2 集 JSON 工作区仍残留一个 id13、8 秒的旧面板，但真实表没有该集记录；HTTP `/production/getFlowData` 会用真实 `o_storyboard` 重建面板数组，所以刷新后的实际面板应为空。这个残留副本不能当作真实执行记录。

今日 `docs/director-plan-evaluation/episode-1-final.md` 已有 12 个节拍和完整导演意图，但还没有替换上述两集生产计划。`directorPlanContext.ts` 把完整原文、当前预算、画幅/题材直接注入，限制导演温度最多 0.6，是有效进展；不能把隔离文本候选当作生产链已经改善。

## 已确认程序缺陷

### D1：对白全局顺序丢失，倒转因果也能判通过（高）

- 代码：[storyboardValidator.ts](D:/Toonflow-app-master/src/agents/productionAgent/storyboardValidator.ts:56)，56–70 行。
- 根因：按说话人聚合全部台词后分别比较；保留同一人的局部顺序，丢失跨说话人的全局顺序。
- 本次复现：来源是“甲：你来了。→乙：我来了。”，镜头表改成“乙答→甲问”，结果仍 `valid:true, coverageVerified:true`。
- 建议：来源解析为具有 sourceDialogueId、speaker、text、ordinal 的事件序列。拆句允许一个来源事件映射多镜，校验映射顺序及每个事件恰好完整覆盖，不把跨角色聚合字符串作为覆盖结论。

### D2：对白时长没有进入保存校验（高）

- 代码：[storyboardValidator.ts](D:/Toonflow-app-master/src/agents/productionAgent/storyboardValidator.ts:30)，30–41、50–52 行只校验数值与合计；[storyboardContentGuard.ts](D:/Toonflow-app-master/src/agents/productionAgent/storyboardContentGuard.ts:12)仅传预算与资产 ID。
- 本次复现：约 90 字的中文台词放在 1 秒镜头、片段与场预算也都为 1 秒，依然 `valid:true, coverageVerified:true`。
- Skills 已要求约 4 字/秒初估和并行/串行关系；实现完全依赖模型自检、监制文字，没有确定的 timing finding。
- 建议：保存时给出真实估算依据、口播开始/结束、停顿及必须串行动作。没有真实音轨时标“估算”，明显超限先阻止进入视频；不能把一切动作时长相加，也不能固定增添每标点 1 秒。实测/生成音轨可用时替换估算。

### D3：手动改面板绕过旧提示词失效与关联同步（高）

- 入口：[storyboard.vue](D:/Toonflow-app-master/Toonflow-web-master/src/views/production/node/storyboard.vue:438)。
- 服务端：[editStoryboardInfo.ts](D:/Toonflow-app-master/src/routes/production/storyboard/editStoryboardInfo.ts:18)只更新 prompt/videoDesc。
- 正常 AI 修订路径：[storyboardRevision.ts](D:/Toonflow-app-master/src/agents/productionAgent/storyboardRevision.ts:80)调用面板同步，[storyboardPanelSync.ts](D:/Toonflow-app-master/src/agents/productionAgent/storyboardPanelSync.ts:31)调用旧视频提示词失效。
- 影响：用户在面板修正动作后，轨道旧视频提示词、时长、资产关系仍可保留为可执行输入；修正不一定进入下游。随后总表修订又可能因两份文本不同而拒绝。
- 建议：统一修订事务，面板编辑须携带 project/script、sourceRevision 和 expectedHash，更新实际镜头结构与关联，归档旧词并使未来视频提示词失效，保留已生成视频/选择；明确独立面板变更如何回写或派生于总表。

### D4：人工总表保存也绕过内容审核、面板同步与提示词失效（高）

- 代码：[saveFlowData.ts](D:/Toonflow-app-master/src/routes/production/saveFlowData.ts:75)，75–85 行检测人工总表变化后删除 progress；44–51 行旧单场入口直接 merge。
- 两个分支都不调用 guardStoryboardContent、syncRevisedStoryboardPanels、markStoryboardPromptsStale。
- 删除进度能避免伪造旧快照，但不会使旧面板与视频输入对应新文本。也缺少导演人工编辑的事实校验。
- 建议：用户改文稿也走同一个受控修订命令。人工修改不应因“无需模型”就跳过一致性与最低制作可行性检查。

### D5：分镜图缺参考时静默丢弃，@图序号会偏移（高）

- 代码：[batchGenerateImage.ts](D:/Toonflow-app-master/src/routes/production/storyboard/batchGenerateImage.ts:110)，110–118 行丢失未选图资产；[同文件](D:/Toonflow-app-master/src/routes/production/storyboard/batchGenerateImage.ts:212)，212–230 行把找不到/读失败的图片变成 null 再 filter(Boolean)。
- 影响：原提示词 @图1 人、@图2 场景、@图3 道具，第一或第二张失效后，后续图片前移；提示词仍使用原编号。模型成功返回也可能画错角色或场景。
- 建议：冻结一个与文本完全一致的参考计划，校验每个 assetId、imageId、fingerprint 与可读性；必要图缺失明确报错，禁止默默改顺序。参考内容变化后使图片/视频候选的来源状态可识别。

### D6：逐镜首帧面板无法使用现有总表修订同步（中）

- 首帧契约：[production_execution_storyboard_panel.md](D:/Toonflow-app-master/data/skills/production_execution_storyboard_panel.md:30)，每镜一块，videoDesc 为该镜的描述。
- 同步代码：[storyboardPanelSync.ts](D:/Toonflow-app-master/src/agents/productionAgent/storyboardPanelSync.ts:13)，13–24 行只按整片段正文精确匹配一块面板。
- 本次用标准逐镜面板描述模拟，未独立修改也收到“有独立修改或映射不唯一”。所以目前已验证的同步只覆盖一个片段一块的多参模式。
- 建议：新增稳定 sceneId/beatId/shotId/segmentId、sourceRevision，映射由服务端编译器保存；不能把自由文本相同视为唯一关系。数量变化仍保留明确重编排流程和历史。

### D7：总表提交后，当前浏览器面板副本不会自动刷新（中）

- 服务端 revision 事务更新 o_storyboard，但通知只返回总表/进度：[storyboardRevision.ts](D:/Toonflow-app-master/src/agents/productionAgent/storyboardRevision.ts:95)。
- 前端 [productionAgent.ts](D:/Toonflow-app-master/Toonflow-web-master/src/stores/productionAgent.ts:92)，92–104 行只更新 storyboardTable/progress，不刷新 storyboard。
- Agent 读取 assets/storyboard 则依赖该浏览器副本：[tools.ts](D:/Toonflow-app-master/src/agents/productionAgent/tools.ts:150)，150–166 行。
- 建议：修订回执包含受影响面板与轨道，或前端按版本定向重取；Agent 的执行数据从服务端真实表读取。JSON 工作区面板缓存可保留，但不得作为生成权威源。

## 已确认质量设计缺口

### Q1：审核仍主动排除缺失基础资产

[production_agent_supervision.md](D:/Toonflow-app-master/data/skills/production_agent_supervision.md:131)，131–132 行要求缺少角色/道具/场景资产不报告；150–151 行只有资产库已有相应资产才审核关联。

实际第 2 集 Sc2，超市、户外店、工业供应商三个地点的四个片段全部仅引用 `[1,217]`（艾娃＋系统采购扫描界面），没有场景参考，且数据库六场结构校验全部通过。视频模型可根据文字生成地点，但没有稳定场景拓扑、货架布局或视觉证据。应允许“缺少制作所需参考”作为可操作问题：明确允许临时背景/自动提取候选/复用适配场景/用户接受无专门参考；不要把缺口从审核结果里排除。

### Q2：监制没有看到图片，无法证明图与文字一致

[productionAgent.ts](D:/Toonflow-app-master/Toonflow-web-master/src/stores/productionAgent.ts:108)，108–126 行把资产、衍生资产、分镜的 src 删除；分镜 prompt 也被删除。当前生产子 Agent 可调用读取与技法文本工具，没有获得可查看参考图的执行入口。因此“身份/姿态/场景连续性”主要是对文字描述的审核。不能把名字、状态、存在 ID 当作实际视觉质量。

建议独立视觉审核当前选图和候选：全角色表身份是否一致、衣服是否正确、人物动作与支撑、场景是否可拍、道具数量和文字载体；生成候选默认保留历史，经人工/视觉检查再采用。视觉模型能力/配置需另行验证；当前只有文本配置证据。

### Q3：今天导演契约改善，但新结果缺少硬结构版本与执行映射

[screenplay.ts](D:/Toonflow-app-master/src/agents/productionAgent/screenplay.ts:100)没有精确命中“逐场导演设计”标题就跳过所有节拍检查。保留旧稿可读是合理兼容，但新任务也可提交旧格式，且没有 qualityVersion。节拍检查仅确认区间连续与预算，不验证来源锚点、局势变化、表演可拍性、状态链。

分镜协议 [index.ts](D:/Toonflow-app-master/src/agents/productionAgent/index.ts:330)直接注入原本场、统计和上一场最后 800 字，完整导演设计则要求模型自行 get_flowData 读取。Skill 要求读取，但没有程序断言已经读全，也没有输出“哪个 beat 被哪个 shot 覆盖”。新导演意图可能在下游重新创作时丢失。

建议新生成采用带版本的结构数据；旧版本标出缺少导演设计、不阻止查看。场目标、观众新信息、节拍 sourceRef、entryState/exitState、speaker/prop/location 清晰保存；每镜引用 beatId，镜头编译核对覆盖/状态连续。只增加文档长度没有完成交接。

### Q4：全部场次完成与质量批准仍主要靠模型口头调度

[production_agent_decision.md](D:/Toonflow-app-master/data/skills/production_agent_decision.md:11)要求监制通过才进面板，[index.ts](D:/Toonflow-app-master/src/agents/productionAgent/index.ts:395)只返回监制自由文本；[batchAddStoryboardInfo.ts](D:/Toonflow-app-master/src/routes/production/storyboard/batchAddStoryboardInfo.ts:37)校验项目、ID与幂等，未检查所用分镜 revision/批准状态/当前总表片段是否完全一致。

建议形成绑定 sourceRevision 的结构审核结果（程序事实、文本语义、视觉、人工采用分别有状态）；面板编译读当前明确采用的版本，编译后核对数量/时长/参考。不用再增加一层自由文本“打分 Agent”冒充确定结果。

### Q5：实际分镜有重复动作与高生成复杂度

此项是对当前保存文本的制作判断，不是视频实测结论：

- 第 1 集 Sc3 最后片段先“结束通话，把手机放桌上”，两镜后又“收起通话浮窗…放下手机”；没有中间拿起行为，重复同一信息和动作。
- 一次 23 字物资报价被 7＋9 秒两个近景承载，导演目标/新信息变化不足，末世备战的推进容易变成持续拨电话。并非单凭镜头超过 8 秒就错误，需要证明表演和局势持续推进。
- 第 2 集 Sc3 写“用手指连出三条路线，笔迹沿墙面延伸”，未交代使墙面产生笔迹的工具/机制；属于可拍摄性缺口。
- 第 1 集 Sc1 在 6 秒片段内含掰开最后抓握、两个人高度关系、落水、鲨攻击、船与水下两种场景；文字上覆盖并不证明一轮生成能保留每个物理状态。
- 第 1 集 Sc3 首片段 15 秒内含惊醒、屏幕、卧室/起居区位置变化、电视字幕、多个闪回地点、系统模块，当前多参面板没有给这些变化先验构图与逐段 visual proof。

应以完整戏剧动作/状态为单位做小样：需要复杂接触的镜头先证实构图与起始/终止状态；信息页和字幕另验证可读性，必要时合成。不要继续加长所有 videoDesc 来解决执行难度，也不要固定要求每个节拍一镜或所有镜头都 3 秒。

## 建议实施顺序

1. 优先修复参考计划/图片输入一致性、人工编辑失效链、对白顺序、明确不可完成的口播时间，先消除“看似正常但实际喂错”的行为。
2. 将导演计划/镜头/片段做成最小结构编译链，保留 Markdown 作为可读视图；让面板编译成为确定性代码，模型只创作需判断的内容。
3. 为当前角色与核心场景建立真实视觉验收，先做同一主角、两人接触、动作接续、信息界面四类小样。至少核对实际图和成片帧，比较成功样本与失败样本的参数/输入，避免仅用成功 toast 或长文本评估。
4. 最后调整节奏和审查 UI：比较“来源事件覆盖→观众新信息→演员可见变化→时长”，将重复动作合并、信息密集处留读取窗口、关键选择留反应；影片节奏不能由 15 秒 provider 上限直接决定。

现有资产、视频选择、生产工作区和生成历史应继续保留；新增版本只使未来输入清楚失效，不自动重生成/替换已有结果。

## 验证记录

运行：`node_modules/.bin/tsx.cmd --test tests/director-plan.test.ts tests/director-plan-context.test.ts tests/storyboard-panel-sync.test.ts tests/screenplay-continuity.test.ts tests/storyboard-revision.test.ts`。

结果：21 passed / 0 failed。测试使用内存 SQLite 或临时目录，不写生产数据库。

纯函数反例：跨说话人次序倒转仍 coverageVerified；超长对白仅 1 秒仍 coverageVerified；仅统计表没有导演设计仍 validateDirectorFacts=[]；逐镜标准 videoDesc 被整片段同步判断为冲突。未提交反例测试文件，因为本次为审查，不修改业务实现。

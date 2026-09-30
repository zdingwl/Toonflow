---
name: production_execution_storyboard_panel.md
description: >-
  视频制作执行层Agent技能 — 分镜面板写入。
  采用路由模式：先识别决策层派发的写入模式（纯文本多参 / 故事板辅助多参 / 首位帧），
  再进入该模式专属、自洽、零条件分支的流程，逐行写入分镜面板。
---
# 执行层 Agent — 分镜面板写入

你是视频制作项目的**执行层 Agent**，接收决策层派发的任务指令并执行。

## 通用规则

- 执行前先调用 `get_flowData` 确认工作区状态；已有内容在其基础上修改，除非指令要求重写
- 只执行当前任务对应的工作，不越权执行其他阶段
- 完成写入后返回一句简短确认即可，不复述完整内容；返回后本次任务终止

---

## 五、分镜面板写入

### 工具

| 操作 | 调用 |
|------|------|
| 读取剧本 | `get_flowData("script")` |
| 读取分镜表 | `get_flowData("storyboardTable")` |
| 写入分镜面板（逐条） | `add_flowData_storyboard({ ... })` |

**`add_flowData_storyboard` 参数**（**每个写入单位调用一次**，不再输出 `<storyboardItem>` XML）：

| 参数 | 类型 | 说明 |
|------|------|------|
| `videoDesc` | `string` | 画面描述、场景、关联资产名称、时长、景别、运镜、角色动作、情绪、光影氛围、台词、音效、关联资产ID（**故事板辅助多参模式**为固定文本） |
| `prompt` | `string \| null` | 分镜图片提示词；本模式无 prompt 时传 `null` |
| `track` | `string` | 分组 |
| `duration` | `number` | 视频推荐时长（秒） |
| `associateAssetsIds` | `number[] \| null` | 该分镜/组所需的资产ID列表 |
| `shouldGenerateImage` | `"true" \| "false"` | 是否生成分镜图（字符串枚举） |

### 路由（第一步必做）

本阶段为**路由模式**：先识别决策层派发指令中明确携带的**写入模式关键词**，再进入该模式专属流程执行。**模式由决策层指定，执行层不自行判断**。

| 派发模式 | 进入流程 | 关键差异 |
|----------|----------|----------|
| **纯文本多参模式** | → [流程 A](#流程-a--纯文本多参模式) | 不加载技法、不生成 prompt/分镜图；**以表内 `### 片段` 为写入单位**（track 顺序累加） |
| **首位帧模式** | → [流程 C](#流程-c--首位帧模式) | 完整生成 prompt 与分镜图；**不分组**，每行独立一组 track 递增 |

> 进入对应流程后严格线性执行，流程内不再做跨模式判断。全部流程共同遵守文末「[全模式共享硬约束](#全模式共享硬约束)」。

---

### 流程 A · 纯文本多参模式

**特征**：仅写入视频描述与资产绑定，不生成提示词、不生成分镜图。**以分镜表已有的 `### 片段` 为写入单位**——不自行重新分片，每个片段写入一条视频段（一次 `add_flowData_storyboard` 调用）。严格线性，自洽。

**第 1 步 · 读取数据**
同轮调用 `get_flowData("script")`、`get_flowData("storyboardTable")`。**本模式不加载任何提示词技法**（无需 `storyboard_prompt_techniques` / `director_storyboard`）。分镜表已按「场（`## 场N`）→ 片段（`### 片段…`）」预先切分，本模式**直接沿用表内片段，不再自行做 ≤15s 分组**。每个片段先读取 `**连续性契约**`，它是首尾状态与跨场承接的机器依据。

**第 2 步 · 逐片段写入视频描述（videoDesc）**
以分镜表的每个 `### 片段` 为单位，按以下固定顺序写入：
1. **连续性契约原文**：完整保留该片段的单行 `**连续性契约**：{...}`，不得改写 JSON、状态 ID、group、axisLock 或 screenDirection。
2. **承接说明**：
   - `continuityMode=PRESERVE`：必须从契约的 `entryStateId / entrySummary / axisLock / screenDirection` 开始，明确“本片段首帧继承该状态”。这条规则**允许并要求跨场承接**；场界本身不能把连续动作清零。
   - `continuityMode=RESET`：明确这是导演规划允许的新状态建立，不继承上一片段即时姿态；但角色身份、服装状态和剧情事实仍遵守当前资产/剧本。
3. **该片段分镜行原文**：完整保留 7 列表格中的序号、画面描述、时长、景别、运镜、台词、音效；不擅自补不存在的“角色动作/朝向/空间关系”独立列。

连续性不再由本阶段重新“猜上一镜末帧”。`PRESERVE` 时，契约就是上游已经确认的入口状态；`RESET` 时也只有契约允许的状态可重建。若发现本片段 entryStateId 与上一片段 exitStateId 不一致，应停止写入并报告上游分镜表问题，不得自行修正文案掩盖冲突。

**第 3 步 · 逐片段调用 `add_flowData_storyboard` 写入**
以每个 `### 片段` 为单位逐条调用：
- `videoDesc`：第 2 步整理的“连续性契约 + 承接说明 + 该片段7列表格原文”
- `prompt`：`null`
- `track`：按片段顺序递增，跨场继续递增
- `duration`：取片段标题标注时长，并与片段内镜头合计一致
- `associateAssetsIds`：取该片段自己的 `引用资产ID`，不得假设同场全部片段共用同一组资产
- `shouldGenerateImage`：`"false"`

```
add_flowData_storyboard({ videoDesc: "连续性契约 + 承接说明 + 片段原文", prompt: null, track: "顺序递增", duration: 片段时长, associateAssetsIds: [该片段资产ID], shouldGenerateImage: "false" })
```

**第 4 步 · 结束**
仅返回一句确认：`已完成分镜面板写入（纯文本多参模式）`。

---

---

### 流程 C · 首位帧模式

**特征**：完整生成提示词并生成分镜图，激活 `storyboard_prompt_techniques` + 风格专属 `director_storyboard`，**每条分镜独立一组**，提示词按**首帧原则**转换；含人物连贯性预分析、`@图N` 标注、六项忠实性校验全链路。严格线性，自洽，零条件分支。

**第 1 步 · 读取数据并激活技法**
同轮调用 `get_flowData("script")`、`get_flowData("storyboardTable")`（**本阶段不读取导演规划 `scriptPlan`**——分镜表已是导演规划的完整落地，执行层只依据分镜表写入）；并激活技法 `storyboard_prompt_techniques`（通用提示词技法参考，含解析映射规则、景别词库、输出格式规范、提示词结构框架、画质规范、图像资产标注规则、人物位置连贯性规则）与风格专属技法 `director_storyboard`（提示词生成的全部参考依据），冲突时以风格专属技法为准。

**第 2 步 · 连续性与首帧预分析**
正式写入前通读全部分镜表，以每个片段的 `**连续性契约**` 建立状态链：
- `entryStateId / entrySummary` 是该片段第一帧的权威起始状态；`exitStateId / exitSummary` 是该片段结束状态。
- `PRESERVE` 片段必须沿用上一片段（包括跨场）的 continuityGroup、axisLock、screenDirection 以及契约指定的姿态/支撑/道具状态；不得因为生成一张新分镜图而把人物恢复成资产设定图站姿。
- `RESET` 片段才允许建立新的时空构图；仍要服从角色当前有效资产状态。
- 具体画面左右位置、面向、支撑关系优先读 entrySummary/exitSummary 和 7 列中的“画面描述”；不要寻找不存在的独立 orientation / spatialRelation / action 列。
- 若契约与画面描述矛盾，停止并报告分镜表冲突，不自行选择一个版本继续生成。

**第 3 步 · 确定分组（track）**
**不分组**：每条分镜独立一组，`track` 按顺序递增（第 1 行 track=1，第 2 行 track=2，以此类推）。每条 `duration` 必须严格使用 `storyboardTable` 对应行时长。

**第 4 步 · 图像资产标注与正文绑定**
为每条分镜的 prompt 生成图像资产标注前缀，按 `associateAssetsIds` 的引用顺序，依次标注 `@图N 为xx{类型}`；**提示词正文中所有涉及该角色/场景/道具的位置，必须使用对应的 `@图N` 替代其名称**，建立参考图与画面描述的直接绑定（依据已加载技法中的「prompt 图像资产标注规则」）。

**第 5 步 · 生成视频描述（videoDesc）**
根据当前片段/镜头的 `连续性契约 + 7列表格（画面描述、时长、景别、运镜、台词、音效）+ 引用资产` 生成 `videoDesc`。第一句明确 entryStateId/entrySummary；若为 PRESERVE，写明继承上一状态。**禁止包含任何光影/色温/明暗/色调描述**。

**第 6 步 · 生成提示词（prompt）并忠实性校验**
逐行读取 `storyboardTable` 对应片段的连续性契约，以及该行「画面描述 / 景别 / 运镜 / 台词 / 音效」，严格按已加载技法中的内容忠实性原则映射为提示词；首帧必须先满足契约的 entryState，再表现本镜动作。**提示词正文不得包含光影/色温/明暗/色调描述**。**生成每条提示词后须立即逐字段比对分镜表原始内容**，确认：
1. 连续性契约的 entryStateId / entrySummary / axisLock / screenDirection 已落实，PRESERVE 没有状态复位
2. 画面描述中的所有可见主体、动作因果和空间关系均完整保留
3. 提示词中无光影/色调相关词汇
4. 景别与运镜匹配
5. 台词和动作顺序一致
6. 若本镜改变朝向/位置/支撑/持有物，变化过程在画面描述中有明确动作原因

校验不通过须修正后再进入下一步。

**第 7 步 · 逐行调用 `add_flowData_storyboard` 写入**
严格按 `storyboardTable` 的分镜数据行**逐行调用** `add_flowData_storyboard`（每行一次，排除表头与分隔行），参数取值：
- `videoDesc`：第 5 步生成的该行视频描述
- `prompt`：第 6 步生成并校验通过的该行提示词
- `track`：按顺序递增的独立分组（字符串）
- `duration`：**直接取该行时长**数值
- `associateAssetsIds`：该分镜所需的资产ID列表
- `shouldGenerateImage`：`"true"`

```
add_flowData_storyboard({ videoDesc: "视频描述", prompt: "提示词内容", track: "按顺序递增的独立分组", duration: 视频推荐时间, associateAssetsIds: [该分镜所需的资产ID列表], shouldGenerateImage: "true" })
```

**第 8 步 · 结束**
仅返回一句确认：`已完成分镜面板写入（首位帧模式）`。

---

### 全模式共享硬约束

以下约束取值跨模式恒定，**所有流程（A/B/C）均须遵守**：

- **前置条件**：分镜表已构建完成且用户已确认
- **videoDesc 必填**：每个写入单位的 `videoDesc` 必须包含对应的连续性契约、首帧承接说明、7列分镜信息与关联资产；不得虚构当前执行表中不存在的独立 action/orientation/spatialRelation/emotion 字段（**故事板辅助多参模式例外**——`videoDesc` 为固定文本 `参考故事板内容进行视频生成`，画面信息由故事板图承载）
- **光影/色调排除**：`videoDesc` 与 `prompt` 中均**禁止包含任何光影方向/色温/明暗/色调描述**——这些视觉参数由视频模型从场景图参考自动推导，agent 显式描述会与场景图原生光影冲突
- **音乐排除**：`videoDesc` 与 `prompt` 中均**禁止包含任何音乐/配乐描述**，仅可承载「音效」列对应的环境音/动作音
- **逐条写入**：必须调用 `add_flowData_storyboard` 写入工作区分镜面板，**每个写入单位调用一次**（不再输出 `<storyboardItem>` XML）；逐条写入，不遗漏、不重复、不合并多个写入单位
- **数量一致性**：`add_flowData_storyboard` 调用次数必须与模式写入单位一致——纯文本多参以 `### 片段` 为单位，首位帧模式以表格数据行为单位；均不含场标题、片段标题、契约行、表头与分隔行
- **时长一致性**：分镜面板 `duration` 必须与对应写入单位时长一致——纯文本多参取片段标题时长，首位帧模式取数据行时长
- **阶段边界**：本阶段禁止调用 `generate_storyboard_images`

> 取值随模式而异的约束（track 分组规则、`prompt` 取值、`shouldGenerateImage`、prompt 内容忠实性、技法激活、人物位置连贯性校验、图像资产标注）已在各自流程内正向声明，不在此重复。

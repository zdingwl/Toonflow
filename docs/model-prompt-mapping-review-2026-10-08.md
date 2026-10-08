# 模型映射与模型专用提示词审查

审查环境：`D:\Toonflow-app-master`，`http://localhost:50188/#/project`，2026-10-08。此次沿用正常项目流程，重点修复模型专用规则的内容、来源与实际读取关系。前面的四项任务规则另见 [提示词管理审查](D:/Toonflow-app-master/docs/prompt-management-review-2026-10-08.md)。

## 结论

截图里的问题确实会影响生成。四份旧视频模板依赖已过时的输入格式，H3 的镜头规则又与上游分镜表冲突；绑定页面允许选择系统任务规则，而 H3 运行时还会忽略用户选择。已经修正五份视频模板、共同准则和读取链，并完成本地页面核验。此次没有生成或替换人物图片、分镜图片和视频，不能把规则修复视为成片质量已验收。

## 查到的问题与影响

| 问题 | 实际影响 | 本轮处理 |
| --- | --- | --- |
| 视频候选扫描整个 modelPrompt 目录 | 事件提取、资产提取、音色绑定也可绑给视频模型；普通视频可能收到完全不同的任务规则 | 只扫描 video 文件，绑定前校验模型、文件与兼容性 |
| H3 多参考固定读取内置文件，绕过绑定表 | 用户保存自定义规则成功，实际生成却没有使用 | 页面与生成共用模板解析；合法显式绑定优先，取消后按模型与生成模式自动选择 |
| 通用和 Wan 仍要求十二个顿号字段、虚构 XML 属性和 prop 类型 | 当前实际七列表格、数字 ID、tool 类型被错读；示例外貌可能变成新剧情 | 四份旧模板全部改用真实输入，并兼容旧自然语言分镜 |
| 上游每行一镜，下游却要求只有显式 cut 才拆镜 | 同景别、固定机位或连续动作的多行可能被合并，丢失镜头节奏 | 有效七列行按独立镜头编译；H3 对可靠 cameraPlan 使用实际累计时点 |
| 全景被解释成环境建立镜头，首尾帧一律禁止切镜 | 人物动作退化成远景展示，源分镜的合法切镜被抹掉 | 全景人物动作保留全身与支撑；首尾帧用途与源镜头边界分开处理 |
| 参考媒体和编号推断错误 | 把 audio/video 当图片；按资产顺序重编号；把音色关联当实际上传 | 输入增加 mediaType、mediaIndex、frameRole，模板只遵循实际清单 |
| CRUD 可以跨入 system、覆盖同名文件、删除已用模板 | 系统默认损坏、失效绑定或悄悄回退，后续结果难以复现 | 安全文件名、video 子目录与真实路径检查；创建不覆盖；内置及已用文件禁止删除 |
| 失败正文或空响应可能被保存为完成 | 超时长提示变成可提交的视频正文，旧有效提示词被错误替换 | H3 与普通视频统一拒绝空响应及明确的时长/参考失败回复，保留旧正文 |

将默认系统文件移入 modelPrompt/system 后，原来的全目录扫描暴露了混列；这是前一轮改动遗漏的相邻调用点，此次已经补齐。

## 五份模型规则的具体变化

- [H3 多参考](D:/Toonflow-app-master/data/modelPrompt/video/minimaxH3Multi-referenceMode.md)：保留官方六个章节、Subject/Picture 固定绑定、完整人物板占一个 Picture，以及身份与项目渲染各自的职责。新增有效表格每行独立镜头、可靠时点上的切镜和无法容纳完整动作/对白时的失败出口。共同准则、H3 上下文和项目视频手册同步修改，避免最后一层重新要求一镜到底。
- [Seedance 2](D:/Toonflow-app-master/data/modelPrompt/video/seedance2Multi-parameterMode.md)：区分图片、视频和音频参考，依据各类实际序号明确指代；允许实际上传的分镜图提供构图依据。删掉全部素材都写成图片、禁止光影、固定刻板音色推断和虚构的输入包装。
- [通用首尾帧](D:/Toonflow-app-master/data/modelPrompt/video/universalFirstAndLastFrameMode.md)：按真实帧用途解释起止状态，正文重点写运动、变化与镜头。删掉固定五段重复清单、示例擅加衣装/写实画风，以及首尾帧就必须一镜到底的要求。
- [通用多参考](D:/Toonflow-app-master/data/modelPrompt/video/universalMulti-parameterMode.md)：不再假定所有模型有统一原生标签。已有原生映射时复用；没有时使用清楚的自然语言参考说明，不凭数据库 ID 另算上传序号。
- [Wan 2.6](D:/Toonflow-app-master/data/modelPrompt/video/wan2.6Single-imageFirstFrameMode.md)：明确 I2V 是单首帧，R2V 使用实际图像/视频混合顺序对应 characterN。音频不占角色参考序号；提示词不能代替供应商参数切换 API 或强制多镜头。

四份旧模板合计约 39,949 → 19,908 字节。减少的是重复要求、过期结构和无依据推断；完整对白、动作因果、景别、切镜与参考关系仍需保留。

普通视频的项目渲染手册原来作为 assistant 消息传入；现在提高到 system 的明确规则，避免被旧专用模板里的示例画风覆盖。编译器没有收到图像像素时，不允许声称看见了人物外貌或首尾帧细节。

## 网上资料采用了什么

1. [MiniMax 官方 H3 Ref2VA 指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)：采用六段结构、稳定引用含义、首镜无时间戳及后续切镜时间戳，保留对白原语言。项目每行一镜来自本项目的分镜表契约，不能假称是官方对所有输入的要求。
2. [火山引擎 Seedance 2 提示词指南](https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh)：采用明确指定每个参考的用途，分别处理图片、视频和音频。平台支持分镜参考不代表本次一定上传了分镜图；必须以真实输入为准。
3. [Runway 图生视频指南](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide)：仅采用图像提供静态依据、正文重点描述运动的写法，不把 Runway 的模型语法移植给其他供应商。
4. [Wan I2V API](https://www.alibabacloud.com/help/en/model-studio/legacy-image-to-video-api-reference/) 与 [Wan R2V API](https://help.aliyun.com/zh/model-studio/legacy-wan-reference-to-video-api-reference)：分别核对首帧、统一参考顺序、提示词长度和镜头参数边界。实际多镜头能力由服务请求参数决定，不能仅靠正文保证。

## 页面与调用关系

这个映射功能当前只被视频提示词生成消费，人物资产与分镜绘图使用各自的任务规则和 Skills。因此 Qwen 四视图和 Ollama 分组显示空表，并不能证明对应模型未配置；它们没有视频模型，这个接口原来却仍返回空分组。现在只显示有视频模型的供应商，并说明此处的管理范围。

当前配置共八个视频模型，H3 的原绑定文件没有变更。H3 候选只包含兼容规则，新增提示词预填当前模型规则后另存为自定义文件；保存自定义绑定后实际调用该文件。编辑失败不会覆盖原文件，取消弹窗不会修改原表格状态。未绑定时按实际生成模式选择自动规则，支持多种规则的模型显示“自动按生成方式选择”。

实际读取：[modelPromptTemplates.ts](D:/Toonflow-app-master/src/utils/modelPromptTemplates.ts)、[videoPromptGeneration.ts](D:/Toonflow-app-master/src/utils/videoPromptGeneration.ts)。界面：[modelMap.vue](D:/Toonflow-app-master/Toonflow-web-master/src/components/setting/components/modelMap.vue)。

![修复后的 H3 绑定候选](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/after-h3-binding.png)

## 验证与边界

- 最终相关回归 **221/221 通过**，包含真实 Express 路由、临时模板目录、内存 SQLite，以及 H3 自定义规则实际进入模型请求、取消后恢复默认、错族/错模式拒绝、源行时点、空响应及明确失败不覆盖旧正文。证据：[final-tests.log](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/final-tests.log)。
- 前端 Vite 构建成功，产物放入临时目录，未覆盖已有部署包。本地 50188 是开发服务，已经呈现修改。后台和桌面入口均完成 bundle 检查：[bundle-check.json](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/bundle-check.json)。全仓库 `tsc --noEmit` 仍失败，包含已有前端/旧文档与脚本类型问题；本轮新增模板管理 helper、映射接口和新契约测试没有匹配到类型诊断。证据：[typecheck.log](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/typecheck.log)，不把打包成功等同于全仓库类型通过。
- 已登录页面验证了最终候选、实际绑定和取消弹窗后的原绑定保留。未带用户 token 的直接 API 请求返回 401；没有绕过认证，也不把该请求记录为接口成功证据。
- 本地 Qwen 的隔离 H3 文本样本在十分钟限制内未得到可用结果，当时模型驻留查询显示 size_vram=0。没有生成视频、没有覆盖持久提示词，不能据此判断模型必然执行全部镜头或成片观感已经改善。
- 原文件备份在 [before-source](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/before-source) 与 [before-templates](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/before-templates)。已有资产、图片、分镜、轨道、视频、语言版本与导演工作数据的摘要保持一致；原有七十条剧本也保持一致。

运行期间另有“新剧本”项目新增二十条剧本并开始资产提取。我重启开发后端中断了这项并行工作；核对时没有新资产或关联提交，二十条提取状态被启动逻辑标为软件退出失败。已通过已登录页面恢复这二十条提取，保留“更新已有资产描述”未勾选，数据库与页面均回到提取中。此处确认的是恢复执行，尚未确认提取最终完成。状态证据：[recovered-asset-extraction.json](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/recovered-asset-extraction.json)。原有数据保留检查见 [final-existing-data-checks.json](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/final-existing-data-checks.json)。没有删除这批新增剧本，没有自动重做已完成媒体。

![并行提取已恢复执行](D:/Toonflow-app-master/docs/model-prompt-mapping-review-2026-10-08/recovered-asset-extraction.png)

后续应以同一组当前参考图、同一模型参数和相同源分镜做小规模前后成片比较，逐项检查身份、渲染媒介、动作因果、镜头边界、对白与嘴型。对格式正确但仍漏镜、改动作或换脸的样本，继续修对应源规则；仅靠增加形容词、要求“更电影感”或放宽验证不能解决这些内容问题。

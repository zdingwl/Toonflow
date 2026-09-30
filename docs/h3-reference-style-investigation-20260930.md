# H3 人物画风一致性：2026-09-30 实测

## 结论与依据

用户提供的卡通大眼视频，对应项目 1790665121730、轨道 1790715576565、历史视频 2。实际选中人物图是资产 202 的完整四视图板，场景是资产 5。此次检查实际数据库、图片、视频和 ComfyUI 历史任务，未仅根据截图推断。

发现两个独立问题：

1. 原生 H3 provider 把参考图写成 `inputs.ref_images.ref_image_0` 的嵌套对象。ComfyUI V3 Autogrow API 要求输入键为扁平字符串 `"ref_images.ref_image_0"`。旧格式不报错，但本机输入解析器收到 0 张图；修正格式收到 2 张图。此前传入了 LoadImage 节点，却没有建立有效的参考连接。
2. 上游视频提示词模板固定指定 `premium semi-realistic Chinese 3D donghua character asset` 和风格化脸部比例。这会给近自然比例的参考脸增加无依据的风格指令。模板现在先读图，描述能看清的眼脸比例、眼睑、鼻梁、下颌、皮肤、头发和服装表面，限定表情和光照变化不能重新设计脸。

保留一张完整人物板占一个 Picture、原有六段 Ref2VA 格式、20 步、768p、无 Turbo LoRA、已完成视频及其他语言数据。

## 一手资料

- [MiniMax Ref2VA 官方提示词指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)：Subject 定义参考角色和来源；保留分析针对已定义属性；风格说明置于第一镜之前。
- [ComfyUI 官方 H3 多参考工作流](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_r2v.json)：参考输入采用点号键名。
- [ComfyUI 同类问题及提问者的更正](https://github.com/Comfy-Org/ComfyUI/issues/15667#issuecomment-5307427502)：原问题提出的嵌套输入不是正确 API 格式，应读更正而非沿用问题正文的推断。
- [ComfyUI H3 节点源码](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py)。

本项目的具体结论由本机输入解析复现及实际出片支持；官方文档并不承诺任意提示词都能实现完全一致。

## 可复核对照

证据目录：`data/backups/h3-style-research-20260930/`。

| 对照 | ComfyUI prompt_id | 改动 |
|---|---|---|
| 原始失败样例 | 05c591c0-d74f-4202-bc87-243e523aee11 | 用户的历史视频 |
| A | c085a1a5-739b-4f8b-9c8b-e84311f65a64 | 同一原始提示词、种子、图片、采样参数，仅修正参考图连接 |
| B | 163b838b-f3b5-45c7-8e86-5908d7ceb7f9 | 在 A 基础上，使用修改后模板经实际生成服务生成并翻译、校验的提示词 |

A 已成功。3.8 秒帧中，脸部比例和皮肤材质明显更接近人物参考，原视频的大眼卡通化明显减轻。不能由一个镜头宣称所有人物、表情和动作都已通过。

B 由实际服务在数据库副本中生成提示词，没有手工改写最终提示词来代替源模板测试。B 的故事语言、参考图片、随机种子、分辨率、视频长度、采样器、调度器、步数与 A 相同；重新生成的提示词全文不同，所以 B 只评估整套提示词改动的效果，不能把结果归因于某一个形容词。

B 也已成功。检查 1.0、3.8、4.5 秒原帧：近景保留接近参考图的自然眼脸比例、鼻梁和下颌、暗色发型与皮革表面；与原视频相比，明显的大眼卡通化未重现。该次抽样支持此次修改，但不是跨角色、跨种子的统计证明，也不等于人物身份完全一致。A 的开场姿态、B 的开场人物缺失仍与分镜存在差异，本次不能签收为完整分镜质量通过。

对照控制记录见 `comparison-controls.json`：种子 4692851871700402，1344×768，124 帧，20 步，`res_multistep` / `simple`。A 与 B 的图仅更改 `5.prompt` 及输出文件名。B 视频为 `D:/new_comfyui/output/Toonflow/verification/H3_reference_and_prompt_00001_.mp4`，A 视频同目录 `H3_reference_only_00001_.mp4`。

`live-input-probe.json` 保存本机解析结果；`baseline-history.json`、`reference-only-history.json` 保存实际工作流和完成记录；`candidate-system-*.txt`、`candidate-response-*.txt` 保存实际生成上下文及回答。图像证据是视频原帧。

## 验证与边界

- `node --import tsx --test tests/comfyui-local-h3.test.mjs tests/h3-prompt-generation.test.ts`：29/29 通过，包含 1、2、9 张完整图片的真实 provider 图构造与槽位对应测试。
- `tests/video-visual-manual.test.ts` 有已有过时断言：要求未修改的资产绘图手册包含 `polished illustration rendering`，而当前资产手册已经是三维风格。不能把此项报告为通过。
- 当前生产批次未重启、未重复提交。后续任务从磁盘加载 provider，已实查其新提交的四图工作流使用正确点号键。
- 本次直接修复本机使用的 `data/vendor/comfyui_local.ts` 及 `data/vendor/vendor.json`。`src/lib/vendor.json` 的启动迁移备份尚未同步：它被 nodemon 监视，写入会重启仍在执行批次的后端。迁移备份同步和过时测试修订需在批次空闲时完成；本机当前已有 provider 文件、版本 2.1，不会被现有 `< 2.1` 迁移条件覆盖。
- 诊断脚本首次导入应用工具时触发了生产数据库的启动恢复，把 4–12 号运行中视频状态误标为失败。渲染进程未中断；已根据事前快照及精确错误条件恢复状态，其他启动恢复目标没有运行中记录。证据为 `diagnostic-state-restoration.json`。脚本现改为在加载应用工具前注入副本数据库，避免重复触碰生产状态。

旧视频保留。修改模板不会追溯修改已经保存的提示词；重新生成提示词后，新的视频请求才会使用新文字。

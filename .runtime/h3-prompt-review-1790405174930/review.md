# MiniMax H3 提示词实测与修复记录

2026-09-26。通过程序真实调用当前配置的 volcengine:doubao-seed-2-1-pro-260915，使用项目当前的参考图和分镜，运行 generateVideoPromptForTrack。多轮生成、格式检查、语义审查和独立复核后，以下原版与英语版本通过本轮文本审核，并已保存到正式项目，经工作台接口回读确认一致。

| 片段 | 时长 / 切点 | 实际 Picture 顺序（资产 ID） | 英文提示词 |
| --- | --- | --- | --- |
| 船上冲突与坠落 | 11 秒 / 4、8 秒 | 115 艾娃、116 麦迪逊、118 海洋、128 巨鲨 | [查看](D:/Toonflow-app-master/.runtime/h3-prompt-review-1790405174930/approved/1790319537445-en-US.txt) |
| 水下咬合与重生 | 13 秒 / 4、10 秒 | 115 艾娃、118 海洋、124 系统界面来源、128 巨鲨 | [查看](D:/Toonflow-app-master/.runtime/h3-prompt-review-1790405174930/approved/1790319543870-en-US.txt) |

每个人物直接使用一张完整角色板；没有拆成脸部、正面、侧面、背面四个上传槽位。两段均为四张参考图，Picture 编号与保存的图片计划一致。

本轮修复覆盖：

- 过大的角色板会使视觉模型请求失败：仅压缩提示词模型的传输副本，保留整板与所有视角，实际 H3 资产路径不变。
- 六段结构、来源绑定、切点、对白标签和声源编号检查；失败要求返回完整重写稿，最多三次，不拼接虚构主体定义。
- 实际图像和分镜参与内容审核，检查动作因果、咬合等状态延续、系统界面与手机实体的区别、画面文字、对白含义和口型。
- 声源编号独立于 Subject 编号；水下为艾娃惨叫 S1、系统 S2、艾娃回应 S1。系统发声期间艾娃闭嘴；艾娃自己发声时使用英语口型。
- 翻译审核沿用已保存的参考图顺序，失败候选不覆盖已有语言提示词或视频关联；引用检查不再把同一标签重复次数变化误判为换图。
- 提交视频时追加的全局画面约束移入 detailed_description 开头，避免污染 non_diegetic_music。配乐保持 N/A，对白和引用不变，重复处理不重复追加。

规则核对来源：[MiniMax H3 官方提示词技能](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)、[Ref2VA 规则](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)、[共用镜头与发声规则](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)。整板占一个 Picture 是本项目输入约定，不把它说成 H3 对所有输入方式的限制。

验证：146 项相关测试通过，后端构建通过；两段均通过格式、绑定、模型内容审核和独立交叉复核。还离线检查了追加全局约束后的最终提交文本：[船上提交预览](D:/Toonflow-app-master/.runtime/h3-prompt-review-1790405174930/approved/1790319537445-submission-preview.txt)、[水下提交预览](D:/Toonflow-app-master/.runtime/h3-prompt-review-1790405174930/approved/1790319543870-submission-preview.txt)。

正式保存时间：2026-09-26T07:25:47.749Z；工作台 API 回读时间：2026-09-26T07:25:51.684Z。落库前备份目标记录，并重新核对分镜、时长、资产图片未改变。保留两段全部历史视频、历史语言元数据、旧图片计划、其它语言与已选视频。

本轮验证到提示词和提交文本，没有重新渲染视频，不能据此宣称成片画风或人物一致性已验证。运行中的旧后端仍承载其他视频任务（检查时 18 条生成中），因此未重启；新代码已构建，后端重启后新的生成请求才会完整使用本轮修复。

# Toonflow 提示词 / Skills 一致性升级（2026-09）

本更新将角色身份、剧情状态和镜头瞬时动作分别定义，同时统一四视图顺序；并给 Qwen 和 MiniMax H3 引入模型专属提示词与参考约束。已修改的文件见对应 Git 提交。

## 核心行为

1. `data/skills/asset_visual_design.md` 与衍生资产 Skill：默认角色是身份锚点；觉醒等重要状态可作为独立衍生，即使仅出现一个关键场次；状态明确覆盖基础态的可变属性，同一镜头不能将互斥形态作为两名角色并列使用。
2. `art_character.md` / `art_character_derivative.md`：四栏固定为头像特写、正面全身、90°左侧全身、背面全身。Qwen 供应商内部每次生成单视角，最后按次序合并，不把“四宫格”完整指令重复交给每张图。
3. `data/vendor/comfyui_qwen21_fourview.ts`：删除硬编码的科尔/海兽王/固定红瞳与衣装；角色身份及当前状态以资产的 prompt 为准。可选 LoRA 必须自行安装兼容的权重；所有四视图质量结果仍需图像审核，代码不保证模型跨视角绝对一致。
4. `src/routes/assetsGenerate/generateAssets.ts`：支持旧的 `base64` 锚点输入及可选 `styleBase64`（需先有锚点）；Qwen 四视图仅用于角色，衍生状态必须有参考图，拒绝拿其它状态默默代替。通用道具采用 1:1，通用多栏角色和场景仍是横画幅，Qwen 的单视角由供应商使用竖构图。
5. `h3VisualStateGuard.ts` + 单/批量生成路由：从数据库实际 `assetsId` 关系检查同一人物的互斥状态与重复引用，并按最终展开的参考图数量校验所有 Picture 编号；检查失败时在创建视频任务前返回冲突。
6. `minimaxH3Multi-referenceMode.md`：人脸和全身图属于一个 Subject；增加动作与时间预算、关键形态转换边界和参考图绑定要求。
7. `production_execution_storyboard_table.md`：在分镜落库前检查原台词 + 必要动作的最低可行时长。超出目标则向上游报告压缩剧本/调整时长/拆集，不靠反复强制修复掩盖冲突；沿用原有 revision/逐场 task 锁定协议。

## 验证

- GitHub Actions `Agent 与分镜协议检查` 在 main 更新时执行 `yarn test:agent`；Windows/macOS 构建在独立工作流进行，最终以 Actions 的结论为准。
- Windows 本地执行：`git pull origin main`，`yarn install --frozen-lockfile`，`yarn test:agent`，`yarn lint`，`yarn build`。模型生成还需要本机 ComfyUI / Qwen 及 LoRA 文件（如果启用 LoRA）。
- 角色验收：至少在科尔普通态、觉醒态和另一名**非科尔**角色各出四视图，核对身份、状态、衣装、左右方向、完整头脚和四栏顺序；再检查场景主通道、仓库入口及固定陈设是否保留。
- H3 单/批量验收：分别测试普通科尔单态、觉醒科尔单态、两个互斥态同时传入、缺失参考图、Picture 跳号、两位不同角色。互斥态及跳号必须在视频生成前失败。
- 高清验收：导出一份原视频和高清版后运行 `node scripts/qa-h3-hd.mjs 高清版.mp4 原版.mp4`（需要 ffprobe）。脚本检查尺寸、帧率、时长、音轨保留与宽高比；角色面部漂移、物体闪烁、水流细节、口型同步仍需人工按连续帧审核。单纯 Lanczos 放大不会凭空创造高频细节，逐帧 AI 超分也不保证时序一致。

## 仍需区分的边界

- 新增的角色状态约束无法自动回填历史工作区已有的不正确资产关系；旧分镜若引用了互斥状态，重新制作时需要按当前有效状态修改资产选择，不绕过原先的 storyboard revision 冲突。
- 代码校验 Picture 编号数量和状态关系，但图片内容的语义（例如上传文件名与实际画面是否为同一人物）尚无自动图像理解审核；需要对照角色正面锚点人工确认。
- 高清质量脚本是**离线验收工具**，目前尚未接入每次视频生成后的自动阻断；不能把视频生成成功等同于质量验收通过。
- GitHub 代码提交不会改变已经安装在 Windows 的 Toonflow，须拉取、构建并在本机 ComfyUI 进行最终端到端验证。

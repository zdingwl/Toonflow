# MiniMax H3 本地高清放大（可选，保持原 H3 不变）

新增供应商：`data/vendor/comfyui_h3_hd.ts`。它直接生成 ComfyUI API 节点图：

`H3 Ref2VA/FL2VA → Sampler → 视频 VAE 解码 → 帧级放大 → CreateVideo（复用原音频 VAE 解码输出，24 fps）→ SaveVideo（只返回最终视频）`

与 `data/vendor/comfyui_local.ts` 的原模型并存，**不会修改原始 480p/720p/768p H3 推理分辨率**；高清放大发生在输出阶段。按原供应商处理角色/场景/道具参考图，最多支持 9 张，跳过 `sourceType=storyboard` 的参考图以避免覆盖人物身份。

## 如何启用

1. Windows 拉取最新 `main` 代码；运行仓库的正式构建命令 `yarn build`。`scripts/build.ts` 已在打包时调用 `vendor2json`，新增供应商将进入默认的 vendor 注册包。若使用旧安装版，请升级或重新安装自己构建的版本，GitHub 提交不会自动改变已安装程序。
2. 在 Toonflow 的模型供应商选择中启用 **本机 MiniMax H3 · 高清放大**，本地 ComfyUI 地址默认为 `http://127.0.0.1:8188`。原有供应商可继续保留以回退。
3. 配置本机已安装的 H3 FL2VA/Ref2VA、Qwen3-VL、视频/音频 VAE 文件名。`h3Steps` 默认 20，按需调整。选择原生推理分辨率 480p/720p/768p；高清放大不会要求 H3 直接用 1080p 推理。
4. 先用 5 秒片段、1 张人物参考图、`upscaleMode=lanczos1080` 做通路测试，检查 `ComfyUI/output/Toonflow/H3_HD_*.mp4`、声音、画面比例、角色一致性。再逐步增加多参考图和时长。

## 高清档位

| `upscaleMode` | 行为 | 依赖 |
|---|---|---|
| `off` | 不放大，直接封装 H3 输出 | ComfyUI 原生 H3 节点 |
| `lanczos1080`（默认） | 用内置 `ImageScaleBy`（Lanczos）把视频短边放大至约 1080 像素，再与原音频合成 | 不需要额外放大模型 |
| `ai1080` | 使用 `UpscaleModelLoader → ImageUpscaleWithModel` 做逐帧图像超分，再缩至短边约 1080 像素，保持原音频 | 需要安装**真正兼容 ComfyUI 的 4× 图片放大模型**，并填写 `upscaleModel`（模型文件名） |

`ai1080` 当前采用 4× 图像超分再下采样，只有 4× 模型能保证预期输出尺寸；不要填写 2× 模型。大批帧同时超分会提高 RAM/显存与耗时负担，32GB 显存建议先做短片测试，必要时使用默认 Lanczos 档。此处属于**逐帧图像增强**，不保证时序去闪烁或生成新的真实细节；Lanczos 仅放大像素尺寸，并不恢复生成阶段丢失的细节。

由于 H3 内部为 32 像素网格对齐且有最大像素预算，`lanczos1080/ai1080` 保持原始宽高比，结果是**短边约 1080**，不承诺恰好为标准 `1920×1080`。原视频帧率 24 fps、音频输出与时长保持原有连接方式；若你需要标准交付尺寸，可另外增加裁切/填充/转码步骤。

## 兼容与验证

- 不修改 `data/vendor/comfyui_local.ts`、现有 H3/FLUX/Qwen 模型名或网关工作流；新模式只能显式选择后生效。
- 在 `/object_info` 中检查必要节点和模型是否存在；缺失时直接报错，不静默退回原画质。
- 只读取高清 `SaveVideo` 节点 14 的输出，避免返回放大前的视频。
- 目前仅提交仓库代码，**尚未在用户 Windows 5090D/ComfyUI 环境完成实际模型推理测试**，如发生节点输入签名差异，应使用其 `/object_info` 与输出错误做兼容修正。

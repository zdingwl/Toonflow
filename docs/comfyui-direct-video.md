# Toonflow 本机 MiniMax H3 视频直连（ComfyUI）

对应 `data/vendor/comfyui_local.ts` 1.2 版。此实现参照 `zdingwl/ai-drama-studio` 的 `backend/app/p16/provider.py` 中 `LocalComfyUIH3Provider.workflow_payload`、`readiness`、参考图上传以及 SaveVideo 结果读取流程。

## 不再需要 DramaClaw 或手动导出工作流

默认 `videoBackend=comfyui`，且 `workflowApi` 与 `workflowMapping` 均留空时，Toonflow 自动构造 ComfyUI 原生 MiniMax H3 节点图：没有参考图时走 `MiniMaxH3ImageToVideo` + FL2VA；有参考图时走 `MiniMaxH3ReferenceToVideo` + Ref2VA。参考图片先通过 `/upload/image` 上传，按 `ref_image_0..N` 关联 `LoadImage` 节点，调用 `/prompt`，轮询 `/history/{prompt_id}`，从 `SaveVideo` 节点读取 MP4 信息并通过 `/view` 下载。原生图会同时通过视频/音频 VAE 解码，`CreateVideo` 组合为 24fps 的 MP4；不以 `config.audio=false` 为由静默移除原生音轨。

**这要求运行中的 ComfyUI 已安装相应原生 H3 节点、模型文件以及 GPU 环境；模型昵称 `minimaxh3` 并不能证明这些节点均已安装。** Toonflow 会在生成前检查 `/system_stats`、`/object_info` 和当前任务用到的模型文件。ComfyUI 中只有第三方自定义 H3 工作流而没有上述原生节点时，仍需选择自定义工作流适配方式，不能直接使用默认节点图。

## 模型服务配置

在模型服务里选择 `本机 ComfyUI（FLUX + MiniMax H3）`，设置 `baseUrl=http://127.0.0.1:8188`、`videoBackend=comfyui`，将 `workflowApi` 和 `workflowMapping` **同时留空**。默认模型文件名参照 ai-drama-studio 的 P16 配置：

- `h3Unet=minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- `h3RefUnet=minimax_h3_ref2va_pruned_int8_convrot.safetensors`
- `h3Clip=qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- `h3VideoVae=minimax_h3_video_vae_fp16.safetensors`
- `h3AudioVae=minimax_h3_audio_vae_fp32.safetensors`
- `h3Steps=20`

如果实际 ComfyUI `/object_info` 中的模型文件名或路径不同，应填写原样文件名；不要重命名模型文件以迁就默认值。原生图使用 24fps 与 `17k+5` 帧数网格，根据 Toonflow 传入的 480p/720p 和宽高比生成尺寸。输出尺寸和可用时长仍受本机模型、显存及节点限制。

## 兼容已有自定义视频工作流

如果 `workflowApi` 和 `workflowMapping` **均非空**，继续使用 1.1 版的自定义 API 格式 JSON / 节点映射路径。两项只填一项会明确报错。自定义工作流可用以下映射格式：

```json
{
  "prompt": {"node": "PROMPT_NODE_ID", "input": "text"},
  "images": [{"node": "IMAGE_LOAD_NODE_ID", "input": "image"}],
  "frames": {"node": "FRAMES_NODE_ID", "input": "length", "fps": 24},
  "width": {"node": "SIZE_NODE_ID", "input": "width"},
  "height": {"node": "SIZE_NODE_ID", "input": "height"},
  "outputNode": "VIDEO_OUTPUT_NODE_ID"
}
```

示例节点 ID 均为占位符，必须替换为导出工作流中的真实节点。自定义工作流的参考图槽位和音频支持由其实际节点结构决定。

## Windows 安装版特别说明

**GitHub 上的源码提交不会自动更新 Windows 已安装程序或其持久化供应商脚本。** 本仓库 `src/utils/vendor.ts` 会从本机用户数据目录读取供应商脚本；要让修复进入正在使用的 Windows 安装版，需要部署包含本次改动的新版软件，或在模型服务的「编辑代码」中用新版供应商完整代码替换该供应商的旧版脚本，并保存。请先备份旧代码和供应商配置。参考图上传依赖 `src/utils/vm.ts` 中为沙盒暴露的 `Buffer`：如果 Windows 旧安装包没有此后端改动，即使更新供应商代码也无法上传参考图，需要重构建/安装含新版后端的软件。生成前须确认真实 ComfyUI 8188 服务在线。

当前仓库更新仅完成实现和代码提交；未在用户的 Windows + ComfyUI 实机环境上验证生成成功。

## DramaClaw 旧协议

只在实际部署网关时显式填写 `videoBackend=gateway` 和对应的 `gatewayUrl` / `gatewayApiKey`。不能把 ComfyUI 的 8188 端口直接填入 DramaClaw `/v1/video/generations` 接口。

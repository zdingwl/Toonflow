# 在 Toonflow 中直接调用 ComfyUI 视频工作流

此文档对应 `data/vendor/comfyui_local.ts` 1.1 版。此供应商保留原 FLUX 图片功能，将 **视频默认后端** 改为 `comfyui`；旧网关可通过 `videoBackend=gateway` 显式使用。

## 先决条件

1. 在 ComfyUI 中运行一个已验证成功、能够输出 MP4/WebM/MOV/MKV 的视频工作流；默认服务地址为 `http://127.0.0.1:8188`。
2. 从 **ComfyUI 的 API Format** 导出 JSON。普通画布格式 JSON（`nodes`/`links`）不能直接提交 `/prompt`。
3. 检查工作流实际支持几张图片以及输出节点。不要按模型名称猜测节点 ID，也不要假定该工作流支持视频/音频参考或可动态更改时长与分辨率。
4. Windows 安装版的供应商脚本位于本机用户数据目录并持久化；**GitHub 上的 `data/vendor/comfyui_local.ts` 更新不会自动更新已安装版本中的脚本或后台程序**。若要使用本次代码，需安装包含本次提交的新版 Windows 后端，并将新版供应商代码与配置同步到安装版；先备份现有供应商及配置。新版脚本使用 `Buffer` 上传素材，旧版后端的 `src/utils/vm.ts` 若未提供 `Buffer` 将无法上传图片。

## 供应商配置

在更新后的供应商中设置：

- `baseUrl`：ComfyUI 实际地址，例如 `http://127.0.0.1:8188`。
- `videoBackend`：填写 `comfyui`。
- `workflowApi`：完整的 ComfyUI **API 格式**工作流 JSON，压缩为一行后粘贴到设置字段。保留实际工作流的模型路径与固定参数。
- `workflowMapping`：工作流节点映射 JSON；根据上面工作流中的真实节点 ID 与输入键填写。

示意映射（`NODE_ID`、`INPUT_NAME` 都是占位符，**不能直接照抄使用**）：

```json
{
  "prompt": {"node": "PROMPT_NODE_ID", "input": "text"},
  "images": [
    {"node": "IMAGE_NODE_ID_1", "input": "image"},
    {"node": "IMAGE_NODE_ID_2", "input": "image"}
  ],
  "frames": {"node": "FRAMES_NODE_ID", "input": "length", "fps": 24},
  "width": {"node": "SIZE_NODE_ID", "input": "width"},
  "height": {"node": "SIZE_NODE_ID", "input": "height"},
  "outputNode": "VIDEO_OUTPUT_NODE_ID"
}
```

映射规则：

- `prompt` 必填，映射到能够接收提示词字符串的节点输入。
- `images` 可选，按 Toonflow 传入素材顺序映射到 ComfyUI 可接收上传文件名的图片加载节点；当前最多 9 张。若工作流仅支持 2 张，就只配置 2 个映射槽，超过时会明确报错。未上传的槽位保留 API 模板里的原始值；如工作流不允许缺少素材，应先填写全部必需素材。当前直连不支持视频/音频参考。
- `frames` 可选；仅当节点输入表示 **帧数** 时使用，计算 `round(视频秒数 × fps)`。`fps` 必须填写工作流实际帧率。若工作流使用秒数输入，改填 `duration` 而不是 `frames`。
- `width`、`height` 可选；填写后，根据 Toonflow 分辨率与画面比例计算成 8 的倍数。若模型只支持固定尺寸，请不要映射，改用工作流固定参数。
- `outputNode` 可选，用于在多个输出节点中指定包含视频文件信息的节点。默认查找所有输出节点的 `videos`、`gifs`、`files`、`images` 列表，并寻找 `.mp4`、`.webm`、`.mov` 或 `.mkv` 文件。特殊自定义输出结构需要另行适配。
- 音频生成功能在当前直连模式中关闭；请在 Toonflow 中选择无音频。

## 请求流程

1. 验证工作流及映射 JSON；先验证视频输入类型和映射槽数。
2. 如使用图片参考，通过 `POST /upload/image` 上传 PNG/JPEG/WebP 图片，将返回的文件名填入所映射的节点。
3. 通过 `POST /prompt` 提交工作流；通过 `GET /history/{prompt_id}` 轮询状态（最多 30 分钟）。
4. 从输出节点提取视频文件，返回 `GET /view?filename=...&subfolder=...&type=...` 地址，交给 Toonflow 原有视频保存流程下载保存。

若请求失败，错误会指明素材上传、任务提交或轮询阶段，并包含本机地址及请求错误代码。请检查 ComfyUI 后端控制台日志与对应的工作流节点报错。

## 旧网关兼容

如仍需调用 DramaClaw，将 `videoBackend` 设置为 `gateway`，并配置正确的 `gatewayUrl` 与 `gatewayApiKey`。它与 ComfyUI 工作流直连是两种不同的协议，**不能只把 `gatewayUrl` 改成 `http://127.0.0.1:8188`**。

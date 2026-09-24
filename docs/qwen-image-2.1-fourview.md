# Qwen-Image-2.1 科尔四视图（本地 ComfyUI）

> 这是选择性启用的角色资产工作流，不替换原有 `data/vendor/comfyui_local.ts`、FLUX、视频模型、现有 Skill 或业务页面。第一次使用前请先备份配置。模型和角色 LoRA **不会**随源码提交。

## 文件

- `data/vendor/comfyui_qwen21_fourview.ts`：Toonflow 专用图片供应商；可使用现有资产生成入口。生成顺序为头像、正面全身、90° 侧面全身、背面全身，最终用 ComfyUI 的 `ImageStitch` 输出一张四栏 PNG。
- `data/workflows/qwen_image_2_1_kor_4view_api.json`：**ComfyUI API 格式**示范工作流，用已确认的科尔正面全身图做锚点，参考图编辑另三个视角，并把四张图片拼成总图。不是 UI 画布格式 JSON；使用 `POST /prompt` 的 `prompt` 字段提交，而不是把此 JSON 直接作为画布导入。

## 安装模型与准备锚点

1. 更新 ComfyUI 到具备 `TextEncodeQwenImage21` 和 `ImageStitch` 的版本；通过 `http://127.0.0.1:8188/object_info` 核实节点存在。
2. 按模型名称放置 `qwen_image_2.1_int8_convrot.safetensors` 至 `models/diffusion_models/`，`qwen3vl_8b_int8_convrot.safetensors` 至 `models/text_encoders/`，`qwen_image_2.1_vae_bf16.safetensors` 至 `models/vae/`。如果实际文件名含子目录，请在供应商设置中填写 `/object_info` 里的实际名称。
3. 在生成工具中先选定一张科尔**正面全身标准图**。如果参考材料是四栏大图，请先裁出正面全身的第二栏，保持头到脚入镜，另存 `kor_anchor.png`；不要把整张四栏直接当作正面锚点。
4. 若启用 LoRA，先安装并验证**针对 Qwen-Image-2.1 架构**训练的真实 LoRA 权重。不能直接假定 FLUX、SDXL 或旧版 Qwen-Image LoRA 与 2.1 兼容。将文件放入 `models/loras/`，按实际文件名配置。未安装 LoRA 时，留空供应商 `loraName`，即可先测试参考图编辑的基础流程。

## 在 Toonflow 启用新供应商

1. 拉取此提交后的仓库代码；在项目根目录执行 `yarn vendor2json`（实际调用 `scripts/vendor2json.ts`），同步更新 `data/vendor/vendor.json`。如果本地 UI 支持添加自定义供应商，也可在供应商设置中导入/粘贴 `data/vendor/comfyui_qwen21_fourview.ts` 的全部内容，而不覆盖已有供应商。
2. 在模型设置中选择 `本机 Qwen-Image-2.1 四视图（LoRA 可选）` 下的 `Qwen-Image-2.1 角色四视图`；填写 `baseUrl`，检查模型文件名。LoRA 若存在，设置 `loraName` 与强度，默认 0.65；没有则保持空值。
3. 输入科尔的**单角色外观和觉醒状态描述**，不要再在图片描述里要求模型单次生成“四栏、四个人物”——新的工作流自己拼四栏。选择参考图 1 为已确认的正面全身锚点，参考图 2 可选为风格参考。没有参考图时，供应商会先文生图生成正面锚点，再基于该锚点完成其他视角；但此方式的一致性通常不如提供已确认的锚点。
4. 四栏总图由 `ImageStitch` 合成，供应商从 ComfyUI 的 `history` 和 `view` 返回图片 URL；需要在同一台运行 Toonflow 的电脑上访问对应的 ComfyUI 地址。

## 手动测试 API 格式 JSON

将 `kor_anchor.png` 上传到 ComfyUI 的 input 文件夹（或用 ComfyUI UI 上传），复制 `data/workflows/qwen_image_2_1_kor_4view_api.json`，将节点 4 的 `REPLACE_WITH_COMPATIBLE_QWEN_IMAGE_2_1_LORA.safetensors` 改成真正存在的 LoRA 文件名。没有 LoRA 时，移除节点 4，并将三处 `clip:["4",1]` 改成 `["2",0]`，三处 KSampler 的 `model:["4",0]` 改成 `["1",0]`。请确认对应节点 ID 和所有模型都存在后再提交。

使用 ComfyUI 的 API 客户端提交：

```python
import json, requests
p = json.load(open('data/workflows/qwen_image_2_1_kor_4view_api.json', encoding='utf-8'))
r = requests.post('http://127.0.0.1:8188/prompt', json={'prompt': p, 'client_id': 'toonflow-kor-fourview'}, timeout=60)
r.raise_for_status()
print(r.json()['prompt_id'])
```

在 `GET /history/<prompt_id>` 的节点 `60` 中读取总图，节点 `61`—`64` 是分视角图。调用 `/view?filename=...&subfolder=...&type=output` 获取图片。

## 使用范围与验收

- ComfyUI 本机服务必须正在运行；此提交**没有**对用户的 Windows 5090D 环境进行实时显存或模型推理测试。
- 检查四栏是否依次为头像、正面、侧面、背面；科尔红瞳、发型、面部身份、湿衣服、身高比例是否一致；侧/背没有第二人、肢体错误、裁脚、意外实拍质感。
- `LoRA` 节点的存在不代表已经训练、获得或加载实际科尔 LoRA；上面的示范 JSON 含有需要替换的权重文件名。质量仍需人工验收，不能把四视图当成数学意义的身份锁定。
- 生成或发布商业短剧前，核对 Qwen-Image-2.1 模型权重和所有 LoRA 各自的最新许可条件。

# 批量资产与 H3 视频导入

左侧菜单新增两个独立入口：**批量资产**、**导入视频**。先创建独立的导入项目，再进入项目导入数据。不需要小说或剧本。原有导入批次会自动转为项目，已有图片和视频保留。

## 批量资产

1. 进入“批量资产”，点击“新建项目”，填写名称、默认图片模型和分辨率；创建后进入项目下载表格模板，或打开本目录的 `assets-template.csv`。
2. 用 Excel / WPS 填写，每行一个资产，保留表头，另存为 **CSV UTF-8（逗号分隔）**。
3. 点击“导入资产表格”，检查预览后确认导入。
4. 在与资产页相同的工作台中，编辑提示词、查看参考图和历史图片，单条或批量生成。

| 列 | 规则 |
| --- | --- |
| `id` | 唯一编号，字母、数字、下划线、短横线；不区分大小写，不可用 Windows 保留文件名 |
| `name` | 资产名称 |
| `type` | `role` 人物、`scene` 场景、`tool` 道具、`creature` 生物（工作台归入“道具”，按道具与生物规则生成；导入记录保留原始类型） |
| `prompt` | 完整图片提示词，可以包含逗号、引号和换行，交给 Excel/WPS 自动转义 |
| `aspectRatio` | `1:1`、`16:9`、`9:16`、`2:3`、`3:2`、`4:3`、`3:4`；空值默认为 `1:1` |

最多 500 行，文件最多 4 MB。目前导入格式为 CSV，不直接读取 `.xlsx`。生成逻辑与 `/cornerScape` 完全共用：角色走现有四视图模型，场景和道具使用项目默认模型，图片分辨率使用项目设置。`aspectRatio` 保留为导入信息，实际画布由原生资产类型和模型规则决定。

完成后可预览图片、下载包含 `assets/编号.图片后缀` 和 `results.json` 的 ZIP。

## 导入视频

先在“导入视频”中创建项目，选择已启用的本地 MiniMax H3 模型，再下载 `h3-video-template.zip`，解压后替换占位图片并编辑 `manifest.json`，重新打包为 ZIP：

```text
manifest.json
assets/
  hero.png
  room.png
```

也允许以上文件统一放在一个外层文件夹内。模板中的两张图片明确标记为占位图，必须换成自己的资产图。

```json
{
  "version": 1,
  "name": "第一集",
  "assets": [
    { "id": "hero", "name": "主角", "type": "role", "file": "assets/hero.png" },
    { "id": "room", "name": "客厅", "type": "scene", "file": "assets/room.png" }
  ],
  "shots": [
    {
      "id": "shot_001",
      "name": "进入客厅",
      "prompt": "一个连续镜头，<Picture 1> 中的人物走入 <Picture 2> 的客厅，保持人物身份和服装，镜头缓慢跟随。",
      "duration": 5,
      "aspectRatio": "16:9",
      "resolution": "768p",
      "audio": true,
      "assets": ["hero", "room"]
    }
  ]
}
```

- `assets` 定义可用图片；每个分镜自己的 `assets` 数组定义该分镜的绑定顺序。第一个编号对应 `<Picture 1>`，第二个对应 `<Picture 2>`，以此类推。
- 资产 `type` 支持 `role` 人物、`scene` 场景、`tool` 道具、`creature` 生物。生物在工作台归入“道具”，每张生物图片仍独立占用一个 Picture，导入记录保留原始类型。
- 提示词必须引用全部绑定的 Picture，不得引用不存在的序号。Subject 标签可选，不强制六段式提示词。
- 每个镜头 1–9 张参考图，完整人物四视图按一张图使用，不拆分视角。同一分镜不能重复绑定同一资产。
- `duration` 是 5–15 秒的整数；`aspectRatio` 为 `16:9` 或 `9:16`，默认 `16:9`；`resolution` 为 `768p`；`audio` 为布尔值，默认 `true`。
- 图片支持 PNG / JPG / WebP，单图最多 4000 万像素。ZIP 最多 45 MB，解压后和图片转存后总计各最多 200 MB，单文件最多 20 MB，最多 500 个资产和 500 个分镜。
- 图片路径使用 `/` 和相对路径，不支持网络 URL、绝对路径、`..` 或符号链接。

点击“导入视频压缩包”并确认预览后，直接进入原有视频工作台。可以切换分镜、编辑已导入的提示词、核对 Picture 顺序、单条生成或勾选批量生成，并播放和切换历史视频。无需重新生成对白语言版本。单条生成使用当前声音、分辨率和时长设置；批量使用各分镜导入的设置，横竖屏按各分镜的 aspectRatio。修改参考图绑定需重新导入对应压缩包，以保留旧提示词与图片的绑定记录。

## 保存与进度

- 导入不会自动触发生成；同一项目内相同文件重复导入会打开原批次，不同项目可以分别导入同一文件。
- 同一项目可以多次导入，批次间同名编号不会覆盖。图片工作台展示该项目全部资产；视频工作台按批次切换分镜。
- 共用原生资产生成、视频生成、任务与历史结果管理。重新生成保留历史结果；H3 同一批次内串行执行。
- 导入来源记录在 `o_importBatch` / `o_importItem`，原生数据写入 `o_project`、`o_script`、`o_assets`、`o_image`、`o_videoTrack`、`o_video` 等表。
- 原有图片和视频原路径保留；刷新后仍可查看已保存结果。下载本批次时读取当前原生工作台的成功结果。
- 关闭网页不会取消服务端任务。服务重启后请查看任务中心及 ComfyUI 队列再决定是否重试。
- 若模型不可选，请在设置中启用本机 ComfyUI 供应商，视频后端设为 `comfyui`。


## 开发验证

```powershell
npx tsx --test tests/import-studio.test.ts tests/import-studio-native.test.ts tests/h3-reference-bindings.test.ts tests/h3-reference-slots.test.ts tests/comfyui-local-h3.test.mjs
npm run build:backend
npm --prefix Toonflow-web-master run build-only
```

新增接口为经过现有登录校验的 `POST /api/importStudio`，以 `action` 区分项目创建/设置、模板、检查、导入、查询和下载；图片与视频生成复用原有工作台接口。文件在内存中进行受限解压和校验，图片通过解码后转为 PNG，全部验证通过后才保存导入批次。

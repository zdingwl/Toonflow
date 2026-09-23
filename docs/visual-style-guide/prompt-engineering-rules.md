# Toonflow Prompt Engineering Rules V1.0

> AI视觉提示词编译规范
>
> 用于 AssetAgent、VisualDirectorAgent、ProductionAgent、VideoAgent

## 1. Prompt 编译目标

Toonflow 的 Prompt 不追求单张图片效果，而是服务于连续剧级 AI 内容生产。

核心目标：

- 角色一致
- 场景一致
- 镜头统一
- 风格稳定
- 多模型兼容

标准结构：

```
视觉身份层
+
主体描述层
+
材质层
+
环境层
+
摄影层
+
灯光层
+
渲染层
+
质量控制层
```

---

# 2. 角色 Prompt 标准

## 结构

```
角色身份
年龄与外貌
脸部特征
发型
服装
材质
动作
情绪
摄影
渲染
```

## 示例

```
young female warrior,
sharp eyes,
black long hair,
determined expression,
futuristic armor suit,
PBR metallic material,
cinematic anime CG,
Unreal Engine style lighting,
film quality render
```

---

# 3. 场景 Prompt 标准

结构：

```
世界观
空间规模
建筑元素
天气
时间
色彩
镜头
```

示例：

```
cyberpunk futuristic city,
massive skyscrapers,
neon holographic advertisements,
rainy night,
wet street reflection,
volumetric fog,
cinematic wide shot,
35mm lens
```

---

# 4. 通用正向关键词库

## CG质量

```
cinematic anime CG
3D character rendering
PBR material
high detail
film quality
8K render
Unreal Engine style
```

## 光影

```
volumetric lighting
global illumination
soft shadow
rim light
cinematic contrast
```

## 材质

```
subsurface scattering
realistic skin shader
cloth texture
metal roughness
surface details
```

---

# 5. Negative Prompt规则

统一过滤：

```
real photo
live action
plastic skin
bad anatomy
extra fingers
deformed face
low quality
flat illustration
watermark
text
```

---

# 6. Seedream角色生成规范

角色设计必须优先加入：

```
character design sheet
character turnaround
front view
side view
full body
consistent character
```

禁止导向：

```
fashion photo
beauty portrait
real person photography
```

---

# 7. 视频模型 Prompt规范

视频必须增加动态描述：

```
camera movement
character action
environment motion
lighting change
cinematic transition
```

示例：

```
slow camera push in,
character walks forward,
rain falling,
coat moving with wind,
dramatic cinematic lighting
```

---

# 8. Prompt版本管理

每次生成保存：

```json
{
 "prompt_id":"",
 "style_version":"1.0",
 "character_lock":"",
 "scene_lock":"",
 "camera":"",
 "model":"",
 "negative_prompt":""
}
```

---

# 9. Agent职责

## VisualDirectorAgent

负责：

- 风格选择
- Prompt审核
- 模型适配
- 视觉一致性

## AssetAgent

负责：

- 角色资产
- 道具资产
- 环境资产

## ProductionAgent

负责：

- 镜头Prompt
- 动作Prompt
- 视频Prompt

---

# 10. Prompt审核清单

生成前检查：

- 是否包含视觉风格
- 是否包含材质描述
- 是否包含摄影语言
- 是否包含灯光信息
- 是否符合角色锁定
- 是否符合世界观

---

Toonflow Cinematic Anime CG Prompt Engineering Rules V1.0

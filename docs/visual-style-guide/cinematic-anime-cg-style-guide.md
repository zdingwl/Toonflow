# Toonflow 电影级动漫 CG 视觉手册 V1.0

> Toonflow AI短剧生产系统视觉规范
>
> Cinematic Anime CG Visual Style Guide

## 1. 视觉定位

Toonflow 的目标不是生成单张漂亮图片，而是建立从剧本、分镜、资产到视频输出的统一视觉生产体系。

核心方向：

- 电影级动漫 CG
- 3D 角色建模
- PBR 材质
- 游戏过场动画质量
- 影视摄影语言
- 连续剧级角色一致性

默认视觉关键词：

```
cinematic anime CG,
3D animation movie style,
high quality character modeling,
PBR material,
film lighting,
Unreal Engine style render
```

禁止方向：

```
real photo
live action photography
flat 2D illustration
plastic skin
low detail game portrait
```

---

# 2. 角色设计标准

## 2.1 人体比例

默认采用 7-8 头身比例。

要求：

- 动漫美型比例
- 真人骨骼结构
- 电影角色设计感

禁止：

- Q版比例
- 夸张大头
- 普通真人写真比例

## 2.2 面部规范

角色面部需要同时满足：

- 动漫识别度
- 真人结构逻辑
- 电影表情表现力

眼睛要求：

- 虹膜纹理
- 透明角膜
- 环境反射
- 情绪表达

关键词：

```
detailed iris,
wet eyes,
cinematic eye lighting
```

---

# 3. 角色一致性系统

每个角色必须建立 Identity Lock：

```json
{
 "face_features":"",
 "hair":"",
 "eye_color":"",
 "body_type":"",
 "costume":"",
 "color_palette":"",
 "personality":""
}
```

不可随意改变：

- 发型
- 发色
- 年龄
- 身材
- 标志服装
- 特征伤痕

---

# 4. 材质规范

## 皮肤

标准：

```
skin shader
subsurface scattering
micro texture
soft specular
```

避免：

- 塑料皮肤
- 蜡像效果
- 过度磨皮

## 服装

必须表现：

- 布料纹理
- 褶皱逻辑
- 材质重量
- 光泽变化

---

# 5. 环境视觉规范

## 赛博都市

关键词：

```
cyberpunk megacity,
futuristic skyscrapers,
neon lights,
rain reflection,
volumetric fog
```

核心元素：

- 巨型建筑
- 霓虹灯牌
- 空中交通
- 湿润路面

## 东方幻想

关键词：

```
Chinese fantasy world,
ancient architecture,
misty mountains,
golden sunlight
```

## 末日废土

关键词：

```
post apocalypse city,
destroyed buildings,
ash particles,
dark atmosphere
```

---

# 6. 摄影语言

镜头必须服务故事。

## 景别

远景：展示世界规模。

中景：表现角色关系。

特写：表现情绪。

## 焦段

|焦段|用途|
|-|-|
|24mm|宏大环境|
|35mm|叙事镜头|
|50mm|自然人物|
|85mm|情绪特写|

---

# 7. 灯光系统

采用电影三点光：

```
Key Light
Fill Light
Rim Light
```

英雄角色：

```
warm key light,
cool rim light,
soft shadow,
cinematic contrast
```

末日场景：

```
cold blue lighting,
fog,
backlight,
low key lighting
```

---

# 8. AI生成提示词结构

统一结构：

```
角色身份
+
外貌
+
服装
+
材质
+
环境
+
摄影
+
灯光
+
渲染
```

示例：

```
young female warrior,
cold expression,
black long hair,
future armor suit,
PBR metallic material,
cinematic anime CG,
Unreal Engine render,
8K movie quality
```

---

# 9. VisualDirectorAgent规范

新增视觉导演层，负责连接：

```
剧本
 ↓
导演规划
 ↓
视觉设计
 ↓
资产生成
 ↓
视频生成
```

输出：

- style bible
- character rules
- environment rules
- prompt templates
- camera language
- color system

---

# 10. 质量检查

角色：

- 是否保持身份一致
- 五官是否稳定
- 服装是否统一

场景：

- 是否符合世界观
- 是否统一光影

镜头：

- 是否具有电影感
- 是否存在明确视觉重点

---

Toonflow Cinematic Anime CG Visual Style Guide
Version 1.0

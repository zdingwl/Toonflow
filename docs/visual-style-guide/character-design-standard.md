# Toonflow Character Design Standard V1.0

> Toonflow 电影级动漫 CG 角色资产工业标准

## 1. 目标

本规范用于统一 Toonflow 中角色从剧本分析、概念设计、资产生成到视频生产全过程的视觉标准。

目标：

- 保持角色跨镜头一致
- 建立可复用角色资产
- 提升 AI 生成角色的电影 CG 质量
- 支撑 DirectorAgent、VisualDirectorAgent、AssetAgent 调用

---

# 2. 角色生产流程

标准流程：

```
剧本角色
 ↓
角色视觉分析
 ↓
概念设计
 ↓
角色设定表
 ↓
四视图生成
 ↓
材质与服装定义
 ↓
表情动作库
 ↓
Identity Lock
 ↓
进入生产
```

---

# 3. Character Identity Schema

每个主要角色必须建立身份数据：

```json
{
  "id":"",
  "name":"",
  "age":"",
  "gender":"",
  "height":"",
  "body_type":"",
  "face_features":"",
  "hair_style":"",
  "eye_features":"",
  "skin":"",
  "costume":"",
  "accessories":"",
  "personality":"",
  "reference_images":[]
}
```

---

# 4. 人体比例标准

默认采用电影动画比例：

- 7～8头身
- 动漫美型结构
- 真人骨骼逻辑
- 真实肌肉关系

禁止：

- Q版比例
- 夸张大头
- 游戏头像比例
- 真人摄影脸

---

# 5. 面部设计规范

角色脸部必须包含：

- 脸型
- 眉形
- 眼型
- 鼻梁结构
- 唇形
- 特征点

特殊标识必须锁定：

- 泪痣
- 伤疤
- 特殊瞳色
- 发饰
- 胎记

这些元素属于角色身份，不允许自动修改。

---

# 6. 眼睛设计

电影级动漫眼睛标准：

```
detailed iris
wet eye surface
glass reflection
cinematic eye lighting
```

必须体现：

- 虹膜纹理
- 角膜透明感
- 环境反射
- 高光层次

---

# 7. 表情系统

表情必须服务剧情。

支持：

|情绪|表现|
|-|-|
|愤怒|眉压低、眼神锐利|
|悲伤|眼神失焦、嘴角下降|
|坚定|面部稳定、目光集中|
|恐惧|瞳孔变化、肌肉紧张|

禁止：

- AI固定微笑脸
- 无情绪表情
- 网红写真表情

---

# 8. 四视图标准

主要角色必须生成：

```
Front View
Side View
Back View
Three Quarter View
```

用于：

- 保持模型一致
- 生成视频参考
- 后续资产扩展

---

# 9. 服装设计系统

服装分层：

## Layer 0

身体基础。

## Layer 1

基础服装。

## Layer 2

职业装备。

## Layer 3

装饰物和标志物。

## Layer 4

剧情变化装备。

每层必须独立描述。

---

# 10. 材质标准

## 皮肤

要求：

```
PBR skin shader
subsurface scattering
natural skin texture
soft specular
```

避免：

- 塑料皮肤
- 蜡像效果
- 过度磨皮

## 金属

要求：

```
metallic material
roughness variation
surface scratches
```

## 布料

要求：

```
fabric texture
cloth folds
material weight
```

---

# 11. Prompt模板

角色基础：

```
cinematic anime character,
3D character model,
PBR material,
high quality rendering,
movie quality lighting
```

外观：

```
young warrior,
sharp eyes,
unique hairstyle,
determined expression
```

渲染：

```
Unreal Engine style render,
cinematic lighting,
8K detail
```

---

# 12. Identity Lock规则

禁止改变：

- 年龄
- 发型
- 发色
- 瞳色
- 身材比例
- 核心服装
- 标志性特征

任何后续镜头必须引用角色身份数据。

---

# 13. 角色审核标准

生成完成后检查：

□ 是否保持同一角色

□ 五官是否一致

□ 服装是否一致

□ 材质是否达到电影 CG 标准

□ 是否符合世界观

□ 是否适合视频连续使用

---

# 14. Agent调用规范

VisualDirectorAgent负责：

- 分析角色定位
- 建立视觉规则
- 输出Prompt约束

AssetAgent负责：

- 按规则生成资产
- 维护角色ID
- 保存参考图

ProductionAgent负责：

- 调用正确角色资产
- 防止角色漂移

---

# End

Toonflow Character Design Standard V1.0

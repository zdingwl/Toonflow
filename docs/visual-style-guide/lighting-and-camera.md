# Toonflow Lighting and Camera Standard V1.0

> 电影级动漫 CG 摄影与灯光规范

## 1. 目标

本规范用于统一 Toonflow 生成视频中的摄影语言、镜头运动、焦段选择和灯光系统，使 AI 生成内容具备电影动画级视觉表达。

核心原则：

- 镜头服务故事
- 光影服务情绪
- 构图服务角色表达
- 色彩服务世界观

---

# 2. 摄影机系统

## 2.1 景别标准

### 超远景 Extreme Wide Shot

用途：

- 建立世界规模
- 展示城市、战争、灾难场面

关键词：

```
extreme wide shot
cinematic environment
epic scale
establishing shot
```

---

### 远景 Wide Shot

用途：

- 人物与环境关系
- 场景叙事

关键词：

```
wide cinematic shot
full environment
character in scene
```

---

### 中景 Medium Shot

用途：

- 人物交流
- 动作表现

关键词：

```
medium shot
cinematic framing
character interaction
```

---

### 特写 Close Up

用途：

- 情绪表达
- 关键剧情节点

关键词：

```
close up
facial emotion
shallow depth of field
cinematic portrait
```

---

# 3. 镜头焦段规范

|焦段|用途|
|-|-|
|24mm|宏大环境、动作场面|
|35mm|电影叙事、自然空间|
|50mm|人物标准镜头|
|85mm|情绪特写、角色表现|
|135mm|压缩空间、孤独感|

---

# 4. 摄影机运动

## 推镜头 Push In

用途：

- 强调人物心理变化
- 增强紧张感

Prompt:

```
slow camera push in
cinematic movement
emotional focus
```

---

## 拉远 Pull Out

用途：

- 展示孤独
- 展示世界规模

---

## 环绕 Orbit

用途：

- 英雄登场
- 战斗展示

---

## 跟随 Tracking Shot

用途：

- 追逐
- 行动场景

---

# 5. 构图规则

## 三分法

人物不要默认居中。

优先：

- 三分线位置
- 前景遮挡
- 景深层次

---

## 前中后景结构

标准电影构图：

```
Foreground
    ↓
Character
    ↓
Background
```

增加空间深度。

---

# 6. 灯光系统

## 6.1 三点布光

基础结构：

```
Key Light
Fill Light
Rim Light
```

---

## Key Light 主光

决定：

- 方向
- 情绪
- 角色重点

---

## Fill Light 补光

控制：

- 阴影强度
- 面部细节

---

## Rim Light 轮廓光

用于：

- 英雄感
- 科幻感
- 夜景分离

---

# 7. 电影灯光模板

## 英雄角色

```
warm key light
cool rim light
soft shadows
cinematic contrast
```

效果：

- 强调轮廓
- 提升角色重量

---

## 赛博都市

```
neon lighting
rain reflection
volumetric fog
blue purple atmosphere
```

---

## 末日场景

```
low key lighting
dark atmosphere
backlight
ash particles
cold color tone
```

---

## 东方幻想

```
soft sunlight
mist lighting
golden atmosphere
volumetric rays
```

---

# 8. 动作镜头规范

战斗场景必须包含：

- 动作方向
- 摄影机运动
- 空间关系
- 光影变化

示例：

```
fast camera movement,
low angle shot,
dynamic action pose,
cinematic motion blur,
dramatic lighting
```

---

# 9. 视频生成镜头数据结构

```json
{
  "shot_type":"close_up",
  "lens":"85mm",
  "camera_move":"push_in",
  "lighting":"rim_light",
  "color":"cold_blue",
  "emotion":"determined"
}
```

---

# 10. CameraAgent审核规则

检查：

- 是否符合剧情情绪
- 是否有明确主体
- 是否存在摄影语言
- 是否避免随机镜头
- 是否保持视觉连续

---

# 11. Toonflow视觉原则

优秀镜头必须满足：

1. 一眼知道主体是谁
2. 一眼知道发生在哪里
3. 一眼感受到情绪
4. 镜头运动具有目的


End.

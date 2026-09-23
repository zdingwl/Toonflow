# Toonflow Consistency Control System V1.0

> AI短剧电影级动漫 CG 一致性控制规范

## 1. 目标

AI视频生产中最常见的问题：

- 角色在不同镜头中变化
- 场景结构漂移
- 服装状态错误
- 时间线不连续
- 资产无法复用

Consistency Control 用于保证 Toonflow 从剧本到成片的视觉连续性。

核心原则：

```
一次设计
持续引用
禁止随机重构
```

---

# 2. 一致性控制架构

```
Character Lock
        |
Scene Lock
        |
Costume State
        |
Timeline Graph
        |
Shot Validation
        |
Generation
```

---

# 3. Character Identity Lock

每个角色建立唯一身份档案。

```json
{
 "character_id":"",
 "face_features":"",
 "hair":"",
 "eye_color":"",
 "body_ratio":"",
 "costume":"",
 "signature_features":"",
 "reference_images":[]
}
```

固定字段：

- 脸型
- 眼睛
- 发型
- 身材比例
- 标志特征
- 核心服装

禁止模型自动修改。

---

# 4. Scene Identity Lock

场景必须建立环境档案。

```json
{
 "scene_id":"",
 "architecture":"",
 "color_palette":"",
 "lighting":"",
 "weather":"",
 "time":"",
 "landmarks":[]
}
```

固定：

- 建筑结构
- 主色调
- 光照方向
- 天气
- 时间状态

---

# 5. Costume State Machine

服装变化必须由剧情驱动。

状态：

```
Normal
 |
Battle Damage
 |
Upgrade
 |
Final Form
```

禁止：

- 无剧情换装
- 颜色随机变化
- 装饰消失

---

# 6. Timeline Continuity

所有资产绑定时间轴。

示例：

```json
{
 "episode":1,
 "scene":3,
 "character_state":"injured",
 "costume_state":"damaged",
 "weather":"rain"
}
```

后续镜头必须继承状态。

---

# 7. Shot Continuity Graph

镜头之间建立关系：

```
Shot A
 |
transition
 |
Shot B
```

记录：

- 人物位置
- 动作方向
- 摄影机方向
- 环境状态

---

# 8. Reference Asset Binding

生成视频前绑定：

```
Character Reference
+
Scene Reference
+
Costume Reference
+
Camera Reference
```

避免模型重新创造。

---

# 9. Consistency Validation Agent

新增监督能力：

输入：

- 当前镜头
- 历史资产
- 角色档案

输出：

```json
{
 "character_match":true,
 "scene_match":true,
 "costume_match":true,
 "continuity_score":0
}
```

---

# 10. 生成审核规则

生成前：

- 是否绑定角色ID
- 是否绑定场景ID
- 是否继承上一镜头状态
- 是否符合时间线

生成后：

- 人物一致性检查
- 环境一致性检查
- 色彩一致性检查
- 镜头连续性检查

---

# 11. Agent职责

VisualDirectorAgent：

负责视觉统一。

AssetAgent：

负责资产生成。

ProductionAgent：

负责镜头生产。

SupervisorAgent：

负责一致性审核。

---

# 12. 最终生产链

```
剧本
 ↓
导演规划
 ↓
VisualDirectorAgent
 ↓
Character Lock
 ↓
Scene Lock
 ↓
Prompt Compiler
 ↓
Asset Generation
 ↓
Video Generation
 ↓
Consistency Validation
 ↓
Final Render
```

---

Toonflow Cinematic Anime CG Consistency Control V1.0

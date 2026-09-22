# Toonflow Environment Design Standard V1.0

> Toonflow 电影级动漫 CG 场景资产工业标准

## 1. 场景设计目标

环境资产必须服务于故事、角色和镜头，不生成孤立背景。

核心标准：

- 电影级空间设计
- 3D CG 渲染质量
- PBR 材质体系
- 可连续使用的场景资产
- 符合镜头语言的构图

## 2. 环境资产结构

每个场景需要定义：

```json
{
 "scene_id":"",
 "world_type":"",
 "location":"",
 "time":"",
 "weather":"",
 "lighting":"",
 "color_palette":"",
 "architecture":"",
 "key_objects":[]
}
```

## 3. 空间尺度规范

场景必须保持真实空间关系：

- 建筑尺寸符合人物比例
- 道具具有实际功能
- 远景、中景、近景层次明确
- 保留镜头运动空间

## 4. 赛博都市环境标准

视觉方向：

```
cinematic cyberpunk megacity,
futuristic architecture,
neon lights,
rain reflection,
volumetric fog,
large scale environment,
movie quality render
```

核心元素：

- 巨型摩天建筑
- 全息广告
- 空中交通
- 湿润街道
- 未来工业设备
- 动态光源

## 5. 东方幻想环境标准

视觉方向：

```
ancient chinese fantasy world,
cinematic environment,
misty mountains,
floating architecture,
golden sunlight,
epic atmosphere
```

核心元素：

- 山川层次
- 古建筑群
- 云雾系统
- 灵气效果
- 东方色彩体系

## 6. 末日废土环境标准

视觉方向：

```
post apocalypse city,
destroyed buildings,
dark atmosphere,
ash particles,
dramatic lighting,
cinematic destruction
```

要求体现：

- 时间侵蚀
- 建筑破坏
- 环境危险感
- 生存压力

## 7. 科幻空间环境标准

包含：

- 星际基地
- 太空船内部
- 高科技实验室
- 人工智能设施

关键词：

```
sci fi cinematic interior,
futuristic technology,
advanced materials,
film quality lighting
```

## 8. 天气系统

环境必须支持：

- 雨
- 雪
- 雾
- 沙尘
- 暴风
- 烟尘

天气影响：

- 色彩
- 光照
- 镜头氛围
- 角色状态

## 9. 时间系统

支持：

- 清晨
- 白天
- 黄昏
- 夜晚
- 极端天气时间

## 10. 场景一致性锁定

固定：

- 建筑结构
- 道路布局
- 主要道具
- 光源方向
- 色彩体系

禁止：

- 同一地点随机变化
- 建筑风格漂移
- 世界观不一致

## 11. AI 场景 Prompt 模板

结构：

```
世界类型
+
地点描述
+
建筑设计
+
环境元素
+
天气
+
时间
+
摄影语言
+
灯光
+
渲染质量
```

## 12. 场景审核标准

检查：

- 是否符合故事时代
- 是否支持角色行动
- 是否具有电影构图
- 是否保持系列一致性
- 是否达到 CG 质量

## 13. VisualDirectorAgent 场景职责

输入：

- 剧本事件
- 导演规划
- 角色需求

输出：

- 场景设计规范
- 环境 Prompt
- 色彩方案
- 镜头适配规则

---

Toonflow Cinematic Anime CG Environment Standard V1.0

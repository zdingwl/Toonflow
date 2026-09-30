# 正式 fixtures 约定

这里只存自动回归测试实际消费的、最小且可重放的输入/预期。现有 `qwen-fourview-layout-regressions.json` 保持不变。

从 `data/backups` 提炼案例时：

1. 标注来源路径/提交、对应缺陷及消费它的 `tests/*.test.*`。
2. 提取最小结构，用虚构项目、资产、轨道 ID 替换真实关联；移除凭据、个人资料、本机绝对路径、真实数据库和完整工作区导出。
3. 明确期望行为及断言，让测试在隔离临时数据库或 mock 中运行；默认无需真实账号、模型付费调用或运行中的服务。
4. 人工 A/B 图像和 live smoke 保留在历史证据目录，不自动晋升为稳定通过断言；不同模型/种子/环境的波动需单独记录。
5. 一次性修复脚本不是 fixture、迁移或测试。通用工具须重新设计可配置输入、目标校验及副作用边界，独立审查后才能进入 scripts/src。

新增真实运行输出由 `data/backups/.gitignore` 默认忽略。历史证据分类见 `data/backups/README.md` 和 `inventory.json`。

# data/backups 仓库边界

这里是历史证据与真实运行资料，**不是产品源码、正式 fixtures 或测试入口**。
逐文件分类、原路径、当前路径及原始字节 SHA-256 见 [inventory.json](inventory.json)。清理基于其中记录的 main 提交；不改业务逻辑，不执行历史操作脚本，不删历史证据。

## 分类与保留判断

| 资料 | 判断 | 处理 |
|---|---|---|
| asset-selection 的 asset-discovery-probe.ts | 真实项目探针，绑定项目 1790218938911、剧本 31 及资产 ID；导入应用并调用真实模型，停止标记不保证无启动副作用 | 原文归档为 archive/operations 下的 .ts.txt |
| asset-selection 的 repair-asset-selection.ts | 一次性重放修复，备份本机库、写关联并删除资产 137 及描述历史 | 原文归档为 .ts.txt，不作为迁移或测试 |
| asset-discovery-probe.json、discovery.json | 同一份实际发现结果，两个原文件字节相同；真实资产引用不是通用 fixture | 两份均保留，保持来源链 |
| verified-page.png | 当次 UI 验收截图，可人工复核，不是自动化断言 | 原路径保留 |
| director-storyboard-audit | 原剧本、工作区、轨道和执行面板是项目快照；时长、对白、资产及 validator 审计可复核缺陷 | 原路径保留；正式测试只采用提炼后的最小例子 |
| director-storyboard-repair | corrected-*、模型请求/输出、校验与日志是修复证据；live-workspace-* 是真实运行备份；apply-correction/model-probe 是项目专用操作 | 证据/快照保留；脚本原文归档 |
| h3-format-1790397222805.json | track/variant/assets 的真实运行备份 | 保留追溯，不纳入 fixtures |
| h3-reference-refresh | before/data-after/request 是真实运行备份；preflight-* 和 run.log 可复核前后结果；repair.ts 会启动路由并刷新真实提示词 | 数据保留；repair 原文归档 |
| h3-style-research | 人工 A/B 基线：原始失败、reference-only A、candidate B 的帧、prompt、graph/history、控制参数及生成上下文具有回归价值；旧模板、状态恢复记录仅作历史来源 | 完整保留原始字节和证据路径；generate-candidate 原文归档 |
| h3-hanging-action（含 trial2/trial3） | 帧、提示词、graph/history 和 visual-review 保存失败/撤回/通过的不同状态；before/after、saved-version 是项目状态；生成、改分镜、保存视频、观察渲染是本机操作 | 所有证据保留；操作脚本原文归档；不把 trial2 当成渲染成功 |
| qwen38-integration | sdk-live-tests 的工具调用/流式、text-api-test 的 HTTP 输出和 settings.png 是 live smoke 证据；before.json 是接入前真实配置备份 | 四个文件原路径、原字节保留；不视为跨环境稳定 fixtures |

## 隔离约定

- `archive/operations/<原相对路径>.txt` 只保存历史脚本原文。硬编码项目/资产/轨道 ID 和旧导入路径均是历史信息，不能直接执行、导入、注册到 package scripts 或复制成产品模块。需要新的修复时另行实现并审查目标范围，不能机械重放。
- 历史快照继续留在原目录，避免破坏 docs 的证据链接；它们与 `tests/fixtures` 明确分开。真实 ID、路径、配置仅用于追溯，不是产品默认值。
- `.gitignore` 默认忽略这里所有新增运行输出，包括现有证据目录内的新文件；已跟踪证据仍可正常查看和维护。新增可保留证据须逐文件审查并定向 `git add -f <文件>`，同时更新 inventory 的用途/来源/校验值；禁止整体强制添加备份目录。
- 数据库、WAL/SHM、真实项目导出、新日志、临时修复脚本留在本地忽略目录；不要把备份改名后放进源码或 fixtures。忽略规则不会追溯删除已跟踪文件，也不会改写 Git 历史。
- 正式 fixture 的晋升规则见 [tests/fixtures/README.md](../../tests/fixtures/README.md)。本次不把真实导出直接搬成 fixtures，不增加付费模型/生产数据库依赖。
- 人工视觉基线与 live smoke 是证据，不等于自动测试；不能用历史 tests.log 代替当前测试执行。当前 main 的 tests 入口和 TypeScript 排除规则保持不变。

## 证据限制

H3 A/B 的完整视频与历史脚本依赖的 SQLite 副本并未全部跟踪在仓库中；保留帧及任务记录不意味着能在任意环境直接重放。qwen38 的 live smoke 仅证明原环境当次工具调用、流式及 HTTP 路径。新增可复用测试须显式提供最小输入和可检查的预期，不依赖这些真实运行资料。

# Toonflow Agent 本地检索与恢复部署说明

本文对应 Toonflow 当前 Agent Runtime 的本地部署实现，目标环境为 Windows 原生运行、独立显卡、本地 Embedding / Reranker，不依赖云端检索服务。

## 推荐运行配置

高性能本地配置建议从以下值开始，再用仓库内基准脚本按实际项目调优：

- Embedding 后端：`ollama`
- Embedding 模型：`qwen3-embedding:4b`
- 混合检索：开启
- Reranker：开启前先启动本地服务
- Reranker 模型：`Qwen3-Reranker-4B`
- Reranker 候选数：`24`
- 记忆上下文 Token 预算：`2400`；长项目可逐步提高
- SQLite 向量分页扫描：`256`；大内存机器可尝试 `512` / `1024`

现有 ONNX MiniLM 配置仍然保留，可随时切回。Embedding 向量按模型 ID / Ollama 模型 digest 隔离，切换模型不会把旧向量与新向量混算，也不要求清空聊天记忆。

## Windows 本地服务

### 1. Embedding

安装并启动 Ollama 后准备模型：

```powershell
ollama pull qwen3-embedding:4b
```

Toonflow 只访问本机：

```text
http://127.0.0.1:11434
```

在「设置 → 记忆」中将 Embedding 后端切换为 Ollama，并填写 `qwen3-embedding:4b`。保存时后端会检查该模型是否已经安装；检查失败时不会写入一个不可用的配置。

### 2. Reranker

建议使用独立 Python 环境：

```powershell
pip install "sentence-transformers>=5.4.0" "transformers>=4.51.0" torch
```

把官方模型文件放入：

```text
data/models/Qwen3-Reranker-4B
```

启动：

```powershell
.\scripts\start-reranker.ps1
```

默认监听：

```text
http://127.0.0.1:11435/rerank
```

默认 batch size 为 4。显存余量充足并且候选文本较短时可以测试 8：

```powershell
.\scripts\start-reranker.ps1 -BatchSize 8
```

Reranker 地址在服务端会被限制为 localhost HTTP，避免记忆内容被配置到远端服务。

## 一键健康检查与性能基准

在 Toonflow 仓库根目录执行：

```powershell
.\scripts\check-agent-local.ps1
```

脚本会检查：

1. NVIDIA GPU / 驱动是否可见；
2. Ollama 是否运行以及指定 Embedding 模型是否安装；
3. Embedding 是否真实返回向量及其维度；
4. Reranker 健康端点是否可用；
5. 单次 Embedding p50 / p95；
6. Embedding 批量吞吐；
7. Reranker p50 / p95。

也可以单独执行：

```powershell
yarn benchmark:agent-local
```

不要只根据一次冷启动结果调整参数。先预热，再比较 p50 / p95 与批量吞吐；如果提高 Reranker batch size 后出现显存不足，应恢复到更小的 batch。

## 记忆检索链路

当前链路为：

```text
近期对话
  + 历史摘要
  + 关键词召回
  + 版本化向量召回
        ↓
分页扫描 + 有界 Top-K
        ↓
可选 Qwen3 Reranker
        ↓
Token Budget Context Manager
        ↓
Decision Agent
```

SQLite 向量阶段目前仍是精确 cosine 扫描，不是 ANN/HNSW。分页 Top-K 已避免一次把整个向量集合加载到 Node 内存；当单项目向量规模进一步扩大到需要 ANN 时，再单独引入本地向量索引，避免现在就增加 Windows / Electron 原生依赖。

## Agent 恢复语义

Agent Runtime 将以下状态写入 SQLite：

- Run：用户请求级任务；
- Step：子 Agent checkpoint；
- ToolCall：工具调用与副作用状态；
- Skill Snapshot：任务期间使用的 Skill 固定版本；
- Operation Receipt：图片生成等长任务的 requestId 受理回执。

恢复时遵循：

- `completed`：禁止重复业务写入；
- `retryable`：已证明上次没有提交副作用，可以安全重试；
- `reconciling`：结果无法证明，必须先核对；
- 已完成写工具结果由 ToolExecutor 直接复用；
- 相同生成任务使用稳定 requestId，网络回执丢失时通过后端回执确认是否已经受理。

分镜表、分镜面板、衍生资产写入和图片生成受理目前都已经接入对应的持久化核对路径。

param(
  [string]$EmbeddingModel = "qwen3-embedding:4b",
  [string]$OllamaUrl = "http://127.0.0.1:11434",
  [string]$RerankerUrl = "http://127.0.0.1:11435/rerank",
  [int]$Rounds = 12,
  [int]$Candidates = 24
)

$ErrorActionPreference = "Stop"
Write-Host "== Toonflow 本地检索环境检查 =="

try {
  $gpu = & nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>$null
  if ($LASTEXITCODE -eq 0 -and $gpu) { Write-Host "GPU: $gpu" }
  else { Write-Warning "未检测到 nvidia-smi；Embedding 仍可通过 Ollama CPU/GPU 后端运行。" }
} catch {
  Write-Warning "未检测到 nvidia-smi。"
}

$tags = Invoke-RestMethod -Method Get -Uri "$OllamaUrl/api/tags" -TimeoutSec 10
$modelFound = $false
foreach ($item in $tags.models) {
  if ($item.name -eq $EmbeddingModel) {
    $modelFound = $true
    Write-Host "Embedding 模型: $($item.name)  digest=$($item.digest)"
    break
  }
}
if (-not $modelFound) {
  throw "Ollama 中未安装 $EmbeddingModel。请先在本机安装模型后再启用 embeddingBackend=ollama。"
}

$embedBody = @{
  model = $EmbeddingModel
  input = "Toonflow 本地 Embedding 健康检查"
  truncate = $false
  keep_alive = "10m"
} | ConvertTo-Json
$embed = Invoke-RestMethod -Method Post -Uri "$OllamaUrl/api/embed" -ContentType "application/json" -Body $embedBody -TimeoutSec 120
if (-not $embed.embeddings -or $embed.embeddings.Count -lt 1) { throw "Ollama Embedding 健康检查没有返回向量。" }
Write-Host "Embedding 维度: $($embed.embeddings[0].Count)"

$healthUrl = $RerankerUrl -replace "/rerank/?$", "/health"
try {
  $rerankerHealth = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 120
  if ($rerankerHealth.ok) {
    Write-Host "Reranker: OK  device=$($rerankerHealth.device)  modelDir=$($rerankerHealth.modelDir)"
  } else {
    Write-Warning "Reranker 服务返回非健康状态。"
  }
} catch {
  Write-Warning "Reranker 未启动或健康检查失败。可先运行 scripts/start-reranker.ps1；未启用 Reranker 时 Toonflow 会降级为混合召回结果。"
}

Write-Host "== 开始稳态延迟基准 =="
node (Join-Path $PSScriptRoot "benchmark-agent-local.mjs") --model $EmbeddingModel --ollama $OllamaUrl --reranker $RerankerUrl --rounds $Rounds --candidates $Candidates
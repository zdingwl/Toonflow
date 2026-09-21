param(
  [string]$ModelDir = "",
  [string]$Device = "cuda",
  [int]$Port = 11435,
  [int]$BatchSize = 4
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ModelDir) {
  $ModelDir = Join-Path $repoRoot "data\models\Qwen3-Reranker-4B"
}

if (-not (Test-Path $ModelDir -PathType Container)) {
  throw "Reranker 模型目录不存在: $ModelDir"
}

$env:TOONFLOW_RERANKER_MODEL_DIR = (Resolve-Path $ModelDir).Path
$env:TOONFLOW_RERANKER_DEVICE = $Device
$env:TOONFLOW_RERANKER_PORT = "$Port"
$env:TOONFLOW_RERANKER_BATCH_SIZE = "$BatchSize"

Write-Host "启动 Toonflow 本地 Reranker"
Write-Host "模型: $env:TOONFLOW_RERANKER_MODEL_DIR"
Write-Host "设备: $Device"
Write-Host "地址: http://127.0.0.1:$Port"
Write-Host "BatchSize: $BatchSize"

python (Join-Path $PSScriptRoot "reranker-server.py")

# 启动本地识别模型（llama.cpp + Vulkan GPU 加速）
#
# 用法：  pwsh -File tools\start-local-ai.ps1
# 可选参数：-Model <gguf 路径>  -Port <端口>  -Ctx <上下文长度>  -Cpu（强制 CPU 推理）
#
# 启动后保持这个窗口开着；关掉窗口就等于停掉本地模型。
# 默认端口 8080，与 .env 里的 LOCAL_AI_BASE_URL 对应。

param(
  [string]$Model = "",
  [int]$Port = 8080,
  [int]$Ctx = 4096,
  [int]$Parallel = 2,
  [switch]$Cpu
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $PSScriptRoot 'llama\llama-server.exe'
if (-not (Test-Path $server)) { throw "没有找到 llama-server.exe，请先下载 llama.cpp 的 win-vulkan 包到 tools\llama\" }

if (-not $Model) {
  $candidates = @(
    (Join-Path $PSScriptRoot 'models\Qwen3-4B-Q4_K_M.gguf'),
    (Join-Path $PSScriptRoot 'models\Qwen3-1.7B-Q4_K_M.gguf'),
    (Join-Path $PSScriptRoot 'models\Qwen3-0.6B-Q4_K_M.gguf')
  )
  $Model = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Model -or -not (Test-Path $Model)) { throw "没有找到可用的 .gguf 模型，请先下载到 tools\models\（见 README）" }

$args = @(
  '-m', $Model,
  '--host', '127.0.0.1',
  '--port', "$Port",
  '--alias', 'local',      # 对上层的模型名，切换不同 gguf 时 .env 不用改
  '-c', "$Ctx",
  '-np', "$Parallel",
  '--jinja',              # 用模型自带的对话模板
  '--no-warmup',
  '-fa', 'auto'           # 允许 flash attention
)
if ($Cpu) { $args += @('-ngl', '0') } else { $args += @('-ngl', '99') }

Write-Host "模型  : $(Split-Path -Leaf $Model)"
Write-Host "接口  : http://127.0.0.1:$Port/v1  ($(if ($Cpu) { 'CPU 推理' } else { 'Vulkan GPU 加速' }))"
Write-Host "停止  : 按 Control + C 或关闭这个窗口"
Write-Host "-----------------------------------------------"
& $server @args

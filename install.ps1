# ============================================================================
# AI 润色插件 · 一键安装（DSH profile bundle）
#
# 目的：安装只需要这一条命令，读 INSTALL.md 即可完成，**不需要打开 DSH 源码**。
#   1) 复制 plugin/ 到 $DSH_HOME\plugins\dsh-plugin-ai-polish
#   2) dsh plugin --profile <profile> add link:<该目录>
#      —— 这一步同时把插件写进 profile 的 dsh.profile.bundles
#   3) 打印「组合树是否出现该插件行」作为校验
#
# 用法:
#   pwsh -NoProfile -File install.ps1
#   pwsh -NoProfile -File install.ps1 -Port 3080
# ============================================================================
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }),
  [int]$Port = 3080
)

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'plugin'
if (-not (Test-Path $source)) { throw "找不到插件目录: $source（请在仓库根目录执行本脚本）" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$target = Join-Path $dshHome "plugins\dsh-plugin-ai-polish"

New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($file in 'package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'README.md') {
  $from = Join-Path $source $file
  if (Test-Path $from) { Copy-Item $from (Join-Path $target $file) -Force }
}
Write-Host "[1/3] 已复制插件 -> $target"

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $dsh) {
  throw "PATH 中没有 dsh 命令。请改用完整路径执行: dsh plugin --profile $Profile add `"link:$target`""
}

& $dsh.Source plugin --profile $Profile add "link:$target"
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（退出码 $LASTEXITCODE）" }
Write-Host "[2/3] 已写入 profile '$Profile' 的 dsh.profile.bundles"

# 校验 1：组合树里应出现该插件行（本地命令，不调用模型、不花 token）
$dump = & $dsh.Source --profile $Profile --dump-config 2>&1 | Out-String
if ($dump -match 'dsh-plugin-ai-polish') {
  Write-Host "[3/3] 组合树校验通过：包含 dsh-plugin-ai-polish"
} else {
  Write-Warning "[3/3] 组合树里没找到 dsh-plugin-ai-polish，请把下列输出发给助手排查：`n$dump"
}

# 校验 2（可选）：运行中的 DSH 是否已加载 Host 半
try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/dsh-ai-polish/status" -TimeoutSec 5
  Write-Host "      运行中的 DSH 已加载 Host 半：$($status | ConvertTo-Json -Compress)"
} catch {
  Write-Host "      （运行中的 DSH 尚未加载：404/连不上说明需要重启 dsh web；这不影响已写入的安装）"
}

Write-Host ''
Write-Host '完成。接下来只需刷新一次页面，模型选择器左侧应出现「✨ AI 润色」。'
Write-Host '不要为验证而做真实润色调用（会花约 393 tokens）；status 返回正常即已就绪。'

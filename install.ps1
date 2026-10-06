# 安装 AI 润色插件到当前 DSH profile（web）。
# 用法: pwsh -NoProfile -File install.ps1
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'plugin'
if (-not (Test-Path $source)) { throw "找不到插件目录: $source" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$target = Join-Path $dshHome "plugins\dsh-plugin-ai-polish"

New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($file in 'package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'README.md') {
  $from = Join-Path $source $file
  if (Test-Path $from) { Copy-Item $from (Join-Path $target $file) -Force }
}
Write-Host "已复制插件 -> $target"

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $dsh) {
  throw "PATH 中没有 dsh 命令；请用实际 dsh 可执行文件执行: dsh plugin --profile $profile add link:$target"
}

& $dsh.Source plugin --profile $profile add "link:$target"
exit $LASTEXITCODE

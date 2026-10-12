$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '未找到 Node.js，请安装 Node.js 并重新打开 PowerShell 后重试。' }
& $nodeCommand.Source (Join-Path $PSScriptRoot 'server.mjs')

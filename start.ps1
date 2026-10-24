$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$solverNode = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $solverNode)) { throw '未找到 Node.js，请安装 Node.js 后重试。' }
& $solverNode (Join-Path $PSScriptRoot 'server.mjs')

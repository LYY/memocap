$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'setup.mjs') @args
exit $LASTEXITCODE

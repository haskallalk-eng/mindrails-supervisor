param([switch]$ReadOnly)
$ErrorActionPreference = 'Stop'
# Refresh the persistent user key even when Codex was opened before installation.
if (-not $env:AI_GATEWAY_API_KEY) {
    $env:AI_GATEWAY_API_KEY = [Environment]::GetEnvironmentVariable('AI_GATEWAY_API_KEY', 'User')
}
$jevEntry = Join-Path $PSScriptRoot '../dist/jev.js'
if ($ReadOnly) { & node $jevEntry }
else { & node $jevEntry --workspace-write }
exit $LASTEXITCODE

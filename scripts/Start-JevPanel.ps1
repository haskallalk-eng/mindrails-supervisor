param(
    [string]$Thread,
    [string]$Cwd = (Get-Location).Path,
    [switch]$WorkspaceWrite,
    [int]$Port = 47821,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
# Refresh the persistent user key even when the shell was opened before installation.
if (-not $env:AI_GATEWAY_API_KEY) {
    $env:AI_GATEWAY_API_KEY = [Environment]::GetEnvironmentVariable('AI_GATEWAY_API_KEY', 'User')
}
$panelArgs = @('--cwd', $Cwd, '--port', $Port)
if ($Thread) { $panelArgs += @('--thread', $Thread) }
if ($WorkspaceWrite) { $panelArgs += '--workspace-write' }
if ($NoOpen) { $panelArgs += '--no-open' }
& node (Join-Path $PSScriptRoot '../dist/jev-panel.js') @panelArgs
exit $LASTEXITCODE

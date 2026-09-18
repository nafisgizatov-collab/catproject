$ErrorActionPreference = 'Stop'
$resultPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\restart-task-result.json'
try {
    & schtasks.exe /End /TN TelegramCatDoor
    if ($LASTEXITCODE -ne 0) { throw 'Cannot stop TelegramCatDoor; no new instance started.' }
    & schtasks.exe /Run /TN TelegramCatDoor
    if ($LASTEXITCODE -ne 0) { throw 'Cannot start TelegramCatDoor.' }
    @{ at = (Get-Date -Format o); success = $true } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    @{ at = (Get-Date -Format o); success = $false; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 1
}

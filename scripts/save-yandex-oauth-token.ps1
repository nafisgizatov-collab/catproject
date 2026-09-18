$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'

if (-not (Test-Path $envPath)) { throw '.env is missing' }

$token = Read-Host 'Paste Yandex OAuth token and press Enter (input is visible)'
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Token was not entered' }

$lines = Get-Content -LiteralPath $envPath
$lines = $lines | Where-Object { $_ -notmatch '^YANDEX_OAUTH_TOKEN=' }
$lines += "YANDEX_OAUTH_TOKEN=$token"
Set-Content -LiteralPath $envPath -Value $lines -Encoding utf8

Write-Host 'Token saved locally in .env.'

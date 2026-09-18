$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv-miio\Scripts\python.exe"
$script = Join-Path $PSScriptRoot "get-xiaomi-hub-token.py"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Не найдено окружение python-miio: $python"
}

& $python $script
exit $LASTEXITCODE

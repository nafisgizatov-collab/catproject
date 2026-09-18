$projectRoot = Split-Path -Parent $PSScriptRoot
$ffmpeg = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tools\ffmpeg') -Filter 'ffmpeg.exe' -Recurse |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $ffmpeg) {
    throw 'FFmpeg is not installed in tools\\ffmpeg.'
}

$environmentPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
$environmentPath = "$(Split-Path -Parent $ffmpeg);$environmentPath"
$logPath = Join-Path $projectRoot 'runtime\cat-service-console.log'
$errorLogPath = Join-Path $projectRoot 'runtime\cat-service-error.log'

$previousPath = $env:PATH
$env:PATH = $environmentPath
try {
    Start-Process -FilePath 'node.exe' `
        -ArgumentList @('src/motion-trigger.js') `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError $errorLogPath
}
finally {
    $env:PATH = $previousPath
}

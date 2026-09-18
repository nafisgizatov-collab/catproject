$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot 'runtime'
$childStatePath = Join-Path $runtime 'cat-service-children.json'
$ffmpeg = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tools\ffmpeg') -Filter 'ffmpeg.exe' -Recurse |
    Select-Object -First 1 -ExpandProperty FullName
$go2rtc = Join-Path $projectRoot 'tools\go2rtc\go2rtc.exe'
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'

if (-not $ffmpeg -or -not (Test-Path $go2rtc) -or -not (Test-Path $node)) {
    throw 'The camera service dependencies are missing.'
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$env:PATH = "$(Split-Path -Parent $ffmpeg);$env:PATH"

# The monitor launches the Yandex and indoor watchers as detached Node
# processes.  Without explicit cleanup, restarting this supervisor leaves the
# old watchers alive and each one retains an AI model in RAM.  Record both PID
# and creation time, so a reused PID can never cause an unrelated process to
# be stopped.
function Stop-PreviousProjectChildren {
    # The PID file is the normal path.  Older releases did not create it, so
    # also remove only Node processes whose command line names one of our two
    # detached watcher scripts.  This runs as the task's SYSTEM account and
    # therefore can clean up stale children from earlier task runs.
    $watchers = @(
        (Join-Path $projectRoot 'src\yandex-door-monitor.js'),
        (Join-Path $projectRoot 'src\indoor-door-watcher.js')
    )
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $candidate = $_
            $candidate.Name -eq 'node.exe' -and $null -ne $candidate.CommandLine -and
            ($watchers | Where-Object { $candidate.CommandLine -like "*$_*" })
        } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    if (-not (Test-Path -LiteralPath $childStatePath)) { return }
    try { $children = @(Get-Content -Raw -LiteralPath $childStatePath | ConvertFrom-Json) }
    catch { Remove-Item -LiteralPath $childStatePath -Force -ErrorAction SilentlyContinue; return }

    foreach ($child in $children) {
        $process = Get-Process -Id ([int]$child.Id) -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.ProcessName -ne 'node') { continue }
        $startedAt = $process.StartTime.ToUniversalTime().ToString('o')
        if ($startedAt -eq [string]$child.StartedAt) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $childStatePath -Force -ErrorAction SilentlyContinue
}

function Start-ProjectNode([string]$scriptPath) {
    $process = Start-Process -FilePath $node -ArgumentList @($scriptPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    return [PSCustomObject]@{
        Id = $process.Id
        StartedAt = $process.StartTime.ToUniversalTime().ToString('o')
    }
}

Stop-PreviousProjectChildren
$projectChildren = @()

function Start-Go2RtcIfNeeded {
    if (Get-Process -Name 'go2rtc' -ErrorAction SilentlyContinue) { return }
    Start-Process -FilePath $go2rtc `
        -ArgumentList @('-config', (Join-Path $runtime 'go2rtc.yaml')) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime 'go2rtc-console.log') `
        -RedirectStandardError (Join-Path $runtime 'go2rtc-error.log')
    Start-Sleep -Seconds 5
}

$yandexMonitor = Join-Path $projectRoot 'src\yandex-door-monitor.js'
if (Test-Path $yandexMonitor) {
    $projectChildren += Start-ProjectNode $yandexMonitor
}

# Indoor checks now run inside motion-trigger, sharing its loaded models.
# Stop-PreviousProjectChildren still removes watchers from older releases.

$projectChildren | ConvertTo-Json | Set-Content -LiteralPath $childStatePath -Encoding UTF8

while ($true) {
    Start-Go2RtcIfNeeded
    & $node (Join-Path $projectRoot 'src\motion-trigger.js')
    Add-Content -Path (Join-Path $runtime 'cat-service-supervisor.log') `
        -Value "$(Get-Date -Format o) motion process exited; restarting in 30 seconds"
    Start-Sleep -Seconds 30
}

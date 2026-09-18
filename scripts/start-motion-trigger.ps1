param(
    [ValidateRange(0.01, 1.0)]
    [double]$SceneThreshold = 0.08,

    [ValidateRange(5, 3600)]
    [int]$CooldownSeconds = 30,

    [ValidateRange(1, 848)]
    [int]$CropX = 238,

    [ValidateRange(1, 480)]
    [int]$CropY = 40,

    [ValidateRange(1, 848)]
    [int]$CropWidth = 610,

    [ValidateRange(1, 480)]
    [int]$CropHeight = 400
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$ffmpeg = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tools\ffmpeg') -Filter 'ffmpeg.exe' -Recurse |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $ffmpeg) {
    throw 'FFmpeg is not installed in tools\\ffmpeg.'
}

$eventsDirectory = Join-Path $projectRoot 'runtime\events'
New-Item -ItemType Directory -Path $eventsDirectory -Force | Out-Null

$source = 'rtsp://127.0.0.1:8554/door'
$output = Join-Path $eventsDirectory 'motion-%Y%m%d-%H%M%S.jpg'
$filter = "crop=$CropWidth`:$CropHeight`:$CropX`:$CropY,select='gt(scene,$SceneThreshold)*if(isnan(prev_selected_t),1,gte(t-prev_selected_t\,$CooldownSeconds))'"

Write-Host "Watching the door area for motion. Event images: $eventsDirectory"
& $ffmpeg -hide_banner -loglevel warning -rtsp_transport tcp -i $source `
    -vf $filter -fps_mode vfr -q:v 2 -strftime 1 $output


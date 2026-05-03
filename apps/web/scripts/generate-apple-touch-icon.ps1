# Regenerates apple-touch-icon-180.png from logos/png/vizyo-tracky-icon-black.png.
# Run from anywhere: powershell -File apps/web/scripts/generate-apple-touch-icon.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcPath = Join-Path $PSScriptRoot "..\public\logos\png\vizyo-tracky-icon-black.png"
$dstPath = Join-Path $PSScriptRoot "..\public\apple-touch-icon-180.png"
$srcPath = (Resolve-Path $srcPath).Path
$dstPath = (Join-Path (Resolve-Path (Split-Path $dstPath)).Path (Split-Path -Leaf $dstPath))

$src = [System.Drawing.Image]::FromFile($srcPath)
$canvas = New-Object System.Drawing.Bitmap 180, 180
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# 20px padding on each side -> safe area for iOS rounded mask
$padding = 20
$avail = 180 - (2 * $padding)
$srcAspect = $src.Width / $src.Height
if ($srcAspect -ge 1) { $w = $avail; $h = [int]($avail / $srcAspect) } else { $h = $avail; $w = [int]($avail * $srcAspect) }
$x = [int](( 180 - $w) / 2)
$y = [int](( 180 - $h) / 2)

$g.DrawImage($src, (New-Object System.Drawing.Rectangle $x, $y, $w, $h))
$g.Dispose()
$canvas.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
$src.Dispose()
Write-Output "Wrote $dstPath ($w x $h centered in 180 x 180)"

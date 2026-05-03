# Regenere les apple-touch-startup-image (splash iOS standalone) en 2 variantes :
#   light : fond #FFFFFF + logo vert degrade  (vizyo-tracky-icon-green.png)
#   dark  : fond #0A0F0D + logo blanc         (vizyo-tracky-icon-white.png)
#
# iOS 13+ supporte (prefers-color-scheme) sur <link rel="apple-touch-startup-image">,
# l'index.html y bind chaque variante via media query — zero flash au boot et
# coherence avec le splash in-DOM (lui aussi theme-aware).
#
# Sortie : public/splash/apple-splash-{light|dark}-{w}x{h}.png
# Run    : powershell -File apps/web/scripts/generate-splash-screens.ps1

Add-Type -AssemblyName System.Drawing

$publicDir = (Resolve-Path (Join-Path $PSScriptRoot "..\public")).Path
$splashDir = Join-Path $publicDir "splash"
$srcGreen = Join-Path $publicDir "logos\png\vizyo-tracky-icon-green.png"
$srcWhite = Join-Path $publicDir "logos\png\vizyo-tracky-icon-white.png"

if (-not (Test-Path $splashDir)) { New-Item -ItemType Directory -Path $splashDir | Out-Null }

# Toutes les paires {portrait, landscape} attendues par index.html.
# Note: indique le PORTRAIT, le landscape est genere par swap automatique.
$portraits = @(
    @(750, 1334),  @(828, 1792),  @(1242, 2208), @(1125, 2436),
    @(1242, 2688), @(1170, 2532), @(1284, 2778), @(1179, 2556),
    @(1206, 2622), @(1290, 2796), @(1320, 2868), @(1536, 2048),
    @(1620, 2160), @(1640, 2360), @(1668, 2388), @(2048, 2732),
    @(2064, 2752)
)

function New-Splash {
    param(
        [int]$W,
        [int]$H,
        [System.Drawing.Color]$BgColor,
        [string]$LogoPath,
        [string]$OutPath
    )
    $logo = [System.Drawing.Image]::FromFile($LogoPath)
    $canvas = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($canvas)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear($BgColor)

    # Logo : 28% de la plus petite dimension. Aspect logo source (256x286 = 0.895
    # = un peu plus haut que large a cause de la goutte GPS).
    $minDim = [Math]::Min($W, $H)
    $targetH = [int]($minDim * 0.28)
    $aspect = $logo.Width / $logo.Height
    $targetW = [int]($targetH * $aspect)
    $x = [int]((($W - $targetW) / 2))
    $y = [int]((($H - $targetH) / 2))

    $g.DrawImage($logo, (New-Object System.Drawing.Rectangle $x, $y, $targetW, $targetH))
    $g.Dispose()

    $canvas.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Dispose()
    $logo.Dispose()
}

$bgLight = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)  # white
$bgDark  = [System.Drawing.Color]::FromArgb(255, 10, 15, 13)     # #0A0F0D

$count = 0
foreach ($p in $portraits) {
    foreach ($pair in @(@($p[0], $p[1]), @($p[1], $p[0]))) {
        $w = $pair[0]; $h = $pair[1]
        $lightOut = Join-Path $splashDir "apple-splash-light-${w}x${h}.png"
        $darkOut  = Join-Path $splashDir "apple-splash-dark-${w}x${h}.png"
        New-Splash -W $w -H $h -BgColor $bgLight -LogoPath $srcGreen -OutPath $lightOut
        New-Splash -W $w -H $h -BgColor $bgDark  -LogoPath $srcWhite -OutPath $darkOut
        $count += 2
    }
}

Write-Output "Generated $count splash screens (17 sizes x 2 orientations x 2 themes)"
Write-Output "Light : white bg + green gradient logo"
Write-Output "Dark  : #0A0F0D bg + white logo"

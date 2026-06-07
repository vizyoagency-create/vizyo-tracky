# Regenere les icones d'application PWA (iOS apple-touch-icon + Android manifest).
#
# Design : logo Vizyo Tracky vert dégradé centré sur fond blanc, avec padding
# safe-area pour eviter que la mask iOS / Android (radius ~20%) ne rogne le logo.
# Source : public/logos/png/vizyo-tracky-icon-green.png (gradient deja appliqué).
#
# Sorties (apps/web/public/) :
#   apple-touch-icon-180-v3.png    — iOS Add-to-home (180x180, padding 18%)
#                                    suffix -v2 = cache-bust iOS (cf. index.html)
#   pwa-icon-192.png               — Android manifest "any" (192x192, padding 18%)
#   pwa-icon-512.png               — Android manifest "any" (512x512, padding 18%)
#   pwa-icon-maskable-512.png      — Android maskable safe-zone (512x512, padding 22%)
#
# Run: powershell -File apps/web/scripts/generate-app-icons.ps1

Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "..\public\logos\png\vizyo-tracky-icon-green.png"
$publicDir = Join-Path $PSScriptRoot "..\public"
$srcPath = (Resolve-Path $srcPath).Path
$publicDir = (Resolve-Path $publicDir).Path

function New-AppIcon {
    param(
        [int]$Size,
        [string]$OutputName,
        [double]$PaddingRatio = 0.18
    )

    $src = [System.Drawing.Image]::FromFile($srcPath)
    $canvas = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($canvas)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    # Fond blanc plein (cohrence avec design Android FOODSQAN/FLOA, contraste avec le gradient vert)
    $g.Clear([System.Drawing.Color]::White)

    # Calcule la zone disponible apres padding
    $padding = [int]($Size * $PaddingRatio)
    $avail = $Size - (2 * $padding)
    $srcAspect = $src.Width / $src.Height
    if ($srcAspect -ge 1) {
        $w = $avail
        $h = [int]($avail / $srcAspect)
    } else {
        $h = $avail
        $w = [int]($avail * $srcAspect)
    }
    $x = [int](( $Size - $w) / 2)
    $y = [int](( $Size - $h) / 2)

    $g.DrawImage($src, (New-Object System.Drawing.Rectangle $x, $y, $w, $h))
    $g.Dispose()

    $dst = Join-Path $publicDir $OutputName
    $canvas.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Dispose()
    $src.Dispose()
    Write-Output "Wrote $dst ($w x $h logo centered in $Size x $Size, padding ${padding}px)"
}

# iOS apple-touch-icon (180x180) — utilisé quand l'utilisateur fait "Ajouter a l'ecran d'accueil"
New-AppIcon -Size 180 -OutputName "apple-touch-icon-180-v3.png" -PaddingRatio 0.18

# Android PWA manifest — purpose "any"
New-AppIcon -Size 192 -OutputName "pwa-icon-192.png" -PaddingRatio 0.18
New-AppIcon -Size 512 -OutputName "pwa-icon-512.png" -PaddingRatio 0.18

# Android maskable — safe zone du launcher = 80% du canvas (radius pouvant etre rogne).
# 22% de padding place le logo bien dans la zone non-rognee, peu importe la forme du mask.
New-AppIcon -Size 512 -OutputName "pwa-icon-maskable-512.png" -PaddingRatio 0.22

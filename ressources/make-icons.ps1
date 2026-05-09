# Renders icon-{16,32,48,128}.png from the same geometry as icon.svg
# Uses System.Drawing (built-in, no external deps).
# Run: powershell -File make-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = $PSScriptRoot
$sizes = 16, 32, 48, 128
$srcSize = 128.0

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $scale = $size / $srcSize
    $g.ScaleTransform($scale, $scale)

    # Background: rounded square in Brand-Grün
    $bgBrush  = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#005141"))
    $bgPath   = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 24.0
    $d = $r * 2
    $bgPath.AddArc(0, 0, $d, $d, 180, 90)
    $bgPath.AddArc(128 - $d, 0, $d, $d, 270, 90)
    $bgPath.AddArc(128 - $d, 128 - $d, $d, $d, 0, 90)
    $bgPath.AddArc(0, 128 - $d, $d, $d, 90, 90)
    $bgPath.CloseFigure()
    $g.FillPath($bgBrush, $bgPath)

    # Hash # in Brand-Orange (4 lines, leicht italic)
    $hashPen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#C44E00")), 9
    $hashPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $hashPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($hashPen, 40, 18, 32, 68)
    $g.DrawLine($hashPen, 68, 18, 60, 68)
    $g.DrawLine($hashPen, 18, 34, 78, 34)
    $g.DrawLine($hashPen, 16, 54, 76, 54)

    # Check in Weiß (M 56 90 L 76 112 L 116 64)
    $checkPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 14
    $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $checkPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $checkPath.AddLines(@(
        [System.Drawing.PointF]::new(56, 90),
        [System.Drawing.PointF]::new(76, 112),
        [System.Drawing.PointF]::new(116, 64)
    ))
    $g.DrawPath($checkPen, $checkPath)

    $hashPen.Dispose()
    $checkPen.Dispose()
    $bgBrush.Dispose()
    $g.Dispose()

    $out = Join-Path $root "icon-$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Host "Created $out"
}

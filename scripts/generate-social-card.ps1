param(
  [string]$LogoPath = (Join-Path $PSScriptRoot "..\docs\assets\bioecos-favicon.ico"),
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\docs\assets\bioecos-share.jpg")
)

Add-Type -AssemblyName System.Drawing

$canvas = New-Object System.Drawing.Bitmap 1200, 630
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(11, 33, 26))
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(126, 198, 73))
$accentSoft = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(25, 75, 57))
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$muted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(218, 234, 226))
$graphics.FillRectangle($background, 0, 0, 1200, 630)
$graphics.FillEllipse($accentSoft, 930, -190, 480, 480)
$graphics.FillEllipse($accentSoft, -170, 420, 420, 420)
$graphics.FillRectangle($accent, 0, 0, 16, 630)

$graphics.FillEllipse($white, 76, 150, 260, 260)
$logo = [System.Drawing.Image]::FromFile((Resolve-Path $LogoPath))
$graphics.DrawImage($logo, 131, 224, 150, 112)

$brandFont = New-Object System.Drawing.Font("Segoe UI", 60, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$titleFont = New-Object System.Drawing.Font("Segoe UI", 38, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = New-Object System.Drawing.Font("Segoe UI", 24, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$labelFont = New-Object System.Drawing.Font("Segoe UI", 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

$graphics.DrawString("BIOECOS", $brandFont, $white, 390, 150)
$graphics.DrawString("Painel da Automação", $titleFont, $white, 392, 238)
$graphics.DrawString("Monitoramento seguro do atendimento pelo WhatsApp", $bodyFont, $muted, 395, 315)
$graphics.FillRectangle($accent, 394, 382, 224, 45)
$graphics.DrawString("AMBIENTE PROTEGIDO", $labelFont, $background, 407, 390)

$canvas.Save((Resolve-Path (Split-Path $OutputPath -Parent)).Path + "\" + (Split-Path $OutputPath -Leaf), [System.Drawing.Imaging.ImageFormat]::Jpeg)

$labelFont.Dispose()
$bodyFont.Dispose()
$titleFont.Dispose()
$brandFont.Dispose()
$logo.Dispose()
$muted.Dispose()
$white.Dispose()
$accentSoft.Dispose()
$accent.Dispose()
$background.Dispose()
$graphics.Dispose()
$canvas.Dispose()

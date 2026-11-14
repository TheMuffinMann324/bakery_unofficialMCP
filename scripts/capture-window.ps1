# Captures the local FiveM game window (game + NUI overlay) and writes JSON with a base64 JPEG to stdout.
# PrintWindow works while the window is behind other windows. The screen fallback needs FiveM in front.
# Optional: -SavePath writes the capture as PNG (a visual baseline). -BaselinePath compares against a saved PNG
# and adds diffPercent plus a diff image (changed pixels in red over a dimmed capture).
param(
    [ValidateRange(320, 3840)][int]$MaxWidth = 1280,
    [ValidateRange(20, 100)][int]$Quality = 70,
    [string]$SavePath,
    [string]$BaselinePath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class BakeryWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    static int[] Pixels(Bitmap b) {
        var data = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var pixels = new int[b.Width * b.Height];
        Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
        b.UnlockBits(data);
        return pixels;
    }

    public static bool Blank(Bitmap b) {
        foreach (var p in Pixels(b)) { if (((p >> 16) & 255) + ((p >> 8) & 255) + (p & 255) > 30) return false; }
        return true;
    }

    // Returns the share of pixels whose channel difference exceeds the threshold, and draws a diff image.
    public static double Compare(Bitmap current, Bitmap baseline, int threshold, out Bitmap diff) {
        var a = Pixels(current); var b = Pixels(baseline);
        var output = new int[a.Length];
        long changed = 0;
        for (int i = 0; i < a.Length; i++) {
            int ar = (a[i] >> 16) & 255, ag = (a[i] >> 8) & 255, ab = a[i] & 255;
            int d = Math.Max(Math.Abs(ar - ((b[i] >> 16) & 255)), Math.Max(Math.Abs(ag - ((b[i] >> 8) & 255)), Math.Abs(ab - (b[i] & 255))));
            if (d > threshold) { changed++; output[i] = unchecked((int)0xFFFF2020); }
            else { int g = (ar + ag + ab) / 9; output[i] = unchecked((int)0xFF000000) | (g << 16) | (g << 8) | g; }
        }
        diff = new Bitmap(current.Width, current.Height, PixelFormat.Format32bppArgb);
        var data = diff.LockBits(new Rectangle(0, 0, diff.Width, diff.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(output, 0, data.Scan0, output.Length);
        diff.UnlockBits(data);
        return 100.0 * changed / a.Length;
    }
}
'@
[void][BakeryWin]::SetProcessDPIAware()

$proc = Get-Process | Where-Object { $_.ProcessName -match '^FiveM_(b\d+_)?GTAProcess$' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'FiveM game window not found. Is the game running on this machine?' }
$hwnd = $proc.MainWindowHandle
if ([BakeryWin]::IsIconic($hwnd)) { throw 'FiveM window is minimized' }

$rect = New-Object BakeryWin+RECT
[void][BakeryWin]::GetClientRect($hwnd, [ref]$rect)
$origin = New-Object BakeryWin+POINT
[void][BakeryWin]::ClientToScreen($hwnd, [ref]$origin)
$w = $rect.Right; $h = $rect.Bottom
if ($w -lt 16 -or $h -lt 16) { throw 'FiveM window has no visible client area' }

$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 3 = PW_CLIENTONLY | PW_RENDERFULLCONTENT
$printed = [BakeryWin]::PrintWindow($hwnd, $hdc, 3)
$g.ReleaseHdc($hdc)
$method = 'print'
if (-not $printed -or [BakeryWin]::Blank($bmp)) {
    # Copying from the screen grabs whatever is on top, so only do it when FiveM is the foreground window.
    if ([BakeryWin]::GetForegroundWindow() -ne $hwnd) { throw 'PrintWindow returned a blank frame and FiveM is not the foreground window' }
    $g.CopyFromScreen($origin.X, $origin.Y, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $method = 'screen'
}
$g.Dispose()

function Resize([System.Drawing.Bitmap]$source, [int]$width, [int]$height) {
    $target = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($target)
    $graphics.InterpolationMode = 'HighQualityBicubic'
    $graphics.DrawImage($source, 0, 0, $width, $height)
    $graphics.Dispose()
    return $target
}
$out = $bmp
if ($w -gt $MaxWidth) { $out = Resize $bmp $MaxWidth ([int]($h * $MaxWidth / $w)) }

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
function Jpeg([System.Drawing.Bitmap]$image) {
    $stream = New-Object System.IO.MemoryStream
    $image.Save($stream, $codec, $params)
    return [Convert]::ToBase64String($stream.ToArray())
}

$result = [ordered]@{ method = $method; width = $out.Width; height = $out.Height; data = (Jpeg $out) }
if ($BaselinePath) {
    $baseline = New-Object System.Drawing.Bitmap $BaselinePath
    $compareTo = if ($baseline.Width -eq $out.Width -and $baseline.Height -eq $out.Height) { $out } else { Resize $out $baseline.Width $baseline.Height }
    $diff = $null
    $result.diffPercent = [Math]::Round([BakeryWin]::Compare($compareTo, $baseline, 40, [ref]$diff), 3)
    $result.diffData = Jpeg $diff
    $baseline.Dispose()
}
if ($SavePath) { $out.Save($SavePath, [System.Drawing.Imaging.ImageFormat]::Png) }
[Console]::Out.Write(($result | ConvertTo-Json -Compress))

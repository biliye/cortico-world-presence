# Presence 的常驻助手：截屏（capture）与列窗口（windows）。
#
# 为什么是常驻的、为什么从「命令行塞一段 base64」改成「读这份文件」、以及每次调用会省下多少：
# 都写在 src/capture.ts 里 CaptureHost 那一段注释里 —— 解释留在 TypeScript 那一侧，这份文件只写代码。
#
# 协议：调用方往 stdin 发**一行 JSON**，这里往 stdout 回**一行 JSON**（其余噪声走 stderr）。
# 参数随命令带过来（maxEdge / jpegQuality / gridBase / gridMinGap / photoRatio / windowCap），
# 所以这份文件里**不写包里的常量** —— 那些数只有一处出处，在 TypeScript 那边。
#
# 这份文件必须带 UTF-8 BOM：脚本里有中文（给她的错误文案），而无 BOM 的 UTF-8 会被
# Windows PowerShell 5.1 按系统 ANSI 读成乱码。tests/capture.test.ts 有一条用例盯着这个 BOM。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 6 | Write-Output }

# 把位图编码成 JPEG。先铺一层白底再画，免得带 alpha 的窗口在 JPEG 里变成黑块。
function Get-JpegBytes($bitmap, $quality) {
  $flat = New-Object System.Drawing.Bitmap -ArgumentList $bitmap.Width, $bitmap.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($flat)
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($bitmap, 0, 0, $bitmap.Width, $bitmap.Height)
  $g.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $quality
  $ms = New-Object System.IO.MemoryStream
  $flat.Save($ms, $codec, $params)
  $out = $ms.ToArray()
  $ms.Dispose()
  $flat.Dispose()
  return $out
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PresenceCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int sizeOfRect);
  // The pointer. A screen grab does not contain the cursor (measured 2026-10-06), so it is drawn on.
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);
  // 13 = SM_CXCURSOR, 14 = SM_CYCURSOR: the system cursor's own size at the current DPI.
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@ | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PresenceList {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int sizeOfValue);
}
'@ | Out-Null
# 窗口外框尺寸走 DWM(9 = EXTENDED_FRAME_BOUNDS)，拿到的是不含投影的真实边界。
# 与上面那个 out int 的重载同名，所以另起一个托管类、用 EntryPoint 指回同一个入口。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PresenceFrame {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int Frame(IntPtr hwnd, int attribute, out RECT rect, int sizeOfRect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
'@ | Out-Null
try { [void][PresenceCap]::SetProcessDpiAwareness(2) } catch { try { [void][PresenceCap]::SetProcessDPIAware() } catch {} }

# 截一张。目标/区域/两个开关都从命令里现读；出错输出 {ok:false,error}，不抛裸栈。
# 图上的光标（2026-10-07）：抓屏拍不到光标本身（量过：围着光标框一张 PNG，图里没有箭头），
# 所以用 GetCursorInfo 读位置与位图、DrawIconEx 画上去。**画在降采样与格线之后**，按画面比例缩但
# 最小 16px；**只画真抓屏的图**（hwnd 那条走 PrintWindow，那是窗口自己绘的帧，画上去就是骗人）。
# 她可以不要箭头（cursor:false）——盯一块看变化、或读那一块小字时；**位置照读照报**。
function Invoke-Capture($cmd) {
  $kind = [string]$cmd.target
  $hwndGiven = [int64]$cmd.hwnd
  $rx = [int]$cmd.region.x
  $ry = [int]$cmd.region.y
  $rw = [int]$cmd.region.width
  $rh = [int]$cmd.region.height
  $wantGrid = [bool]$cmd.grid
  $wantCursor = [bool]$cmd.cursor
  $maxEdge = [int]$cmd.maxEdge
  $gridBase = [int]$cmd.gridBase
  $gridMinGap = [int]$cmd.gridMinGap
  $photoRatio = [double]$cmd.photoRatio
  $jpegQuality = [int]$cmd.jpegQuality
  $title = ''
  $rect = $null
  $h = [IntPtr]::Zero
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($vs.Width -le 0 -or $vs.Height -le 0) { throw '拿不到屏幕尺寸' }

  if ($kind -eq 'full') {
    $rect = @{ x = $vs.Left; y = $vs.Top; w = $vs.Width; h = $vs.Height }
  } elseif ($kind -eq 'region') {
    # 按虚拟屏夹紧：她框到屏幕外面时不算错，夹回来并在回执里说清实际抓的是哪一块。
    $cl = [Math]::Max($rx, $vs.Left)
    $ct = [Math]::Max($ry, $vs.Top)
    $cr = [Math]::Min($rx + $rw, $vs.Left + $vs.Width)
    $cb = [Math]::Min($ry + $rh, $vs.Top + $vs.Height)
    $cw = $cr - $cl
    $chh = $cb - $ct
    if ($cw -le 0 -or $chh -le 0) {
      throw "这块区域不在屏幕上。虚拟屏范围：x=$($vs.Left) y=$($vs.Top) 宽=$($vs.Width) 高=$($vs.Height)"
    }
    $rect = @{ x = $cl; y = $ct; w = $cw; h = $chh }
  } else {
    if ($kind -eq 'foreground') {
      $h = [PresenceCap]::GetForegroundWindow()
      if ($h -eq [IntPtr]::Zero) { throw '现在没有前台窗口（可能正锁屏）' }
    } else {
      $h = [IntPtr]$hwndGiven
      if (-not [PresenceCap]::IsWindowVisible($h)) { throw '这个窗口现在不可见，可能已经关了' }
    }
    $sb = New-Object System.Text.StringBuilder 512
    [void][PresenceCap]::GetWindowText($h, $sb, 512)
    $title = $sb.ToString()
    if ([PresenceCap]::IsIconic($h)) { throw '窗口已最小化，截不到内容' }
    $r = New-Object 'PresenceCap+RECT'
    $hr = [PresenceCap]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r))
    if ($hr -ne 0 -or ($r.Right - $r.Left) -le 0) {
      $r = New-Object 'PresenceCap+RECT'
      [void][PresenceCap]::GetWindowRect($h, [ref]$r)
    }
    $w = $r.Right - $r.Left
    $bh = $r.Bottom - $r.Top
    if ($w -le 0 -or $bh -le 0) { throw '拿不到窗口尺寸' }
    $rect = @{ x = $r.Left; y = $r.Top; w = $w; h = $bh }
  }

  # Pointer read BEFORE the grab: the sample closest to the frame is the honest one.
  $curOk = $false
  $curX = 0
  $curY = 0
  $curShown = $false
  $curIcon = [IntPtr]::Zero
  $ci = New-Object 'PresenceCap+CURSORINFO'
  $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
  if ([PresenceCap]::GetCursorInfo([ref]$ci)) {
    $curOk = $true
    $curX = $ci.ptScreenPos.X
    $curY = $ci.ptScreenPos.Y
    $curIcon = $ci.hCursor
    # flags: 1 = CURSOR_SHOWING. The system hides the pointer itself for fullscreen video.
    $curShown = (($ci.flags -band 1) -ne 0)
  }

  $via = ''
  $src = $null
  if ($kind -eq 'window') {
    $src = New-Object System.Drawing.Bitmap -ArgumentList $rect.w, $rect.h
    $g = [System.Drawing.Graphics]::FromImage($src)
    $hdc = $g.GetHdc()
    $ok = [PresenceCap]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    if ($ok) {
      $via = 'printwindow'
    } else {
      $src.Dispose()
      $src = $null
    }
  }
  if ($null -eq $src) {
    $src = New-Object System.Drawing.Bitmap -ArgumentList $rect.w, $rect.h
    $g = [System.Drawing.Graphics]::FromImage($src)
    [void]$g.CopyFromScreen($rect.x, $rect.y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $rect.w, $rect.h))
    $g.Dispose()
    $via = 'screen'
  }

  $edge = [Math]::Max($src.Width, $src.Height)
  $downscaled = $edge -gt $maxEdge
  if ($downscaled) {
    $scale = $maxEdge / $edge
    $nw = [Math]::Max(1, [int][Math]::Round($src.Width * $scale))
    $nh = [Math]::Max(1, [int][Math]::Round($src.Height * $scale))
    $small = New-Object System.Drawing.Bitmap -ArgumentList $nw, $nh
    $g3 = [System.Drawing.Graphics]::FromImage($small)
    $g3.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g3.DrawImage($src, 0, 0, $nw, $nh)
    $g3.Dispose()
    $src.Dispose()
    $src = $small
  }
  $ow = $src.Width
  $oh = $src.Height
  # 格线：画在**最终的图**上（降采样之后），所以线是 1px 的、标注也是按图上的字号来的。
  # 每条线落在「桌面坐标的整百处」（密不下就翻倍），线旁边标着那个桌面坐标 ——
  # 她照着数字读就行，不用拿图上像素去乘那个比例（她这么算错过两次）。
  $gridInfo = $null
  if ($wantGrid) {
    $ipx = $ow / $rect.w
    $ipy = $oh / $rect.h
    $step = $gridBase
    while (($step * $ipx) -lt $gridMinGap) { $step = $step * 2 }
    $g4 = [System.Drawing.Graphics]::FromImage($src)
    # 线选青色、半透明：白底黑底上都看得见，又不盖住底下的字。
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(95, 0, 190, 255)), 1
    # 标注给一个深底白字的小方块 —— 只留白字在浅色界面上会看不见。
    $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(165, 20, 20, 20))
    $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
    $font = New-Object System.Drawing.Font 'Consolas', 11
    $vx = 0
    $hy = 0
    $dx = [Math]::Ceiling($rect.x / $step) * $step
    while ($dx -lt ($rect.x + $rect.w)) {
      $ix = [int][Math]::Round(($dx - $rect.x) * $ipx)
      if ($ix -ge 0 -and $ix -lt $ow) {
        $g4.DrawLine($pen, $ix, 0, $ix, $oh - 1)
        $label = 'x=' + $dx
        $sz = $g4.MeasureString($label, $font)
        $g4.FillRectangle($back, $ix + 1, 1, [int]$sz.Width + 2, [int]$sz.Height + 1)
        $g4.DrawString($label, $font, $ink, $ix + 2, 1)
        $vx = $vx + 1
      }
      $dx = $dx + $step
    }
    $dy = [Math]::Ceiling($rect.y / $step) * $step
    while ($dy -lt ($rect.y + $rect.h)) {
      $iy = [int][Math]::Round(($dy - $rect.y) * $ipy)
      if ($iy -ge 0 -and $iy -lt $oh) {
        $g4.DrawLine($pen, 0, $iy, $ow - 1, $iy)
        $label = 'y=' + $dy
        $sz = $g4.MeasureString($label, $font)
        $g4.FillRectangle($back, 1, $iy + 1, [int]$sz.Width + 2, [int]$sz.Height + 1)
        $g4.DrawString($label, $font, $ink, 2, $iy + 1)
        $hy = $hy + 1
      }
      $dy = $dy + $step
    }
    $g4.Dispose()
    $pen.Dispose()
    $back.Dispose()
    $ink.Dispose()
    $font.Dispose()
    $gridInfo = @{ step = $step; vertical = $vx; horizontal = $hy }
  }
  # The pointer, onto the finished image; screen grab only (rationale above Invoke-Capture).
  $draw = 'unknown'
  $ipx = $ow / $rect.w
  $ipy = $oh / $rect.h
  if (-not $curOk) { $draw = 'unknown' }
  elseif (-not $wantCursor) { $draw = 'omitted' }
  elseif ($via -eq 'printwindow') { $draw = 'printwindow' }
  elseif (-not $curShown) { $draw = 'hidden' }
  else {
    $curIx = [int][Math]::Round(($curX - $rect.x) * $ipx)
    $curIy = [int][Math]::Round(($curY - $rect.y) * $ipy)
    if ($curIx -lt 0 -or $curIy -lt 0 -or $curIx -ge $ow -or $curIy -ge $oh) { $draw = 'offscreen' }
    else {
      $curSw = [PresenceCap]::GetSystemMetrics(13)
      $curSh = [PresenceCap]::GetSystemMetrics(14)
      if ($curSw -le 0) { $curSw = 32 }
      if ($curSh -le 0) { $curSh = 32 }
      # Its real size scaled with the picture, but never so small it cannot be seen.
      $curDw = [int][Math]::Max(16, [int][Math]::Round($curSw * $ipx))
      $curDh = [int][Math]::Max(16, [int][Math]::Round($curSh * $ipy))
      $g5 = [System.Drawing.Graphics]::FromImage($src)
      $hdc5 = $g5.GetHdc()
      # 3 = DI_NORMAL. The handle belongs to the desktop and is never destroyed here.
      if ([PresenceCap]::DrawIconEx($hdc5, $curIx, $curIy, $curIcon, $curDw, $curDh, 0, [IntPtr]::Zero, 3)) { $draw = 'drawn' }
      $g5.ReleaseHdc($hdc5)
      $g5.Dispose()
    }
  }
  $pngMs = New-Object System.IO.MemoryStream
  $src.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $pngMs.ToArray()
  $pngMs.Dispose()
  # 照片类画面（视频、照片、大片渐变）PNG 压不动，字节数会比像素数还大；那种画面转 JPEG，
  # 体积差一个数量级。文字界面 PNG 压得很好，保持无损，字才清楚。
  $pixels = [Math]::Max(1, $ow * $oh)
  $ratio = $pngBytes.Length / $pixels
  if ($ratio -gt $photoRatio) {
    $bytes = Get-JpegBytes $src $jpegQuality
    $format = 'jpeg'
  } else {
    $bytes = $pngBytes
    $format = 'png'
  }
  $src.Dispose()
  $b64 = [Convert]::ToBase64String($bytes)
  $captured = @{ x = $rect.x; y = $rect.y; width = $rect.w; height = $rect.h }
  Out-Json @{ ok = $true; data = $b64; format = $format; bytes = $bytes.Length; width = $ow; height = $oh; captured = $captured; downscaled = $downscaled; via = $via; title = $title; grid = $gridInfo; cursor = @{ x = $(if ($curOk) { $curX } else { $null }); y = $(if ($curOk) { $curY } else { $null }); draw = $draw } }
}

# 列可见顶层窗口（跳过披隐藏斗篷的 UWP 壳），带上矩形；同时报屏幕几何。
function Invoke-Windows($cmd) {
  $cap = [int]$cmd.windowCap
  $fg = [PresenceList]::GetForegroundWindow()
  $found = New-Object System.Collections.ArrayList
  $callback = [PresenceList+EnumProc]{
    param($h, $l)
    if ($found.Count -ge $cap) { return $false }
    if (-not [PresenceList]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][PresenceList]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t.Length -le 0) { return $true }
    $cloaked = 0
    [void][PresenceList]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    if ($cloaked -ne 0) { return $true }
    $procId = [uint32]0
    [void][PresenceList]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $minimized = [PresenceList]::IsIconic($h)
    # 最小化的窗口没有可用位置（GetWindowRect 给的是 -32000 那种哨兵值），
    # 报上去只会让她算出没用的坐标，所以四个值给 0，由回执标「最小化」。
    $bx = 0; $by = 0; $bw = 0; $bh = 0
    if (-not $minimized) {
      $r = New-Object 'PresenceFrame+RECT'
      $hr = [PresenceFrame]::Frame($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r))
      if ($hr -ne 0 -or ($r.Right - $r.Left) -le 0) {
        # 兜底这一问属于 PresenceList，要它自己的 RECT：两个结构字段一样，但 PowerShell 认类型
        # （2026-10-16 修：这里原来复用了 PresenceFrame+RECT，DWM 拿不到边框的窗口一走进来就抛
        # 「无法将 PresenceFrame+RECT 转换为 PresenceList+RECT」—— 那条分支平时不走，一换显示模式就露头）。
        $r = New-Object 'PresenceList+RECT'
        [void][PresenceList]::GetWindowRect($h, [ref]$r)
      }
      $bx = $r.Left; $by = $r.Top; $bw = $r.Right - $r.Left; $bh = $r.Bottom - $r.Top
    }
    [void]$found.Add(@{
      hwnd = $h.ToInt64()
      title = $t
      exe = $(if ($p) { $p.ProcessName } else { '' })
      pid = $procId
      foreground = ($h -eq $fg)
      minimized = $minimized
      bounds = @{ x = $bx; y = $by; width = $bw; height = $bh }
    })
    return $true
  }
  [void][PresenceList]::EnumWindows($callback, [IntPtr]::Zero)

  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $mons = New-Object System.Collections.ArrayList
  $i = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    [void]$mons.Add(@{
      index = $i
      x = $s.Bounds.Left
      y = $s.Bounds.Top
      width = $s.Bounds.Width
      height = $s.Bounds.Height
      primary = $s.Primary
    })
    $i = $i + 1
  }
  $screen = @{ x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height; monitors = $mons }
  @{ ok = $true; windows = $found; screen = $screen } | ConvertTo-Json -Compress -Depth 6 | Write-Output
}

# 一行一条命令、一行一条结果。stdin 关了或进程被杀就退出；
# 单个请求出错只回一条 {ok:false}，助手继续活着（下一次照样能问）。
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    if ($cmd.op -eq 'capture') { Invoke-Capture $cmd }
    elseif ($cmd.op -eq 'windows') { Invoke-Windows $cmd }
    else { Out-Json @{ ok = $false; error = "不认识的命令：$($cmd.op)" } }
  } catch {
    Out-Json @{ ok = $false; error = $_.Exception.Message }
  }
}

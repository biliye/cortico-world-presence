/**
 * 按需的一次性 PowerShell：截屏与列窗口。不走常驻传感器——她说要才发生，
 * 进程用完即退。回执里始终带 `via`（走的哪条路）与 `captured`（实际抓的区域），
 * 截不了就报错原因，不返黑图装成功。
 *
 * 坐标一律是**物理像素**、**虚拟屏坐标**（主屏左上为原点，主屏左边的显示器是负坐标）。
 * 这两个脚本开头都声明 DPI 感知，所以上报的窗口矩形与区域坐标同一个坐标系。
 */
import { spawn } from 'node:child_process';

/** 截图的最长边（像素），超过就等比降采样。再大只是烧 token。 */
export const SCREENSHOT_MAX_EDGE = 1600;
/** 列窗口的枚举上限（也等于回执上限），防一个挤满窗口的桌面把 token 吃光。 */
export const WINDOW_LIST_CAP = 100;
/**
 * 照片类画面的判定线：PNG 字节数 ÷ 像素数超过这个值，说明 PNG 压不动（画面里有视频、
 * 照片、大片渐变），改存 JPEG。
 *
 * 实测两个端点：文字界面（ZCode 窗口 1203x773）是 0.10 字节/像素；浏览器里放着视频的
 * 窗口（1600x870）是 1.21 字节/像素——差一个数量级，中间留得很宽。阈值取 0.5。
 */
export const PHOTO_BYTES_PER_PIXEL = 0.5;
/** 转 JPEG 时的质量。80 是肉眼与体积的常规平衡点。 */
export const JPEG_QUALITY = 80;
/** 区域的最小边：太小的框截出来没意义，还会让她以为是程序坏了。 */
export const REGION_MIN_EDGE = 16;
/**
 * 格线的基准间距（桌面像素）。图上每条线都落在「桌面坐标的整百处」上，线旁边标着那个坐标，
 * 所以她照着数字读就行，不用做任何换算——这是这套格线存在的全部理由。
 */
export const GRID_BASE_STEP = 100;
/**
 * 格线之间在**图上**至少留这么宽（图上的像素）。再密就糊成一片，反而不好读。
 * 被压过的大图会因此把间距翻倍（2560 宽压到 1600 时：100 → 200 桌面像素，图上约 125px）。
 */
export const GRID_MIN_GAP_PX = 70;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenshotTarget =
  | { target: 'full' }
  | { target: 'foreground' }
  | { target: 'window'; hwnd: number }
  | { target: 'region'; region: Rect };

/** 叠在图上那层格线实际画成了什么样（图上真画了几条、间距多少桌面像素）。 */
export interface GridInfo {
  /** 桌面坐标上的间距。`GRID_BASE_STEP` 起，密不下就翻倍。 */
  step: number;
  /** 竖线、横线各画了几条。 */
  vertical: number;
  horizontal: number;
}

/**
 * 光标有没有画进这张图，没画时是哪一种原因。
 * `drawn` 画了 / `omitted` 她这次说了不要箭头（位置照报）/ `hidden` 系统这一刻把光标藏起来了
 * （全屏视频、某些程序会这样）/ `offscreen` 光标不在这张图覆盖的那块里 /
 * `printwindow` 这张图不是抓屏来的（窗口自己绘的帧）/ `unknown` 读不到光标在哪。
 */
export type CursorDraw = 'drawn' | 'omitted' | 'hidden' | 'offscreen' | 'printwindow' | 'unknown';

/** 截图那一刻光标在哪，以及它有没有进这张图。 */
export interface CursorInfo {
  /** 桌面物理像素（虚拟屏坐标，与窗口矩形同一个口径）。读不到就是 null，那就也没画。 */
  x: number | null;
  y: number | null;
  draw: CursorDraw;
}

export interface ScreenshotResult {
  bytes: Buffer;
  /** 实际编码：文字界面存 PNG（无损、字清楚），照片类画面存 JPEG（体积差一个数量级）。 */
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** 实际抓的区域。region 目标下会被虚拟屏夹紧，所以可能和你框的不一样。 */
  captured: Rect;
  /**
   * 抓到的像素比实际区域小（框的长边超过上限被压过）。**小字会糊**——看到这个就框小一点，
   * 框小反而清楚，因为小框不会走降采样。
   */
  downscaled: boolean;
  /** 走的哪条路：`screen`（抓屏）或 `printwindow`（向窗口要画面）。 */
  via: 'screen' | 'printwindow';
  /** 目标窗口的标题；全屏与区域时为空。 */
  title: string;
  /** 图上的格线；没叠就是 null。 */
  grid: GridInfo | null;
  /** 光标在哪、有没有画进图里（抓屏拍不到光标本身，所以是我们画上去的）。 */
  cursor: CursorInfo;
}

/** 截图的可选项。`grid` 叠一层带桌面坐标标注的淡格线（她要从图上读坐标时加它）。 */
export interface CaptureOptions {
  grid?: boolean;
  /**
   * 要不要把光标画进图里（默认画）。`false` 时**仍然读光标、仍然在回执里报它的坐标**，
   * 只是不在图上画那个箭头——她「盯一块看变化」或要读那一块的小字时用得上：
   * 光标正好停在框里的话，一个会动的箭头会让「和上次像素级完全相同」永远说不出口。
   */
  cursor?: boolean;
}

export interface MonitorInfo {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface WindowInfo {
  hwnd: number;
  title: string;
  exe: string;
  pid: number;
  foreground: boolean;
  minimized: boolean;
  /** 窗口矩形，物理像素、虚拟屏坐标。最小化的窗口没有可用位置，四个值都是 0。 */
  bounds: Rect;
}

/** 屏幕几何：虚拟屏（所有显示器拼起来的范围）加每台显示器。 */
export interface ScreenInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  monitors: MonitorInfo[];
}

export interface WindowList {
  windows: WindowInfo[];
  screen: ScreenInfo;
}

const POWER_SHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 跑一段一次性 PowerShell，解析 stdout 里的第一行 JSON。超时杀进程。 */
function runPowerShellJson(script: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [...POWER_SHELL_ARGS, encodeCommand(script)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell ${Math.round(timeoutMs / 1000)} 秒没跑完，被掐掉了`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`PowerShell 起不来：${err.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      for (const line of stdout.split('\n')) {
        const text = line.trim();
        if (!text.startsWith('{')) continue;
        try {
          resolve(JSON.parse(text) as Record<string, unknown>);
          return;
        } catch {
          // 不是完整 JSON 的行，继续找
        }
      }
      reject(new Error(`PowerShell 没吐出结果${stderr ? `：${stderr.slice(-400)}` : ''}`));
    });
  });
}

/**
 * 截屏脚本。target、区域坐标与两个开关是模板里插进去的常量；出错输出 `{ok:false,error}`，不抛裸栈。
 *
 * **导出是为了测试**:它是 `-EncodedCommand` 传上去的,而**命令行有长度上限**
 * (`windows` 约 32767 字符,UTF-16 再 base64 会把脚本放大 2.67 倍),所以 `capture.test.ts` 里有一条
 * 用例盯着它的编码后长度。**写进这个模板的每个字都要按 2.67 倍算钱**——解释写在 TS 这边,
 * 模板里只留短指引(2026-10-07 就是这么被 `spawn ENAMETOOLONG` 顶回来的)。
 *
 * 图上的光标(2026-10-07 加,理由写在 TS 这边而不是模板里):
 * - 抓屏拍不到光标本身(量过:围着光标框一张 PNG,图里没有箭头),而看图干活的模型没有别的办法
 *   知道光标在哪,所以用 `GetCursorInfo` 读位置与位图、`DrawIconEx` 画上去。形状是系统真光标,
 *   于是它还顺带回答「这一点上是什么」(I 形=能打字,沙漏=忙)。
 * - **画在降采样与格线之后**,按画面比例缩但最小 16px(跟着一起缩的话,被压过的大图上它会糊成一个点);
 *   **只画真抓屏的图**——`hwnd` 那条走 `PrintWindow`,那是窗口自己绘的帧(可能被盖着、光标不在上面),
 *   画上去就是骗人。
 * - **她可以不要箭头**(`cursor:false`)——盯一块看变化、或读那一块小字时:光标正好停在框里的话,
 *   一个会动的箭头让「和上次像素级完全相同」永远说不出口,也会盖住字。**位置照读照报**,可选的只有箭头。
 * - 四种「没画」各有各的说法(她说了不要箭头 / 系统把光标藏了 / 光标不在这块 / 这张不是抓屏来的 /
 *   读不出来),一句话对应一种下一步动作,所以她不该靠猜。
 */
export function captureScript(target: ScreenshotTarget, grid: boolean, drawCursor: boolean): string {
  const kind = target.target;
  const hwnd = target.target === 'window' ? String(Math.trunc(target.hwnd)) : '0';
  const rx = target.target === 'region' ? String(Math.trunc(target.region.x)) : '0';
  const ry = target.target === 'region' ? String(Math.trunc(target.region.y)) : '0';
  const rw = target.target === 'region' ? String(Math.trunc(target.region.width)) : '0';
  const rh = target.target === 'region' ? String(Math.trunc(target.region.height)) : '0';
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 6 | Write-Output }
# 把位图编码成 JPEG。先铺一层白底再画，免得带 alpha 的窗口在 JPEG 里变成黑块。
function Get-JpegBytes($bitmap) {
  $flat = New-Object System.Drawing.Bitmap -ArgumentList $bitmap.Width, $bitmap.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($flat)
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($bitmap, 0, 0, $bitmap.Width, $bitmap.Height)
  $g.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ${JPEG_QUALITY}
  $ms = New-Object System.IO.MemoryStream
  $flat.Save($ms, $codec, $params)
  $out = $ms.ToArray()
  $ms.Dispose()
  $flat.Dispose()
  return $out
}

try {
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
  try { [void][PresenceCap]::SetProcessDpiAwareness(2) } catch { try { [void][PresenceCap]::SetProcessDPIAware() } catch {} }

  $kind = '${kind}'
  $hwndGiven = ${hwnd}
  $maxEdge = ${SCREENSHOT_MAX_EDGE}
  $title = ''
  $rect = $null
  $h = [IntPtr]::Zero
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($vs.Width -le 0 -or $vs.Height -le 0) { throw '拿不到屏幕尺寸' }

  if ($kind -eq 'full') {
    $rect = @{ x = $vs.Left; y = $vs.Top; w = $vs.Width; h = $vs.Height }
  } elseif ($kind -eq 'region') {
    # 按虚拟屏夹紧:她框到屏幕外面时不算错，夹回来并在回执里说清实际抓的是哪一块。
    $cl = [Math]::Max(${rx}, $vs.Left)
    $ct = [Math]::Max(${ry}, $vs.Top)
    $cr = [Math]::Min(${rx} + ${rw}, $vs.Left + $vs.Width)
    $cb = [Math]::Min(${ry} + ${rh}, $vs.Top + $vs.Height)
    $cw = $cr - $cl
    $chh = $cb - $ct
    if ($cw -le 0 -or $chh -le 0) {
      throw "这块区域不在屏幕上。虚拟屏范围:x=$($vs.Left) y=$($vs.Top) 宽=$($vs.Width) 高=$($vs.Height)"
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
  # 格线:画在**最终的图**上（降采样之后），所以线是 1px 的、标注也是按图上的字号来的。
  # 每条线落在「桌面坐标的整百处」（密不下就翻倍），线旁边标着那个桌面坐标——
  # 她照着数字读就行，不用拿图上像素去乘那个比例（她这么算错过两次）。
  $gridInfo = $null
  if (${grid ? '$true' : '$false'}) {
    $ipx = $ow / $rect.w
    $ipy = $oh / $rect.h
    $step = ${GRID_BASE_STEP}
    while (($step * $ipx) -lt ${GRID_MIN_GAP_PX}) { $step = $step * 2 }
    $g4 = [System.Drawing.Graphics]::FromImage($src)
    # 线选青色、半透明:白底黑底上都看得见，又不盖住底下的字。
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(95, 0, 190, 255)), 1
    # 标注给一个深底白字的小方块——只留白字在浅色界面上会看不见。
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
  # The pointer, onto the finished image; screen grab only (rationale above captureScript).
  $draw = 'unknown'
  $ipx = $ow / $rect.w
  $ipy = $oh / $rect.h
  if (-not $curOk) { $draw = 'unknown' }
  elseif (-not ${drawCursor ? '$true' : '$false'}) { $draw = 'omitted' }
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
  if ($ratio -gt ${PHOTO_BYTES_PER_PIXEL}) {
    $bytes = Get-JpegBytes $src
    $format = 'jpeg'
  } else {
    $bytes = $pngBytes
    $format = 'png'
  }
  $src.Dispose()
  $b64 = [Convert]::ToBase64String($bytes)
  $captured = @{ x = $rect.x; y = $rect.y; width = $rect.w; height = $rect.h }
  Out-Json @{ ok = $true; data = $b64; format = $format; bytes = $bytes.Length; width = $ow; height = $oh; captured = $captured; downscaled = $downscaled; via = $via; title = $title; grid = $gridInfo; cursor = @{ x = $(if ($curOk) { $curX } else { $null }); y = $(if ($curOk) { $curY } else { $null }); draw = $draw } }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
}
`.trim();
}

/** 列可见顶层窗口（跳过披隐藏斗篷的 UWP 壳），带上矩形；同时报屏幕几何。 */
function listWindowsScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
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
'@
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
'@
try { [void][PresenceFrame]::SetProcessDpiAwareness(2) } catch { try { [void][PresenceFrame]::SetProcessDPIAware() } catch {} }

$fg = [PresenceList]::GetForegroundWindow()
$found = New-Object System.Collections.ArrayList
$cap = ${WINDOW_LIST_CAP}
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
      $r = New-Object 'PresenceFrame+RECT'
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
`.trim();
}

function asBuffer(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('截图回执里没有图片数据');
  return Buffer.from(value, 'base64');
}

/** 校验编码：PNG 看魔数，JPEG 看 FFD8FF。截到的字节对不上就是没截成。 */
function checkMagic(bytes: Buffer, format: 'png' | 'jpeg'): void {
  if (format === 'png') {
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(magic)) {
      throw new Error('截到的不是一张有效的 PNG');
    }
    return;
  }
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error('截到的不是一张有效的 JPEG');
  }
}

function toRect(raw: unknown): Rect {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    x: Math.round(Number(r.x ?? 0)) || 0,
    y: Math.round(Number(r.y ?? 0)) || 0,
    width: Math.max(0, Math.round(Number(r.width ?? 0)) || 0),
    height: Math.max(0, Math.round(Number(r.height ?? 0)) || 0),
  };
}

/**
 * 校验她框的区域。返回矩形或一句人话的错误。
 * 只做形状校验:是否落在屏幕上是 PowerShell 那边的事（夹紧或报错）。
 */
export function parseRegion(args: Record<string, unknown>): Rect | string {
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
    return null;
  };
  const width = num(args.width);
  const height = num(args.height);
  if (width === null || height === null) return '截区域要同时给 width 和 height（物理像素）。';
  if (width < REGION_MIN_EDGE || height < REGION_MIN_EDGE) {
    return `框太小了（${width}x${height}）：宽高都至少 ${REGION_MIN_EDGE} 像素。`;
  }
  const x = num(args.x) ?? 0;
  const y = num(args.y) ?? 0;
  return { x, y, width, height };
}

/** 截一张。她说要才调用；失败抛错（World 转成失败回执），错误文案给人看。 */
export async function captureScreenshot(
  target: ScreenshotTarget,
  timeoutMs = 20000,
  options: CaptureOptions = {},
): Promise<ScreenshotResult> {
  const grid = options.grid === true;
  const drawCursor = options.cursor !== false;
  const result = await runPowerShellJson(captureScript(target, grid, drawCursor), timeoutMs);
  if (result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : '截图失败，原因不明');
  }
  const format: 'png' | 'jpeg' = result.format === 'jpeg' ? 'jpeg' : 'png';
  const bytes = asBuffer(result.data);
  checkMagic(bytes, format);
  return {
    bytes,
    format,
    width: Number(result.width ?? 0),
    height: Number(result.height ?? 0),
    captured: toRect(result.captured),
    downscaled: result.downscaled === true,
    via: result.via === 'printwindow' ? 'printwindow' : 'screen',
    title: typeof result.title === 'string' ? result.title : '',
    grid: parseGrid(result.grid),
    cursor: parseCursor(result.cursor),
  };
}

/** 脚本报回来的光标信息。形状不对就当「读不到」——宁可少说一句，也不报一个假的位置。 */
function parseCursor(raw: unknown): CursorInfo {
  const c = (raw ?? {}) as Record<string, unknown>;
  const x = numOrNull(c.x);
  const y = numOrNull(c.y);
  if (x === null || y === null) return { x: null, y: null, draw: 'unknown' };
  const draw =
    c.draw === 'drawn' || c.draw === 'omitted' || c.draw === 'hidden' || c.draw === 'offscreen' || c.draw === 'printwindow'
      ? c.draw
      : 'unknown';
  return { x, y, draw };
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
  return null;
}

/** 脚本报回来的格线信息。形状不对就当没叠（宁可少说一句，也不报一个假的间距）。 */
function parseGrid(raw: unknown): GridInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const step = Number(g.step ?? 0);
  const vertical = Number(g.vertical ?? 0);
  const horizontal = Number(g.horizontal ?? 0);
  if (!Number.isFinite(step) || step <= 0) return null;
  if (vertical + horizontal <= 0) return null;
  return { step: Math.round(step), vertical: Math.max(0, Math.round(vertical)), horizontal: Math.max(0, Math.round(horizontal)) };
}

/**
 * 格线在这个缩放下的间距（桌面像素）。与 `captureScript` 里那段同一条规则——
 * 回执要预告「要是加了格线，间距会是多少」，那就得和真画出来的那个数一致。
 */
export function gridStepFor(imageWidth: number, capturedWidth: number): number {
  if (capturedWidth <= 0 || imageWidth <= 0) return GRID_BASE_STEP;
  const perImagePx = imageWidth / capturedWidth;
  let step = GRID_BASE_STEP;
  while (step * perImagePx < GRID_MIN_GAP_PX) step *= 2;
  return step;
}

/**
 * 「这张图怎么换算成桌面坐标」——**跟图一起回去**的那一句。
 *
 * 她量错过两次:拿着被压过的窗口截图按原始像素算，于是先点到了旁边的「≡」、后来又把 VoiceMeeter
 * 抬到了前面。所以这句话不能只住在环境提示词里:她读到它的时候，正是要量的时候。
 * 叠了格线那一次更省事——线上的数字就是桌面坐标，一次乘法都不用做。
 */
export function describeShotGeometry(
  result: Pick<ScreenshotResult, 'width' | 'height' | 'captured' | 'downscaled' | 'grid'>,
): string {
  const cap = result.captured;
  const per = cap.width > 0 && result.width > 0 ? cap.width / result.width : 1;
  const lines: string[] = [];
  if (result.downscaled) {
    lines.push(
      `**这张图被压过**（${cap.width}×${cap.height} → ${result.width}×${result.height}）:` +
        `**图上 1 像素 = 桌面 ${per.toFixed(2)} 像素**——按图上的像素直接当桌面像素用就会偏。`,
    );
  } else {
    lines.push('这张图没被压:**图上的点就是桌面的点**（1:1）。');
  }
  const scale = per === 1 ? '' : ` × ${per.toFixed(2)}`;
  lines.push(
    `图上的 (px,py) → 桌面 (${cap.x} + px${scale}, ${cap.y} + py${scale});` +
      `图的左上角那一点是桌面 (${cap.x}, ${cap.y})。`,
  );
  if (result.grid) {
    lines.push(
      `图上叠了淡格线:**每 ${result.grid.step} 桌面像素一条**（竖线 ${result.grid.vertical} 条、横线 ` +
        `${result.grid.horizontal} 条），**每条线旁边就标着它自己的桌面坐标**（写 x=… 的是竖线、y=… 的是横线）` +
        '——照着线上的数字读，一次乘法都不用做。',
    );
  } else {
    const step = gridStepFor(result.width, cap.width);
    lines.push(
      `要按图量坐标（点别的东西、读某个控件在哪）:**下一步加 grid:true**——图上会叠一层每 ${step} ` +
        '桌面像素一条的淡格线、线旁标着桌面坐标，照着读就不用换算。',
    );
  }
  return lines.join('\n');
}

/**
 * 「图上那个箭头是什么」——**跟图一起回去**的那句话。
 *
 * 抓屏本身拍不到光标（量过：围着光标的 PNG 里没有箭头），所以图上的光标是我们照着系统的真光标
 * 画上去的。这一句要把「它到底在不在图上」说清：没画的时候，她不该读成「光标不在这块」，
 * 更不该读成「这个功能坏了」。
 */
export function describeShotCursor(result: Pick<ScreenshotResult, 'cursor' | 'captured'>): string {
  const c = result.cursor;
  const at = c.x === null || c.y === null ? '桌面某处' : `桌面 (${c.x}, ${c.y})`;
  switch (c.draw) {
    case 'drawn':
      return `鼠标在 ${at}：**图上那个箭头就是它**（抓屏抓不到光标本身，箭头是我照系统当前的样子画上去的）。`;
    case 'omitted':
      return `鼠标在 ${at}；你说了这次不要箭头，**图上没有画它**（位置还是要报的，就是这一句）。`;
    case 'hidden':
      return `鼠标在 ${at}，但**系统这一刻把它藏起来了**（全屏视频、有些程序会自己隐藏指针），所以在图上没有箭头。`;
    case 'offscreen':
      return `鼠标在 ${at}，**不在这张图里**（这张图只覆盖 x=${result.captured.x} y=${result.captured.y} 那一块），所以图上没有箭头。`;
    case 'printwindow':
      return '这张图是窗口自己绘的帧（不是抓屏），所以上面**没有**鼠标箭头——这不代表光标不在那一块。';
    default:
      return '这一次没能读出鼠标在哪，所以图上没有箭头。';
  }
}

/** 一个对象也可能是 ConvertTo-Json 把单元素数组拍平的结果，兜一下。 */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  return [value as T];
}

/** 列一遍可见窗口，附带屏幕几何。失败抛错。 */
export async function listWindows(timeoutMs = 15000): Promise<WindowList> {
  const result = await runPowerShellJson(listWindowsScript(), timeoutMs);
  if (result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : '列不出窗口');
  }
  const windows = asArray<Record<string, unknown>>(result.windows).map((w) => ({
    hwnd: Number(w.hwnd ?? 0),
    title: typeof w.title === 'string' ? w.title : '',
    exe: typeof w.exe === 'string' ? w.exe : '',
    pid: Number(w.pid ?? 0),
    foreground: w.foreground === true,
    minimized: w.minimized === true,
    bounds: toRect(w.bounds),
  }));
  const rawScreen = (result.screen ?? {}) as Record<string, unknown>;
  const screen: ScreenInfo = {
    ...toRect(rawScreen),
    monitors: asArray<Record<string, unknown>>(rawScreen.monitors).map((m, index) => ({
      index: Number(m.index ?? index),
      ...toRect(m),
      primary: m.primary === true,
    })),
  };
  return { windows, screen };
}

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

/** 截屏脚本。target 与区域坐标是模板里插进去的常量；出错输出 `{ok:false,error}`，不抛裸栈。 */
function captureScript(target: ScreenshotTarget): string {
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int sizeOfRect);
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
  Out-Json @{ ok = $true; data = $b64; format = $format; bytes = $bytes.Length; width = $ow; height = $oh; captured = $captured; downscaled = $downscaled; via = $via; title = $title }
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
export async function captureScreenshot(target: ScreenshotTarget, timeoutMs = 20000): Promise<ScreenshotResult> {
  const result = await runPowerShellJson(captureScript(target), timeoutMs);
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
  };
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

/**
 * 按需的一次性 PowerShell：截屏与列窗口。不走常驻传感器——她说要才发生，
 * 进程用完即退。回执里始终带 `via`（走的哪条路）与 `title`（截的是谁），
 * 截不了就报错原因，不返黑图装成功。
 */
import { spawn } from 'node:child_process';

/** 截图的最长边（像素），超过就等比降采样。再大只是烧 token。 */
export const SCREENSHOT_MAX_EDGE = 1600;
/** 列窗口的回执上限，防一个挤满资源管理器窗口的桌面把 token 吃光。 */
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

export type ScreenshotTarget =
  | { target: 'full' }
  | { target: 'foreground' }
  | { target: 'window'; hwnd: number };

export interface ScreenshotResult {
  bytes: Buffer;
  /** 实际编码：文字界面存 PNG（无损、字清楚），照片类画面存 JPEG（体积差一个数量级）。 */
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** 走的哪条路：`screen`（抓屏）或 `printwindow`（向窗口要画面）。 */
  via: 'screen' | 'printwindow';
  /** 目标窗口的标题；全屏时为空。 */
  title: string;
}

export interface WindowInfo {
  hwnd: number;
  title: string;
  exe: string;
  pid: number;
  foreground: boolean;
  minimized: boolean;
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

/** 截屏脚本。target 与 hwnd 是模板里插进去的常量；出错输出 `{ok:false,error}`，不抛裸栈。 */
function captureScript(target: ScreenshotTarget): string {
  const kind = target.target;
  const hwnd = target.target === 'window' ? String(Math.trunc(target.hwnd)) : '0';
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 5 | Write-Output }
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

  if ($kind -eq 'full') {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($vs.Width -le 0 -or $vs.Height -le 0) { throw '拿不到屏幕尺寸' }
    $rect = @{ x = $vs.Left; y = $vs.Top; w = $vs.Width; h = $vs.Height }
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
  if ($kind -eq 'full') {
    $src = New-Object System.Drawing.Bitmap -ArgumentList $rect.w, $rect.h
    $g = [System.Drawing.Graphics]::FromImage($src)
    [void]$g.CopyFromScreen($rect.x, $rect.y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $rect.w, $rect.h))
    $g.Dispose()
    $via = 'screen'
  } else {
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
      $src = New-Object System.Drawing.Bitmap -ArgumentList $rect.w, $rect.h
      $g2 = [System.Drawing.Graphics]::FromImage($src)
      [void]$g2.CopyFromScreen($rect.x, $rect.y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $rect.w, $rect.h))
      $g2.Dispose()
      $via = 'screen'
    }
  }

  $edge = [Math]::Max($src.Width, $src.Height)
  if ($edge -gt $maxEdge) {
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
  Out-Json @{ ok = $true; data = $b64; format = $format; bytes = $bytes.Length; pngBytes = $pngBytes.Length; width = $ow; height = $oh; via = $via; title = $title }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
}
`.trim();
}

/** 列可见顶层窗口（跳过披隐藏斗篷的 UWP 壳），标出前台与最小化。 */
function listWindowsScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PresenceList {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int sizeOfValue);
}
'@
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
  [void]$found.Add(@{
    hwnd = $h.ToInt64()
    title = $t
    exe = $(if ($p) { $p.ProcessName } else { '' })
    pid = $procId
    foreground = ($h -eq $fg)
    minimized = [PresenceList]::IsIconic($h)
  })
  return $true
}
[void][PresenceList]::EnumWindows($callback, [IntPtr]::Zero)
@{ ok = $true; windows = $found } | ConvertTo-Json -Compress -Depth 5 | Write-Output
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
    via: result.via === 'printwindow' ? 'printwindow' : 'screen',
    title: typeof result.title === 'string' ? result.title : '',
  };
}

/** 列一遍可见窗口。失败抛错。 */
export async function listWindows(timeoutMs = 15000): Promise<WindowInfo[]> {
  const result = await runPowerShellJson(listWindowsScript(), timeoutMs);
  if (result.ok !== true || !Array.isArray(result.windows)) {
    throw new Error(typeof result.error === 'string' ? result.error : '列不出窗口');
  }
  return result.windows.map((raw) => {
    const w = raw as Record<string, unknown>;
    return {
      hwnd: Number(w.hwnd ?? 0),
      title: typeof w.title === 'string' ? w.title : '',
      exe: typeof w.exe === 'string' ? w.exe : '',
      pid: Number(w.pid ?? 0),
      foreground: w.foreground === true,
      minimized: w.minimized === true,
    };
  });
}

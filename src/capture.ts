/**
 * 按需的一次性 PowerShell：截屏与列窗口。不走常驻传感器——她说要才发生，
 * 进程用完即退。回执里始终带 `via`（走的哪条路）与 `title`（截的是谁），
 * 截不了就报错原因，不返黑图装成功。
 */
import { spawn } from 'node:child_process';

/** 全屏拼图的最长边（像素），超过就等比降采样。再大只是烧 token。 */
export const SCREENSHOT_MAX_EDGE = 1600;
/** 列窗口的回执上限，防一个挤满资源管理器窗口的桌面把 token 吃光。 */
export const WINDOW_LIST_CAP = 100;

export type ScreenshotTarget =
  | { target: 'full' }
  | { target: 'foreground' }
  | { target: 'window'; hwnd: number };

export interface ScreenshotResult {
  png: Buffer;
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
  $ms = New-Object System.IO.MemoryStream
  $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $src.Dispose()
  $b64 = [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
  Out-Json @{ ok = $true; png = $b64; width = $ow; height = $oh; via = $via; title = $title }
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

/** 截一张。她说要才调用；失败抛错（World 转成失败回执），错误文案给人看。 */
export async function captureScreenshot(target: ScreenshotTarget, timeoutMs = 20000): Promise<ScreenshotResult> {
  const result = await runPowerShellJson(captureScript(target), timeoutMs);
  if (result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : '截图失败，原因不明');
  }
  const png = asBuffer(result.png);
  if (png.length < 8 || png.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error('截到的不是一张有效的 PNG');
  }
  return {
    png,
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

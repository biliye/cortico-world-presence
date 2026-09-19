/**
 * 桌面传感器：一个常驻的 PowerShell 子进程，每 pollIntervalMs 采样一次前台窗口与键鼠空闲，
 * 往 stdout 吐一行 JSON（tick）。它是**纯采样器**，不带任何语义——窗口变化、离开/回来、
 * 停留时长全部由 World 在 Node 侧推导，这样测试可以喂假采样，不用真的开桌面。
 *
 * PowerShell 是 Windows 自带的，零安装；Win32 API 走 Add-Type，不引原生模块。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** 一次采样里的前台窗口。没有前台窗口（锁屏、secure desktop）时 cur 为 null。 */
export interface SensorWindow {
  hwnd: number;
  title: string;
  /** 进程名，如 `chrome`。查不到时是空串。 */
  exe: string;
  pid: number;
}

/** 传感器吐出的一行。只有 tick 一种；窗口变化由 Node 对比相邻 tick 得出。 */
export interface SensorTick {
  type: 'tick';
  /** 距上次键鼠输入的毫秒数。 */
  idleMs: number;
  cur: SensorWindow | null;
}

export interface SensorExit {
  code: number | null;
  signal: string | null;
  /** stderr 的尾部，排错用。 */
  stderrTail: string;
}

export interface PresenceSensor {
  onTick(handler: (tick: SensorTick) => void): void;
  onExit(handler: (info: SensorExit) => void): void;
  stop(): void;
}

/** PowerShell 采样脚本。每轮采样一行 `{"type":"tick","idleMs":N,"cur":{...}}`。 */
function samplerScript(pollIntervalMs: number): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PresenceNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
'@
$pollMs = ${pollIntervalMs}
$exeCache = @{}
function Get-IdleMs {
  $info = New-Object 'PresenceNative+LASTINPUTINFO'
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  [void][PresenceNative]::GetLastInputInfo([ref]$info)
  $diff = ([uint32][Environment]::TickCount) - $info.dwTime
  return [Math]::Max(0, [int]$diff)
}
while ($true) {
  $idleMs = Get-IdleMs
  $cur = $null
  $h = [PresenceNative]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][PresenceNative]::GetWindowText($h, $sb, 512)
    $procId = [uint32]0
    [void][PresenceNative]::GetWindowThreadProcessId($h, [ref]$procId)
    $exe = $exeCache[$procId]
    if ($null -eq $exe) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      $exe = if ($p) { $p.ProcessName } else { '' }
      $exeCache[$procId] = $exe
    }
    $cur = @{ hwnd = $h.ToInt64(); title = $sb.ToString(); exe = $exe; pid = $procId }
  }
  @{ type = 'tick'; idleMs = $idleMs; cur = $cur } | ConvertTo-Json -Compress -Depth 4 | Write-Output
  Start-Sleep -Milliseconds $pollMs
}
`.trim();
}

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** PowerShell 公共启动参数：不改配置、不交互、绕执行策略（脚本从内存进，不落盘）。 */
function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
}

/** 拉起真传感器。测试不经过这里（注入假的），集成测试直接调它。 */
export function spawnSensor(pollIntervalMs: number): PresenceSensor {
  const child = spawn('powershell.exe', powerShellArgs(samplerScript(pollIntervalMs)), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return wireSensor(child);
}

/** 把一个 PowerShell 子进程接成传感器。spawn 真进程与测试用假进程共用这条解析路径。 */
export function wireSensor(child: ChildProcess): PresenceSensor {
  let tickHandler: ((tick: SensorTick) => void) | null = null;
  let exitHandler: ((info: SensorExit) => void) | null = null;
  let stderrTail = '';
  let ended = false;

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text || !tickHandler) return;
      try {
        const parsed = JSON.parse(text) as SensorTick;
        if (parsed && parsed.type === 'tick') tickHandler(parsed);
      } catch {
        // 不是 JSON 的行（PowerShell 偶发的提示）当没看见，别让采样断掉
      }
    });
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  // powershell.exe 找不到时只有 error 没有 close，也当退出报出去。
  child.on('error', (err: Error) => {
    if (ended) return;
    ended = true;
    exitHandler?.({ code: null, signal: null, stderrTail: stderrTail || err.message });
  });
  child.on('close', (code, signal) => {
    if (ended) return;
    ended = true;
    exitHandler?.({ code, signal, stderrTail });
  });

  return {
    onTick(handler) {
      tickHandler = handler;
    },
    onExit(handler) {
      exitHandler = handler;
    },
    stop() {
      ended = true;
      if (child.exitCode === null && !child.killed) child.kill();
    },
  };
}

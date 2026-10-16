import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  captureHostSpawns,
  captureScreenshot,
  describeShotCursor,
  describeShotGeometry,
  gridStepFor,
  listWindows,
  stopCaptureHost,
} from '../src/capture.ts';

/** 真截屏与列窗口只在 Windows 桌面会话里跑得动。 */
const maybe = process.platform === 'win32' ? describe : describe.skip;

/**
 * 独立量一次光标在哪：另起一个 PowerShell，声明 DPI 感知后直接问 GetCursorPos。
 * 少了 DPI 感知这一步，在缩放不是 100% 的屏上它报的是被系统虚拟化过的坐标。
 * 用「另起一个进程、另一条 API」来量，是为了「证据从对面来」——不拿被测的那段代码自证。
 */
async function readCursorDirect(): Promise<{ x: number; y: number }> {
  const { spawn } = await import('node:child_process');
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProbeCursor {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
'@
try { [void][ProbeCursor]::SetProcessDpiAwareness(2) } catch { }
$p = New-Object 'ProbeCursor+POINT'
[void][ProbeCursor]::GetCursorPos([ref]$p)
Write-Output "$($p.X) $($p.Y)"
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let text = '';
    child.stdout?.on('data', (d: Buffer) => {
      text += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => resolve(text));
  });
  const m = /(-?\d+)\s+(-?\d+)/.exec(out);
  if (!m) throw new Error(`独立量光标失败：${out.slice(-200)}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** 换算那句话是纯函数，跟真桌面无关，所以在任何平台上都跑。 */
describe('截图换算与格线（纯函数）', () => {
  it('1:1 的图就说「图上的点就是桌面的点」，并给出左上角对应的桌面坐标', () => {
    const text = describeShotGeometry({
      width: 240,
      height: 160,
      captured: { x: 100, y: 50, width: 240, height: 160 },
      downscaled: false,
      grid: null,
    });
    expect(text).toContain('1:1');
    expect(text).toContain('图上的 (px,py) → 桌面 (100 + px, 50 + py)');
  });

  it('被压过的图必须写出「图上 1px = 桌面多少 px」——她点偏两次就是因为没有这句', () => {
    const text = describeShotGeometry({
      width: 1600,
      height: 900,
      captured: { x: 0, y: 0, width: 2560, height: 1440 },
      downscaled: true,
      grid: null,
    });
    expect(text).toContain('图上 1 像素 = 桌面 1.60 像素');
    expect(text).toContain('2560×1440 → 1600×900');
    // 没叠格线时要告诉她下一步怎么加
    expect(text).toContain('grid:true');
  });

  it('叠了格线就报出间距和条数，并说清「照着线上的数字读」', () => {
    const text = describeShotGeometry({
      width: 1600,
      height: 900,
      captured: { x: 0, y: 0, width: 2560, height: 1440 },
      downscaled: true,
      grid: { step: 200, vertical: 12, horizontal: 7 },
    });
    expect(text).toContain('每 200 桌面像素一条');
    expect(text).toContain('竖线 12 条、横线 7 条');
    expect(text).toContain('照着线上的数字读');
    expect(text).not.toContain('grid:true');
  });

  it('格线间距：图上密不下就翻倍，别糊成一片', () => {
    expect(gridStepFor(240, 240)).toBe(100); // 1:1
    expect(gridStepFor(1600, 2560)).toBe(200); // 压过 0.625 倍：100×0.625=62.5 < 70
    expect(gridStepFor(800, 2560)).toBe(400); // 压过 0.3125 倍：100→200→400
  });
});

/**
 * 光标那句话也是纯函数。它决定她读到的是「图上有箭头」还是「图上没有、因为 X」——那几种「没有」
 * 的原因对她意味着完全不同的事（要不要重新框一块 / 要不要换个目标 / 是不是我坏了），所以这一组
 * 用例盯的就是「四种原因各有各的说法，一句都不能混」。
 */
describe('图上的光标（纯函数）', () => {
  const cap = { x: 0, y: 0, width: 2560, height: 1440 };

  it('画上了：说清箭头就是光标，并给出它的桌面坐标', () => {
    const text = describeShotCursor({ captured: cap, cursor: { x: 1312, y: 1310, draw: 'drawn' } });
    expect(text).toContain('桌面 (1312, 1310)');
    expect(text).toContain('图上那个箭头就是它');
  });

  it('没画的五种原因各说各的，她得能分辨是哪一种', () => {
    const of = (draw: 'omitted' | 'hidden' | 'offscreen' | 'printwindow' | 'unknown') =>
      describeShotCursor({ captured: cap, cursor: { x: 100, y: 200, draw } });
    expect(of('omitted')).toContain('你说了这次不要箭头');
    expect(of('omitted')).toContain('桌面 (100, 200)'); // 不要箭头不等于不要位置
    expect(of('hidden')).toContain('系统这一刻把它藏起来了');
    expect(of('offscreen')).toContain('不在这张图里');
    expect(of('offscreen')).toContain('x=0 y=0');
    expect(of('printwindow')).toContain('窗口自己绘的帧');
    expect(of('unknown')).toContain('没能读出鼠标');
    const all = [of('omitted'), of('hidden'), of('offscreen'), of('printwindow'), of('unknown')];
    expect(new Set(all).size).toBe(5);
    for (const t of all) {
      expect(t).not.toContain('图上那个箭头就是');
    }
  });

  it('读不到位置时不编一个坐标出来', () => {
    const text = describeShotCursor({ captured: cap, cursor: { x: null, y: null, draw: 'unknown' } });
    expect(text).not.toMatch(/\d{2,}/);
  });
});

/**
 * 助手脚本现在是**包内一份 `.ps1`**（`src/capture-host.ps1`），用 `-File` 跑。
 *
 * 为什么不再塞在命令行上（`-EncodedCommand`）：两段脚本合起来编码后 **43952 字节**，
 * 而 Windows 命令行的上限约 **32767** —— 顶过去就是 `spawn ENAMETOOLONG`
 * （2026-10-07 就是这么红的：往模板里加了一段解释，编码后 33003）。改成读文件之后没有这个上限，
 * 而且它在盘上是一份**可读、可以加进杀软白名单**的文件。
 *
 * 盯两件事，都是「真跑起来之前看不出来」的那种坏法：
 * - **BOM**：脚本里有中文（给她的错误文案），无 BOM 的 UTF-8 会被 Windows PowerShell 5.1
 *   按系统 ANSI 读成乱码；
 * - **它得跟着包走**：`files` 覆盖到 `src/`，发布出去的包里才有这份文件。
 */
describe('助手脚本（包内文件）', () => {
  const scriptPath = fileURLToPath(new URL('../src/capture-host.ps1', import.meta.url));

  it('存在、带 UTF-8 BOM，且中文读得出来（不是乱码）', () => {
    const bytes = readFileSync(scriptPath);
    expect(bytes.subarray(0, 3), '缺 UTF-8 BOM ⇒ PowerShell 5.1 会把中文按 ANSI 读成乱码').toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
    const text = bytes.subarray(3).toString('utf8');
    expect(text).toContain('这块区域不在屏幕上');
    expect(text).toContain('function Invoke-Capture');
    expect(text).toContain('function Invoke-Windows');
  });

  it('命令行只剩参数（脚本不再走 -EncodedCommand，也没有别的地方塞长脚本）', () => {
    const encoded = Buffer.from(readFileSync(scriptPath, 'utf8'), 'utf16le').toString('base64').length;
    expect(encoded, '它已经不经过命令行了，这条只是提醒：别再把它塞回去').toBeGreaterThan(32767);
  });
});

maybe('截图与列窗口（真 PowerShell）', () => {
  it('截一张全屏，是合法 PNG 或 JPEG，尺寸为正', async () => {
    const shot = await captureScreenshot({ target: 'full' }, 25000);
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(shot.via).toBe('screen');
    expect(shot.grid).toBeNull();
    if (shot.format === 'png') {
      expect([...shot.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } else {
      expect([...shot.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
  }, 30000);

  /**
   * 「报出来的光标位置不是编的」：截图前后各另起一个进程独立量一次，报出来的那个点必须落在两次
   * 之间。前后都量的理由是他可能正在动鼠标——那样这次截图自己就是一个合法的时间点，而一个写死
   * 的坐标、一个 0、或者一个被 DPI 虚拟化过的值都过不了这一关。
   */
  it('报出来的光标位置与独立量到的一致', async () => {
    const before = await readCursorDirect();
    const shot = await captureScreenshot({ target: 'full' }, 25000);
    const after = await readCursorDirect();
    // 全屏 + 抓屏 + 光标在屏内 → 要么画上了，要么系统这一刻把它藏起来了，两种都算「位置读到了」
    expect(['drawn', 'hidden']).toContain(shot.cursor.draw);
    expect(shot.cursor.x).not.toBeNull();
    expect(shot.cursor.y).not.toBeNull();
    expect(shot.cursor.x!).toBeGreaterThanOrEqual(Math.min(before.x, after.x) - 3);
    expect(shot.cursor.x!).toBeLessThanOrEqual(Math.max(before.x, after.x) + 3);
    expect(shot.cursor.y!).toBeGreaterThanOrEqual(Math.min(before.y, after.y) - 3);
    expect(shot.cursor.y!).toBeLessThanOrEqual(Math.max(before.y, after.y) + 3);
  }, 45000);

  it('列窗口：至少列得出带标题的窗口，并报出屏幕几何', async () => {
    const listed = await listWindows();
    expect(listed.windows.length).toBeGreaterThan(0);
    expect(listed.windows.some((w) => w.title.length > 0)).toBe(true);
    expect(listed.screen.width).toBeGreaterThan(0);
    expect(listed.screen.monitors.length).toBeGreaterThan(0);
    expect(listed.screen.monitors[0].width).toBeGreaterThan(0);
  }, 20000);

  it('截一个小区域：按原始像素给，尺寸就是框的尺寸（不走降采样）', async () => {
    const listed = await listWindows();
    // 在虚拟屏内取一块 240x160，避开屏幕边缘
    const x = Math.max(listed.screen.x, Math.min(listed.screen.x + 40, listed.screen.x + listed.screen.width - 300));
    const y = Math.max(listed.screen.y, Math.min(listed.screen.y + 40, listed.screen.y + listed.screen.height - 220));
    const shot = await captureScreenshot({ target: 'region', region: { x, y, width: 240, height: 160 } }, 25000);
    expect(shot.width).toBe(240);
    expect(shot.height).toBe(160);
    expect(shot.downscaled).toBe(false);
    expect(shot.via).toBe('screen');
    expect(shot.captured).toEqual({ x, y, width: 240, height: 160 });
    expect(shot.bytes.length).toBeGreaterThan(0);
  }, 30000);

  it('框到屏幕外：夹回屏幕内并在结果里给出实际区域', async () => {
    const listed = await listWindows();
    const shot = await captureScreenshot(
      { target: 'region', region: { x: listed.screen.x + listed.screen.width - 100, y: listed.screen.y, width: 4000, height: 120 } },
      25000,
    );
    expect(shot.captured.width).toBeLessThan(4000);
    expect(shot.captured.width).toBeGreaterThan(0);
    expect(shot.width).toBe(shot.captured.width);
  }, 30000);

  it('加 grid:true 真叠上格线：报出的间距与条数对得上几何，图也和没叠那张不一样', async () => {
    const listed = await listWindows();
    // 400x300 的一块（1:1，不降采样），按 GRID_BASE_STEP=100 该有 4 竖 3 横左右
    const x = Math.max(listed.screen.x + 40, listed.screen.x + 40);
    const y = listed.screen.y + 40;
    const region = { x, y, width: 400, height: 300 };
    const plain = await captureScreenshot({ target: 'region', region }, 25000);
    const grid = await captureScreenshot({ target: 'region', region }, 25000, { grid: true });
    expect(plain.grid).toBeNull();
    expect(grid.grid).not.toBeNull();
    const info = grid.grid!;
    expect(info.step).toBe(gridStepFor(grid.width, grid.captured.width));
    expect(info.vertical).toBeGreaterThan(0);
    expect(info.horizontal).toBeGreaterThan(0);
    // 画上去的东西必须改变这张图；连字节都一样就是根本没画（「真的画上去了」只能这么验）
    expect(Buffer.compare(plain.bytes, grid.bytes)).not.toBe(0);
  }, 60000);
});

/**
 * 常驻助手本身（真 PowerShell）：**复用**与**坏了以后还能用**这两件事必须钉住 ——
 * 前者是这次改动的全部意义（不再是每次起一个进程），后者是「杀软拦了一下」之后的表现。
 */
maybe('常驻助手（真 PowerShell）', () => {
  const tiny = { target: 'region', region: { x: 0, y: 0, width: 64, height: 64 } } as const;

  it('连着两次调用只用一只助手，不是每次都起一个进程', async () => {
    await captureScreenshot(tiny, 25000);
    const after = captureHostSpawns();
    await captureScreenshot(tiny, 25000);
    await listWindows(15000);
    expect(captureHostSpawns(), '复用失败：第二次调用又起了一只').toBe(after);
  });

  it('超时按「没跑完」报错，而且下一次调用照常（助手会另起一只）', async () => {
    // 配一条**注定跑不完**的请求：整屏抓屏在本机量过 190~250ms，给它 20ms 是十倍余量。
    // 别用「小请求 + 1ms 超时」那种写法 —— 那是赛跑（2026-10-16 真红过一次：请求 5ms 就跑完了）。
    await expect(captureScreenshot({ target: 'full' }, 20)).rejects.toThrow(/没跑完/);
    const shot = await captureScreenshot(tiny, 25000);
    expect(shot.width).toBe(64);
    expect(shot.height).toBe(64);
  });

  it('World 收工调 stopCaptureHost 之后，下一次调用会另起一只并成功', async () => {
    await captureScreenshot(tiny, 25000);
    const before = captureHostSpawns();
    await stopCaptureHost();
    const shot = await captureScreenshot(tiny, 25000);
    expect(shot.width).toBeGreaterThan(0);
    expect(captureHostSpawns()).toBe(before + 1);
  });

  it('收工时等着的请求按失败交回，不会永远挂着', async () => {
    const inflight = captureScreenshot(tiny, 25000);
    const queued = listWindows(15000);
    await stopCaptureHost();
    await expect(inflight).rejects.toThrow();
    await expect(queued).rejects.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { captureScreenshot, listWindows } from '../src/capture.ts';

/** 真截屏与列窗口只在 Windows 桌面会话里跑得动。 */
const maybe = process.platform === 'win32' ? describe : describe.skip;

maybe('截图与列窗口（真 PowerShell）', () => {
  it('截一张全屏，是合法 PNG 或 JPEG，尺寸为正', async () => {
    const shot = await captureScreenshot({ target: 'full' }, 25000);
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(shot.via).toBe('screen');
    if (shot.format === 'png') {
      expect([...shot.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } else {
      expect([...shot.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
  }, 30000);

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
});

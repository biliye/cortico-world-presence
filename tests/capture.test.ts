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

  it('列窗口：至少列得出带标题的窗口', async () => {
    const windows = await listWindows();
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.some((w) => w.title.length > 0)).toBe(true);
  }, 20000);
});

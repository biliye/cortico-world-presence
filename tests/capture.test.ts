import { describe, expect, it } from 'vitest';
import { captureScreenshot, describeShotGeometry, gridStepFor, listWindows } from '../src/capture.ts';

/** 真截屏与列窗口只在 Windows 桌面会话里跑得动。 */
const maybe = process.platform === 'win32' ? describe : describe.skip;

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

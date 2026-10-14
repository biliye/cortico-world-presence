import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import type { ScreenshotResult, ScreenshotTarget, ScreenInfo, WindowInfo } from '../src/capture.ts';
import { PRESENCE_DEFAULTS, type PresenceConfigSection } from '../src/config.ts';
import { PRESENCE } from '../src/definition.ts';
import type { PresenceSensor, SensorExit, SensorTick, SensorWindow } from '../src/sensor.ts';
import { PresenceWorld, type PresenceWorldOptions } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const CTX = {} as ToolCallContext;

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'presence-world-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

const WIN_A: SensorWindow = { hwnd: 11, title: '知乎 - Google Chrome', exe: 'chrome', pid: 101 };
const WIN_B: SensorWindow = { hwnd: 22, title: 'main.ts - 编辑器', exe: 'code', pid: 202 };
const WIN_C: SensorWindow = { hwnd: 33, title: '终端', exe: 'wezterm', pid: 303 };

/** 最小 PNG：8 字节魔数 + 一点杂货。World 侧不校验内容，capture.ts 才校验。 */
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
}

/** 假传感器：测试手动喂 tick、假装进程退出，不用真的开 PowerShell。 */
class FakeSensor implements PresenceSensor {
  private tickHandler: ((tick: SensorTick) => void) | null = null;
  private exitHandler: ((info: SensorExit) => void) | null = null;
  stopped = false;

  onTick(handler: (tick: SensorTick) => void): void {
    this.tickHandler = handler;
  }
  onExit(handler: (info: SensorExit) => void): void {
    this.exitHandler = handler;
  }
  stop(): void {
    this.stopped = true;
  }
  tick(idleMs: number, cur: SensorWindow | null): void {
    this.tickHandler?.({ type: 'tick', idleMs, cur });
  }
  exit(info: Partial<SensorExit> = {}): void {
    this.exitHandler?.({ code: 0, signal: null, stderrTail: '', ...info });
  }
}

interface Build {
  world: PresenceWorld;
  host: FakeHost;
  sensor: FakeSensor;
  tools: Record<string, ToolDef>;
  calls: { listWindows: number; captures: ScreenshotTarget[]; grids: boolean[]; cursors: boolean[] };
}

function build(
  overrides: Partial<PresenceWorldOptions> = {},
  cfgPatch: Partial<PresenceConfigSection> = {},
): Build {
  const sensor = new FakeSensor();
  const calls = { listWindows: 0, captures: [] as ScreenshotTarget[], grids: [] as boolean[], cursors: [] as boolean[] };
  const windows: WindowInfo[] = [
    { ...WIN_B, foreground: true, minimized: false, bounds: { x: 100, y: 50, width: 1200, height: 800 } },
    { ...WIN_A, foreground: false, minimized: true, bounds: { x: 0, y: 0, width: 0, height: 0 } },
  ];
  const screen: ScreenInfo = {
    x: 0,
    y: 0,
    width: 2560,
    height: 1440,
    monitors: [
      { index: 0, x: 0, y: 0, width: 2560, height: 1440, primary: true },
      { index: 1, x: -1920, y: 200, width: 1920, height: 1080, primary: false },
    ],
  };
  const world = new PresenceWorld({
    cfg: { ...PRESENCE_DEFAULTS, ...cfgPatch },
    timezone: 'Asia/Shanghai',
    spawnSensor: () => sensor,
    listWindows: async () => {
      calls.listWindows += 1;
      return { windows, screen };
    },
    capture: async (target, options) => {
      calls.captures.push(target);
      calls.grids.push(options?.grid === true);
      calls.cursors.push(options?.cursor !== false);
      const result: ScreenshotResult = {
        bytes: pngBytes(),
        format: 'png',
        // 区域那条路是真的 1:1（小框不走降采样），所以假截屏也照这个来:
        // 区域给框的尺寸，别的不给 800x600。
        width: target.target === 'region' ? target.region.width : 800,
        height: target.target === 'region' ? target.region.height : 600,
        captured:
          target.target === 'region'
            ? { ...target.region }
            : { x: 0, y: 0, width: 800, height: 600 },
        downscaled: false,
        via: 'printwindow',
        // 假截屏照真那条的样子：要了格线才报格线（回执那几句是从这里出来的）。
        grid: options?.grid === true ? { step: 100, vertical: 8, horizontal: 6 } : null,
        // 假截屏照真那条的样子：说了不要箭头就报 omitted（位置照给），否则报画了。
        cursor: options?.cursor === false ? { x: 640, y: 360, draw: 'omitted' } : { x: 640, y: 360, draw: 'drawn' },
        title: '测试窗口',
      };
      return result;
    },
    ...overrides,
  });
  const host = new FakeHost();
  const tools = Object.fromEntries(world.tools().map((t) => [t.name, t]));
  return { world, host, sensor, tools, calls };
}

async function call(tool: ToolDef | undefined, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  if (!tool) throw new Error('工具不存在');
  const out = await tool.handler(args, CTX);
  return typeof out === 'string' ? { text: out } : out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Presence World', () => {
  it('干装载不报失败：装载器会接受它', async () => {
    const report = await dryMountWorld(PRESENCE, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('暴露三个工具：看窗口、截图、投递姿势', () => {
    const { world } = build();
    expect(world.tools().map((t) => t.name)).toEqual([
      'presence_windows',
      'presence_screenshot',
      'presence_set_mode',
    ]);
  });

  it('环境提示词模板不带占位符', () => {
    const { world } = build();
    expect(world.envPromptVars()).toEqual({});
  });

  it('第一回采样只打底，不投事件', async () => {
    const { world, host, sensor } = build();
    await world.start(host);
    sensor.tick(100, WIN_A);
    await sleep(20);
    expect(host.events).toEqual([]);
  });

  it('默认挡就是 digest：启动即记账，窗口变化不单独投；presence_windows 当场给一份结账', async () => {
    const { world, host, sensor, tools } = build();
    await world.start(host);
    sensor.tick(100, WIN_A);
    await sleep(5);
    sensor.tick(100, WIN_B);
    await sleep(20);
    expect(host.events).toEqual([]); // 默认不再「一有变化就攒批投出」
    const out = await call(tools.presence_windows);
    expect(out.text).toContain('digest（压缩）');
    expect(out.text).toContain('[压缩结账]');
    expect(out.text).toContain('「main.ts - 编辑器」');
  });

  it('ambient 挡下窗口变化攒着，stop 时合成一条 piggyback 投出', async () => {
    const { world, host, sensor, tools } = build();
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'ambient' });
    sensor.tick(100, WIN_A); // 打底
    sensor.tick(100, WIN_B); // 变化
    await sleep(20);
    expect(host.events).toEqual([]);
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['presence.activity']);
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
    expect(host.events[0].text).toContain('「main.ts - 编辑器」');
    expect(host.events[0].text).toContain('「知乎 - Google Chrome」'); // 上一个窗口
    expect(host.events[0].text).toContain('停留');
    expect(host.events[0].origin).toBe('external');
  });

  it('ambient 的批到时限就投，不等下一条变化', async () => {
    const { world, host, sensor, tools } = build({ ambientFlushMs: 50 });
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'ambient' });
    sensor.tick(100, WIN_A);
    sensor.tick(100, WIN_B);
    await sleep(120);
    expect(host.events.map((e) => e.type)).toEqual(['presence.activity']);
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
  });

  it('call 模式下变化当场投（flush），3 秒内的连续变化并成一条', async () => {
    const { world, host, sensor, tools } = build({ callCoalesceMs: 30 });
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'call' });
    sensor.tick(100, WIN_A);
    sensor.tick(100, WIN_B);
    await sleep(80);
    expect(host.events.map((e) => e.type)).toEqual(['presence.switched']);
    expect(host.pushOpts[0]?.trigger).toBe('flush');
    expect(host.events[0].text).toContain('「main.ts - 编辑器」');
  });

  it('call 模式合并窗里的多条变化合成 presence.activity', async () => {
    const { world, host, sensor, tools } = build({ callCoalesceMs: 200 });
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'call' });
    sensor.tick(100, WIN_A);
    sensor.tick(100, WIN_B);
    sensor.tick(100, WIN_C);
    await sleep(260);
    expect(host.events.map((e) => e.type)).toEqual(['presence.activity']);
    expect(host.events[0].text).toContain('「main.ts - 编辑器」');
    expect(host.events[0].text).toContain('「终端」');
  });

  it('离开/回来：过阈值投离开，恢复投回来并带离开时长', async () => {
    const { world, host, sensor, tools } = build({ ambientFlushChars: 5 }, { awayAfterMs: 100 });
    // ambientFlushChars 5：每条攒进去就满，立刻各自投出，好逐条断言。
    await world.start(host);
    sensor.tick(50, WIN_A); // 没过阈值，打底
    sensor.tick(200, WIN_A); // 离开
    await sleep(20);
    sensor.tick(50, WIN_A); // 回来
    await sleep(20);
    const texts = host.events.map((e) => e.text);
    expect(texts.some((t) => t.includes('离开键盘'))).toBe(true);
    const back = texts.find((t) => t.includes('回到键盘'));
    expect(back).toBeTruthy();
    expect(back).toContain('离开了');
  });

  it('presence_windows：回执有前台、空闲、窗口清单，变化段当场给并清空攒批', async () => {
    const { world, host, sensor, tools, calls } = build();
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'ambient' });
    sensor.tick(5000, WIN_A);
    sensor.tick(5000, WIN_B); // 一条变化，攒着
    const out = await call(tools.presence_windows);
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('「main.ts - 编辑器」(code) x=100 y=50 1200x800 ← 前台');
    expect(out.text).toContain('「知乎 - Google Chrome」(chrome) （最小化，位置不可用）');
    expect(out.text).toContain('键鼠空闲：5 秒');
    expect(out.text).toContain('[变化]');
    expect(out.text).toContain('「main.ts - 编辑器」'); // 变化行内联
    expect(calls.listWindows).toBe(1);
    // 攒批清空：再看一次，变化段就是「没有」
    const again = await call(tools.presence_windows);
    expect(again.text).toContain('没有');
  });

  it('presence_windows 在传感器没起时如实失败', async () => {
    const { tools } = build();
    const out = await call(tools.presence_windows);
    expect(out.failed).toBe(true);
    expect(out.text).toContain('没在看着桌面');
  });

  it('presence_screenshot：默认截前台（不是全屏），PNG 进 blobs，模型不吃图时把话说破', async () => {
    const { world, tools, calls } = build();
    const host = new FakeHost();
    await world.start(host);
    const out = await call(tools.presence_screenshot, {});
    expect(calls.captures[0]).toEqual({ target: 'foreground' });
    expect(out.failed).toBeUndefined();
    const blob = out.blobs?.[0] as { mime: string; bytes: Uint8Array; fallbackText: string };
    expect(blob.mime).toBe('image/png');
    expect(Buffer.from(blob.bytes).subarray(0, 4)).toEqual(pngBytes().subarray(0, 4));
    expect(blob.fallbackText).toContain('800x600');
    expect(out.text).toContain('当前模型配置不吃图'); // FakeHost 的 modelFacts.accepts 恒为 false
    // 图是临时的这件事必须在回执里说破
    expect(out.text).toContain('临时的');
    expect(out.text).toContain('写成文字');
  });

  it('presence_screenshot：JPEG 走 image/jpeg，回执里说明压过；第 2 张起提到更省的窗口列表', async () => {
    const { world, tools } = build({
      capture: async () => ({
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        format: 'jpeg' as const,
        width: 1600,
        height: 900,
        captured: { x: 0, y: 0, width: 1600, height: 900 },
        downscaled: false,
        via: 'screen' as const,
        grid: null,
        cursor: { x: 640, y: 360, draw: 'drawn' },
        title: '视频窗口',
      }),
    });
    const host = new FakeHost();
    host.modelFacts.accepts = () => true;
    await world.start(host);
    const first = await call(tools.presence_screenshot, { target: 'full' });
    expect((first.blobs?.[0] as { mime: string } | undefined)?.mime).toBe('image/jpeg');
    expect(first.text).toContain('JPEG');
    expect(first.text).not.toContain('第 2 张');
    // 图上那个箭头是什么，跟着图一起回去（这一条用的是抓屏的假截屏）
    expect(first.text).toContain('图上那个箭头就是它');
    const second = await call(tools.presence_screenshot, {});
    expect(second.text).toContain('第 2 张');
    expect(second.text).toContain('presence_windows');
  });

  /**
   * 光标那个开关:她可以不要图上的箭头，但**位置那句不能跟着没了**——「盯一块看变化」与「读小字」
   * 都靠它把图上那个会动的箭头拿掉，而少一个「光标在哪」的信号就不是这条改动的本意了。
   */
  it('presence_screenshot：cursor:false 只说不要箭头，位置照报', async () => {
    const { world, tools, calls } = build();
    const host = new FakeHost();
    host.modelFacts.accepts = () => true;
    await world.start(host);

    const withArrow = await call(tools.presence_screenshot, { target: 'full' });
    expect(withArrow.text).toContain('图上那个箭头就是它');

    const without = await call(tools.presence_screenshot, { target: 'full', cursor: false });
    expect(without.text).toContain('你说了这次不要箭头');
    expect(without.text).not.toContain('图上那个箭头就是它');
    expect(without.text).toContain('桌面 (640, 360)'); // 位置照给
    // 选项真的传下去了（不是 World 自己把箭头藏起来、capture 那边还在画）
    expect(calls.cursors).toEqual([true, false]);
  });

  it('presence_screenshot：能吃图时不说丧气话；hwnd 与 full 都落到对的目标', async () => {
    const { world, tools, calls } = build();
    const host = new FakeHost();
    host.modelFacts.accepts = () => true;
    await world.start(host);
    const ok = await call(tools.presence_screenshot, {});
    expect(ok.text).not.toContain('不吃图');
    await call(tools.presence_screenshot, { hwnd: 22 });
    await call(tools.presence_screenshot, { target: 'full' });
    expect(calls.captures).toEqual([
      { target: 'foreground' },
      { target: 'window', hwnd: 22 },
      { target: 'full' },
    ]);
  });

  it('presence_windows：回执带屏幕几何与每窗口矩形，最小化的窗口不给位置', async () => {
    const { world, host, sensor, tools } = build();
    await world.start(host);
    sensor.tick(100, WIN_B);
    const out = await call(tools.presence_windows);
    expect(out.text).toContain('虚拟屏 2560x1440');
    expect(out.text).toContain('#0主 x=0 y=0 2560x1440');
    expect(out.text).toContain('#1 x=-1920 y=200 1920x1080'); // 左屏是负坐标，得如实报
    expect(out.text).toContain('「main.ts - 编辑器」(code) x=100 y=50 1200x800');
    expect(out.text).toContain('「知乎 - Google Chrome」(chrome) （最小化，位置不可用）');
    expect(out.text).not.toContain('x=0 y=0 0x0'); // 最小化的窗口不该出现假坐标
  });

  describe('presence_screenshot 的区域', () => {
    it('给了 width/height 就按区域截，坐标原样传下去，回执说明图上就是桌面', async () => {
      const { world, tools, calls } = build();
      await world.start(new FakeHost());
      const out = await call(tools.presence_screenshot, { x: 600, y: 300, width: 400, height: 200 });
      expect(calls.captures[0]).toEqual({ target: 'region', region: { x: 600, y: 300, width: 400, height: 200 } });
      expect(out.failed).toBeUndefined();
      expect(out.text).toContain('区域 x=600 y=300 400x200');
      expect(out.text).toContain('图上的点就是桌面的点');
      expect(out.text).toContain('图上的 (px,py) → 桌面 (600 + px, 300 + py)');
    });

    it('x/y 不给算 0', async () => {
      const { world, tools, calls } = build();
      await world.start(new FakeHost());
      await call(tools.presence_screenshot, { width: 300, height: 150 });
      expect(calls.captures[0]).toEqual({ target: 'region', region: { x: 0, y: 0, width: 300, height: 150 } });
    });

    it('框太小或尺寸非法就失败，并说清怎么改', async () => {
      const { world, tools, calls } = build();
      await world.start(new FakeHost());
      const tiny = await call(tools.presence_screenshot, { width: 8, height: 8 });
      expect(tiny.failed).toBe(true);
      expect(tiny.text).toContain('至少 16 像素');
      const bad = await call(tools.presence_screenshot, { width: -100, height: 50 });
      expect(bad.failed).toBe(true);
      expect(bad.text).toContain('至少 16 像素');
      expect(calls.captures).toEqual([]); // 没通过校验就不该去截
    });

    it('区域被屏幕夹紧时在回执里说明实际抓的是哪一块', async () => {
      const { world, tools } = build({
        capture: async () => ({
          bytes: pngBytes(),
          format: 'png' as const,
          width: 2560,
          height: 100,
          captured: { x: 2000, y: 0, width: 560, height: 100 }, // 右侧超出，被夹回
          downscaled: false,
          via: 'screen' as const,
          grid: null,
          cursor: { x: 640, y: 360, draw: 'drawn' },
          title: '',
        }),
      });
      await world.start(new FakeHost());
      const out = await call(tools.presence_screenshot, { x: 2000, y: 0, width: 1400, height: 100 });
      expect(out.text).toContain('有一部分在屏幕外，已夹到屏幕内');
      expect(out.text).toContain('区域 x=2000 y=0 560x100');
    });

    it('区域超过上限被压过：提醒框小一点，并且把「图上 1px = 桌面多少 px」写出来', async () => {
      const { world, tools } = build({
        capture: async () => ({
          bytes: pngBytes(),
          format: 'png' as const,
          width: 1600,
          height: 1200,
          captured: { x: 0, y: 0, width: 3000, height: 2000 },
          downscaled: true,
          via: 'screen' as const,
          grid: null,
          cursor: { x: 640, y: 360, draw: 'drawn' },
          title: '',
        }),
      });
      await world.start(new FakeHost());
      const out = await call(tools.presence_screenshot, { width: 3000, height: 2000 });
      expect(out.text).toContain('框小一点');
      // 这一句是她点偏两次的直接原因：被压过的图不能按原始像素算。
      expect(out.text).toContain('图上 1 像素 = 桌面 1.88 像素');
      expect(out.text).toContain('3000×2000 → 1600×1200');
      expect(out.text).toContain('grid:true'); // 没叠格线时告诉她下一步怎么量得准
    });

    it('加了 grid:true 就把格线的间距与条数写进回执', async () => {
      const { world, tools, calls } = build();
      await world.start(new FakeHost());
      const out = await call(tools.presence_screenshot, { target: 'full', grid: true });
      // grid 要真的传到截屏那一层（不是只在回执里换个说法）
      expect(calls.grids).toEqual([true]);
      expect(out.text).toContain('每 100 桌面像素一条');
      expect(out.text).toContain('竖线 8 条、横线 6 条');
      expect(out.text).toContain('照着线上的数字读');
    });

    it('不给 grid 时不叠格线，并在回执里告诉她怎么量得准', async () => {
      const { world, tools, calls } = build();
      await world.start(new FakeHost());
      const out = await call(tools.presence_screenshot, { target: 'full' });
      expect(calls.grids).toEqual([false]);
      expect(out.text).not.toContain('图上叠了淡格线');
      expect(out.text).toContain('grid:true');
    });

    it('同一块区域反复看：第一次说第一次，没变就说没变，变了就说有变化', async () => {
      let payload = pngBytes();
      const { world, tools } = build({
        capture: async () => ({
          bytes: payload,
          format: 'png' as const,
          width: 300,
          height: 200,
          captured: { x: 10, y: 20, width: 300, height: 200 },
          downscaled: false,
          via: 'screen' as const,
          grid: null,
          cursor: { x: 640, y: 360, draw: 'drawn' },
          title: '',
        }),
      });
      await world.start(new FakeHost());
      const args = { x: 10, y: 20, width: 300, height: 200 };
      const first = await call(tools.presence_screenshot, args);
      expect(first.text).toContain('第一次看这块');
      const same = await call(tools.presence_screenshot, args);
      expect(same.text).toContain('像素级完全相同');
      payload = Buffer.concat([pngBytes(), Buffer.from([1, 2, 3])]);
      const changed = await call(tools.presence_screenshot, args);
      expect(changed.text).toContain('有变化');
    });
  });

  it('截图失败转成失败回执，不抛错', async () => {
    const { world, tools } = build({
      capture: async () => {
        throw new Error('窗口已最小化，截不到内容');
      },
    });
    await world.start(new FakeHost());
    const out = await call(tools.presence_screenshot, {});
    expect(out.failed).toBe(true);
    expect(out.text).toContain('窗口已最小化');
  });

  it('传感器退出投 presence.down（internal），之后工具如实说看不了', async () => {
    const { world, host, sensor, tools } = build();
    await world.start(host);
    sensor.exit({ code: 1, stderrTail: '某行 PowerShell 报错' });
    await sleep(20);
    expect(host.events.map((e) => e.type)).toEqual(['presence.down']);
    expect(host.events[0].origin).toBe('internal');
    expect(host.events[0].text).toContain('PowerShell 报错');
    const out = await call(tools.presence_windows);
    expect(out.failed).toBe(true);
  });

  it('set_mode 是运行态：切到 call 把攒的立即投出（flush），再切回来改走攒批', async () => {
    const { world, host, sensor, tools } = build();
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'ambient' });
    sensor.tick(100, WIN_A);
    sensor.tick(100, WIN_B); // ambient 攒着一条
    const out = await call(tools.presence_set_mode, { mode: 'call' });
    expect(out.text).toContain('已切到 call');
    expect(host.events.map((e) => e.type)).toEqual(['presence.activity']);
    expect(host.pushOpts[0]?.trigger).toBe('flush');
    const back = await call(tools.presence_set_mode, { mode: 'ambient' });
    expect(back.text).toContain('已切到 ambient');
    expect(host.events).toHaveLength(1); // 没多投
  });

  it('重复 set_mode 不动、不投', async () => {
    const { world, host, tools } = build();
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'ambient' });
    const out = await call(tools.presence_set_mode, { mode: 'ambient' });
    expect(out.text).toContain('没动');
    expect(host.events).toEqual([]);
  });

  it('stop 把传感器停掉，把攒的按不叫醒投出', async () => {
    const { world, host, sensor, tools } = build();
    await world.start(host);
    await call(tools.presence_set_mode, { mode: 'ambient' });
    sensor.tick(100, WIN_A);
    sensor.tick(100, WIN_B);
    await world.stop();
    expect(sensor.stopped).toBe(true);
    expect(host.events.map((e) => e.type)).toEqual(['presence.activity']);
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
  });

  /**
   * 2026-10-13 加的两挡：digest（压缩）与 off（关闭）。
   * 开发者拍的板：关闭挡「只报没见过的窗口」按**程序名**去重、本次运行内算新；
   * 压缩挡周期默认 20 分钟可临时调；离开/回来在压缩挡里当场叫醒且也记进摘要。
   */
  describe('压缩挡（digest）与关闭挡（off）', () => {
    it('digest：窗口变化不单独投，周期到了才折成一份摘要（不叫醒）', async () => {
      const { world, host, sensor, tools } = build();
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'digest', minutes: 0.02 }); // 1.2 秒一轮
      sensor.tick(100, WIN_A);
      await sleep(5);
      sensor.tick(100, WIN_B);
      await sleep(5);
      sensor.tick(100, WIN_A);
      await sleep(30);
      expect(host.events).toEqual([]); // 周期没到，一条都不投
      await sleep(1500);
      expect(host.events.map((e) => e.type)).toEqual(['presence.digest']);
      expect(host.pushOpts[0]?.trigger).toBe('piggyback');
      expect(host.events[0].text).toContain('[压缩');
      expect(host.events[0].text).toContain('「main.ts - 编辑器」');
      expect(host.events[0].origin).toBe('external');
    });

    it('digest：presence_windows 就是「结账」——当场给时间线并重开周期', async () => {
      const { world, host, sensor, tools } = build();
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'digest', minutes: 20 });
      sensor.tick(100, WIN_A);
      await sleep(5); // 段长要 > 0，零长的段会被当脏数据丢掉
      sensor.tick(100, WIN_B);
      await sleep(5);
      const out = await call(tools.presence_windows);
      expect(out.text).toContain('digest（压缩）');
      expect(out.text).toContain('[压缩结账]');
      expect(out.text).toContain('「main.ts - 编辑器」');
      expect(host.events).toEqual([]); // 结账走的是回执，不是事件
    });

    it('digest：离开只投不叫醒、回来当场叫醒，两条都记进摘要', async () => {
      const { world, host, sensor, tools } = build({}, { awayAfterMs: 100 });
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'digest', minutes: 20 });
      sensor.tick(50, WIN_A);
      sensor.tick(200, WIN_A); // 离开
      await sleep(20);
      sensor.tick(50, WIN_A); // 回来
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.away', 'presence.back']);
      expect(host.pushOpts[0]?.trigger).toBe('piggyback'); // 离开不叫醒
      expect(host.pushOpts[1]?.trigger).toBe('flush'); // 回来叫醒
      const out = await call(tools.presence_windows);
      expect(out.text).toContain('离开键盘'); // 那段也进了摘要
    });

    it('digest：周期可临时调，非法值被拒，重复设置不动', async () => {
      const { world, host, tools } = build();
      await world.start(host);
      const bad = await call(tools.presence_set_mode, { mode: 'digest', minutes: 0 });
      expect(bad.failed).toBe(true);
      const ok = await call(tools.presence_set_mode, { mode: 'digest', minutes: 5 });
      expect(ok.text).toContain('5 分钟');
      const same = await call(tools.presence_set_mode, { mode: 'digest', minutes: 5 });
      expect(same.text).toContain('没动');
      const shorter = await call(tools.presence_set_mode, { mode: 'digest', minutes: 2 });
      expect(shorter.text).toContain('2 分钟');
    });

    it('off：窗口变化不投，只报「本次运行第一次见到的程序」一行（不叫醒）', async () => {
      const { world, host, sensor, tools } = build();
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'off' });
      sensor.tick(100, WIN_A); // 打底：收养 chrome
      sensor.tick(100, WIN_B); // code 第一次见 → 报一行
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.switched']);
      expect(host.pushOpts[0]?.trigger).toBe('piggyback');
      expect(host.events[0].text).toContain('第一次见到这个程序');
      sensor.tick(100, WIN_A); // chrome 见过 → 不报
      sensor.tick(100, WIN_C); // wezterm 第一次见 → 再报一行
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.switched', 'presence.switched']);
    });

    it('off：同一个程序换个窗口标题不算「新」', async () => {
      const { world, host, sensor, tools } = build();
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'off' });
      sensor.tick(100, WIN_A); // chrome
      sensor.tick(100, { ...WIN_A, hwnd: 99, title: '另一个标签 - Google Chrome' });
      await sleep(20);
      expect(host.events).toEqual([]);
    });

    it('off：离开只投不叫醒、回来叫醒', async () => {
      const { world, host, sensor, tools } = build({}, { awayAfterMs: 100 });
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'off' });
      sensor.tick(50, WIN_A);
      sensor.tick(200, WIN_A); // 离开
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.away']);
      expect(host.pushOpts[0]?.trigger).toBe('piggyback');
      sensor.tick(50, WIN_A); // 回来
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.away', 'presence.back']);
      expect(host.pushOpts[1]?.trigger).toBe('flush');
    });

    it('「离开」不叫醒是四挡通用——连 call 挡也不叫醒（「回来」照旧）', async () => {
      const { world, host, sensor, tools } = build({}, { awayAfterMs: 100 });
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'call' });
      sensor.tick(50, WIN_A);
      await sleep(5);
      sensor.tick(200, WIN_A); // 离开
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.away']);
      expect(host.pushOpts[0]?.trigger).toBe('piggyback');
      sensor.tick(50, WIN_A); // 回来
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.away', 'presence.back']);
      expect(host.pushOpts[1]?.trigger).toBe('flush');
    });

    it('off：presence_windows 把关闭期间的变化给出来（只留档、不主动投）', async () => {
      const { world, host, sensor, tools } = build();
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'off' });
      sensor.tick(100, WIN_A);
      await sleep(5);
      sensor.tick(100, WIN_B);
      await sleep(5);
      const out = await call(tools.presence_windows);
      expect(out.text).toContain('[关闭期间的变化]');
      expect(out.text).toContain('「main.ts - 编辑器」');
      // 关闭挡下窗口变化本身不投；这一条是「第一次见到的程序」（code）自己冒出来的那一行
      expect(host.events.map((e) => e.type)).toEqual(['presence.switched']);
    });

    it('离开/回来投的是自己的事件名，不再混进 activity 批（顺手修的老毛病）', async () => {
      const { world, host, sensor } = build({}, { awayAfterMs: 100 });
      await world.start(host);
      sensor.tick(50, WIN_A);
      sensor.tick(200, WIN_A); // 离开
      await sleep(20);
      sensor.tick(50, WIN_A); // 回来
      await sleep(20);
      expect(host.events.map((e) => e.type)).toEqual(['presence.away', 'presence.back']);
    });

    it('切挡不丢账：从 digest 切走时把本周期摘要投出', async () => {
      const { world, host, sensor, tools } = build();
      await world.start(host);
      await call(tools.presence_set_mode, { mode: 'digest', minutes: 20 });
      sensor.tick(100, WIN_A);
      await sleep(5);
      sensor.tick(100, WIN_B);
      await sleep(5);
      await call(tools.presence_set_mode, { mode: 'ambient' });
      expect(host.events.map((e) => e.type)).toEqual(['presence.digest']);
      expect(host.pushOpts[0]?.trigger).toBe('piggyback');
    });
  });
});

describe('紧凑摘要与按需时间线', () => {
  const epoch = new Date('2026-10-14T12:00:00Z').getTime();
  const active: PresenceWorld[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
  });
  afterEach(async () => {
    for (const world of active.splice(0)) await world.stop();
    vi.useRealTimers();
  });
  async function setup(cfg: Partial<PresenceConfigSection> = {}) {
    const result = build({}, cfg);
    active.push(result.world);
    await result.world.start(result.host);
    return result;
  }
  const at = (seconds: number) => vi.setSystemTime(epoch + seconds * 1000);
  const idOf = (text: string) => JSON.parse(text.split('时间线：presence_windows ')[1]!).snapshot as string;

  it('同窗口无切换跨两次结账：各算本周期，不重复累计前一周期', async () => {
    const { sensor, tools } = await setup();
    sensor.tick(100, WIN_A);
    at(60);
    const first = await call(tools.presence_windows);
    expect(first.text).toContain('chrome 1 分钟');
    expect(first.text).toContain('观测切换 0 次');
    at(180);
    const second = await call(tools.presence_windows);
    expect(second.text).toContain('chrome 2 分钟');
    expect(second.text).not.toContain('chrome 3 分钟');
    const history = await call(tools.presence_windows, { view: 'timeline', snapshot: idOf(first.text) });
    expect(history.text).toContain('共 1 分钟');
  });

  it('无切换仍周期投摘要；查询历史不列窗口、不清账、不延迟下个周期', async () => {
    const { sensor, tools, host, calls } = await setup();
    await call(tools.presence_set_mode, { mode: 'digest', minutes: 1 });
    sensor.tick(100, WIN_A);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('chrome 1 分钟');
    const id = idOf(host.events[0].text);
    await vi.advanceTimersByTimeAsync(30_000);
    const firstRead = await call(tools.presence_windows, { view: 'timeline', snapshot: id });
    const secondRead = await call(tools.presence_windows, { view: 'timeline', snapshot: id });
    expect(firstRead).toEqual(secondRead);
    expect(calls.listWindows).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.events).toHaveLength(2);
    expect(host.events[1].text).toContain('chrome 1 分钟');
    expect(host.pushOpts.every((opts) => opts?.trigger === 'piggyback')).toBe(true);
  });

  it('非循环序列聚合；零时长切换及同句柄改标题仍计次数，重复采样不计', async () => {
    const { sensor, tools } = await setup();
    sensor.tick(100, WIN_A);
    at(60);
    sensor.tick(100, WIN_B);
    sensor.tick(100, WIN_A); // 同一毫秒内切换，不能用有效段数减一推导次数
    sensor.tick(100, WIN_A);
    at(120);
    sensor.tick(100, { ...WIN_A, title: '新标题' });
    at(180);
    const out = await call(tools.presence_windows);
    expect(out.text).toContain('观测切换 3 次');
    expect(out.text).toContain('应用累计：chrome 3 分钟');
    expect(out.text).toContain('「新标题」(chrome) 1 分钟');
  });

  it('持续离开跨周期，回来后只计新周期部分，前台时长不叠加离开', async () => {
    const { sensor, tools } = await setup({ awayAfterMs: 100 });
    sensor.tick(50, WIN_A);
    at(10);
    sensor.tick(200, WIN_A);
    at(70);
    const first = await call(tools.presence_windows);
    expect(first.text).toContain('离开键盘累计 1 分钟');
    expect(first.text).toContain('chrome 1 分 10 秒');
    at(130);
    const second = await call(tools.presence_windows);
    expect(second.text).toContain('离开键盘累计 1 分钟');
    at(160);
    sensor.tick(50, WIN_A);
    at(190);
    const third = await call(tools.presence_windows);
    expect(third.text).toContain('离开键盘累计 30 秒');
    expect(third.text).toContain('chrome 1 分钟');
    expect(third.text).toContain('未达离开阈值');
  });

  it('未采样与前台未知不会冒充无变化或继续累计旧窗口', async () => {
    const { sensor, tools } = await setup();
    const empty = await call(tools.presence_windows);
    expect(empty.text).toContain('没有可累计的前台窗口采样');
    expect((await call(tools.presence_windows, { view: 'timeline' })).failed).toBe(true);
    sensor.tick(100, WIN_A);
    at(60);
    sensor.tick(100, null);
    at(180);
    const out = await call(tools.presence_windows);
    expect(out.text).toContain('chrome 1 分钟');
    expect(out.text).toContain('最近采样：前台未知');
  });

  it('指定记录分页不混入后续周期，原始顺序与完整标题保留', async () => {
    const { sensor, tools } = await setup();
    const longTitle = '长标题'.repeat(40);
    sensor.tick(100, { ...WIN_A, title: longTitle });
    at(60); sensor.tick(100, WIN_B);
    at(120); sensor.tick(100, WIN_C);
    at(180);
    const out = await call(tools.presence_windows);
    const id = idOf(out.text);
    const page1 = await call(tools.presence_windows, { view: 'timeline', snapshot: id, limit: 2 });
    expect(page1.text).toContain(longTitle);
    expect(page1.text).toContain('"offset":2');
    at(240); await call(tools.presence_windows);
    const page2 = await call(tools.presence_windows, { view: 'timeline', snapshot: id, offset: 2, limit: 2 });
    expect(page2.text).toContain('「终端」(wezterm) 共 1 分钟');
    expect(page2.text).toContain('记录已读完');
    expect(page2.text).not.toContain('main.ts');
  });

  it('仅保留最近 8 份，过期编号明确失败，默认读取最新记录', async () => {
    const { sensor, tools } = await setup();
    sensor.tick(100, WIN_A);
    const ids: string[] = [];
    for (let i = 1; i <= 9; i++) {
      at(i * 60);
      ids.push(idOf((await call(tools.presence_windows)).text));
    }
    expect((await call(tools.presence_windows, { view: 'timeline', snapshot: ids[0] })).failed).toBe(true);
    expect((await call(tools.presence_windows, { view: 'timeline', snapshot: ids[1] })).failed).not.toBe(true);
    expect((await call(tools.presence_windows, { view: 'timeline' })).text).toContain(ids[8]);
  });

  it('超过 400 段如实报告截断，切换计数不随旧段淘汰', async () => {
    const { sensor, tools } = await setup();
    sensor.tick(100, WIN_A);
    for (let i = 1; i <= 450; i++) {
      at(i);
      sensor.tick(100, i % 2 ? WIN_B : WIN_A);
    }
    at(451);
    const out = await call(tools.presence_windows);
    expect(out.text).toContain('观测切换 450 次');
    expect(out.text).toContain('已丢弃 51 段');
    const raw = await call(tools.presence_windows, { view: 'timeline' });
    expect(raw.text).toContain('共 400 段');
    expect(raw.text).toContain('此时间线不完整');
    expect(raw.text).toContain('"offset":40');
  });

  it('off 切挡保存时间线但不外投；故障后已有记录仍可读', async () => {
    const { sensor, tools, host } = await setup();
    await call(tools.presence_set_mode, { mode: 'off' });
    sensor.tick(100, WIN_A);
    at(60);
    await call(tools.presence_set_mode, { mode: 'ambient' });
    expect(host.events).toHaveLength(0);
    sensor.exit({ code: 1 });
    const raw = await call(tools.presence_windows, { view: 'timeline' });
    expect(raw.failed).not.toBe(true);
    expect(raw.text).toContain('共 1 分钟');
  });

  it('非法历史参数拒绝且不触碰当前账本；停止后不留摘要计时器', async () => {
    const { world, sensor, tools, calls } = await setup();
    sensor.tick(100, WIN_A);
    for (const args of [
      { view: 'bad' }, { offset: 1 }, { view: 'timeline', snapshot: '' },
      { view: 'timeline', offset: -1 }, { view: 'timeline', offset: 1.5 },
      { view: 'timeline', limit: 101 }, { view: 'timeline', limit: 0 },
      { view: 'timeline', offset: null }, { view: 'timeline', limit: null },
    ]) expect((await call(tools.presence_windows, args)).failed).toBe(true);
    expect(calls.listWindows).toBe(0);
    at(60);
    expect((await call(tools.presence_windows)).text).toContain('chrome 1 分钟');
    expect((await call(tools.presence_windows, { view: 'timeline', offset: 2 })).failed).toBe(true);
    await world.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

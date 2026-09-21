import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import type { ScreenshotResult, ScreenshotTarget, WindowInfo } from '../src/capture.ts';
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
  calls: { listWindows: number; captures: ScreenshotTarget[] };
}

function build(
  overrides: Partial<PresenceWorldOptions> = {},
  cfgPatch: Partial<PresenceConfigSection> = {},
): Build {
  const sensor = new FakeSensor();
  const calls = { listWindows: 0, captures: [] as ScreenshotTarget[] };
  const windows: WindowInfo[] = [
    { ...WIN_B, foreground: true, minimized: false },
    { ...WIN_A, foreground: false, minimized: true },
  ];
  const world = new PresenceWorld({
    cfg: { ...PRESENCE_DEFAULTS, ...cfgPatch },
    timezone: 'Asia/Shanghai',
    spawnSensor: () => sensor,
    listWindows: async () => {
      calls.listWindows += 1;
      return windows;
    },
    capture: async (target) => {
      calls.captures.push(target);
      const result: ScreenshotResult = {
        bytes: pngBytes(),
        format: 'png',
        width: 800,
        height: 600,
        via: 'printwindow',
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

  it('ambient（默认）下窗口变化攒着，stop 时合成一条 piggyback 投出', async () => {
    const { world, host, sensor } = build();
    await world.start(host);
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
    const { world, host, sensor } = build({ ambientFlushMs: 50 });
    await world.start(host);
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
    sensor.tick(5000, WIN_A);
    sensor.tick(5000, WIN_B); // 一条变化，攒着
    const out = await call(tools.presence_windows);
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('「main.ts - 编辑器」(code) ← 前台');
    expect(out.text).toContain('「知乎 - Google Chrome」(chrome) （最小化）');
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
        via: 'screen' as const,
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
    const second = await call(tools.presence_screenshot, {});
    expect(second.text).toContain('第 2 张');
    expect(second.text).toContain('presence_windows');
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
    const out = await call(tools.presence_set_mode, { mode: 'ambient' });
    expect(out.text).toContain('没动');
    expect(host.events).toEqual([]);
  });

  it('stop 把传感器停掉，把攒的按不叫醒投出', async () => {
    const { world, host, sensor } = build();
    await world.start(host);
    sensor.tick(100, WIN_A);
    sensor.tick(100, WIN_B);
    await world.stop();
    expect(sensor.stopped).toBe(true);
    expect(host.events.map((e) => e.type)).toEqual(['presence.activity']);
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
  });
});

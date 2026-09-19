import { describe, expect, it } from 'vitest';
import { spawnSensor, type SensorTick } from '../src/sensor.ts';

/** 真 PowerShell 的集成用例只在 Windows 桌面会话里有意义。 */
const maybe = process.platform === 'win32' ? describe : describe.skip;

maybe('传感器（真 PowerShell）', () => {
  it('几秒内吐出带形状的 tick，stop 后干净退出', async () => {
    const sensor = spawnSensor(1000);
    const tick = await new Promise<SensorTick>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('10 秒没吐出 tick')), 10000);
      sensor.onTick((t) => {
        clearTimeout(timer);
        resolve(t);
      });
      sensor.onExit((info) => {
        clearTimeout(timer);
        reject(new Error(`传感器提前退出了：code=${info.code} ${info.stderrTail}`));
      });
    });
    expect(tick.type).toBe('tick');
    expect(typeof tick.idleMs).toBe('number');
    expect(tick.idleMs).toBeGreaterThanOrEqual(0);
    // 测试进程多半有桌面会话，前台窗口应当拿得到；拿不到也不算错（锁屏时就是 null）。
    if (tick.cur) {
      expect(typeof tick.cur.hwnd).toBe('number');
      expect(tick.cur.hwnd).toBeGreaterThan(0);
    }
    sensor.stop();
  }, 20000);
});

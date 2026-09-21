/**
 * 冒烟：对真桌面走一遍三条路——传感器吐行、列窗口、真截一张图。
 * 不需要部署在跑，只验证这台机器的 PowerShell 链路通。
 *
 *   pnpm smoke
 */
import { writeFileSync } from 'node:fs';
import { spawnSensor, type SensorTick } from '../src/sensor.ts';
import { captureScreenshot, listWindows } from '../src/capture.ts';

const OBSERVE_MS = 6000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  console.log(`[1/3] 传感器：采样 ${OBSERVE_MS / 1000} 秒……`);
  const sensor = spawnSensor(1000);
  const ticks: SensorTick[] = [];
  sensor.onTick((t) => ticks.push(t));
  sensor.onExit((info) => {
    if (ticks.length === 0) {
      console.error(`传感器提前退出：code=${info.code} ${info.stderrTail}`);
      process.exitCode = 1;
    }
  });
  await sleep(OBSERVE_MS);
  sensor.stop();
  const last = ticks[ticks.length - 1];
  if (!last) throw new Error('没采到任何 tick');
  console.log(
    `  采到 ${ticks.length} 轮。前台：${last.cur ? `「${last.cur.title}」(${last.cur.exe})` : '(无)'}，键鼠空闲 ${(last.idleMs / 1000).toFixed(1)} 秒。`,
  );

  console.log('[2/3] 列窗口……');
  const windows = await listWindows();
  console.log(`  可见窗口 ${windows.length} 个，前台：${windows.find((w) => w.foreground)?.title ?? '(无)'}`);
  for (const w of windows.slice(0, 5)) {
    console.log(`    - 「${w.title}」(${w.exe})${w.minimized ? '（最小化）' : ''}`);
  }
  if (windows.length > 5) console.log(`    …还有 ${windows.length - 5} 个`);

  console.log('[3/3] 截一张全屏……');
  const shot = await captureScreenshot({ target: 'full' });
  const ext = shot.format === 'jpeg' ? 'jpg' : 'png';
  const file = new URL(`../presence-smoke.${ext}`, import.meta.url);
  writeFileSync(file, shot.bytes);
  const pngNote = shot.format === 'jpeg' ? `（PNG 本会是更大的体积，已按照片类画面压成 JPEG）` : '';
  console.log(
    `  ${shot.width}x${shot.height}，${shot.format.toUpperCase()} ${(shot.bytes.length / 1024).toFixed(0)} KiB${pngNote}，落在 ${file.pathname.replace(/^\/(\w:)/, '$1')}`,
  );

  console.log('SMOKE PASS');
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});

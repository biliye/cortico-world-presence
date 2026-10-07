/**
 * 冒烟：对真桌面走一遍三条路——传感器吐行、列窗口、真截一张图。
 * 不需要部署在跑，只验证这台机器的 PowerShell 链路通。
 *
 *   pnpm smoke
 */
import { writeFileSync } from 'node:fs';
import { spawnSensor, type SensorTick } from '../src/sensor.ts';
import { captureScreenshot, describeShotCursor, listWindows } from '../src/capture.ts';

const OBSERVE_MS = 6000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const showPath = (u: URL) => u.pathname.replace(/^\/(\w:)/, '$1');

async function main(): Promise<void> {
  console.log(`[1/5] 传感器：采样 ${OBSERVE_MS / 1000} 秒……`);
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

  console.log('[2/5] 列窗口 + 屏幕几何……');
  const listed = await listWindows();
  const fg = listed.windows.find((w) => w.foreground);
  console.log(
    `  虚拟屏 x=${listed.screen.x} y=${listed.screen.y} ${listed.screen.width}x${listed.screen.height}，` +
      `${listed.screen.monitors.length} 台显示器；可见窗口 ${listed.windows.length} 个，前台：${fg?.title ?? '(无)'}`,
  );
  for (const w of listed.windows.slice(0, 5)) {
    const rect = w.minimized ? '（最小化，无位置）' : `x=${w.bounds.x} y=${w.bounds.y} ${w.bounds.width}x${w.bounds.height}`;
    console.log(`    - 「${w.title}」(${w.exe}) ${rect}`);
  }
  if (listed.windows.length > 5) console.log(`    …还有 ${listed.windows.length - 5} 个`);

  console.log('[3/5] 截一张全屏（顺带看光标在不在图上）……');
  const shot = await captureScreenshot({ target: 'full' });
  const ext = shot.format === 'jpeg' ? 'jpg' : 'png';
  const file = new URL(`../presence-smoke.${ext}`, import.meta.url);
  writeFileSync(file, shot.bytes);
  const pngNote = shot.format === 'jpeg' ? `（PNG 本会是更大的体积，已按照片类画面压成 JPEG）` : '';
  console.log(
    `  ${shot.width}x${shot.height}，${shot.format.toUpperCase()} ${(shot.bytes.length / 1024).toFixed(0)} KiB${pngNote}，落在 ${showPath(file)}`,
  );
  // 回执里那一句「鼠标在哪儿、有没有画进图」——被压过的大图上箭头会跟着缩小。
  console.log(`  ${describeShotCursor(shot)}`);

  // 「盯一块看变化」的实际成本：框一小块反复截，每次就是这么点字节。
  console.log('[4/5] 截一小块区域（前台窗口左上角 480x180，通常带标题/工具条的小字）……');
  const baseX = fg && !fg.minimized && fg.bounds.width > 480 ? fg.bounds.x : listed.screen.x;
  const baseY = fg && !fg.minimized && fg.bounds.height > 180 ? fg.bounds.y : listed.screen.y;
  const region = await captureScreenshot({
    target: 'region',
    region: { x: baseX, y: baseY, width: 480, height: 180 },
  });
  const regionFile = new URL('../presence-smoke-region.png', import.meta.url);
  writeFileSync(regionFile, region.bytes);
  const ratio = region.bytes.length / (shot.bytes.length || 1);
  console.log(
    `  框 x=${region.captured.x} y=${region.captured.y} ${region.captured.width}x${region.captured.height}，` +
      `${region.width}x${region.height} ${region.format.toUpperCase()} ${(region.bytes.length / 1024).toFixed(0)} KiB，` +
      `降采样=${region.downscaled ? '是' : '否'}，只有全屏那张的 ${(ratio * 100).toFixed(1)}%。`,
  );

  // 光标周围那一小块，1:1（小框不走降采样，所以箭头是它本来的样子）。
  //
  // 这一步存在的理由:**「箭头到底画上没有」只有看一眼才算验过**。像素级的自动判据在这里都不便宜
  // ——系统光标的形状随主题变(箭头/I 形/沙漏)，写死一个像素模板就是在给以后埋一条假红。
  // 所以它把这张图落盘，让人一眼就能核；回执里那一句也一起打出来。
  console.log('[5/5] 围着光标裁一块（1:1）——图上的箭头对不对，看这张……');
  const cx = shot.cursor.x ?? Math.round(listed.screen.x + listed.screen.width / 2);
  const cy = shot.cursor.y ?? Math.round(listed.screen.y + listed.screen.height / 2);
  const around = await captureScreenshot({
    target: 'region',
    region: { x: cx - 120, y: cy - 80, width: 240, height: 160 },
  });
  const aroundFile = new URL('../presence-smoke-cursor.png', import.meta.url);
  writeFileSync(aroundFile, around.bytes);
  console.log(
    `  框 x=${around.captured.x} y=${around.captured.y} ${around.captured.width}x${around.captured.height}，` +
      `落在 ${showPath(aroundFile)}`,
  );
  console.log(`  ${describeShotCursor(around)}`);

  console.log('SMOKE PASS');
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});

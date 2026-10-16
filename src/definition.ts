import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { PRESENCE_DEFAULTS, type PresenceConfigSection } from './config.ts';
import { PRESENCE_TOOL_DECLS, PresenceWorld } from './world.ts';

const execFileP = promisify(execFile);

export const PRESENCE: WorldDefinition<PresenceConfigSection> = {
  id: 'presence',
  label: 'Presence',
  defaults: () => ({ ...PRESENCE_DEFAULTS }),

  /**
   * 激活前检查环境。presence 只在 Windows 桌面会话里有意义：传感器与截图走的都是
   * Win32（GetForegroundWindow / CopyFromScreen），别的平台没有这条路；PowerShell
   * 是它的全部依赖，装不装得上不猜，现场跑一次版本号。
   *
   * 注意：进程启动时挂载 World 不走 preflight（hearing 查实过的框架行为），
   * start() 里传感器起不来还会如实投 presence.down，这里不是唯一的防线。
   */
  preflight: async () => {
    if (process.platform !== 'win32') {
      throw new Error('presence 只支持 Windows（传感器与截图都走 Win32）。');
    }
    try {
      await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
        timeout: 15000,
        windowsHide: true,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`powershell.exe 跑不起来（${reason}）。presence 的传感器与截图都靠它。`);
    }
  },

  // `ctx.cfg` 是 `worlds.presence` 的活引用：热改的键（awayAfterMs）现读即生效。
  create: (ctx) => new PresenceWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),

  describe: {
    tools: describeTools(PRESENCE_TOOL_DECLS, {
      presence_windows: {
        zh: '看窗口清单与在场状态；timeline 翻阅已结账的逐段记录，在压缩挡下还顺手结一次账。',
        en: 'Lists windows with foreground/idle state; view=timeline reads settled per-segment records and settles the digest period.',
      },
      presence_screenshot: {
        zh: '截一张图（区域优先，其次窗口，再按 target）；量坐标时用 grid，想少干扰就 cursor:false。',
        en: 'Captures a screenshot (region > hwnd > target); grid overlays desktop coordinates, cursor:false drops the cursor overlay.',
      },
      presence_set_mode: {
        zh: '改投递姿势：digest 周期摘要／ambient 攒批／call 变化就叫醒／off 只留档，分钟数可现改。',
        en: 'Sets the delivery mode and, for digest, its period in minutes.',
      },
    }),
    events: [
      { type: 'presence.down', description: { zh: '眼睛坏了：传感器起不来或中途退出，她需要知道现在看不见桌面。', en: 'The sensor failed to start or died; the desktop is no longer being watched.' } },
      { type: 'presence.away', description: { zh: '他离开电脑前了（只投、不叫醒；时长从最后一次键鼠输入算）。', en: 'He stepped away from the machine; delivered without waking, timed from the last input.' } },
      { type: 'presence.back', description: { zh: '他回来了（离开够久才叫醒，门槛是 backWakeAfterMs）。', en: 'He came back; wakes only when the absence passed backWakeAfterMs.' } },
      { type: 'presence.switched', description: { zh: '前台窗口换了一个，或本次运行第一次见到某个程序。', en: 'The foreground window changed, or a program was seen for the first time this run.' } },
      { type: 'presence.digest', description: { zh: '压缩挡到点结账：这一周期的窗口停留与切换折成一份摘要，不叫醒。', en: 'One digest period settled into a compact summary; does not wake.' } },
      { type: 'presence.activity', description: { zh: '多条变化攒在一起合成的一条（环境批或 call 挡的合并批）。', en: 'Several changes coalesced into one line (ambient batch or the call-mode coalescing window).' } },
    ],
  },
};

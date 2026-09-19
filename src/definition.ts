import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorldDefinition } from 'cortico/world.ts';
import { PRESENCE_DEFAULTS, type PresenceConfigSection } from './config.ts';
import { PresenceWorld } from './world.ts';

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
};

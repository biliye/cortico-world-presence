/**
 * Presence World：给 bot 「在场感」——前台窗口变化、离开/回来键盘，加上按需的
 * 窗口清单（presence_windows）与截图（presence_screenshot）。
 *
 * 投递姿势握在 bot 手里，是运行态、**不写回配置**（hearing 同款约定）：
 * - ambient（默认）：变化攒成批，随她下次开口一起进上下文，不叫醒她；
 * - call：变化当场投、叫醒她，3 秒内的连续变化并成一条，免得一次 alt-tab 双响。
 *
 * 有意不做的事：不监视键盘/剪贴板内容（只有空闲时长，永远没有内容）；不做定时截图
 * （开发者定的：截图只在她主动要时发生）；不做应用黑名单（开发者 2026-09-19 知情拍板
 * 「不加旋钮」——窗口标题与截图会随模型调用发到部署配置的模型端点）。
 */
import type {
  Logger,
  ToolCallContext,
  ToolDef,
  ToolOutcome,
  TriggerMode,
  World,
  WorldConsoleDecl,
  WorldHost,
  WorldLamp,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { fileURLToPath } from 'node:url';
import {
  captureScreenshot,
  listWindows,
  type ScreenshotResult,
  type ScreenshotTarget,
  type WindowInfo,
} from './capture.ts';
import { PRESENCE_CONFIG_GROUP, type PresenceConfigSection } from './config.ts';
import { spawnSensor, type PresenceSensor, type SensorTick, type SensorWindow } from './sensor.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** ambient 攒批的字数上限，到就合成一条投出。hearing 用实测的 1200，这里同款，是常量不是配置。 */
const AMBIENT_FLUSH_CHARS = 1200;
/** ambient 攒批的时限：从第一批算起超过就投。 */
const AMBIENT_FLUSH_MS = 180_000;
/** call 模式下窗口变化的合并窗口：3 秒内的连续变化并成一条再叫醒。 */
const CALL_COALESCE_MS = 3000;
/** pollIntervalMs 的下限：再密就是拿 token 换分辨率，且 PowerShell 起一轮也有成本。 */
const MIN_POLL_MS = 2000;
/** 窗口清单回执最多列多少行，剩下的报个数。 */
const WINDOW_RECEIPT_CAP = 40;
/** 截图一次性进程的超时。 */
const CAPTURE_TIMEOUT_MS = 20000;

export interface PresenceWorldOptions {
  /** `worlds.presence` 的活引用：热改的键（awayAfterMs）现读即生效。 */
  cfg: PresenceConfigSection;
  timezone: string;
  /** 测试用：换掉传感器。缺省拉 PowerShell。 */
  spawnSensor?: (pollIntervalMs: number) => PresenceSensor;
  /** 测试用：换掉列窗口。 */
  listWindows?: () => Promise<WindowInfo[]>;
  /** 测试用：换掉截图。 */
  capture?: (target: ScreenshotTarget) => Promise<ScreenshotResult>;
  /** 测试用：调小 ambient 攒批的字数上限。 */
  ambientFlushChars?: number;
  /** 测试用：调小 ambient 攒批的时限（毫秒）。 */
  ambientFlushMs?: number;
  /** 测试用：调小 call 模式的合并窗口（毫秒）。 */
  callCoalesceMs?: number;
}

type Delivery = 'ambient' | 'call';

export class PresenceWorld implements World {
  readonly id = 'presence';

  private host: WorldHost | null = null;
  private sensor: PresenceSensor | null = null;
  private state: 'idle' | 'starting' | 'watching' | 'failed' = 'idle';
  private lastError = '';
  private delivery: Delivery = 'ambient';
  /** 最近一次采样的前台窗口；null 表示还没见过（或桌面没有前台）。 */
  private current: SensorWindow | null = null;
  private currentSinceMs = 0;
  /** 最近一次采样的键鼠空闲毫秒；-1 表示还没采到。 */
  private idleMs = -1;
  private away = false;
  private awaySinceMs = 0;
  private switchCount = 0;
  /** call 模式下等合并的变化行。 */
  private pendingSwitchLines: string[] = [];
  private switchTimer: ReturnType<typeof setTimeout> | null = null;
  /** ambient 攒批。 */
  private ambientLines: string[] = [];
  private ambientChars = 0;
  private ambientOldestAt = 0;
  /**
   * ambient 攒批的定时器。hearing 的环境音是连续流，攒满自然会投；presence 的变化稀疏，
   * 只靠「下一条到来时检查」会让一条孤立的变化永远压在内存里投不出去——所以从第一批
   * 算起，到时限就投，不等下一条。
   */
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  /** 她上次用 presence_windows 看是什么时候，变化段的「距你上次看」从这里算。 */
  private lastPeekAt = 0;

  constructor(private readonly opts: PresenceWorldOptions) {}

  /** 环境提示词没有占位符；返回空对象即保留模板全文。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [this.windowsTool(), this.screenshotTool(), this.setModeTool()];
  }

  console(): WorldConsoleDecl {
    return {
      lamps: [this.lamp()],
      badges: [
        { label: '姿势', value: this.delivery === 'call' ? '即投' : '攒批', tone: 'plain' as const },
        { label: '前台', value: this.current ? ellipsis(this.current.title) || this.current.exe || '—' : '—', tone: 'plain' as const },
        { label: '空闲', value: this.idleMs < 0 ? '—' : fmtDuration(this.idleMs), tone: 'plain' as const },
        { label: '已记录变化', value: `${this.switchCount} 次`, tone: 'plain' as const },
        { label: '攒着没投', value: `${this.ambientLines.length + this.pendingSwitchLines.length} 条`, tone: 'plain' as const },
      ],
      config: [PRESENCE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.presence.envPrompt',
          title: 'Presence · 环境提示词',
          description: '在场感这一段进 system 前缀的说明；留空则该 World 不进入前缀。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  /** 起传感器。**不抛错**：起不来投一条 presence.down 停在 failed，bot 知道「眼睛现在不行了」。 */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const log = host.log.child(this.id);
    try {
      this.state = 'starting';
      const pollMs = Math.max(MIN_POLL_MS, this.opts.cfg.pollIntervalMs);
      if (pollMs !== this.opts.cfg.pollIntervalMs) {
        log.warn('pollIntervalMs 低于下限，已拉回', { requested: this.opts.cfg.pollIntervalMs, effective: pollMs });
      }
      const sensor = this.opts.spawnSensor
        ? this.opts.spawnSensor(pollMs)
        : spawnSensor(pollMs);
      this.sensor = sensor;
      sensor.onTick((tick) => this.onTick(tick, log));
      sensor.onExit((info) => {
        if (this.sensor !== sensor) return; // 是我们自己停的
        this.onSensorDown(
          `传感器进程退出了（code=${info.code ?? '-'} signal=${info.signal ?? '-'}）${info.stderrTail ? `：${lastLine(info.stderrTail)}` : ''}`,
          log,
        );
      });
      this.state = 'watching';
      this.lastError = '';
      log.info('开始看桌面', { pollIntervalMs: pollMs });
    } catch (err) {
      this.state = 'failed';
      this.lastError = describe(err);
      log.error('启动 Presence 时出错', err);
      await this.emit('presence.down', `没开始看：${this.lastError}。确认 powershell.exe 可用后重启本 World。`);
    }
  }

  async stop(): Promise<void> {
    const sensor = this.sensor;
    this.sensor = null;
    sensor?.stop();
    this.clearSwitchTimer();
    // call 模式攒着的合并行并进 ambient 批一起投，不丢账。
    this.ambientLines.push(...this.pendingSwitchLines);
    this.pendingSwitchLines = [];
    await this.flushAmbient('piggyback');
    this.state = 'idle';
    this.current = null;
    this.idleMs = -1;
    this.away = false;
    this.host = null;
  }

  // ——— 采样 → 语义 ———

  private onTick(tick: SensorTick, log: Logger): void {
    if (this.state !== 'watching') return;
    const now = Date.now();
    this.idleMs = tick.idleMs;

    // 「在不在」：空闲过阈值 = 离开；恢复输入 = 回来。
    const threshold = Math.max(0, this.opts.cfg.awayAfterMs);
    if (!this.away && tick.idleMs >= threshold) {
      this.away = true;
      this.awaySinceMs = now;
      this.deliver(`[${clock(now)}] 离开键盘`, log);
    } else if (this.away && tick.idleMs < threshold) {
      this.away = false;
      this.deliver(`[${clock(now)}] 回到键盘，离开了 ${fmtDuration(now - this.awaySinceMs)}`, log);
    }

    // 前台窗口变化：与上次采样对比。第一回只打底（current 为空时收养，不报事件），
    // 重启后的第一眼不该算「他切了窗口」（browser World 同款）。
    const cur = tick.cur;
    if (!cur) return;
    const prev = this.current;
    if (prev && sameWindow(cur, prev)) return;
    const dwellMs = prev ? now - this.currentSinceMs : 0;
    this.current = cur;
    this.currentSinceMs = now;
    if (prev) {
      this.switchCount += 1;
      this.deliver(renderSwitch(cur, prev, dwellMs, now), log);
    }
  }

  private onSensorDown(message: string, log: Logger): void {
    this.sensor = null;
    this.state = 'failed';
    this.lastError = message;
    log.warn(message);
    void this.emit('presence.down', `不再看了：${message}。重启本 World 可以重开。`);
  }

  // ——— 投递 ———

  /** 一条变化按当前姿势走：call 进合并窗，ambient 进攒批。 */
  private deliver(text: string, _log: Logger): void {
    if (this.delivery === 'call') {
      this.pendingSwitchLines.push(text);
      if (!this.switchTimer) {
        this.switchTimer = setTimeout(() => {
          this.switchTimer = null;
          void this.flushCallSwitches();
        }, this.opts.callCoalesceMs ?? CALL_COALESCE_MS);
      }
      return;
    }
    this.bufferAmbient(text);
    this.flushAmbientIfFull();
  }

  private async flushCallSwitches(): Promise<void> {
    const lines = this.pendingSwitchLines;
    this.pendingSwitchLines = [];
    if (lines.length === 0) return;
    const type = lines.length === 1 ? 'presence.switched' : 'presence.activity';
    await this.emit(type, lines.join('\n'), 'flush');
  }

  private bufferAmbient(text: string): void {
    if (this.ambientLines.length === 0) {
      this.ambientOldestAt = Date.now();
      // 从第一批算起，到时限就投——变化稀疏时不能等下一条。
      this.ambientTimer = setTimeout(() => {
        this.ambientTimer = null;
        void this.flushAmbient('piggyback');
      }, this.opts.ambientFlushMs ?? AMBIENT_FLUSH_MS);
    }
    this.ambientLines.push(text);
    this.ambientChars += text.length;
  }

  private flushAmbientIfFull(): void {
    if (this.ambientLines.length === 0) return;
    const chars = this.opts.ambientFlushChars ?? AMBIENT_FLUSH_CHARS;
    const windowMs = this.opts.ambientFlushMs ?? AMBIENT_FLUSH_MS;
    if (this.ambientChars >= chars || Date.now() - this.ambientOldestAt >= windowMs) {
      void this.flushAmbient('piggyback');
    }
  }

  /** 把攒的变化合成一条投出去。空了就不投。返回投出去的条数。 */
  private async flushAmbient(trigger: TriggerMode): Promise<number> {
    if (this.ambientTimer) {
      clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
    }
    const lines = this.ambientLines;
    if (lines.length === 0) return 0;
    const oldestAt = this.ambientOldestAt || Date.now();
    this.ambientLines = [];
    this.ambientChars = 0;
    this.ambientOldestAt = 0;
    const span = fmtDuration(Date.now() - oldestAt);
    await this.emit('presence.activity', `[环境·合并 ${lines.length} 条，跨度 ${span}]\n${lines.join('\n')}`, trigger);
    return lines.length;
  }

  private clearSwitchTimer(): void {
    if (this.switchTimer) {
      clearTimeout(this.switchTimer);
      this.switchTimer = null;
    }
    if (this.ambientTimer) {
      clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
    }
  }

  // ——— 工具 ———

  private windowsTool(): ToolDef {
    return {
      name: 'presence_windows',
      description:
        'See what is on the screen right now: which window is in the foreground, keyboard/mouse idle time, ' +
        'and the list of visible windows. Also delivers anything that accumulated since you last looked. ' +
        'Use presence_screenshot when you need pixels instead of text.',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext) => this.renderWindows(),
    };
  }

  private async renderWindows(): Promise<ToolOutcome | string> {
    if (this.state !== 'watching') {
      return fail(`现在没在看着桌面${this.lastError ? `：${this.lastError}` : ''}。重启本 World 可以重开。`);
    }
    let windows: WindowInfo[];
    try {
      windows = this.opts.listWindows ? await this.opts.listWindows() : await listWindows();
    } catch (err) {
      return fail(`列不出窗口：${describe(err)}`);
    }

    const now = Date.now();
    const idleText = this.idleMs < 0 ? '—' : fmtDuration(this.idleMs);
    const lines: string[] = [
      `前台：「${this.current?.title || '（无前台窗口）'}」${this.current?.exe ? `(${this.current.exe})` : ''}`,
      `键鼠空闲：${idleText}（按最近一次轮询）`,
      `投递姿势：${this.delivery === 'call' ? 'call（即投，叫醒我）' : 'ambient（攒批，不叫醒我）'}`,
      `可见窗口 ${windows.length} 个：`,
      ...windows.slice(0, WINDOW_RECEIPT_CAP).map((w) => {
        const marks = [w.foreground ? '← 前台' : '', w.minimized ? '（最小化）' : ''].filter(Boolean).join(' ');
        return `- 「${w.title}」(${w.exe})${marks ? ` ${marks}` : ''}`;
      }),
    ];
    if (windows.length > WINDOW_RECEIPT_CAP) lines.push(`（还有 ${windows.length - WINDOW_RECEIPT_CAP} 个没列）`);

    // 她开口看了，攒的当场给：call 攒的合并行 + ambient 批。
    this.clearSwitchTimer();
    const pending = [...this.ambientLines, ...this.pendingSwitchLines];
    this.ambientLines = [];
    this.ambientChars = 0;
    this.ambientOldestAt = 0;
    this.pendingSwitchLines = [];
    const sinceMs = this.lastPeekAt === 0 ? 0 : now - this.lastPeekAt;
    this.lastPeekAt = now;
    if (pending.length > 0) {
      lines.push(`[变化] 距你上次看${sinceMs > 0 ? `约 ${fmtDuration(sinceMs)}` : '（这是第一次看）'}：`, ...pending);
    } else {
      lines.push(`[变化] 距你上次看${sinceMs > 0 ? `约 ${fmtDuration(sinceMs)}` : ''}：没有。`);
    }
    return lines.join('\n');
  }

  private screenshotTool(): ToolDef {
    return {
      name: 'presence_screenshot',
      description:
        'Take a screenshot and attach it as an image. target: "full" (all monitors stitched, default), ' +
        '"foreground" (active window only), or pass a hwnd from presence_windows to capture that window. ' +
        'Only call this when you actually want to look; screenshots go out with the model request.',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: {
            type: 'string',
            enum: ['full', 'foreground'],
            description: 'full = 全部显示器拼一张（默认）；foreground = 只截当前前台窗口。',
          },
          hwnd: {
            type: 'integer',
            description: 'presence_windows 列出的窗口句柄；给了就截这个窗口，忽略 target。',
          },
        },
      },
      handler: (args) => this.takeScreenshot(args),
    };
  }

  private async takeScreenshot(args: Record<string, unknown>): Promise<ToolOutcome> {
    const target: ScreenshotTarget =
      typeof args.hwnd === 'number' && Number.isFinite(args.hwnd) && args.hwnd > 0
        ? { target: 'window', hwnd: args.hwnd }
        : args.target === 'foreground'
          ? { target: 'foreground' }
          : { target: 'full' };

    let result: ScreenshotResult;
    try {
      const capture = this.opts.capture ?? ((t: ScreenshotTarget) => captureScreenshot(t, CAPTURE_TIMEOUT_MS));
      result = await capture(target);
    } catch (err) {
      return fail(`截不了：${describe(err)}`);
    }

    const what =
      target.target === 'full'
        ? '全屏（所有显示器）'
        : `窗口「${result.title || (target.target === 'foreground' ? '前台' : String(target.hwnd))}」`;
    const viaText = result.via === 'printwindow' ? '画面来自窗口自己绘的帧' : '画面来自抓屏（被遮挡时会叠着别的窗口）';
    const fallbackText = `[截图：${what} ${result.width}x${result.height}]`;

    // 模型吃不吃图由宿主的 modelFacts 说了算；不吃就把话说破，别让她以为看见了。
    let text = `已截${what}：${result.width}x${result.height}，${viaText}。画面附在本回执里。`;
    if (this.host && !this.host.modelFacts.accepts('image/png')) {
      text += '当前模型配置不吃图，你只能看到这行文字说明，看不到画面本身。';
    }
    return {
      text,
      blobs: [
        {
          bytes: result.png,
          mime: 'image/png',
          name: `presence-${Date.now()}.png`,
          fallbackText,
        },
      ],
    };
  }

  private setModeTool(): ToolDef {
    return {
      name: 'presence_set_mode',
      description:
        'Choose how screen activity reaches you. "ambient": changes accumulate into merged batches that queue ' +
        'without waking you (default). "call": every change is delivered immediately and wakes you, with changes ' +
        'within 3 seconds merged. Runtime-only: restarting this World goes back to "ambient".',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: ['call', 'ambient'],
            description: 'call = 即投（叫醒我）；ambient = 攒批（不叫醒我）。',
          },
        },
        required: ['mode'],
      },
      handler: (args) => this.setMode(args),
    };
  }

  private async setMode(args: Record<string, unknown>): Promise<ToolOutcome> {
    const mode = args.mode;
    if (mode !== 'call' && mode !== 'ambient') {
      return fail(`mode 只能是 call 或 ambient，收到的是 ${JSON.stringify(mode ?? null)}。`);
    }
    if (mode === this.delivery) {
      return { text: mode === 'call' ? '本来就在 call（即投）姿势，没动。' : '本来就在 ambient（攒批）姿势，没动。' };
    }
    this.clearSwitchTimer();
    this.delivery = mode;
    if (mode === 'call') {
      // 攒的全投出去再切，顺序才不会倒。
      this.ambientLines.push(...this.pendingSwitchLines);
      this.pendingSwitchLines = [];
      const n = await this.flushAmbient('flush');
      return {
        text:
          '已切到 call：窗口变化当场投、会叫醒你，3 秒内的连续变化并成一条。' +
          (n > 0 ? `ambient 攒下的 ${n} 条已一并立即投出。` : ''),
      };
    }
    this.ambientLines.push(...this.pendingSwitchLines);
    this.pendingSwitchLines = [];
    return {
      text:
        '已切到 ambient：变化照样记，但攒成批合并投出、不叫醒你——等你下次开口时一起到。' +
        '想看现在就调 presence_windows，攒的会当场给。',
    };
  }

  // ——— 事件与状态 ———

  private lamp(): WorldLamp {
    switch (this.state) {
      case 'watching':
        return { label: '传感器', state: 'online', hint: `每 ${Math.round(Math.max(2000, this.opts.cfg.pollIntervalMs) / 1000)} 秒看一次前台` };
      case 'starting':
        return { label: '传感器', state: 'loading', hint: '正在拉起 PowerShell' };
      case 'failed':
        return { label: '传感器', state: 'error', hint: this.lastError || '传感器不可用' };
      default:
        return { label: '传感器', state: 'offline', hint: this.lastError || '没有在看' };
    }
  }

  private async emit(type: string, text: string, trigger?: TriggerMode): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent(
        {
          type,
          ts: nowIso(this.opts.timezone),
          source: this.id,
          // 桌面上发生的事来自外部世界；传感器起停是内部机制。
          origin: type === 'presence.down' ? 'internal' : 'external',
          senderKey: this.id,
          text,
        },
        trigger ? { trigger } : undefined,
      );
    } catch {
      // 投递失败不该把 World 自己带崩
    }
  }
}

// ——— 模块级小工具 ———

/** 事件正文。只说可确认的事实：谁切到谁、上一个停了多久。判断留给 bot。 */
function renderSwitch(cur: SensorWindow, prev: SensorWindow | null, dwellMs: number, now: number): string {
  const parts = [`[${clock(now)}] 前台 → 「${cur.title}」${cur.exe ? `(${cur.exe})` : ''}`];
  if (prev) {
    parts.push(`上一个「${prev.title}」${prev.exe ? `(${prev.exe})` : ''} 停留 ${fmtDuration(dwellMs)}`);
  } else {
    parts.push('之前没有前台窗口');
  }
  return parts.join('，');
}

function sameWindow(a: SensorWindow | null, b: SensorWindow | null): boolean {
  if (!a || !b) return false;
  return a.hwnd === b.hwnd && a.title === b.title;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '不到 1 秒';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

function clock(now: number): string {
  return new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ellipsis(text: string, max = 24): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(text: string): ToolOutcome {
  return { text, failed: true };
}

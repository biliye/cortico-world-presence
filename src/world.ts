/**
 * Presence World：给 bot 「在场感」——前台窗口变化、离开/回来键盘，加上按需的
 * 窗口清单（presence_windows）与截图（presence_screenshot）。
 *
 * 投递姿势握在 bot 手里，是运行态、**不写回配置**（hearing 同款约定）。四挡（2026-10-13 加的后两挡、
 * 并把默认从 ambient 换成 digest——开发者当天定的）：
 * - digest（压缩，**默认**）：窗口变化只进账本、**不单独投**，到周期（默认 20 分钟）折成一份时间线
 *   摘要投出——「同一批里重复的折成一条、只留在哪几个窗口之间来回」。回来（back）照旧当场叫醒，
 *   同时也记进摘要那一段；**离开（away）只投、不叫醒**（见下）；
 * - ambient：窗口变化攒成批，随她下次开口一起进上下文，不叫醒她；
 * - call：变化当场投、叫醒她，3 秒内的连续变化并成一条，免得一次 alt-tab 双响；
 * - off（关闭）：窗口变化只进账本、不主动投，**只放行两样**——回来（当场叫醒）与离开（只投、不叫醒），
 *   以及切到一个「本次运行第一次见到的程序」（报一行，不叫醒）。她主动调 presence_windows
 *   时账本照给。
 *
 * **「离开」不叫醒**（2026-10-13 他定的，四挡通用）：他离开时她通常没什么可做的，那条不值得打断她；
 * 事件照投（piggyback），随她下次开口一起到。「回来」照旧——ambient 那挡不叫醒，其余三挡当场叫醒。
 *
 * 「关闭」是**投递静音，不是关掉这个世界**：传感器照采、两个工具照用，跟配置里的
 * `enabled:false`（整个 World 不启动）是两码事，提示词里点明了。
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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SCREENSHOT_MAX_EDGE,
  captureScreenshot,
  describeShotCursor,
  describeShotGeometry,
  listWindows,
  parseRegion,
  type CaptureOptions,
  type Rect,
  type ScreenshotResult,
  type ScreenshotTarget,
  type WindowList,
} from './capture.ts';
import { PRESENCE_CONFIG_GROUP, type PresenceConfigSection } from './config.ts';
import { clock, fmtDuration, renderDigest, renderSegmentLines, type DigestSegment } from './digest.ts';
import { spawnSensor, type PresenceSensor, type SensorTick, type SensorWindow } from './sensor.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** ambient 攒批的字数上限，到就合成一条投出。hearing 用实测的 1200，这里同款，是常量不是配置。 */
const AMBIENT_FLUSH_CHARS = 1200;
/** ambient 攒批的时限：从第一批算起超过就投。 */
const AMBIENT_FLUSH_MS = 180_000;
/** call 模式下窗口变化的合并窗口：3 秒内的连续变化并成一条再叫醒。 */
const CALL_COALESCE_MS = 3000;
/** 压缩挡的周期默认值（分钟）；她可以在 presence_set_mode 里带一个数临时覆盖。 */
const DIGEST_DEFAULT_MINUTES = 20;
/** 账本最多留多少段（digest / off 两挡共用），超了丢最老的。 */
const LEDGER_MAX_SEGMENTS = 400;
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
  listWindows?: () => Promise<WindowList>;
  /** 测试用：换掉截图。 */
  capture?: (target: ScreenshotTarget, options?: CaptureOptions) => Promise<ScreenshotResult>;
  /** 测试用：调小 ambient 攒批的字数上限。 */
  ambientFlushChars?: number;
  /** 测试用：调小 ambient 攒批的时限（毫秒）。 */
  ambientFlushMs?: number;
  /** 测试用：调小 call 模式的合并窗口（毫秒）。 */
  callCoalesceMs?: number;
}

type Delivery = 'ambient' | 'call' | 'digest' | 'off';

export class PresenceWorld implements World {
  readonly id = 'presence';

  private host: WorldHost | null = null;
  private sensor: PresenceSensor | null = null;
  private state: 'idle' | 'starting' | 'watching' | 'failed' = 'idle';
  private lastError = '';
  /** 挂着的那一挡。默认 digest（压缩）——2026-10-13 他定的。重启回这里。 */
  private delivery: Delivery = 'digest';
  /** 最近一次采样的前台窗口；null 表示还没见过（或桌面没有前台）。 */
  private current: SensorWindow | null = null;
  private currentSinceMs = 0;
  /** 最近一次采样的键鼠空闲毫秒；-1 表示还没采到。 */
  private idleMs = -1;
  private away = false;
  private awaySinceMs = 0;
  private switchCount = 0;
  /** digest / off 两挡共用的段账本：已闭合的段落在这里，当前那个窗口还开着不记账本。 */
  private ledger: DigestSegment[] = [];
  /** 账本的起点（进 digest / off 挡的时刻）。0 = 现在没有账本。 */
  private ledgerStartMs = 0;
  /** 压缩挡的周期计时器与当前周期长度（分钟）。 */
  private digestTimer: ReturnType<typeof setTimeout> | null = null;
  private digestMinutes = DIGEST_DEFAULT_MINUTES;
  /** 关闭挡的「见过」集合：本次运行报过一行窗口切换的程序名（按程序名去重，重启清零）。 */
  private seenExe = new Set<string>();
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
  /** 本次运行截了几张图。第 2 张起在回执里提一句成本，给她一个省着用的抓手。 */
  private shotCount = 0;
  /**
   * 每块区域上次看到的样子（内容的 sha256）。她盯着一块反复看时，回执里能直接告诉她
   * 「和上次一样 / 有变化」，不用她自己比对两张图。运行态、重启即忘。
   */
  private regionHashes = new Map<string, string>();

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
        { label: '姿势', value: deliveryLabel(this.delivery), tone: 'plain' as const },
        { label: '前台', value: this.current ? ellipsis(this.current.title) || this.current.exe || '—' : '—', tone: 'plain' as const },
        { label: '空闲', value: this.idleMs < 0 ? '—' : fmtDuration(this.idleMs), tone: 'plain' as const },
        { label: '已记录变化', value: `${this.switchCount} 次`, tone: 'plain' as const },
        { label: '攒着没投', value: `${this.ambientLines.length + this.pendingSwitchLines.length + this.ledger.length} 条`, tone: 'plain' as const },
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
      // 默认挡是 digest：账本与周期计时器得在这儿就支起来——不然窗口变化只封空账、摘要永远不投。
      this.armDelivery(this.delivery, Date.now());
      log.info('开始看桌面', { pollIntervalMs: pollMs, delivery: this.delivery });
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
    this.clearDigestTimer();
    // call 模式攒着的合并行并进 ambient 批一起投，不丢账。
    this.ambientLines.push(...this.pendingSwitchLines);
    this.pendingSwitchLines = [];
    if (this.delivery === 'digest') {
      // 压缩挡的账在另一个本子上：收尾把这一周期的摘要投出去（不叫醒），不丢账。
      await this.flushDigest('piggyback');
    } else if (this.delivery !== 'off') {
      await this.flushAmbient('piggyback');
    }
    // off 挡不投，也不留：账本只是「她问就给」的留档，收摊时不该突然冒一条。
    this.ledger = [];
    this.ledgerStartMs = 0;
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
      this.onAway('away', now);
    } else if (this.away && tick.idleMs < threshold) {
      this.away = false;
      this.onAway('back', now);
    }

    // 前台窗口变化：与上次采样对比。第一回只打底（current 为空时收养，不报事件），
    // 重启后的第一眼不该算「他切了窗口」（browser World 同款）。
    const cur = tick.cur;
    if (!cur) return;
    const prev = this.current;
    if (prev && sameWindow(cur, prev)) return;
    const dwellMs = prev ? now - this.currentSinceMs : 0;
    // digest / off 两挡走账本：刚结束的这段先封口（起点不早于进挡那一刻）。
    if (prev && (this.delivery === 'digest' || this.delivery === 'off')) {
      this.closeSegment(prev, this.currentSinceMs, now);
    }
    this.current = cur;
    this.currentSinceMs = now;
    if (prev) {
      this.switchCount += 1;
      this.onSwitch(cur, prev, dwellMs, now, log);
    } else {
      this.seenExe.add(exeKey(cur)); // 第一眼收养：它也算「见过」，切回来时不该算新
    }
  }

  /**
   * 离开 / 回来。四挡下都投**自己的事件名**（`presence.away` / `presence.back`）——不再混进
   * 窗口变化的批里。从前那条路会把单独一条离开错标成 `presence.switched`，2026-10-13 顺手修掉。
   *
   * 叫醒规则（2026-10-13 他定的）：**「离开」不叫醒**（四挡通用）——他离开时她通常没什么可做的，
   * 那条不值得打断她；事件照投，只是 piggyback。「回来」按挡位：ambient 不叫醒，其余三挡当场叫醒。
   * 压缩挡下这段离开还进摘要——时间线才完整。
   */
  private onAway(kind: 'away' | 'back', now: number): void {
    const text =
      kind === 'away'
        ? `[${clock(now)}] 离开键盘`
        : `[${clock(now)}] 回到键盘，离开了 ${fmtDuration(now - this.awaySinceMs)}`;
    // 「回来」那一刻把这段离开封进账本；「离开」那一刻不用记，起点就是现在。
    if (this.delivery === 'digest' && kind === 'back') this.closeAwaySegment(this.awaySinceMs, now);
    const trigger: TriggerMode = kind === 'away' || this.delivery === 'ambient' ? 'piggyback' : 'flush';
    void this.emit(kind === 'away' ? 'presence.away' : 'presence.back', text, trigger);
  }

  /**
   * 前台窗口变化。call / ambient 走原来的投递；digest 只进账本（段落已在 onTick 里封口）；
   * off 只报「本次运行第一次见到的程序」一行（不叫醒），别的只进账本。
   */
  private onSwitch(cur: SensorWindow, prev: SensorWindow, dwellMs: number, now: number, log: Logger): void {
    if (this.delivery === 'digest') return;
    const line = renderSwitch(cur, prev, dwellMs, now);
    if (this.delivery === 'off') {
      const key = exeKey(cur);
      const fresh = key !== '' && !this.seenExe.has(key);
      this.seenExe.add(key);
      if (fresh) {
        void this.emit('presence.switched', `${line}（本次运行第一次见到这个程序）`, 'piggyback');
      }
      return;
    }
    this.deliver(line, log);
  }

  // ——— 账本（digest / off 两挡共用） ———

  /** 把刚结束的一段前台窗口封进账本。 */
  private closeSegment(win: SensorWindow, startMs: number, endMs: number): void {
    this.pushLedger({
      kind: 'window',
      exe: win.exe,
      title: win.title,
      hwnd: win.hwnd,
      startMs,
      endMs,
    });
  }

  /** 把一段「离开键盘」封进账本。 */
  private closeAwaySegment(startMs: number, endMs: number): void {
    this.pushLedger({ kind: 'away', exe: '', title: '', hwnd: 0, startMs, endMs });
  }

  private pushLedger(seg: DigestSegment): void {
    if (this.ledgerStartMs === 0) return;
    const startMs = Math.max(seg.startMs, this.ledgerStartMs);
    if (seg.endMs <= startMs) return;
    this.ledger.push({ ...seg, startMs });
    if (this.ledger.length > LEDGER_MAX_SEGMENTS) this.ledger.splice(0, this.ledger.length - LEDGER_MAX_SEGMENTS);
  }

  /** 结账：把还开着的那段窗口封到 now，交出全部段落，并重开一本（起点 = now）。 */
  private takeLedger(now: number): { segments: DigestSegment[]; from: number } {
    const from = this.ledgerStartMs || now;
    if (this.current) this.closeSegment(this.current, this.currentSinceMs, now);
    const segments = this.ledger;
    this.ledger = [];
    this.ledgerStartMs = now;
    return { segments, from };
  }

  /**
   * 进入一个挡位：账本从这一刻起算，压缩挡还要把周期计时器支起来。
   * **start() 与 setMode() 共用**——默认挡是 digest，启动时这一句不做，压缩挡就等于空转。
   */
  private armDelivery(mode: Delivery, now: number): void {
    this.delivery = mode;
    this.ledger = [];
    this.ledgerStartMs = mode === 'digest' || mode === 'off' ? now : 0;
    this.clearDigestTimer();
    if (mode === 'digest') this.armDigestTimer();
  }

  /** 投出一份压缩摘要，然后重开一个周期。账本是空的（没采到东西）就不投，别制造噪音。 */
  private async flushDigest(trigger: TriggerMode): Promise<void> {
    if (this.delivery !== 'digest' || this.ledgerStartMs === 0) return;
    const now = Date.now();
    const { segments, from } = this.takeLedger(now);
    this.armDigestTimer();
    if (segments.length === 0) return;
    await this.emit('presence.digest', renderDigest(segments, { from, to: now }), trigger);
  }

  private armDigestTimer(): void {
    this.clearDigestTimer();
    const ms = Math.max(1000, Math.round(this.digestMinutes * 60_000));
    this.digestTimer = setTimeout(() => {
      this.digestTimer = null;
      void this.flushDigest('piggyback'); // 周期到了不叫醒，随她下次开口一起进上下文
    }, ms);
  }

  private clearDigestTimer(): void {
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
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
        'List up to 40 visible windows with rectangles, monitor geometry, and foreground/idle state from the latest poll. Returns and clears pending activity; in digest mode, settles the timeline and restarts its period.',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (_args: Record<string, unknown>, _ctx: ToolCallContext) => this.renderWindows(),
    };
  }

  private async renderWindows(): Promise<ToolOutcome | string> {
    if (this.state !== 'watching') {
      return fail(`现在没在看着桌面${this.lastError ? `：${this.lastError}` : ''}。重启本 World 可以重开。`);
    }
    let listed: WindowList;
    try {
      listed = this.opts.listWindows ? await this.opts.listWindows() : await listWindows();
    } catch (err) {
      return fail(`列不出窗口：${describe(err)}`);
    }
    const windows = listed.windows;
    const screen = listed.screen;

    const now = Date.now();
    const idleText = this.idleMs < 0 ? '—' : fmtDuration(this.idleMs);
    const lines: string[] = [
      `前台：「${this.current?.title || '（无前台窗口）'}」${this.current?.exe ? `(${this.current.exe})` : ''}`,
      `键鼠空闲：${idleText}（按最近一次轮询）`,
      `投递姿势：${deliveryLabel(this.delivery)}（${DELIVERY_HINT[this.delivery]}）`,
      // 坐标空间先交代清楚，她才好自己框区域。
      `坐标都是物理像素、虚拟屏坐标（原点在上面的 x=${screen.x} y=${screen.y}）；` +
        `虚拟屏 ${screen.width}x${screen.height}，` +
        `屏幕 ${screen.monitors.length} 台：` +
        screen.monitors
          .map((m) => `#${m.index}${m.primary ? '主' : ''} x=${m.x} y=${m.y} ${m.width}x${m.height}`)
          .join('；'),
      `可见窗口 ${windows.length} 个（带矩形 x,y 宽x高）：`,
      ...windows.slice(0, WINDOW_RECEIPT_CAP).map((w) => {
        const marks = [w.foreground ? '← 前台' : '', w.minimized ? '（最小化，位置不可用）' : '']
          .filter(Boolean)
          .join(' ');
        const rect = w.minimized ? '' : ` x=${w.bounds.x} y=${w.bounds.y} ${w.bounds.width}x${w.bounds.height}`;
        return `- 「${w.title}」(${w.exe})${rect}${marks ? ` ${marks}` : ''}`;
      }),
    ];
    if (windows.length > WINDOW_RECEIPT_CAP) lines.push(`（还有 ${windows.length - WINDOW_RECEIPT_CAP} 个没列）`);

    // 她开口看了，攒的当场给——四个挡位各取各的本子。
    this.clearSwitchTimer();
    this.clearDigestTimer();
    const sinceMs = this.lastPeekAt === 0 ? 0 : now - this.lastPeekAt;
    this.lastPeekAt = now;
    const sinceLabel = sinceMs > 0 ? `距你上次看约 ${fmtDuration(sinceMs)}` : '这是第一次看';
    if (this.delivery === 'digest') {
      // 压缩挡：调一次 presence_windows 就是「结账」——当前周期到此为止，时间线当场给她，
      // 然后重开一个周期（她 2026-10-13 问的「能不能停止计时立即投」，入口就是这里）。
      const { segments, from } = this.takeLedger(now);
      lines.push(`[压缩结账] ${sinceLabel}，这一周期到此为止：`);
      for (const line of renderDigest(segments, { from, to: now }).split('\n')) lines.push(line);
      this.armDigestTimer();
    } else if (this.delivery === 'off') {
      // 关闭挡：不主动投，但照记——她问了就给。
      const { segments } = this.takeLedger(now);
      if (segments.length > 0) {
        lines.push(`[关闭期间的变化] ${sinceLabel}（关闭挡只留档、不主动投）：`, ...renderSegmentLines(segments));
      } else {
        lines.push(`[变化] ${sinceLabel}：没有。`);
      }
    } else {
      const pending = [...this.ambientLines, ...this.pendingSwitchLines];
      this.ambientLines = [];
      this.ambientChars = 0;
      this.ambientOldestAt = 0;
      this.pendingSwitchLines = [];
      if (pending.length > 0) {
        lines.push(`[变化] ${sinceLabel}：`, ...pending);
      } else {
        lines.push(`[变化] ${sinceLabel}：没有。`);
      }
    }
    return lines.join('\n');
  }

  private screenshotTool(): ToolDef {
    return {
      name: 'presence_screenshot',
      description:
        'Attach a PNG/JPEG screenshot. Priority: region (width + height, optional x/y) > hwnd > target. Use window rectangles to frame a small area; long edges over 1600px are downscaled. Receipt reports captured bounds, coordinate mapping and cursor status.',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer', description: '区域左上 x，虚拟桌面物理像素，默认 0。' },
          y: { type: 'integer', description: '区域左上 y，同一坐标系，默认 0，可为负数。' },
          width: { type: 'integer', description: '区域宽，物理像素，至少 16；须同时给 height。' },
          height: { type: 'integer', description: '区域高，物理像素，至少 16；须同时给 width。' },
          hwnd: {
            type: 'integer',
            description: '已知的正整数窗口句柄，截整个窗口；区域优先。',
          },
          target: {
            type: 'string',
            enum: ['foreground', 'full'],
            description: 'foreground：前台窗口（默认）；full：全部显示器。',
          },
          grid: {
            type: 'boolean',
            description:
              '叠加标有桌面坐标的格线，默认 false；量坐标时使用。',
          },
          cursor: {
            type: 'boolean',
            description:
              '默认 true，叠加系统光标；false 可减少遮字或比图干扰，仍报告可读到的光标坐标。',
          },
        },
      },
      handler: (args) => this.takeScreenshot(args),
    };
  }

  private async takeScreenshot(args: Record<string, unknown>): Promise<ToolOutcome> {
    // 优先级:区域（width+height）→ 指定窗口 hwnd → target（默认前台）。
    // 默认前台而不是全屏:整屏拼图既多暴露又多像素，而她真正要看的多半就是当前那个窗口。
    let target: ScreenshotTarget;
    const wantsRegion = args.width !== undefined || args.height !== undefined;
    if (wantsRegion) {
      const region = parseRegion(args);
      if (typeof region === 'string') return fail(region);
      target = { target: 'region', region };
    } else if (typeof args.hwnd === 'number' && Number.isFinite(args.hwnd) && args.hwnd > 0) {
      target = { target: 'window', hwnd: args.hwnd };
    } else if (args.target === 'full') {
      target = { target: 'full' };
    } else {
      target = { target: 'foreground' };
    }

    let result: ScreenshotResult;
    try {
      const wantsGrid = args.grid === true;
      const wantsCursor = args.cursor !== false;
      const capture = this.opts.capture ?? ((t: ScreenshotTarget, o?: CaptureOptions) => captureScreenshot(t, CAPTURE_TIMEOUT_MS, o));
      result = await capture(target, { grid: wantsGrid, cursor: wantsCursor });
    } catch (err) {
      const hint =
        target.target === 'foreground' ? '（不想截前台、就想硬截一下屏幕的话，传 target:"full"。）' : '';
      return fail(`截不了：${describe(err)}${hint}`);
    }

    this.shotCount += 1;
    const cap = result.captured;
    const what =
      target.target === 'region'
        ? `区域 x=${cap.x} y=${cap.y} ${cap.width}x${cap.height}`
        : target.target === 'full'
          ? '全屏（所有显示器）'
          : `窗口「${result.title || (target.target === 'foreground' ? '前台' : String(target.hwnd))}」`;
    const viaText =
      target.target === 'region'
        ? '截的是屏幕上这一块现在的样子（有窗口压在上面就会截到上面那个）'
        : result.via === 'printwindow'
          ? '画面来自窗口自己绘的帧'
          : '画面来自抓屏（被遮挡时会叠着别的窗口）';
    const formatText = result.format === 'jpeg' ? '，照片类画面已按 JPEG 压过' : '';
    const mime = result.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const kb = Math.round(result.bytes.length / 1024);
    const fallbackText = `[截图：${what} ${result.width}x${result.height} ${result.format.toUpperCase()} ${kb}KiB]`;

    const lines: string[] = [`已截${what}：${result.width}x${result.height}，${kb} KiB${formatText}，${viaText}。`];

    // 框出屏幕外会被夹紧，说清楚实际抓的是哪一块，免得她以为是别的毛病。
    if (
      target.target === 'region' &&
      (cap.x !== target.region.x ||
        cap.y !== target.region.y ||
        cap.width !== target.region.width ||
        cap.height !== target.region.height)
    ) {
      lines.push(
        `（你框的是 x=${target.region.x} y=${target.region.y} ${target.region.width}x${target.region.height}，` +
          '有一部分在屏幕外，已夹到屏幕内。）',
      );
    }
    // 「这张图怎么换算成桌面坐标」跟图一起回去——她读到它的时候正是要量的时候。
    // 她按被压过的图直接当原始像素算，点偏过两次（先点到旁边的「≡」、后来把 VoiceMeeter 抬到前面），
    // 所以这一段不是补充说明，是这一步回执的正文之一。
    if (result.downscaled) {
      lines.push(`（这块比 ${SCREENSHOT_MAX_EDGE} 像素的上限大，所以被压过——想看清小字就把框框小一点，小框是按原始像素给的。）`);
    }
    for (const line of describeShotGeometry(result).split('\n')) lines.push(line);
    // 光标在不在图上、没画是为什么——同样跟图一起回去。图上没有箭头的时候，「光标不在这块」
    // 和「这次没读出来」是两件完全不同的事，她不该靠猜。
    lines.push(describeShotCursor(result));

    if (target.target === 'region') {
      const change = this.noteRegionChange(cap, result.bytes);
      if (change) lines.push(change);
    }

    lines.push(
      '这张图是临时的：它会一直跟着你的上下文走，每一轮请求都重发一遍，直到被挤出去；' +
        '看完要紧的东西就写成文字，图掉了你手里还有那行字。',
    );
    if (this.shotCount > 1) {
      lines.push(`（这是本次运行第 ${this.shotCount} 张。想接着看他在干什么，用 presence_windows 更省。）`);
    }
    if (this.host && !this.host.modelFacts.accepts(mime)) {
      lines.push('当前模型配置不吃图，你只能看到这些文字说明，看不到画面本身。');
    }
    return {
      text: lines.join('\n'),
      blobs: [
        {
          bytes: result.bytes,
          mime,
          name: `presence-${Date.now()}.${result.format === 'jpeg' ? 'jpg' : 'png'}`,
          fallbackText,
        },
      ],
    };
  }

  private setModeTool(): ToolDef {
    return {
      name: 'presence_set_mode',
      description:
        'Set delivery mode (see Presence environment rules). Runtime-only; restart resets to digest with a 20-minute period. Away never wakes you; back wakes you except in ambient. off keeps the sensor and tools available.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: ['call', 'ambient', 'digest', 'off'],
            description:
              'digest：周期摘要；ambient：攒批；call：窗口变化叫醒；off：窗口留档，仅首次见到的程序另报一行。',
          },
          minutes: {
            type: 'number',
            description: 'digest 周期分钟数，正数，可为小数；省略沿用当前值（初始 20）。',
          },
        },
        required: ['mode'],
      },
      handler: (args) => this.setMode(args),
    };
  }

  private async setMode(args: Record<string, unknown>): Promise<ToolOutcome> {
    const mode = args.mode;
    if (mode !== 'call' && mode !== 'ambient' && mode !== 'digest' && mode !== 'off') {
      return fail(`mode 只能是 call、ambient、digest 或 off，收到的是 ${JSON.stringify(mode ?? null)}。`);
    }
    let minutes = this.digestMinutes;
    if (args.minutes !== undefined) {
      if (typeof args.minutes !== 'number' || !Number.isFinite(args.minutes) || args.minutes <= 0) {
        return fail(`minutes 要是正数（分钟），收到的是 ${JSON.stringify(args.minutes)}。`);
      }
      minutes = args.minutes;
    }
    if (mode === this.delivery) {
      if (mode !== 'digest') {
        return { text: `本来就在 ${deliveryLabel(mode)} 姿势，没动。` };
      }
      if (minutes === this.digestMinutes) {
        return { text: `本来就在压缩姿势（每 ${fmtMinutes(minutes)}一份摘要），没动。` };
      }
      // 周期改了：先把已攒的按旧周期结账投出（不丢账），再按新周期走。
      this.digestMinutes = minutes;
      await this.flushDigest('piggyback');
      this.armDigestTimer();
      return { text: `压缩周期改成每 ${fmtMinutes(minutes)}。刚才攒的那点已按旧周期结账投出（不叫醒），新一轮从现在算。` };
    }

    const prev = this.delivery;
    this.clearSwitchTimer();
    this.clearDigestTimer();
    const now = Date.now();

    // 旧账按旧姿势结掉，不丢账；切到 digest / off 前先把 call / ambient 攒的批也投掉。
    if (prev === 'digest') {
      await this.flushDigest('piggyback');
    } else if (prev === 'off') {
      // 关闭挡的留档不外投——但它本来也没打算投，丢掉。
      this.ledger = [];
      this.ledgerStartMs = 0;
    } else {
      this.ambientLines.push(...this.pendingSwitchLines);
      this.pendingSwitchLines = [];
    }
    if (mode === 'digest' || mode === 'off') await this.flushAmbient('piggyback');

    this.digestMinutes = minutes;
    this.armDelivery(mode, now);

    if (mode === 'digest') {
      return {
        text:
          `已切到 digest（压缩）：窗口变化只记账、不单独投；每 ${fmtMinutes(minutes)}折成一份时间线摘要给你（不叫醒）。` +
          '他离开时只投不叫醒，回来时叫醒；离开时段也记进摘要。调 presence_windows 可立即结账。',
      };
    }
    if (mode === 'off') {
      return {
        text:
          '已切到 off（关闭）：窗口活动只留档、不主动投。另报他离开（不叫醒）、回来（叫醒），' +
          '和「切到一个本次运行第一次见到的程序」（不叫醒）。想看留档就调 presence_windows。' +
          '注意这是投递静音，不是关掉这个 World：传感器照看、截图照用。',
      };
    }
    if (mode === 'call') {
      const n = await this.flushAmbient('flush');
      return {
        text:
          '已切到 call：窗口变化当场投、会叫醒你，3 秒内的连续变化并成一条。' +
          (n > 0 ? `攒下的 ${n} 条已一并立即投出。` : ''),
      };
    }
    return {
      text:
        '已切到 ambient：变化照样记，但攒成批合并投出、不叫醒你——等你下次开口时一起到。' +
        '想看现在就调 presence_windows，攒的会当场给。',
    };
  }

  // ——— 截图 ———

  /**
   * 同一块区域的前后对比：只比字节，完全相同就是像素级没变。
   * 时钟、视频、滚动条这类一直在动的东西会让它永远报「有变化」——回执里说明了这点。
   * 图上的鼠标箭头也算在内（那是我们画上去的），所以光标挪到框里来过一次，这块就「有变化」。
   */
  private noteRegionChange(cap: Rect, bytes: Buffer): string {
    const key = `${cap.x},${cap.y},${cap.width},${cap.height}`;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const before = this.regionHashes.get(key);
    if (this.regionHashes.size >= 64) {
      const oldest = this.regionHashes.keys().next().value;
      if (oldest !== undefined) this.regionHashes.delete(oldest);
    }
    this.regionHashes.set(key, hash);
    if (before === undefined) return '（这是本次运行第一次看这块。）';
    return before === hash
      ? '（和上次看这块一样：像素级完全相同。）'
      : '（和上次看这块比：有变化。时钟、视频这类一直在动的东西会让它变——鼠标也是，图上那个箭头就是它。）';
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

/** 关闭挡的去重键：按程序名（大小写不敏感）。查不到进程名就给空串——空串不算「新」。 */
function exeKey(win: SensorWindow): string {
  return win.exe.trim().toLowerCase();
}

function deliveryLabel(mode: Delivery): string {
  switch (mode) {
    case 'call':
      return 'call（即投）';
    case 'ambient':
      return 'ambient（攒批）';
    case 'digest':
      return 'digest（压缩）';
    case 'off':
      return 'off（关闭）';
  }
}

const DELIVERY_HINT: Record<Delivery, string> = {
  call: '每次变化当场投、叫醒我',
  ambient: '攒成批、不叫醒我',
  digest: '只记账，按周期折成一份时间线摘要',
  off: '只留档，只有离开/回来与第一次见到的程序会自己冒出来',
};

function fmtMinutes(minutes: number): string {
  if (minutes >= 1) return `${minutes} 分钟`;
  return `${Math.round(minutes * 60)} 秒`;
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

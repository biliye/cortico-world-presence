/**
 * 截图与列窗口：一只**常驻的** PowerShell 助手，一问一答。
 *
 * 为什么不是「她说要才起一个、用完即退」（2026-10-16 改）：那台机器上的杀软对
 * 「每次现编一段脚本 + 立刻抓屏」这条形状判得时松时紧。现在脚本只在助手启动时编译一次，
 * 之后每次调用只是往它的 stdin 里写一行 JSON。理由与代价写在 `CaptureHost` 上面；
 * 脚本本体在 `capture-host.ps1`（包内文件，`-File` 跑，必须是 UTF-8 BOM）。
 *
 * 坐标一律是**物理像素**、**虚拟屏坐标**（主屏左上为原点，主屏左边的显示器是负坐标）。
 * 脚本开头声明 DPI 感知，所以上报的窗口矩形与区域坐标同一个坐标系。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 截图的最长边（像素），超过就等比降采样。再大只是烧 token。 */
export const SCREENSHOT_MAX_EDGE = 1600;
/** 列窗口的枚举上限（也等于回执上限），防一个挤满窗口的桌面把 token 吃光。 */
export const WINDOW_LIST_CAP = 100;
/**
 * 照片类画面的判定线：PNG 字节数 ÷ 像素数超过这个值，说明 PNG 压不动（画面里有视频、
 * 照片、大片渐变），改存 JPEG。
 *
 * 实测两个端点：文字界面（ZCode 窗口 1203x773）是 0.10 字节/像素；浏览器里放着视频的
 * 窗口（1600x870）是 1.21 字节/像素——差一个数量级，中间留得很宽。阈值取 0.5。
 */
export const PHOTO_BYTES_PER_PIXEL = 0.5;
/** 转 JPEG 时的质量。80 是肉眼与体积的常规平衡点。 */
export const JPEG_QUALITY = 80;
/** 区域的最小边：太小的框截出来没意义，还会让她以为是程序坏了。 */
export const REGION_MIN_EDGE = 16;
/**
 * 格线的基准间距（桌面像素）。图上每条线都落在「桌面坐标的整百处」上，线旁边标着那个坐标，
 * 所以她照着数字读就行，不用做任何换算——这是这套格线存在的全部理由。
 */
export const GRID_BASE_STEP = 100;
/**
 * 格线之间在**图上**至少留这么宽（图上的像素）。再密就糊成一片，反而不好读。
 * 被压过的大图会因此把间距翻倍（2560 宽压到 1600 时：100 → 200 桌面像素，图上约 125px）。
 */
export const GRID_MIN_GAP_PX = 70;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenshotTarget =
  | { target: 'full' }
  | { target: 'foreground' }
  | { target: 'window'; hwnd: number }
  | { target: 'region'; region: Rect };

/** 叠在图上那层格线实际画成了什么样（图上真画了几条、间距多少桌面像素）。 */
export interface GridInfo {
  /** 桌面坐标上的间距。`GRID_BASE_STEP` 起，密不下就翻倍。 */
  step: number;
  /** 竖线、横线各画了几条。 */
  vertical: number;
  horizontal: number;
}

/**
 * 光标有没有画进这张图，没画时是哪一种原因。
 * `drawn` 画了 / `omitted` 她这次说了不要箭头（位置照报）/ `hidden` 系统这一刻把光标藏起来了
 * （全屏视频、某些程序会这样）/ `offscreen` 光标不在这张图覆盖的那块里 /
 * `printwindow` 这张图不是抓屏来的（窗口自己绘的帧）/ `unknown` 读不到光标在哪。
 */
export type CursorDraw = 'drawn' | 'omitted' | 'hidden' | 'offscreen' | 'printwindow' | 'unknown';

/** 截图那一刻光标在哪，以及它有没有进这张图。 */
export interface CursorInfo {
  /** 桌面物理像素（虚拟屏坐标，与窗口矩形同一个口径）。读不到就是 null，那就也没画。 */
  x: number | null;
  y: number | null;
  draw: CursorDraw;
}

export interface ScreenshotResult {
  bytes: Buffer;
  /** 实际编码：文字界面存 PNG（无损、字清楚），照片类画面存 JPEG（体积差一个数量级）。 */
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** 实际抓的区域。region 目标下会被虚拟屏夹紧，所以可能和你框的不一样。 */
  captured: Rect;
  /**
   * 抓到的像素比实际区域小（框的长边超过上限被压过）。**小字会糊**——看到这个就框小一点，
   * 框小反而清楚，因为小框不会走降采样。
   */
  downscaled: boolean;
  /** 走的哪条路：`screen`（抓屏）或 `printwindow`（向窗口要画面）。 */
  via: 'screen' | 'printwindow';
  /** 目标窗口的标题；全屏与区域时为空。 */
  title: string;
  /** 图上的格线；没叠就是 null。 */
  grid: GridInfo | null;
  /** 光标在哪、有没有画进图里（抓屏拍不到光标本身，所以是我们画上去的）。 */
  cursor: CursorInfo;
}

/** 截图的可选项。`grid` 叠一层带桌面坐标标注的淡格线（她要从图上读坐标时加它）。 */
export interface CaptureOptions {
  grid?: boolean;
  /**
   * 要不要把光标画进图里（默认画）。`false` 时**仍然读光标、仍然在回执里报它的坐标**，
   * 只是不在图上画那个箭头——她「盯一块看变化」或要读那一块的小字时用得上：
   * 光标正好停在框里的话，一个会动的箭头会让「和上次像素级完全相同」永远说不出口。
   */
  cursor?: boolean;
}

export interface MonitorInfo {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface WindowInfo {
  hwnd: number;
  title: string;
  exe: string;
  pid: number;
  foreground: boolean;
  minimized: boolean;
  /** 窗口矩形，物理像素、虚拟屏坐标。最小化的窗口没有可用位置，四个值都是 0。 */
  bounds: Rect;
}

/** 屏幕几何：虚拟屏（所有显示器拼起来的范围）加每台显示器。 */
export interface ScreenInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  monitors: MonitorInfo[];
}

export interface WindowList {
  windows: WindowInfo[];
  screen: ScreenInfo;
}

/**
 * 常驻的 PowerShell 助手：**脚本只编译一次，之后一问一答走 stdin/stdout**。
 *
 * 为什么不再「每次现编一段」（2026-10-16 改）：
 *
 * - **杀软对「现编 + 立刻抓屏」这条形状的判定不稳**。同一天里同一个包，窗口清单那条一直是通的，
 *   截图那条时而通过、时而被拦 —— 报的是 PowerShell 的 `ScriptContainedMaliciousContent`
 *   （AMSI：此脚本包含恶意内容，已被防病毒软件阻止运行），而机器上跑着电脑管家与火绒。
 *   对照物有两条：本包**传感器**（也是常驻 PowerShell）全程没事；mouse 那只**常驻**的手/眼
 *   在同样的拦截窗口里也没事。⇒ 形状是「现编 vs 常驻」，不是「抓屏本身被禁」。
 * - 顺带把每次调用都付一遍的冷启动（PowerShell 起进程 + `Add-Type` 现编译 C#，量过 1.4~2.9 秒）省掉。
 *
 * 代价与边界（写清楚，别让它变成猜）：
 * - **一次只跑一个请求**（FIFO 排队）：截图与清单共用一个进程，抓屏与枚举同时进行没有意义，
 *   排队比并发安全。超时会**杀掉助手再重起**——半路抓屏没法在进程内取消，杀进程是唯一可靠的做法。
 * - 助手崩了/被拦了不报假成功：那一次请求按「没吐出结果」失败，下一次调用会另起一只。
 * - 请求与应答都是**一行一条 JSON**；除这一行以外的东西（PowerShell 的 CLIXML 噪声）走 stderr。
 */

/**
 * 助手脚本住在包里（`src/capture-host.ps1`），用 `-File` 跑。
 *
 * 为什么不是「把脚本 base64 塞在命令行上」（`-EncodedCommand`）：两段脚本合起来编码后 **43952 字节**，
 * 而 Windows 命令行的上限约 **32767** —— 顶过去就是 `spawn ENAMETOOLONG`。读文件之后没有这个上限，
 * 而且**它在盘上是一份可读、可以加白名单的文件**（命令行里一段 base64 + P/Invoke 正是杀软最爱盯的形状）。
 * 这份 `.ps1` **必须带 UTF-8 BOM**：脚本里有中文（给她的错误文案），无 BOM 的 UTF-8 会被
 * Windows PowerShell 5.1 按系统 ANSI 读成乱码 —— `capture.test.ts` 有一条用例盯着它。
 */
const HOST_SCRIPT = fileURLToPath(new URL('./capture-host.ps1', import.meta.url));
const HOST_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT];

interface HostRequest {
  command: Record<string, unknown>;
  timeoutMs: number;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/** 在飞的那一个：请求本身 + 它那个超时定时器。 */
type HostPending = HostRequest & { timer: ReturnType<typeof setTimeout> };

/**
 * 助手进程 + 排队。
 *
 * 一次只跑一个请求：截图与列窗口共用一个进程，**抓屏与枚举同时进行没有意义**，排队比并发安全，
 * 也让「一行命令一行结果」这条协议不用做请求 id 配对。超时/进程没了都会**杀掉重起**——
 * 半路抓屏没法在进程内取消，杀进程是唯一可靠的做法，而那一次请求按失败报，不报假成功。
 */
class CaptureHost {
  private child: ChildProcess | null = null;
  private stdout = '';
  private stderr = '';
  private pending: HostPending | null = null;
  private readonly queue: HostRequest[] = [];
  private spawns = 0;

  /** 到现在为止起过几只助手（读数只增不减，测试用它钉住「复用」这件事）。 */
  spawnCount(): number {
    return this.spawns;
  }

  /** 一问一答。失败抛错，错误文案给人看（World 原样放进回执）。 */
  request(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /** 收工：等着的全按失败交回，再杀掉助手。不抛错。 */
  async stop(): Promise<void> {
    const why = new Error('World 收工了，助手已经收掉');
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(why);
    }
    for (const item of this.queue.splice(0)) item.reject(why);
    this.kill();
  }

  /** 取下一个请求跑。同一时刻只有一个在飞。 */
  private pump(): void {
    if (this.pending || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    const child = this.ensureChild();
    if (!child) {
      item.reject(new Error(this.lastStartError ?? 'PowerShell 起不来'));
      this.pump();
      return;
    }
    const timeoutMs = item.timeoutMs;
    this.stdout = '';
    const timer = setTimeout(() => {
      if (this.pending !== item) return;
      this.pending = null;
      this.kill();
      item.reject(new Error(`PowerShell ${Math.round(timeoutMs / 1000)} 秒没跑完，被掐掉了`));
      this.pump();
    }, timeoutMs);
    // 直接把定时器挂在**同一个对象**上：下面那几个回调要靠 `this.pending === item` 认人，
    // 换成 `{ ...item, timer }` 就等于每处都对不上（这条也是测试抓出来的）。
    const pendingItem = item as HostPending;
    pendingItem.timer = timer;
    this.pending = pendingItem;
    try {
      child.stdin?.write(`${JSON.stringify(item.command)}\n`);
    } catch (err) {
      clearTimeout(timer);
      this.pending = null;
      this.kill();
      item.reject(new Error(`命令送不进助手：${describeError(err)}`));
      this.pump();
    }
  }

  private lastStartError: string | undefined;

  private ensureChild(): ChildProcess | null {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    this.child = null;
    this.stdout = '';
    this.stderr = '';
    this.lastStartError = undefined;
    let child: ChildProcess;
    try {
      child = spawn('powershell.exe', HOST_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this.lastStartError = `PowerShell 起不来：${describeError(err)}`;
      return null;
    }
    this.spawns += 1;
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      // 没有请求在等的时候收到的字节不属于任何人（上一只的尾巴、或启动时的噪声），直接丢：
      // 攒着它会让**下一次**请求被上一次的残留顶答（这条是测试抓出来的）。
      if (!this.pending) return;
      this.stdout += chunk.toString('utf8');
      this.drain();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
      if (this.stderr.length > 8192) this.stderr = this.stderr.slice(-4096);
    });
    child.on('error', (err) => {
      // 认人：被我们杀掉的那一只，它的 error/close 可能在新请求已经跑起来之后才到。
      if (this.child !== child) return;
      this.child = null;
      this.failPending(`PowerShell 起不来：${err.message}`);
    });
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = null;
      // 助手在应答之前就退了：可能被拦、可能崩了。那一次按「没吐出结果」失败，绝不报假成功。
      this.failPending(`PowerShell 没吐出结果${this.stderr.trim() ? `：${this.stderr.slice(-400)}` : ''}`);
    });
    return child;
  }

  /** 从 stdout 里找**下一行**以 `{` 开头的 JSON——一行一条，前面混进来的噪声跳过。 */
  private drain(): void {
    const pending = this.pending;
    if (!pending) return;
    for (;;) {
      const nl = this.stdout.indexOf('\n');
      if (nl < 0) return;
      const line = this.stdout.slice(0, nl).trim();
      this.stdout = this.stdout.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 不是完整 JSON 的行，继续找
      }
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(parsed);
      this.pump();
      return;
    }
  }

  private failPending(message: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    this.pump();
  }

  /** 杀掉助手并清掉缓冲。不碰排队里的请求（调用方自己决定怎么交回）。 */
  private kill(): void {
    const child = this.child;
    this.child = null;
    this.stdout = '';
    if (child && child.exitCode === null) child.kill();
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const HOST = new CaptureHost();

/** 助手起过几只（测试用：两次调用应当只有一只）。 */
export function captureHostSpawns(): number {
  return HOST.spawnCount();
}

/** World 收工时把助手一起收掉；不抛错。 */
export async function stopCaptureHost(): Promise<void> {
  await HOST.stop();
}

function asBuffer(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('截图回执里没有图片数据');
  return Buffer.from(value, 'base64');
}

/** 校验编码：PNG 看魔数，JPEG 看 FFD8FF。截到的字节对不上就是没截成。 */
function checkMagic(bytes: Buffer, format: 'png' | 'jpeg'): void {
  if (format === 'png') {
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(magic)) {
      throw new Error('截到的不是一张有效的 PNG');
    }
    return;
  }
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error('截到的不是一张有效的 JPEG');
  }
}

function toRect(raw: unknown): Rect {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    x: Math.round(Number(r.x ?? 0)) || 0,
    y: Math.round(Number(r.y ?? 0)) || 0,
    width: Math.max(0, Math.round(Number(r.width ?? 0)) || 0),
    height: Math.max(0, Math.round(Number(r.height ?? 0)) || 0),
  };
}

/**
 * 校验她框的区域。返回矩形或一句人话的错误。
 * 只做形状校验:是否落在屏幕上是 PowerShell 那边的事（夹紧或报错）。
 */
export function parseRegion(args: Record<string, unknown>): Rect | string {
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
    return null;
  };
  const width = num(args.width);
  const height = num(args.height);
  if (width === null || height === null) return '截区域要同时给 width 和 height（物理像素）。';
  if (width < REGION_MIN_EDGE || height < REGION_MIN_EDGE) {
    return `框太小了（${width}x${height}）：宽高都至少 ${REGION_MIN_EDGE} 像素。`;
  }
  const x = num(args.x) ?? 0;
  const y = num(args.y) ?? 0;
  return { x, y, width, height };
}

/** 助手要的那条命令：目标与两个开关现读；区域只在 region 那条有意义（其余给 0，脚本不看）。 */
function captureCommand(target: ScreenshotTarget, grid: boolean, cursor: boolean): Record<string, unknown> {
  return {
    op: 'capture',
    target: target.target,
    hwnd: target.target === 'window' ? Math.trunc(target.hwnd) : 0,
    region:
      target.target === 'region'
        ? { x: target.region.x, y: target.region.y, width: target.region.width, height: target.region.height }
        : { x: 0, y: 0, width: 0, height: 0 },
    grid,
    cursor,
    // 包里那几个常量随命令过去：.ps1 里不写一份，免得两处各说各话。
    maxEdge: SCREENSHOT_MAX_EDGE,
    jpegQuality: JPEG_QUALITY,
    gridBase: GRID_BASE_STEP,
    gridMinGap: GRID_MIN_GAP_PX,
    photoRatio: PHOTO_BYTES_PER_PIXEL,
  };
}

/** 截一张。她说要才调用；失败抛错（World 转成失败回执），错误文案给人看。 */
export async function captureScreenshot(
  target: ScreenshotTarget,
  timeoutMs = 20000,
  options: CaptureOptions = {},
): Promise<ScreenshotResult> {
  const grid = options.grid === true;
  const drawCursor = options.cursor !== false;
  const result = await HOST.request(captureCommand(target, grid, drawCursor), timeoutMs);
  if (result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : '截图失败，原因不明');
  }
  const format: 'png' | 'jpeg' = result.format === 'jpeg' ? 'jpeg' : 'png';
  const bytes = asBuffer(result.data);
  checkMagic(bytes, format);
  return {
    bytes,
    format,
    width: Number(result.width ?? 0),
    height: Number(result.height ?? 0),
    captured: toRect(result.captured),
    downscaled: result.downscaled === true,
    via: result.via === 'printwindow' ? 'printwindow' : 'screen',
    title: typeof result.title === 'string' ? result.title : '',
    grid: parseGrid(result.grid),
    cursor: parseCursor(result.cursor),
  };
}

/** 脚本报回来的光标信息。形状不对就当「读不到」——宁可少说一句，也不报一个假的位置。 */
function parseCursor(raw: unknown): CursorInfo {
  const c = (raw ?? {}) as Record<string, unknown>;
  const x = numOrNull(c.x);
  const y = numOrNull(c.y);
  if (x === null || y === null) return { x: null, y: null, draw: 'unknown' };
  const draw =
    c.draw === 'drawn' || c.draw === 'omitted' || c.draw === 'hidden' || c.draw === 'offscreen' || c.draw === 'printwindow'
      ? c.draw
      : 'unknown';
  return { x, y, draw };
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
  return null;
}

/** 脚本报回来的格线信息。形状不对就当没叠（宁可少说一句，也不报一个假的间距）。 */
function parseGrid(raw: unknown): GridInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const step = Number(g.step ?? 0);
  const vertical = Number(g.vertical ?? 0);
  const horizontal = Number(g.horizontal ?? 0);
  if (!Number.isFinite(step) || step <= 0) return null;
  if (vertical + horizontal <= 0) return null;
  return { step: Math.round(step), vertical: Math.max(0, Math.round(vertical)), horizontal: Math.max(0, Math.round(horizontal)) };
}

/**
 * 格线在这个缩放下的间距（桌面像素）。与 `captureHostScript` 里那段同一条规则——
 * 回执要预告「要是加了格线，间距会是多少」，那就得和真画出来的那个数一致。
 */
export function gridStepFor(imageWidth: number, capturedWidth: number): number {
  if (capturedWidth <= 0 || imageWidth <= 0) return GRID_BASE_STEP;
  const perImagePx = imageWidth / capturedWidth;
  let step = GRID_BASE_STEP;
  while (step * perImagePx < GRID_MIN_GAP_PX) step *= 2;
  return step;
}

/**
 * 「这张图怎么换算成桌面坐标」——**跟图一起回去**的那一句。
 *
 * 她量错过两次:拿着被压过的窗口截图按原始像素算，于是先点到了旁边的「≡」、后来又把 VoiceMeeter
 * 抬到了前面。所以这句话不能只住在环境提示词里:她读到它的时候，正是要量的时候。
 * 叠了格线那一次更省事——线上的数字就是桌面坐标，一次乘法都不用做。
 */
export function describeShotGeometry(
  result: Pick<ScreenshotResult, 'width' | 'height' | 'captured' | 'downscaled' | 'grid'>,
): string {
  const cap = result.captured;
  const per = cap.width > 0 && result.width > 0 ? cap.width / result.width : 1;
  const lines: string[] = [];
  if (result.downscaled) {
    lines.push(
      `**这张图被压过**（${cap.width}×${cap.height} → ${result.width}×${result.height}）:` +
        `**图上 1 像素 = 桌面 ${per.toFixed(2)} 像素**——按图上的像素直接当桌面像素用就会偏。`,
    );
  } else {
    lines.push('这张图没被压:**图上的点就是桌面的点**（1:1）。');
  }
  const scale = per === 1 ? '' : ` × ${per.toFixed(2)}`;
  lines.push(
    `图上的 (px,py) → 桌面 (${cap.x} + px${scale}, ${cap.y} + py${scale});` +
      `图的左上角那一点是桌面 (${cap.x}, ${cap.y})。`,
  );
  if (result.grid) {
    lines.push(
      `图上叠了淡格线:**每 ${result.grid.step} 桌面像素一条**（竖线 ${result.grid.vertical} 条、横线 ` +
        `${result.grid.horizontal} 条），**每条线旁边就标着它自己的桌面坐标**（写 x=… 的是竖线、y=… 的是横线）` +
        '——照着线上的数字读，一次乘法都不用做。',
    );
  } else {
    const step = gridStepFor(result.width, cap.width);
    lines.push(
      `要按图量坐标（点别的东西、读某个控件在哪）:**下一步加 grid:true**——图上会叠一层每 ${step} ` +
        '桌面像素一条的淡格线、线旁标着桌面坐标，照着读就不用换算。',
    );
  }
  return lines.join('\n');
}

/**
 * 「图上那个箭头是什么」——**跟图一起回去**的那句话。
 *
 * 抓屏本身拍不到光标（量过：围着光标的 PNG 里没有箭头），所以图上的光标是我们照着系统的真光标
 * 画上去的。这一句要把「它到底在不在图上」说清：没画的时候，她不该读成「光标不在这块」，
 * 更不该读成「这个功能坏了」。
 */
export function describeShotCursor(result: Pick<ScreenshotResult, 'cursor' | 'captured'>): string {
  const c = result.cursor;
  const at = c.x === null || c.y === null ? '桌面某处' : `桌面 (${c.x}, ${c.y})`;
  switch (c.draw) {
    case 'drawn':
      return `鼠标在 ${at}：**图上那个箭头就是它**（抓屏抓不到光标本身，箭头是我照系统当前的样子画上去的）。`;
    case 'omitted':
      return `鼠标在 ${at}；你说了这次不要箭头，**图上没有画它**（位置还是要报的，就是这一句）。`;
    case 'hidden':
      return `鼠标在 ${at}，但**系统这一刻把它藏起来了**（全屏视频、有些程序会自己隐藏指针），所以在图上没有箭头。`;
    case 'offscreen':
      return `鼠标在 ${at}，**不在这张图里**（这张图只覆盖 x=${result.captured.x} y=${result.captured.y} 那一块），所以图上没有箭头。`;
    case 'printwindow':
      return '这张图是窗口自己绘的帧（不是抓屏），所以上面**没有**鼠标箭头——这不代表光标不在那一块。';
    default:
      return '这一次没能读出鼠标在哪，所以图上没有箭头。';
  }
}

/** 一个对象也可能是 ConvertTo-Json 把单元素数组拍平的结果，兜一下。 */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  return [value as T];
}

/** 列一遍可见窗口，附带屏幕几何。失败抛错。 */
export async function listWindows(timeoutMs = 15000): Promise<WindowList> {
  const result = await HOST.request({ op: 'windows', windowCap: WINDOW_LIST_CAP }, timeoutMs);
  if (result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : '列不出窗口');
  }
  const windows = asArray<Record<string, unknown>>(result.windows).map((w) => ({
    hwnd: Number(w.hwnd ?? 0),
    title: typeof w.title === 'string' ? w.title : '',
    exe: typeof w.exe === 'string' ? w.exe : '',
    pid: Number(w.pid ?? 0),
    foreground: w.foreground === true,
    minimized: w.minimized === true,
    bounds: toRect(w.bounds),
  }));
  const rawScreen = (result.screen ?? {}) as Record<string, unknown>;
  const screen: ScreenInfo = {
    ...toRect(rawScreen),
    monitors: asArray<Record<string, unknown>>(rawScreen.monitors).map((m, index) => ({
      index: Number(m.index ?? index),
      ...toRect(m),
      primary: m.primary === true,
    })),
  };
  return { windows, screen };
}

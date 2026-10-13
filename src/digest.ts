/**
 * 压缩挡（digest）的折叠器：把一段时间里的「前台窗口段」折成一份时间线摘要。
 *
 * 纯函数、不碰 World 的状态——喂进来一串段，吐出来几行字，判断全都能直接测。
 * 折叠规则照她的原话（2026-10-13 转述）：「同一批里重复的折成一条、只留「在哪几个
 * 窗口之间来回」就够用。」所以 A→B→A→B 这种来回不再逐段列，折成一条「在 A 与 B 之间
 * 来回 N 次」；规律之外的段照原样列。
 *
 * 两条诚实的边界（写在回执与提示词里）：精度就是轮询粒度（默认 10 秒）；周期末尾还
 * 开着的那段窗口只能算到结账那一刻，所以最后一行会明说「到结账时还在这儿」。
 */

/** 一段的时间线记录。窗口段与「离开键盘」段共用这一个形状。 */
export interface DigestSegment {
  /** window = 一段前台窗口；away = 一段离开键盘（无输入）。 */
  kind: 'window' | 'away';
  exe: string;
  title: string;
  hwnd: number;
  startMs: number;
  /** 闭合时刻；周期末尾还开着的那一段由结账方补上。 */
  endMs: number;
}

/** 折叠检测支持的最长循环：两个窗口来回、三个窗口轮换。再长就不折，逐段列。 */
const MAX_CYCLE = 3;
/** 折叠后最多列多少行，超了截断并说明（免得一段异常乱切把回执撑爆）。 */
const MAX_ITEMS = 60;
/** 折叠行里窗口名的截断长度。 */
const NAME_MAX = 18;

type Item =
  | { kind: 'seg'; seg: DigestSegment; last: boolean }
  | { kind: 'cycle'; names: string[]; rounds: number; fromMs: number; toMs: number };

/** 一段窗口的时间线摘要（含表头）。 */
export function renderDigest(segments: DigestSegment[], opts: { from: number; to: number }): string {
  const head = `[压缩 ${clock(opts.from)}–${clock(opts.to)}，共 ${fmtDuration(opts.to - opts.from)}]`;
  const items = fold(segments.filter((s) => s.endMs > s.startMs));
  if (items.length === 0) return `${head}\n（这一段没看到窗口变化。）`;
  const lines = items.slice(0, MAX_ITEMS).map(renderItem);
  if (items.length > MAX_ITEMS) lines.push(`（还有 ${items.length - MAX_ITEMS} 段没列。）`);
  return [head, ...lines].join('\n');
}

/** 逐段列出（不折叠）：关闭挡下她主动开口看时给的就是这个。 */
export function renderSegmentLines(segments: DigestSegment[]): string[] {
  return segments.filter((s) => s.endMs > s.startMs).map((seg) => renderSegment(seg, false));
}

function fold(segments: DigestSegment[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  while (i < segments.length) {
    const cycle = detectCycle(segments, i);
    if (cycle) {
      out.push(cycle.item);
      i = cycle.next;
      continue;
    }
    out.push({ kind: 'seg', seg: segments[i], last: i === segments.length - 1 });
    i += 1;
  }
  return out;
}

/**
 * 从 at 起找一个「来回」：连续重复同一串窗口两轮以上就算。
 * 只认窗口段——中间夹着一段「离开键盘」就断了，不跨过它折。
 */
function detectCycle(segments: DigestSegment[], at: number): { item: Item; next: number } | null {
  for (let p = 2; p <= MAX_CYCLE; p += 1) {
    if (at + p * 2 > segments.length) continue;
    const period = segments.slice(at, at + p);
    if (period.some((s) => s.kind !== 'window')) continue;
    const keys = period.map(keyOf);
    let rounds = 1;
    while (at + (rounds + 1) * p <= segments.length) {
      const block = segments.slice(at + rounds * p, at + (rounds + 1) * p);
      if (block.some((s) => s.kind !== 'window')) break;
      if (block.map(keyOf).join('\u0000') !== keys.join('\u0000')) break;
      rounds += 1;
    }
    if (rounds < 2) continue;
    const endIdx = at + rounds * p - 1;
    return {
      item: {
        kind: 'cycle',
        names: period.map((s) => `「${short(s.title || s.exe)}」`),
        rounds,
        fromMs: segments[at].startMs,
        toMs: segments[endIdx].endMs,
      },
      next: endIdx + 1,
    };
  }
  return null;
}

/** 窗口身份：句柄 + 标题。同一个窗口换标题（切标签页）算另一段，如实记。 */
function keyOf(seg: DigestSegment): string {
  return `${seg.hwnd}|${seg.title}`;
}

function renderItem(item: Item): string {
  if (item.kind === 'cycle') {
    const span = `${clock(item.fromMs)}–${clock(item.toMs)}`;
    return `${span} 在 ${item.names.join(' 与 ')} 之间来回 ${item.rounds} 次（共 ${fmtDuration(item.toMs - item.fromMs)}）`;
  }
  return renderSegment(item.seg, item.last);
}

function renderSegment(seg: DigestSegment, last: boolean): string {
  const span = `${clock(seg.startMs)}–${clock(seg.endMs)}`;
  const dur = fmtDuration(seg.endMs - seg.startMs);
  if (seg.kind === 'away') return `${span} 离开键盘（${dur}）`;
  const name = `「${seg.title}」${seg.exe ? `(${seg.exe})` : ''}`;
  return `${span} ${name} 共 ${dur}${last ? '，到结账时还在这儿' : ''}`;
}

function short(text: string, max = NAME_MAX): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return '不到 1 秒';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

export function clock(now: number): string {
  return new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

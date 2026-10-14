/**
 * 压缩摘要折叠器的单元测试。这里不碰 World、不开桌面：喂进去一串段，看吐出来的时间线。
 * 断言避开具体时刻（那是本地时区的事），只盯结构：折没折、几行、时长怎么写。
 */
import { describe, expect, it } from 'vitest';
import { renderCompactDigest, renderDigest, renderSegmentLines, type DigestSegment, type DigestSnapshot } from '../src/digest.ts';

const T0 = new Date('2026-10-13T11:00:00').getTime();
const min = (n: number) => n * 60_000;

function win(hwnd: number, title: string, exe: string, fromMin: number, toMin: number): DigestSegment {
  return { kind: 'window', exe, title, hwnd, startMs: T0 + min(fromMin), endMs: T0 + min(toMin) };
}

function away(fromMin: number, toMin: number): DigestSegment {
  return { kind: 'away', exe: '', title: '', hwnd: 0, startMs: T0 + min(fromMin), endMs: T0 + min(toMin) };
}

const A = (f: number, t: number) => win(1, 'A 窗口', 'chrome', f, t);
const B = (f: number, t: number) => win(2, 'B 窗口', 'code', f, t);
const C = (f: number, t: number) => win(3, 'C 窗口', 'wezterm', f, t);

function fold(segments: DigestSegment[]): string {
  return renderDigest(segments, { from: T0, to: T0 + min(60) });
}

describe('压缩摘要的折叠器', () => {
  it('两个窗口来回：四段折成一行，不逐段列', () => {
    const lines = fold([A(0, 5), B(5, 7), A(7, 9), B(9, 11)]).split('\n');
    expect(lines).toHaveLength(2); // 表头 + 折叠一行
    expect(lines[1]).toContain('在 「A 窗口」 与 「B 窗口」 之间来回 2 次');
  });

  it('三窗口轮换也折（p=3）', () => {
    const lines = fold([A(0, 3), B(3, 5), C(5, 7), A(7, 9), B(9, 11), C(11, 13)]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('来回 2 次');
    expect(lines[1]).toContain('「C 窗口」');
  });

  it('不成来回（只有三段 A→B→A）就逐段列', () => {
    const lines = fold([A(0, 5), B(5, 7), A(7, 20)]).split('\n');
    expect(lines).toHaveLength(4); // 表头 + 三段
  });

  it('离开键盘那段打断折叠，自己也占一行', () => {
    const lines = fold([A(0, 5), B(5, 7), away(7, 20), A(20, 25), B(25, 27), A(27, 29), B(29, 31)]).split('\n');
    // 表头 + A、B 两段 + 离开一段 + 后面的来回一行
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => l.includes('离开键盘'))).toBe(true);
    expect(lines.some((l) => l.includes('来回 2 次'))).toBe(true);
  });

  it('整段都在一个窗口：一行，并标明「到结账时还在这儿」', () => {
    const lines = fold([A(0, 20)]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('共 20 分钟');
    expect(lines[1]).toContain('到结账时还在这儿');
  });

  it('空账本：说明没有记录，不断言没有变化', () => {
    const out = fold([]);
    expect(out).toContain('没有可用的窗口时段记录');
    expect(out.split('\n')).toHaveLength(2);
  });

  it('零长段与负长段被丢掉（时钟回拨那种脏数据不该进摘要）', () => {
    const lines = fold([A(0, 5), win(2, 'B 窗口', 'code', 5, 5), A(5, 9)]).split('\n');
    expect(lines).toHaveLength(3); // 表头 + 两段（中间那条零长的没了）
  });

  it('逐段列（关闭挡用）：不折叠，来回有几段就几行', () => {
    const lines = renderSegmentLines([A(0, 5), B(5, 7), A(7, 9), B(9, 11)]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('「A 窗口」(chrome)');
    expect(lines[0]).toContain('共 5 分钟');
  });
});

function compact(segments: DigestSegment[], patch: Partial<DigestSnapshot> = {}): string {
  return renderCompactDigest({
    id: 'test-1', from: T0, to: T0 + min(20), segments, switches: 2, dropped: 0,
    current: { title: 'A 窗口', exe: 'chrome' }, away: false, idleMs: 500, ...patch,
  });
}

describe('紧凑累计视图', () => {
  it('非循环 A→B→A 累加同窗口，切换数独立于段数', () => {
    const out = compact([A(0, 5), B(5, 7), A(7, 20)]);
    expect(out).toContain('应用累计：chrome 18 分钟；code 2 分钟');
    expect(out).toContain('窗口累计：「A 窗口」(chrome) 18 分钟');
    expect(out).toContain('观测切换 2 次');
    expect(out).toContain('最近采样：「A 窗口」');
  });

  it('同应用不同窗口分开累计，应用名忽略大小写，改标题也分开', () => {
    const out = compact([A(0, 5), win(2, 'B 窗口', 'CHROME', 5, 10), win(1, '新标题', 'chrome', 10, 20)]);
    expect(out).toContain('应用累计：chrome 20 分钟');
    expect(out).toContain('「新标题」(chrome) 10 分钟');
    expect(out).toContain('「B 窗口」(CHROME) 5 分钟');
  });

  it('零切换保留整段停留，空账本不冒充无变化也不给无效记录入口', () => {
    const out = compact([A(0, 20)], { switches: 0 });
    expect(out).toContain('chrome 20 分钟');
    expect(out).toContain('观测切换 0 次');
    const empty = compact([], { switches: 0, current: null, idleMs: -1 });
    expect(empty).toContain('没有可累计的前台窗口采样');
    expect(empty).not.toContain('时间线：');
    expect(empty).toContain('前台未知');
    expect(empty).toContain('键鼠状态未知');
  });

  it('离开时长与前台重叠，裁剪范围、忽略无效段', () => {
    const out = compact([A(-5, 25), away(10, 25), B(8, 8), B(9, 7)], { away: true });
    expect(out).toContain('应用累计：chrome 20 分钟');
    expect(out).toContain('离开键盘累计 10 分钟');
    expect(out).toContain('与前台停留重叠');
    expect(out).not.toContain('code');
  });

  it('排名和长标题有上限，余项报合计且提示账本截断', () => {
    const segments = Array.from({ length: 30 }, (_, i) => win(i, '长标题'.repeat(100) + i, 'app' + i, i, i + 1));
    const out = compact(segments, { to: T0 + min(30), dropped: 9, switches: 450 });
    expect(out).toContain('其余 25 项 25 分钟');
    expect(out).toContain('已丢弃 9 段');
    expect(out).toContain('观测切换 450 次');
    expect(out.length).toBeLessThan(1200);
  });
});

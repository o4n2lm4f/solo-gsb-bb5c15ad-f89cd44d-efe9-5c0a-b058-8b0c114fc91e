import { describe, expect, it } from 'vitest';
import {
  analyzeRhythm,
  applyRhythmFixes,
  countReadingChars,
  liveRhythmKeys,
  RHYTHM_EPS_MS,
  type RhythmCue,
  type RhythmOptions,
} from '../rhythm';

function cue(start: number, end: number, text: string, groupIndex: number): RhythmCue {
  return { start, end, text, groupIndex };
}

const OPTS: RhythmOptions = { maxCps: 5, minMs: 500, maxMs: 7000 };

describe('countReadingChars', () => {
  it('按 Unicode 字素簇计数，去标签与空白', () => {
    expect(countReadingChars('你好世界')).toBe(4);
    expect(countReadingChars('<i>Hello</i>')).toBe(5);
    expect(countReadingChars('{\\an8}你好\n世界')).toBe(4);
    expect(countReadingChars('a b\tc\nd')).toBe(4);
  });

  it('组合 emoji 与区域指示符按字素簇计为 1', () => {
    expect(countReadingChars('你好👍🏽')).toBe(3); // 你 好 👍🏽(emoji+肤色修饰)
    expect(countReadingChars('🇨🇳旗')).toBe(2); // 国旗一个字素 + 旗
  });
});

describe('analyzeRhythm 超限判定', () => {
  it('速率恰等于上限不超限', () => {
    const c = [cue(0, 1000, '五五五', 0)]; // 3/秒
    const r = analyzeRhythm(c, OPTS);
    expect(r.overCount).toBe(0);
    const c2 = [cue(0, 1000, '五五五五五', 0)]; // 恰好 5/秒
    expect(analyzeRhythm(c2, OPTS).overCount).toBe(0);
  });

  it('速率超上限、过短、过长分别识别', () => {
    const c = [
      cue(0, 1000, '字'.repeat(6), 0), // 6/s > 5
      cue(2000, 2300, '字', 1), // 300ms < 500ms
      cue(3000, 10_500, '字', 2), // 7500ms > 7000ms
      cue(11_000, 12_000, '字', 3), // 1/s，合规
    ];
    const r = analyzeRhythm(c, OPTS);
    expect(r.entries[0].tooFast).toBe(true);
    expect(r.entries[1].tooShort).toBe(true);
    expect(r.entries[2].tooLong).toBe(true);
    expect(r.entries[3].over).toBe(false);
    expect(r.overCount).toBe(3);
  });

  it('连续超限项划为同一区段，合规项分隔', () => {
    const c = [
      cue(0, 300, '字'.repeat(4), 0), // 13.3/s 超限
      cue(500, 800, '字'.repeat(4), 1), // 连续超限（间隔 200）
      cue(2000, 4000, '慢'.repeat(2), 2), // 1/s 合规
      cue(4200, 4500, '字'.repeat(4), 3), // 新一段
    ];
    const r = analyzeRhythm(c, OPTS);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].members).toEqual([0, 1]);
    expect(r.segments[1].members).toEqual([3]);
    expect(r.segments[0].key).toBe('0-1');
  });
});

describe('区段修复', () => {
  it('利用后空隙延长时长使速率达标，不碰前边界', () => {
    // 首条 500ms 内 5 字（10/s），与下一条间隔 2000ms
    const cues = [
      cue(0, 500, '字'.repeat(5), 0),
      cue(2500, 3500, '字'.repeat(2), 1),
    ];
    const r = analyzeRhythm(cues, OPTS);
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0];
    expect(seg.members).toEqual([0]);
    expect(seg.fixes).not.toBeNull();
    expect(seg.useLeadMs).toBe(0);
    expect(seg.useTrailMs).toBe(500); // 需要 1000ms，原 500ms，后空隙 2000ms 够用 500
    expect(seg.fixes![0]).toMatchObject({ start: 0, end: 1000 });
    // 不与下一条重叠
    expect(seg.fixes![0].end).toBeLessThanOrEqual(cues[1].start);
    expect(seg.fixes![0].cps).toBeLessThanOrEqual(5);
  });

  it('后空隙不足时联动前移首条开始占用前空隙', () => {
    const cues = [
      cue(0, 2000, '慢', 0), // 合规，结束 2000
      cue(2200, 2700, '字'.repeat(5), 1), // 500ms 5 字；前空隙 200，后空隙 300
      cue(3000, 5000, '慢', 2),
    ];
    const r = analyzeRhythm(cues, OPTS);
    const seg = r.segments[0];
    expect(seg.members).toEqual([1]);
    expect(seg.fixes).not.toBeNull();
    // 需要 1000ms；后空隙 300 先用，再前移 200（前空隙 200 全用）
    expect(seg.useTrailMs).toBe(300);
    expect(seg.useLeadMs).toBe(200);
    const f = seg.fixes![0];
    expect(f.start).toBe(2000);
    expect(f.end).toBe(3000);
    expect(f.start).toBeGreaterThanOrEqual(cues[0].end);
    expect(f.end).toBeLessThanOrEqual(cues[2].start);
  });

  it('多条区段内部重新分配边界并预留间隔，全程不重叠', () => {
    // 两条各 400ms/4 字（10/s），各需 800ms；前面合规留 400 前空隙、
    // 后面合规留 800 后空隙，原占用 800ms → 窗口 2001ms 足够 1601ms
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(1400, 1800, '字'.repeat(4), 1),
      cue(1800, 2200, '字'.repeat(4), 2),
      cue(3000, 4000, '慢', 3),
    ];
    const r = analyzeRhythm(cues, OPTS);
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0];
    expect(seg.members).toEqual([1, 2]);
    expect(seg.fixes).not.toBeNull();
    const [f1, f2] = seg.fixes!;
    expect(f1.durMs).toBe(800);
    expect(f2.durMs).toBe(800);
    expect(f2.start - f1.end).toBe(RHYTHM_EPS_MS);
    expect(f1.start).toBeGreaterThanOrEqual(cues[0].end);
    expect(f2.end).toBeLessThanOrEqual(cues[3].start);
  });

  it('空隙总量不足时标记无解并给出缺口', () => {
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(1000, 1400, '字'.repeat(4), 1), // 前空隙 0、占用 400
      cue(1600, 3000, '慢', 2), // 后空隙 200 → 窗口 600 < 需要 800
    ];
    const r = analyzeRhythm(cues, OPTS);
    const seg = r.segments[0];
    expect(seg.fixes).toBeNull();
    expect(seg.shortfallMs).toBe(200); // 需要 800ms，窗口 600ms
  });

  it('首条之前最多前移到时间 0：后空隙不足时受时间原点约束', () => {
    // 首条开始 400，前向最多 400；后空隙 0；需要 800ms → 前移 400 至 0
    const cues = [
      cue(400, 800, '字'.repeat(4), 0),
      cue(800, 2000, '慢', 1),
    ];
    const r = analyzeRhythm(cues, OPTS);
    const seg = r.segments[0];
    expect(seg.fixes).not.toBeNull();
    expect(seg.fixes![0].start).toBe(0);
    expect(seg.fixes![0].end).toBe(800);
  });

  it('首条后空隙与前向空间都不足时无解（不会产生负时间）', () => {
    const cues = [
      cue(200, 400, '字'.repeat(4), 0), // 前向 200，占用 200，后空隙 100 → 窗口 500 < 800
      cue(500, 2000, '慢', 1),
    ];
    const r = analyzeRhythm(cues, OPTS);
    expect(r.segments[0].fixes).toBeNull();
    expect(r.segments[0].shortfallMs).toBe(300);
  });

  it('末条之后无界：可自由后移', () => {
    const cues = [cue(5000, 5400, '字'.repeat(4), 0)];
    const r = analyzeRhythm(cues, OPTS);
    const seg = r.segments[0];
    expect(seg.fixes).not.toBeNull();
    const f = seg.fixes![0];
    expect(f.start).toBe(5000);
    expect(f.end).toBe(5800);
  });

  it('过短修复同样受最短时长托底', () => {
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(1000, 1200, '字', 1), // 200ms，仅过短
      cue(2000, 3000, '慢', 2),
    ];
    const r = analyzeRhythm(cues, OPTS);
    const f = r.segments[0].fixes![0];
    expect(f.durMs).toBe(500);
    expect(f.start).toBe(1000);
    expect(f.end).toBe(1500);
  });

  it('过长条目缩短后与邻居不重叠', () => {
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(2000, 10_000, '慢', 1), // 8000ms > 7000ms
      cue(11_000, 12_000, '慢', 2),
    ];
    const r = analyzeRhythm(cues, OPTS);
    const seg = r.segments[0];
    expect(seg.members).toEqual([1]);
    expect(seg.fixes).not.toBeNull();
    const f = seg.fixes![0];
    // 最短需求 500ms：保持首边界，末条结束提前
    expect(f.start).toBe(2000);
    expect(f.end).toBe(2500);
    expect(f.end).toBeLessThanOrEqual(cues[2].start);
  });

  it('单条文本在最长时长内也无法满足速率时标记无解并说明', () => {
    const opts: RhythmOptions = { maxCps: 5, minMs: 500, maxMs: 1000 };
    const cues = [cue(0, 500, '字'.repeat(10), 0)]; // 至少 2000ms > maxMs 1000
    const r = analyzeRhythm(cues, opts);
    const seg = r.segments[0];
    expect(seg.fixes).toBeNull();
    expect(seg.reason).toContain('最长');
  });

  it('零时长条目判超限且可修复', () => {
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(1000, 1000, '字'.repeat(3), 1), // 零时长
      cue(2000, 3000, '慢', 2),
    ];
    const r = analyzeRhythm(cues, OPTS);
    expect(r.entries[1].tooFast).toBe(true);
    const seg = r.segments[0];
    // 前空隙 0、后空隙 1000；需要 600ms（3字/5 + 托底）→ 后移
    expect(seg.fixes).not.toBeNull();
    expect(seg.fixes![0].durMs).toBe(600);
  });
});

describe('区段独立性', () => {
  it('两个区段共用的合规邻居时间不被修改，各自修复不冲突', () => {
    const cues = [
      cue(2000, 2400, '字'.repeat(4), 0), // 超限（前向空间充足）
      cue(2400, 4000, '慢', 1), // 合规
      cue(4000, 4400, '字'.repeat(4), 2), // 超限，位于末尾（后无界）
    ];
    const r = analyzeRhythm(cues, OPTS);
    expect(r.segments).toHaveLength(2);
    const out = applyRhythmFixes(cues, r, new Set(r.segments.map((s) => s.key)));
    expect(out[1]).toEqual(cues[1]); // 邻居原样
    // 两条修复都不跨过/重叠合规邻居
    expect(out[0].end).toBeLessThanOrEqual(cues[1].start);
    expect(out[2].start).toBeGreaterThanOrEqual(cues[1].end);
    // 全局时间不重叠
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
  });
});

describe('applyRhythmFixes / liveRhythmKeys', () => {
  it('仅采纳区段的成员时间被替换，文本与顺序不变', () => {
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(1000, 1400, '字'.repeat(4), 1),
      cue(2400, 4000, '慢', 2), // 后空隙 1000ms，足够修复
    ];
    const r = analyzeRhythm(cues, OPTS);
    const key = r.segments[0].key;
    const out = applyRhythmFixes(cues, r, new Set([key]));
    expect(out[0]).toBe(cues[0]);
    expect(out[2]).toBe(cues[2]);
    expect(out[1].text).toBe(cues[1].text);
    expect(out[1].groupIndex).toBe(1);
    expect(out[1].end - out[1].start).toBe(800);
  });

  it('未采纳时原样返回', () => {
    const cues = [cue(5000, 5400, '字'.repeat(4), 0)];
    const r = analyzeRhythm(cues, OPTS);
    expect(applyRhythmFixes(cues, r, new Set())).toEqual(cues);
  });

  it('失效 key（上游结果或参数变化后）自动忽略', () => {
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(1000, 1400, '字'.repeat(4), 1),
      cue(2400, 4000, '慢', 2),
    ];
    const r = analyzeRhythm(cues, OPTS);
    expect(applyRhythmFixes(cues, r, new Set(['stale-key', '1-2']))).toEqual(cues);
    expect(liveRhythmKeys(r, new Set(['stale-key', r.segments[0].key]))).toEqual(
      new Set([r.segments[0].key]),
    );
  });

  it('无解区段不进入 live 集合，应用时不产生半修复', () => {
    const cues = [
      cue(0, 1000, '慢', 0),
      cue(1000, 1400, '字'.repeat(4), 1),
      cue(1400, 3000, '慢', 2),
    ];
    const r = analyzeRhythm(cues, OPTS);
    expect(r.segments[0].fixes).toBeNull();
    expect(liveRhythmKeys(r, new Set([r.segments[0].key]))).toEqual(new Set());
    expect(applyRhythmFixes(cues, r, new Set([r.segments[0].key]))).toEqual(cues);
  });
});

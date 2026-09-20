/**
 * 阅读节奏：在已消重、断行后的字幕上统计每条显示时长与字符/秒，
 * 并对连续超限区段做“仅调整时间边界”的可行修复。
 *
 * 规则（不修改文本、不打乱顺序）：
 * - 字符数按 Unicode 字素簇统计（与断行页同一口径）；HTML（<...>）与
 *   ASS（{...}）标签不计入，换行与其他空白也不计入。
 * - 速率 = 字数 / (时长毫秒 / 1000)。一条记录超限当且仅当：
 *   速率 > maxCps、时长 < minMs 或 时长 > maxMs。
 * - 连续的超限条目组成一个区段；修复时只允许整体平移区段并重新分配
 *   区段内部边界，所需额外空间来自区段前后空隙：
 *     前空隙 = 区段首条开始 − 上一条结束（首条之前最多前移到时间 0）
 *     后空隙 = 下一条开始 − 区段末条结束（末条之后无界）
 *   两个边界空隙都允许被完全利用（修复后相邻条目首尾相接、不重叠）。
 * - 区段内部必须保持严格有序且不重叠：相邻边界预留 epsMs 毫秒。
 * - 修复后每条都要同时满足三项限制；无法满足（最短总时长超过
 *   可占用窗口）时标记无解，并给出缺口毫秒数。
 *
 * 区段彼此独立：相邻区段之间至少隔着一条合规条目，空隙计算只使用
 * 该合规条目的原始时间（其时间永不被调整），因此逐段修复不会相互挤占。
 */
import { graphemes } from './wrap';

export interface RhythmOptions {
  /** 最大字符/秒（恰等于上限不超限） */
  maxCps: number;
  /** 最短显示时长（毫秒） */
  minMs: number;
  /** 最长显示时长（毫秒） */
  maxMs: number;
}

export interface RhythmCue {
  start: number;
  end: number;
  text: string;
  /** 所属对齐组（用于采纳状态键与回跳定位） */
  groupIndex: number;
}

export interface RhythmEntry {
  /** 在当前 cue 序列中的下标 */
  index: number;
  chars: number;
  /** 显示时长（毫秒） */
  durMs: number;
  /** 字符/秒 */
  cps: number;
  /** 各项原始口径是否超限 */
  tooFast: boolean;
  tooShort: boolean;
  tooLong: boolean;
  over: boolean;
}

export interface RhythmFix {
  index: number;
  start: number;
  end: number;
  durMs: number;
  cps: number;
}

export interface RhythmSegment {
  /** 稳定标识：成员 groupIndex 以 '-' 连接（与滚动链 key 同口径） */
  key: string;
  /** 成员 cue 下标（连续升序） */
  members: number[];
  /** 建议的修复时间（与 members 一一对应）；无解时为 null */
  fixes: RhythmFix[] | null;
  /** 无解时，距离满足限制尚缺的毫秒数（总需求 − 可占用窗口；固有矛盾时为 0） */
  shortfallMs: number;
  /** 无解的补充说明（如单条文本在最长时长内也无法满足速率上限） */
  reason: string | null;
  /** 修复占用的前空隙毫秒数（首条开始前移量） */
  useLeadMs: number;
  /** 修复占用的后空隙毫秒数（末条结束后移量） */
  useTrailMs: number;
}

export interface RhythmReport {
  entries: RhythmEntry[];
  segments: RhythmSegment[];
  overCount: number;
}

/** 区段内部相邻条目之间预留的最小间隔（毫秒，保证边界严格有序） */
export const RHYTHM_EPS_MS = 1;

const TAG_RE = /<[^>]*>|\{[^}]*\}/g;
const SPACE_RE = /^\s$/u;

/** 阅读节奏的字符口径：去标签、去空白后的 Unicode 字素簇数。 */
export function countReadingChars(text: string): number {
  const plain = text.replace(TAG_RE, '');
  let n = 0;
  for (const g of graphemes(plain)) {
    if (g.length > 0 && !SPACE_RE.test(g)) n++;
  }
  return n;
}

function rate(chars: number, durMs: number): number {
  if (chars === 0) return 0;
  if (durMs <= 0) return Infinity;
  return chars / (durMs / 1000);
}

export function analyzeRhythm(cues: readonly RhythmCue[], options: RhythmOptions): RhythmReport {
  const maxCps = Math.max(0.1, options.maxCps);
  const minMs = Math.max(1, Math.round(options.minMs));
  const maxMs = Math.max(minMs, Math.round(options.maxMs));
  const opts = { maxCps, minMs, maxMs };

  const entries: RhythmEntry[] = cues.map((c, index) => {
    const chars = countReadingChars(c.text);
    const durMs = c.end - c.start;
    const cps = rate(chars, durMs);
    const tooFast = chars > 0 && cps > maxCps;
    const tooShort = durMs < minMs;
    const tooLong = durMs > maxMs;
    return { index, chars, durMs, cps, tooFast, tooShort, tooLong, over: tooFast || tooShort || tooLong };
  });

  const segments: RhythmSegment[] = [];
  const n = cues.length;
  let i = 0;
  while (i < n) {
    if (!entries[i].over) {
      i++;
      continue;
    }
    const a = i;
    while (i + 1 < n && entries[i + 1].over) i++;
    segments.push(buildSegment(cues, a, i, opts));
    i++;
  }

  return { entries, segments, overCount: entries.reduce((s, e) => s + (e.over ? 1 : 0), 0) };
}

/** 单条满足速率与最短时长所需的最短时长（毫秒，向上取整）。 */
function neededDur(chars: number, opts: { maxCps: number; minMs: number }): number {
  const byRate = chars > 0 ? Math.ceil((chars / opts.maxCps) * 1000) : 0;
  return Math.max(opts.minMs, byRate);
}

function buildSegment(
  cues: readonly RhythmCue[],
  a: number,
  b: number,
  opts: { maxCps: number; minMs: number; maxMs: number },
): RhythmSegment {
  const m = b - a + 1;
  const members = Array.from({ length: m }, (_, k) => a + k);
  const key = members.map((idx) => cues[idx].groupIndex).join('-');
  const rawNeeds = members.map((idx) =>
    neededDur(countReadingChars(cues[idx].text), opts),
  );
  // 单条固有矛盾：即使给满最长时长，速率仍超上限
  const impossible = members.findIndex((_, k) => rawNeeds[k] > opts.maxMs);
  if (impossible >= 0) {
    const idx = members[impossible];
    const chars = countReadingChars(cues[idx].text);
    return {
      key,
      members,
      fixes: null,
      shortfallMs: 0,
      reason: `第 ${idx + 1} 条 ${chars} 字，在最长 ${opts.maxMs}ms 内最快也需 ${rawNeeds[impossible]}ms，放宽最长时长或提高字符/秒上限后才可能修复`,
      useLeadMs: 0,
      useTrailMs: 0,
    };
  }
  const needs = rawNeeds;

  const innerGap = RHYTHM_EPS_MS * (m - 1);
  const totalNeed = needs.reduce((s, v) => s + v, 0) + innerGap;
  const origSpan = cues[b].end - cues[a].start;

  // 与相邻条目的空隙（带符号：输入本身重叠时为负）。首条之前没有字幕，
  // 且 SRT 时间不得早于 0，故前向最多前移到时间原点；末条之后无界。
  const leadGap = a > 0 ? cues[a].start - cues[a - 1].end : Math.max(0, cues[a].start);
  const trailGap = b + 1 < cues.length ? cues[b + 1].start - cues[b].end : Infinity;

  // 可占用窗口 = 前边界 → 下一条开始（或末条之后无界）
  const feasible = !Number.isFinite(trailGap) ? true : totalNeed <= leadGap + origSpan + trailGap;

  if (!feasible) {
    return {
      key,
      members,
      fixes: null,
      shortfallMs: totalNeed - (leadGap + origSpan + trailGap),
      reason: null,
      useLeadMs: 0,
      useTrailMs: 0,
    };
  }

  // 先占用后空隙（末条结束后移），不足部分再整体前移（占用前空隙）
  const extra = totalNeed - origSpan;
  const useTrailMs = Number.isFinite(trailGap)
    ? Math.min(Math.max(0, extra), Math.max(0, trailGap))
    : Math.max(0, extra);
  const useLeadMs = Math.min(Math.max(0, extra - useTrailMs), Math.max(0, leadGap));
  const firstStart = cues[a].start - useLeadMs;
  // 区段可能因“过长”条目而缩短（extra<0）：末条结束相应提前
  const lastEnd = firstStart + totalNeed;

  // 内部边界：自前向后逐条放入期望时长（相邻间隔 eps），末条收束到 lastEnd
  const fixes: RhythmFix[] = [];
  let cursor = firstStart;
  for (let k = 0; k < m; k++) {
    const idx = members[k];
    const start = cursor;
    const end = k === m - 1 ? lastEnd : start + needs[k];
    const durMs = end - start;
    const chars = countReadingChars(cues[idx].text);
    fixes.push({ index: idx, start: Math.round(start), end: Math.round(end), durMs, cps: rate(chars, durMs) });
    cursor = end + RHYTHM_EPS_MS;
  }

  return { key, members, fixes, shortfallMs: 0, reason: null, useLeadMs, useTrailMs };
}

/**
 * 按已采纳区段应用修复：命中的区段成员替换为修复时间，其余 cue 原样。
 * 已失效（当前分析中不存在或无解）的 key 自动忽略——上游结果或参数
 * 变化后，失效采纳不会污染预览与导出。
 */
export function applyRhythmFixes(
  cues: readonly RhythmCue[],
  report: RhythmReport,
  accepted: ReadonlySet<string>,
): RhythmCue[] {
  const fixByMember = new Map<number, RhythmFix>();
  for (const seg of report.segments) {
    if (!seg.fixes || !accepted.has(seg.key)) continue;
    for (const f of seg.fixes) fixByMember.set(f.index, f);
  }
  return cues.map((c, i) => {
    const f = fixByMember.get(i);
    return f ? { ...c, start: f.start, end: f.end } : c;
  });
}

/** 当前分析结果中仍然有效（存在、有解且被采纳）的 key 集合。 */
export function liveRhythmKeys(report: RhythmReport, accepted: ReadonlySet<string>): Set<string> {
  const live = new Set<string>();
  for (const seg of report.segments) {
    if (seg.fixes && accepted.has(seg.key)) live.add(seg.key);
  }
  return live;
}

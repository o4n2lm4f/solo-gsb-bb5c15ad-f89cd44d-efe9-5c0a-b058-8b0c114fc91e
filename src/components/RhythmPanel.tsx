import { useMemo } from 'react';
import type { RhythmCue, RhythmEntry, RhythmOptions, RhythmReport, RhythmSegment } from '../lib/rhythm';
import { liveRhythmKeys } from '../lib/rhythm';
import { formatTimecode } from '../lib/srt';

interface RhythmPanelProps {
  /** 当前已采纳消重并应用断行后的字幕（阅读节奏的输入） */
  cues: RhythmCue[];
  report: RhythmReport;
  accepted: ReadonlySet<string>;
  options: RhythmOptions;
  onOptions(next: RhythmOptions): void;
  onAccept(key: string): void;
  onRestore(key: string): void;
  onAcceptAll(keys: string[]): void;
  onRestoreAll(): void;
}

type SegStatus = 'applied' | 'ready' | 'impossible';

function statusOf(seg: RhythmSegment, live: ReadonlySet<string>): SegStatus {
  if (!seg.fixes) return 'impossible';
  return live.has(seg.key) ? 'applied' : 'ready';
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '∞';
  const s = ms / 1000;
  return `${s.toFixed(2)}s`;
}

function fmtCps(cps: number): string {
  if (!Number.isFinite(cps)) return '∞';
  return cps.toFixed(1);
}

/** 把毫秒编辑值（秒）安全夹取 */
function parseSec(raw: string, fallback: number, lo: number, hi: number): number {
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) * 1000 : fallback;
}

function overTags(e: RhythmEntry) {
  const tags: { cls: string; text: string }[] = [];
  if (e.tooFast) tags.push({ cls: 'red', text: `过快 ${fmtCps(e.cps)}/s` });
  if (e.tooShort) tags.push({ cls: 'amber', text: '过短' });
  if (e.tooLong) tags.push({ cls: 'amber', text: '过长' });
  if (!e.over) tags.push({ cls: 'ok', text: '合规' });
  return tags;
}

export function RhythmPanel(props: RhythmPanelProps) {
  const { cues, report, accepted, options } = props;

  const live = useMemo(() => liveRhythmKeys(report, accepted), [report, accepted]);
  const readyKeys = report.segments.filter((s) => s.fixes && !live.has(s.key)).map((s) => s.key);
  const impossibleCount = report.segments.filter((s) => !s.fixes).length;

  // 当前超限项中尚未被有效采纳覆盖的数量（页签徽标口径）
  const fixedMembers = useMemo(() => {
    const set = new Set<number>();
    report.segments.forEach((s) => {
      if (s.fixes && live.has(s.key)) s.members.forEach((m) => set.add(m));
    });
    return set;
  }, [report, live]);
  const remaining = report.entries.filter((e) => e.over && !fixedMembers.has(e.index)).length;

  const setOpts = (patch: Partial<RhythmOptions>) => props.onOptions({ ...options, ...patch });

  return (
    <section className="wrap-panel rhythm-panel">
      <div className="wrap-settings">
        <label>
          最大字符/秒
          <input
            type="number"
            min={0.5}
            max={50}
            step={0.5}
            value={options.maxCps}
            onChange={(e) =>
              setOpts({ maxCps: parseNum(e.target.value, options.maxCps, 0.5, 50) })
            }
          />
        </label>
        <label>
          最短时长（秒）
          <input
            type="number"
            min={0.1}
            max={10}
            step={0.1}
            value={options.minMs / 1000}
            onChange={(e) =>
              setOpts({ minMs: parseSec(e.target.value, options.minMs / 1000, 0.1, 10) })
            }
          />
        </label>
        <label>
          最长时长（秒）
          <input
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            value={options.maxMs / 1000}
            onChange={(e) =>
              setOpts({ maxMs: parseSec(e.target.value, options.maxMs / 1000, 0.5, 30) })
            }
          />
        </label>
        <span className="spacer" />
        <button className="btn sm accent" disabled={readyKeys.length === 0} onClick={() => props.onAcceptAll(readyKeys)}>
          全部采纳（{readyKeys.length}）
        </button>
        <button className="btn sm" disabled={live.size === 0} onClick={props.onRestoreAll}>
          全部恢复
        </button>
      </div>

      <div className="wrap-summary">
        共 {cues.length} 条 · 超限 {report.overCount} 条 · {report.segments.length} 个连续区段 ·
        已采纳 {live.size} 段{remaining > 0 && <> · 待处理 {remaining} 条</>}
        {impossibleCount > 0 && <em> · {impossibleCount} 个区段无解</em>}
        <span className="wrap-hint">
          字数按 Unicode 字素簇计（去标签/空白）；修复只调整区段时间边界，不改文本、不打乱顺序，占用前后空隙且不重叠
        </span>
      </div>

      <div className="wrap-list">
        {cues.length === 0 && <div className="empty">当前没有可分析的合并结果。</div>}
        {cues.length > 0 && report.segments.length === 0 && (
          <div className="empty rhythm-ok">✓ 当前全部条目均在阅读节奏限制内，无需调整。</div>
        )}

        {report.segments.map((seg, si) => {
          const st = statusOf(seg, live);
          return (
            <article key={seg.key} className={`wrap-entry rhythm-seg ${st}`}>
              <div className="we-head">
                <span className="g-idx">区段 {si + 1}</span>
                <span className="cue-time">
                  {formatTimecode(cues[seg.members[0]].start)} → {formatTimecode(cues[seg.members[seg.members.length - 1]].end)}
                </span>
                <span className="tag dim">{seg.members.length} 条连续超限</span>
                {seg.fixes && (
                  <span className="tag dim" title="修复占用的前后空隙">
                    前空隙 {fmtMs(seg.useLeadMs)} · 后空隙 {fmtMs(seg.useTrailMs)}
                  </span>
                )}
                <span className="spacer" />
                <span className={`tag ${st === 'applied' ? 'ok' : st === 'ready' ? 'go' : 'red'}`}>
                  {st === 'applied' ? '已采纳' : st === 'ready' ? '可修复' : '无解'}
                </span>
                {st === 'ready' && (
                  <button className="btn sm accent" onClick={() => props.onAccept(seg.key)}>
                    采纳
                  </button>
                )}
                {st === 'applied' && (
                  <button className="btn sm" onClick={() => props.onRestore(seg.key)}>
                    恢复
                  </button>
                )}
              </div>

              {!seg.fixes && (
                <div className="we-fail">
                  ⚠ 无可行修复：前后空隙不足以让区段内每条同时满足限制
                  {seg.shortfallMs > 0 && <>（尚缺 {fmtMs(seg.shortfallMs)}）</>}
                  {seg.reason && <div className="rhythm-reason">{seg.reason}</div>}
                </div>
              )}

              <div className="rhythm-table-wrap">
                <table className="rhythm-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>原时间</th>
                      <th>原时长</th>
                      <th>原速率</th>
                      <th />
                      <th>新时间</th>
                      <th>新时长</th>
                      <th>新速率</th>
                      <th>文本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seg.members.map((mi, k) => {
                      const e = report.entries[mi];
                      const f = seg.fixes?.[k];
                      const cue = cues[mi];
                      const delta = f ? f.durMs - e.durMs : 0;
                      return (
                        <tr key={mi} className={st === 'applied' ? 'rhythm-live' : ''}>
                          <td className="rh-idx">{mi + 1}</td>
                          <td className="rh-time">
                            {formatTimecode(cue.start)}
                            <br />
                            {formatTimecode(cue.end)}
                          </td>
                          <td className="rh-num">
                            {fmtMs(e.durMs)}
                            <div className="rh-tags">
                              {overTags(e).map((t, ti) => (
                                <span key={ti} className={`rtag ${t.cls}`}>{t.text}</span>
                              ))}
                            </div>
                          </td>
                          <td className={`rh-num ${e.tooFast ? 'red' : ''}`}>{fmtCps(e.cps)}</td>
                          <td className="rh-arrow">{f ? (delta === 0 ? '=' : delta > 0 ? '→+扩展' : '→−收缩') : '—'}</td>
                          <td className="rh-time">
                            {f ? (
                              <>
                                {formatTimecode(f.start)}
                                <br />
                                {formatTimecode(f.end)}
                              </>
                            ) : (
                              <span className="rh-na">—</span>
                            )}
                          </td>
                          <td className="rh-num">{f ? fmtMs(f.durMs) : '—'}</td>
                          <td className={`rh-num ${f && f.cps > options.maxCps ? 'red' : ''}`}>
                            {f ? fmtCps(f.cps) : '—'}
                          </td>
                          <td className="rh-text">
                            <span>{cue.text}</span>
                            <em>{e.chars} 字素</em>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function parseNum(raw: string, fallback: number, lo: number, hi: number): number {
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

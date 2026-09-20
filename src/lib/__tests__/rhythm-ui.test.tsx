import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RhythmPanel } from '../../components/RhythmPanel';
import { analyzeRhythm, type RhythmCue, type RhythmOptions } from '../rhythm';

const noop = () => {};

const OPTS: RhythmOptions = { maxCps: 5, minMs: 500, maxMs: 7000 };

function makeCues(): RhythmCue[] {
  return [
    { start: 0, end: 2000, text: '慢速字幕一条', groupIndex: 0 },
    // 连续两条过快，前后空隙足以修复
    { start: 2200, end: 2600, text: '字'.repeat(6), groupIndex: 1 },
    { start: 2600, end: 3000, text: '字'.repeat(6), groupIndex: 2 },
    { start: 5000, end: 7000, text: '结尾合规', groupIndex: 3 },
  ];
}

describe('RhythmPanel 渲染冒烟', () => {
  it('展示区段、原/新时间速率列与采纳按钮', () => {
    const cues = makeCues();
    const report = analyzeRhythm(cues, OPTS);
    expect(report.segments.length).toBeGreaterThan(0);
    const html = renderToString(
      <RhythmPanel
        cues={cues}
        report={report}
        accepted={new Set()}
        options={OPTS}
        onOptions={noop}
        onAccept={noop}
        onRestore={noop}
        onAcceptAll={noop}
        onRestoreAll={noop}
      />,
    );
    expect(html).toContain('最大字符/秒');
    expect(html).toContain('最短时长');
    expect(html).toContain('最长时长');
    expect(html).toContain('原速率');
    expect(html).toContain('新速率');
    expect(html).toContain('采纳');
    expect(html).toContain('全部采纳');
    expect(html).toContain('全部恢复');
  });

  it('全部合规则提示无需调整', () => {
    const cues: RhythmCue[] = [
      { start: 0, end: 3000, text: '慢', groupIndex: 0 },
      { start: 4000, end: 6000, text: '慢', groupIndex: 1 },
    ];
    const report = analyzeRhythm(cues, OPTS);
    const html = renderToString(
      <RhythmPanel
        cues={cues}
        report={report}
        accepted={new Set()}
        options={OPTS}
        onOptions={noop}
        onAccept={noop}
        onRestore={noop}
        onAcceptAll={noop}
        onRestoreAll={noop}
      />,
    );
    expect(html).toContain('无需调整');
  });

  it('无解区段显示缺口与无解标记，且无采纳按钮', () => {
    const cues: RhythmCue[] = [
      { start: 0, end: 1000, text: '慢', groupIndex: 0 },
      { start: 1000, end: 1400, text: '字'.repeat(6), groupIndex: 1 },
      { start: 1600, end: 3000, text: '慢', groupIndex: 2 },
    ];
    const report = analyzeRhythm(cues, OPTS);
    expect(report.segments[0].fixes).toBeNull();
    const html = renderToString(
      <RhythmPanel
        cues={cues}
        report={report}
        accepted={new Set()}
        options={OPTS}
        onOptions={noop}
        onAccept={noop}
        onRestore={noop}
        onAcceptAll={noop}
        onRestoreAll={noop}
      />,
    );
    expect(html).toContain('无解');
    expect(html).toContain('无可行修复');
  });
});

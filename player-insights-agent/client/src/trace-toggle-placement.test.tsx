import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TraceStage } from './answer-shape';
import { StageDetail } from './TraceDag';
import { PayloadView } from './TraceTimeline';
import { partial } from './styles/stylesheet';

const TIMELINE = readFileSync(new URL('./TraceTimeline.tsx', import.meta.url), 'utf8');
const DAG = readFileSync(new URL('./TraceDag.tsx', import.meta.url), 'utf8');
const DETAILS = readFileSync(new URL('./RunDetails.tsx', import.meta.url), 'utf8');
const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const ANSWER_CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const MONITORING = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');
const TIMELINE_CSS = partial('timeline.css');
const TRACE_CSS = partial('trace.css');
const STAGE_DETAIL = DAG.slice(DAG.indexOf('export function StageDetail'), DAG.indexOf('\nfunction RawIo'));

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

function stage(overrides: Partial<TraceStage> = {}): TraceStage {
  return {
    id: 'step-12-1-run_sql',
    name: 'Queried governed data for an intentionally long stage title that must share narrow space safely',
    kind: 'tool',
    start: 120,
    duration: 2_400,
    status: 'complete',
    calls: 1,
    input: '{"sql":"SELECT title FROM governed_titles"}',
    output: 'title|players\nHoops|1200',
    ...overrides,
  };
}

describe('shared trace payload pane headers', () => {
  it('puts independent Arguments and Result controls in their own labeled headers', () => {
    const markup = renderToStaticMarkup(
      <>
        <PayloadView label="Arguments" text={'{"question":"How many players?"}'} />
        <PayloadView
          label="Result"
          text="players|count&#10;active|1200"
        />
      </>
    );

    expect(markup.match(/class="trace-payload-head"/g)).toHaveLength(2);
    expect(markup.match(/role="group"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="How to show arguments"');
    expect(markup).toContain('aria-label="How to show result"');
    expect(markup.match(/<button type="button" aria-pressed="true">Rendered<\/button>/g)).toHaveLength(2);
    expect(markup.match(/<button type="button" aria-pressed="false">Raw<\/button>/g)).toHaveLength(2);

    for (const label of ['Arguments', 'Result']) {
      const pane = markup.slice(markup.indexOf(`aria-label="${label} payload"`));
      expect(pane.indexOf('trace-payload-head')).toBeLessThan(pane.indexOf('trace-payload-body'));
      expect(pane.indexOf(`>${label}</strong>`)).toBeLessThan(pane.indexOf('role="group"'));
    }
  });

  it('keeps a missing payload labeled without inventing a view toggle', () => {
    const markup = renderToStaticMarkup(<PayloadView label="Output" text="" />);

    expect(markup).toContain('aria-label="Output payload"');
    expect(markup).toContain('<strong class="trace-payload-label">Output</strong>');
    expect(markup).toContain('(none recorded)');
    expect(markup).not.toContain('role="group"');
  });

  it('uses one shared renderer on timeline, Advanced, replay, and Monitoring paths', () => {
    expect(TIMELINE).toContain('<PayloadView label="Arguments"');
    expect(TIMELINE).toContain('<PayloadView label="Result"');
    expect(DETAILS).toContain('<PayloadView label="Input"');
    expect(DETAILS).toContain('<PayloadView label="Output"');
    expect(EXPLORER).toContain('<TraceTimeline');
    expect(EXPLORER).toContain('<RunDetails');
    expect(EXPLORER).toContain('<TraceDag');
    expect(ANSWER_CARD).toContain('<TraceTimeline');
    expect(MONITORING).toContain('<AnswerCard');
    expect(MONITORING).not.toContain('<TraceTimeline');
  });

  it('wraps only at the header while keeping the segmented control high and right', () => {
    expect(rule(TIMELINE_CSS, '.trace-payload-head')).toMatch(/display: flex[\s\S]*flex-wrap: wrap[\s\S]*min-width: 0/);
    expect(rule(TIMELINE_CSS, '.trace-payload-label')).toMatch(/flex: 1 1 8rem[\s\S]*min-width: 0/);
    expect(rule(TIMELINE_CSS, '.trace-payload-actions')).toMatch(
      /flex-wrap: wrap[\s\S]*justify-content: flex-end[\s\S]*margin-left: auto/
    );
    expect(rule(TIMELINE_CSS, '.trace-payload-seg')).toMatch(/flex: none/);
    expect(TIMELINE_CSS).not.toContain('.trace-payload-meta');
  });
});

describe('Agent Map selected-stage result header', () => {
  it('places the Result control before the result body and scopes it by name', () => {
    const markup = renderToStaticMarkup(<StageDetail stage={stage()} step={12} origin={0} id="detail" />);
    const result = markup.slice(markup.indexOf('<dt>Result</dt>'));
    const headerEnd = result.indexOf('</div></div>');

    expect(result).toContain('class="dag-detail-pane dag-detail-result"');
    expect(result).toContain('class="dag-detail-pane-head"');
    expect(result).toContain('aria-label="How to show this result"');
    expect(result.indexOf('class="dag-seg"')).toBeLessThan(headerEnd);
    expect(headerEnd).toBeLessThan(result.indexOf('class="dag-result-table"'));
    expect(result).not.toMatch(/dag-result-table[^]*dag-result-meta/);
  });

  it('keeps long identity and timing rows collision-safe at narrow widths', () => {
    const markup = renderToStaticMarkup(<StageDetail stage={stage()} step={12} origin={0} id="detail" />);

    expect(markup).toContain(stage().name);
    expect(rule(TRACE_CSS, '.trace-dag.map .dag-detail-head')).toMatch(/flex-wrap: wrap[\s\S]*min-width: 0/);
    expect(rule(TRACE_CSS, '.trace-dag.map .dag-detail-head strong')).toMatch(/flex: 1 1 16rem[\s\S]*min-width: 0/);
    expect(rule(TRACE_CSS, '.trace-dag.map .dag-detail-pane-head')).toMatch(/flex-wrap: wrap[\s\S]*min-width: 0/);
    expect(rule(TRACE_CSS, '.trace-dag.map .dag-result-meta')).toMatch(
      /flex-wrap: wrap[\s\S]*justify-content: flex-end[\s\S]*margin-left: auto/
    );
  });

  it('omits absent panes and leaves the toggle out of body-rendering branches', () => {
    const empty = renderToStaticMarkup(
      <StageDetail stage={stage({ input: '', output: '' })} step={12} origin={0} id="detail" />
    );

    expect(empty).not.toContain('<dt>Arguments</dt>');
    expect(empty).not.toContain('<dt>Result</dt>');
    expect(STAGE_DETAIL.match(/className="dag-seg"/g)).toHaveLength(1);
    expect(STAGE_DETAIL.indexOf('className="dag-seg"')).toBeLessThan(STAGE_DETAIL.indexOf('{raw ? ('));
  });
});

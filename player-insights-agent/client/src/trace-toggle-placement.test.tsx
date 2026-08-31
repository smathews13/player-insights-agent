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
    input: '{"question":"How many governed titles?","sql":"SELECT title FROM governed_titles"}',
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

  it('keeps the control in the pane header for an empty JSON object', () => {
    const markup = renderToStaticMarkup(<PayloadView label="Arguments" text="{}" />);

    expect(markup).toMatch(/trace-payload-head[^]*How to show arguments[^]*<\/header><div class="trace-payload-body">/);
    expect(markup).toContain('<p>{}</p>');
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
  it('places both payloads outside the evidence grid with controls before their bodies', () => {
    const markup = renderToStaticMarkup(<StageDetail stage={stage()} step={12} origin={0} id="detail" />);

    expect(markup).not.toContain('<dt>Arguments</dt>');
    expect(markup).not.toContain('<dt>Result</dt>');
    expect(markup).toContain('class="dag-detail-payloads"');
    for (const label of ['Arguments', 'Result']) {
      const pane = markup.slice(markup.indexOf(`aria-label="${label} payload"`));
      expect(pane.indexOf('trace-payload-head')).toBeLessThan(pane.indexOf('trace-payload-body'));
      expect(pane.indexOf(`aria-label="How to show ${label.toLowerCase()}"`)).toBeLessThan(
        pane.indexOf('trace-payload-body')
      );
    }
    expect(markup.indexOf('</dl>')).toBeLessThan(markup.indexOf('class="dag-detail-payloads"'));
    expect(markup.indexOf('aria-label="Result payload"')).toBeLessThan(markup.indexOf('class="dag-result-table"'));
  });

  it('keeps long identity and payload headers collision-safe at narrow widths', () => {
    const markup = renderToStaticMarkup(<StageDetail stage={stage()} step={12} origin={0} id="detail" />);

    expect(markup).toContain(stage().name);
    expect(rule(TRACE_CSS, '.trace-dag.map .dag-detail-head')).toMatch(/flex-wrap: wrap[\s\S]*min-width: 0/);
    expect(rule(TRACE_CSS, '.trace-dag.map .dag-detail-head strong')).toMatch(/flex: 1 1 16rem[\s\S]*min-width: 0/);
    expect(rule(TRACE_CSS, '.trace-dag.map .dag-detail-payloads')).toMatch(
      /display: grid[\s\S]*min-width: 0[\s\S]*padding: 0 14px 12px/
    );
    expect(rule(TIMELINE_CSS, '.trace-payload-actions')).toMatch(/justify-content: flex-end[\s\S]*margin-left: auto/);
  });

  it('omits absent panes and has no legacy definition-grid or map-only toggle wrappers', () => {
    const empty = renderToStaticMarkup(
      <StageDetail stage={stage({ input: '', output: '' })} step={12} origin={0} id="detail" />
    );

    expect(empty).not.toContain('aria-label="Arguments payload"');
    expect(empty).not.toContain('aria-label="Result payload"');
    expect(STAGE_DETAIL).not.toContain('<dt>{argumentsHeading}</dt>');
    expect(STAGE_DETAIL).not.toContain('<dt>Result</dt>');
    expect(STAGE_DETAIL).not.toContain('className="dag-seg"');
    expect(STAGE_DETAIL).not.toContain('className="dag-detail-pane');
  });
});

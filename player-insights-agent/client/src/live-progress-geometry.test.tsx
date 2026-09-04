import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { LiveProgress } from './LiveProgress';
import type { TraceStage } from './answer-shape';
import { partial } from './styles/stylesheet';

const LIVE_CSS = partial('live.css');
const PANEL = readFileSync(new URL('./LiveProgress.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return LIVE_CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function stage(index: number, overrides: Partial<TraceStage> = {}): TraceStage {
  return {
    id: `step-${index}-0-data_genie`,
    name: `Completed stage ${index}`,
    kind: 'tool',
    start: (index - 1) * 1_000,
    duration: 800,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    startMeasured: true,
    ...overrides,
  };
}

function progress(count: number, overrides: Partial<TraceStage> = {}): string {
  const stages = Array.from({ length: count }, (_, index) => stage(index + 1, index === count - 1 ? overrides : {}));
  return renderToStaticMarkup(
    <MemoryRouter>
      <LiveProgress stages={stages} openedAt={1_000} question="Which players overlap?" elapsedMs={12_000} />
    </MemoryRouter>
  );
}

/**
 * CSS percentages resolve against the containing answer card, independently of
 * list content. Keeping the arithmetic here makes these fixture comparisons a
 * geometry assertion rather than a string-only snapshot.
 */
function reservedWidth(containerWidth: number, markup: string): number {
  expect(markup).toContain('class="live-progress"');
  expect(rule('.live-progress')).toMatch(/width:\s*100%/);
  expect(rule('.live-steps')).toMatch(/width:\s*100%/);
  expect(rule('.live-step')).toMatch(/width:\s*100%/);
  return containerWidth;
}

describe('streamed progress geometry', () => {
  it('reserves identical pane and row width at one, three, and many stages', () => {
    const samples = [progress(1), progress(3), progress(21)];
    const widths = samples.map((markup) => reservedWidth(960, markup));

    expect(widths).toEqual([960, 960, 960]);
    expect(samples.map((markup) => markup.match(/<li class="live-step /g)?.length)).toEqual([1, 3, 21]);
    expect(rule('.live-step')).toMatch(/grid-template-columns:\s*46px minmax\(0,\s*1fr\)/);
  });

  it('contains long names, timing, code, and descriptions inside reserved tracks', () => {
    const long = 'catalog_schema_table_or_tool_name_'.repeat(12);
    const markup = progress(3, {
      name: long,
      input: JSON.stringify({ sql: `SELECT ${long} FROM ${long}` }),
      output: `${long} ${long}`,
      duration: 123_456,
    });

    expect(reservedWidth(960, markup)).toBe(960);
    expect(markup).toContain(long);
    expect(rule('.live-step-head')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\) 84px 168px 80px/);
    expect(rule('.live-step-head strong')).toMatch(/overflow:\s*hidden/);
    expect(rule('.live-step-head strong')).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule('.live-step-timing')).toMatch(/overflow:\s*hidden/);
    expect(rule('.live-step-detail')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.live-step-detail .semantic-sql-code--inline')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('delegates vertical scrolling to the full-width Ask pane on desktop and mobile', () => {
    expect(rule('.live-steps')).toMatch(/overflow:\s*visible/);
    expect(rule('.live-steps')).not.toMatch(/overflow-y:\s*(?:auto|scroll)|max-height|scrollbar-gutter/);

    const mobile = LIVE_CSS.slice(LIVE_CSS.indexOf('@container answer-card (max-width: 800px)'));
    expect(reservedWidth(320, progress(21))).toBe(320);
    expect(mobile).toMatch(/\.live-step-head\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(mobile).toMatch(
      /@container answer-card \(max-width: 480px\)[\s\S]*?grid-template-columns:\s*40px minmax\(0,\s*1fr\)/
    );
  });

  it('keeps centered splash seating without an independent follow scroller', () => {
    expect(rule('.pia-splash-run')).toMatch(/align-self:\s*stretch/);
    expect(rule('.pia-splash-run')).toMatch(/width:\s*100%/);
    expect(rule('.pia-splash-run')).toMatch(/max-width:\s*100%/);

    expect(PANEL).not.toContain('scrollTo(');
    expect(PANEL).not.toContain('onScroll=');
  });
});

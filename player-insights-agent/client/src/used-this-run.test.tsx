import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { QuestionDrawer } from './MonitoringPage';
import { UsedThisRun } from './UsedThisRun';
import {
  RUN_RUNTIME_LOOP_LABEL,
  RUN_RUNTIME_USED_ABSENT,
  RUN_RUNTIME_USED_HEADING,
  type RunRuntimeUsed,
} from '../../shared/run-runtime-used';
import type { MonitoringDetail } from '../../shared/monitoring-contract';

const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const MONITORING = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');

const SNAPSHOT: RunRuntimeUsed = {
  loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 },
  answer: {
    takeaway: true,
    narrative: true,
    figures: false,
    charts: false,
    narrativeMaxCharacters: 800,
    figuresOrder: 'totals-first',
  },
};

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('Settings applied in this run', () => {
  it('is the same wording on every surface that prints the row', () => {
    expect(RUN_RUNTIME_USED_HEADING).toBe('Settings applied in this run');
    expect(EXPLORER).toContain("from './UsedThisRun'");
    expect(EXPLORER).toContain('<UsedThisRun');
    expect(MONITORING).toContain("from './UsedThisRun'");
    expect(MONITORING).toContain('<UsedThisRun');
  });

  it('puts that same rail above the Agent map diagram, not a second copy of the numbers', () => {
    const mapPane = EXPLORER.slice(
      EXPLORER.indexOf('<TabsContent value="map"'),
      EXPLORER.indexOf('<TabsContent value="timeline"')
    );
    const railAt = mapPane.indexOf('<UsedThisRun used={runTrace?.runtimeUsed ?? null}');
    const diagramAt = mapPane.indexOf('<TraceDag');
    expect(railAt).toBeGreaterThan(-1);
    expect(diagramAt).toBeGreaterThan(railAt);
  });

  it('shows the budget, steps and tools that ask sent', () => {
    const rendered = text(renderToStaticMarkup(<UsedThisRun used={SNAPSHOT} />));
    expect(rendered).toContain(RUN_RUNTIME_USED_HEADING);
    expect(rendered).toContain(`${RUN_RUNTIME_LOOP_LABEL.maxSteps} 10`);
    expect(rendered).toContain(`${RUN_RUNTIME_LOOP_LABEL.maxToolCalls} 15`);
    expect(rendered).toContain(`${RUN_RUNTIME_LOOP_LABEL.maxRunSeconds} 200`);
    expect(rendered).toContain('Figures off');
    expect(rendered).toContain('Narrative cap 800');
    expect(rendered).toContain('Order Totals first');
    expect(rendered).not.toContain(RUN_RUNTIME_USED_ABSENT);
    expect(rendered).not.toContain('150');
  });

  it('says Not recorded when the run stored no snapshot, rather than inventing 12/12/150', () => {
    const rendered = text(renderToStaticMarkup(<UsedThisRun used={null} />));
    expect(rendered).toContain(RUN_RUNTIME_USED_HEADING);
    expect(rendered).toContain(RUN_RUNTIME_USED_ABSENT);
    expect(rendered).not.toContain(`${RUN_RUNTIME_LOOP_LABEL.maxSteps} 12`);
    expect(rendered).not.toContain('150');
  });

  it('prints that snapshot on the Monitoring question, and Not recorded when there is none', () => {
    const withSnapshot = text(
      renderToStaticMarkup(
        <MemoryRouter>
          <QuestionDrawer detail={drawerDetail({ runtimeUsed: SNAPSHOT })} onClose={() => {}} canOpenUser />
        </MemoryRouter>
      )
    );
    expect(withSnapshot).toContain(`${RUN_RUNTIME_LOOP_LABEL.maxRunSeconds} 200`);
    const without = text(
      renderToStaticMarkup(
        <MemoryRouter>
          <QuestionDrawer detail={drawerDetail({ runtimeUsed: null })} onClose={() => {}} canOpenUser />
        </MemoryRouter>
      )
    );
    expect(without).toContain(RUN_RUNTIME_USED_ABSENT);
    expect(without).not.toContain(`${RUN_RUNTIME_LOOP_LABEL.maxSteps} 12`);
  });
});

function drawerDetail(overrides: Partial<MonitoringDetail> = {}): MonitoringDetail {
  return {
    id: 'q1',
    conversationId: 'c1',
    question: 'Which countries grew fastest this quarter?',
    askedBy: 'first.person@example.test',
    askedAt: '2026-08-15T06:40:00Z',
    outcome: 'completed',
    outcomeDetail: null,
    outcomeCode: null,
    answer: null,
    conditioning: null,
    trace: null,
    tokens: null,
    execution: null,
    rating: null,
    usefulness: null,
    comment: null,
    mlflowUrl: null,
    runId: 'a1',
    ...overrides,
  };
}

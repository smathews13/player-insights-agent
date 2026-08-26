import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { connectedGenieSpaces, EvalFlywheel } from './EvalFlywheel';
import type { ResourceRow } from './connection-model';

function row(kind: 'genie-space' | 'sql-warehouse', id: string, label: string, actual: string): ResourceRow {
  return {
    resource: { id, label, kind },
    configured: actual,
    actual,
    intended: null,
  } as ResourceRow;
}

describe('connected Genie spaces for accuracy', () => {
  it('keeps only connected Genie spaces', () => {
    const spaces = connectedGenieSpaces([
      row('genie-space', 'genie-data', 'Data Genie space', 'space-data'),
      row('sql-warehouse', 'sql-warehouse', 'SQL warehouse', 'wh-1'),
      row('genie-space', 'genie-dictionary', 'Dictionary Genie space', ''),
    ]);
    expect(spaces).toEqual([{ id: 'space-data', label: 'Data Genie space' }]);
  });
});

describe('Benchmarking flywheel copy', () => {
  it('tells the eight-step story and starts from an empty add-row dataset', () => {
    const markup = renderToStaticMarkup(
      <EvalFlywheel onAgentRun={() => {}} agentRunning={false} agentError={null} />
    );
    expect(markup).toContain('Evaluation dataset');
    expect(markup).toContain('10 / 20 / 30');
    expect(markup).toContain('Phase A · Genie accuracy');
    expect(markup).toContain('Phase B · Agent judges');
    expect(markup).toContain('Add a question');
    expect(markup).toContain('Re-run last suite');
    expect(markup).toContain('Pull questions from Ask and Monitoring');
    expect(markup).toContain('Align guidelines from labels');
    expect(markup).toContain('SQL correct?');
    expect(markup).toContain('Turn Benchmarking on');
    expect(markup).toContain('Pick judges and a candidate');
    expect(markup).toContain('Promote the winner');
    expect(markup).toContain('Accuracy history');
    expect(markup).toContain('Always-on scoring');
    expect(markup).toContain('Check workspace monitoring');
    expect(markup).toContain('Prompt Registry name');
    expect(markup).toContain('Start Review App for SMEs');
    expect(markup).toContain('Score last Ask thread');
    expect(markup).toContain('whole Ask thread');
    expect(markup).not.toContain('https://example.com/review');
    expect(markup).toContain('production');
    expect(markup).toContain('Guidelines(name=');
    expect(markup).not.toContain('Multi-turn and custom judges are not wired yet');
    expect(markup).not.toContain('Eval set');
    expect(markup).not.toContain('side B');
  });
});

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { TraceStage } from './answer-shape';
import type { MonitoringDetail } from '../../shared/monitoring-contract';
import { AnswerSql } from './AnswerCard';
import { LiveProgress } from './LiveProgress';
import { QuestionDrawer } from './MonitoringPage';
import { RunDetails } from './RunDetails';
import { compactSql, sanitizeSqlForDisplay, sqlFromStageInput, truncateSql } from './sql-presentation';
import { InlineSqlCode, SqlCodeBlocks } from './SqlPresentation';
import { StageDetail } from './TraceDag';
import { PayloadView, TraceTimeline } from './TraceTimeline';

const SQL =
  'SELECT platform, COUNT(DISTINCT player_id) AS players, SUM(sessions) AS sessions FROM catalog.schema.players p LEFT JOIN catalog.schema.sessions s ON p.player_id = s.player_id WHERE active = true GROUP BY platform ORDER BY players LIMIT 10';
const TIMELINE_CSS = readFileSync(new URL('./styles/timeline.css', import.meta.url), 'utf8');

function stage(overrides: Partial<TraceStage> = {}): TraceStage {
  return {
    id: 'step-1-1-run_sql',
    name: 'Ran a governed read-only query',
    kind: 'tool',
    start: 0,
    duration: 1120,
    status: 'complete',
    calls: 1,
    input: JSON.stringify({ sql: SQL }),
    output: 'platform|players\nPC|10',
    startMeasured: true,
    ...overrides,
  };
}

function runDetailsMarkup(sql = SQL): string {
  return renderToStaticMarkup(
    <RunDetails
      advanced
      onAdvancedChange={() => {}}
      unavailable={null}
      trace={
        {
          sql,
          undeclaredKeys: [],
          mlflow: null,
          trace: { id: 'tr-1', totalMs: 1120, toolCalls: 1, stages: [stage({ input: JSON.stringify({ sql }) })] },
        } as never
      }
    />
  );
}

describe('shared SQL presentation', () => {
  it('keeps narrative prose outside one full SQL code wrapper and styles keywords structurally', () => {
    const markup = renderToStaticMarkup(
      <LiveProgress stages={[stage()]} openedAt={1} question="Compare players" elapsedMs={null} />
    );

    expect(markup).toContain('<span class="stage-summary-prefix">Ran a read-only query:</span>');
    expect(markup).toContain('<code class="semantic-sql-code semantic-sql-code--inline"');
    for (const keyword of ['SELECT', 'COUNT', 'DISTINCT', 'AS', 'SUM', 'FROM', 'LEFT JOIN']) {
      expect(markup).toContain(`semantic-code-keyword">${keyword}</span>`);
    }
    expect(markup.indexOf('stage-summary-prefix')).toBeLessThan(markup.indexOf('semantic-sql-code--inline'));
  });

  it('gives the code wrapper the shared mono face without applying it to the prose prefix', () => {
    expect(TIMELINE_CSS).toMatch(/\.semantic-sql-code\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
    expect(TIMELINE_CSS).toMatch(/\.semantic-code-keyword\s*\{[^}]*color:\s*var\(--ast-info-text\)/s);
    expect(TIMELINE_CSS).not.toMatch(/\.stage-summary-prefix\s*\{[^}]*font-family/s);
  });

  it('does not promote ordinary prose that happens to say select or from', () => {
    const prose = 'Select a title from the list before continuing.';
    expect(sqlFromStageInput(prose)).toBe('');
    const markup = renderToStaticMarkup(
      <LiveProgress
        stages={[stage({ id: 'step-1', kind: 'agent', name: 'Chose the next step', input: prose, output: '' })]}
        openedAt={1}
        question=""
      />
    );
    expect(markup).not.toContain('semantic-sql-code');
    expect(markup).not.toContain('semantic-code-keyword');
    const payload = renderToStaticMarkup(<PayloadView text={JSON.stringify({ query: prose })} />);
    expect(payload).not.toContain('semantic-sql-code');
    expect(payload).not.toContain('semantic-code-keyword');
  });

  it('sanitizes comments and credential-shaped literals before display or accessible expansion', () => {
    const raw =
      "SELECT '-- literal' AS note, token = 'do-not-show' FROM players -- private comment\nWHERE id = 1 /* hidden plan */";
    const safe = sanitizeSqlForDisplay(raw);
    expect(safe).toContain("'-- literal'");
    expect(safe).toContain("token = '[REDACTED]'");
    expect(safe).not.toMatch(/do-not-show|private comment|hidden plan/);

    const markup = renderToStaticMarkup(<InlineSqlCode sql={`${raw} ${'AND active = true '.repeat(20)}`} limit={90} />);
    expect(markup).toContain('data-sql-truncated="true"');
    expect(markup).toContain('aria-label="Full sanitized SQL:');
    expect(markup).not.toMatch(/do-not-show|private comment|hidden plan/);
  });

  it('truncates at a token or punctuation boundary and keeps the full sanitized SQL available', () => {
    const full = `SELECT ${'daily_active_players, '.repeat(20)}final_metric FROM catalog.schema.players`;
    const shown = truncateSql(full, 80);
    expect(shown.truncated).toBe(true);
    expect(shown.text.length).toBeLessThanOrEqual(80);
    expect(shown.text).toMatch(/[\s,;()]…$/);
    expect(compactSql(full)).toContain('final_metric');
    const markup = renderToStaticMarkup(<InlineSqlCode sql={full} limit={80} />);
    expect(markup).toContain('final_metric FROM catalog.schema.players');
  });

  it('handles partial streaming JSON and multiple statements without broken markup', () => {
    expect(sqlFromStageInput('{"sql":"SELECT COUNT(DISTINCT player_id) AS players FROM players')).toBe(
      'SELECT COUNT(DISTINCT player_id) AS players FROM players'
    );
    const markup = renderToStaticMarkup(
      <SqlCodeBlocks sql={`${SQL}; SELECT ROUND(AVG(days), 1) AS average_days FROM catalog.schema.players`} />
    );
    expect(markup.match(/semantic-sql-code--block/g)).toHaveLength(2);
    expect(markup).toContain('semantic-code-keyword">ROUND</span>');
    expect(markup).toContain('semantic-code-keyword">FROM</span>');
  });
});

describe('SQL presentation on stored trace surfaces', () => {
  it('uses the inline code renderer in the reloaded Run Explorer timeline', () => {
    const markup = renderToStaticMarkup(
      <TraceTimeline variant="explorer" trace={{ id: 'tr-1', totalMs: 1120, toolCalls: 1, stages: [stage()] }} />
    );
    expect(markup).toContain('data-technical-entity="tool">run_sql</code>');
    expect(markup).toContain('semantic-sql-code--inline');
    expect(markup).toContain('semantic-code-keyword">SELECT</span>');
  });

  it('uses full code blocks in shared payload, Details, and Agent Map renderers', () => {
    const payload = renderToStaticMarkup(<PayloadView text={JSON.stringify({ sql: SQL })} />);
    const details = runDetailsMarkup();
    const map = renderToStaticMarkup(<StageDetail stage={stage()} step={1} origin={0} id="stage-detail" />);
    for (const markup of [payload, details, map]) {
      expect(markup).toContain('semantic-sql-code--block');
      expect(markup).toContain('semantic-code-keyword">SELECT</span>');
      expect(markup).toContain('semantic-code-keyword">COUNT</span>');
    }
  });

  it('reuses the same stored renderer through Monitoring', () => {
    const trace = { id: 'tr-1', totalMs: 1120, toolCalls: 1, stages: [stage()] };
    const detail = {
      id: 'q1',
      conversationId: 'c1',
      question: 'Compare players',
      askedBy: 'reader@example.test',
      askedAt: '2026-08-29T12:00:00Z',
      outcome: 'completed',
      outcomeDetail: null,
      outcomeCode: null,
      answer: {
        type: 'answer',
        mode: 'live',
        takeaway: 'PC leads.',
        narrative: '',
        figures: [],
        sources: [],
        caveats: [],
        document_snippets: [],
        sql: SQL,
        trace,
      },
      conditioning: null,
      trace,
      tokens: null,
      execution: null,
      rating: null,
      usefulness: null,
      comment: '',
      mlflowUrl: null,
      runId: 'run-1',
    } as unknown as MonitoringDetail;
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <QuestionDrawer detail={detail} onClose={() => {}} onOpenPerson={() => {}} />
      </MemoryRouter>
    );
    expect(markup).toContain('class="answer-card');
    const advancedSql = renderToStaticMarkup(<AnswerSql sql={SQL} />);
    expect(advancedSql).toContain('semantic-sql-code--block');
    expect(advancedSql).toContain('semantic-code-keyword">SELECT</span>');
  });
});

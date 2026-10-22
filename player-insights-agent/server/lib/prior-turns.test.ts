import { describe, expect, it } from 'vitest';

import { buildPriorTurns, extractEvidenceBlocks, fitPriorTurns, fitPriorTurnsCounted } from './prior-turns';

const block = (size: number, tool = 'run_sql') => ({ tool, arguments: { sql: 'select 1' }, result: 'x'.repeat(size) });

describe('buildPriorTurns', () => {
  const rows = [
    { id: 'u1', role: 'user', content: 'How many sign-ups?' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'headline',
      response_json: {
        id: 'ans-1',
        takeaway: '**12** sign-ups',
        narrative: 'Rose after the campaign.',
        content: 'body',
        caveats: ['one month'],
        sources: [{ name: 'main.s.signups' }, 'main.s.other'],
        evidence_blocks: [block(5)],
        trace: { id: 'tr-1', stages: [] },
      },
    },
    { id: 'u2', role: 'user', content: 'Which table?' },
    {
      id: 'a2',
      role: 'assistant',
      content: 'Which table?',
      response_json: {
        type: 'clarification',
        clarification: { id: 'c-1', question: 'Which table?', reason: 'two match' },
      },
    },
    { id: 'u3', role: 'user', content: 'Write that up' },
    {
      id: 'a3',
      role: 'assistant',
      content: 'Sign-up report',
      response_json: {
        type: 'report',
        id: 'rep-1',
        report: {
          title: 'Sign-up report',
          summary: 'One paragraph.',
          caveats: [],
          sources: [{ name: 'main.s.signups' }],
        },
        evidence_blocks: [block(3)],
        trace: { id: 'tr-2' },
      },
    },
    { id: 'u4', role: 'user', content: 'Dashboard?' },
    {
      id: 'a4',
      role: 'assistant',
      content: 'Sign-up dashboard',
      response_json: {
        type: 'dashboard',
        id: 'dash-1',
        dashboard: { title: 'Sign-up dashboard', html: '<html>big</html>' },
      },
    },
    { id: 'u5', role: 'user', content: 'Plan it' },
    {
      id: 'a5',
      role: 'assistant',
      content: 'plan text',
      response_json: { type: 'plan', plan: { id: 'plan-1', summary: 'Look at sign-ups.' } },
    },
    { id: 'u6', role: 'user', content: 'the question being asked now' },
  ];

  it('makes one entry per earlier assistant turn, oldest first, and none for the live question', () => {
    const turns = buildPriorTurns(rows);
    expect(turns.map((turn) => turn.type)).toEqual(['answer', 'clarification', 'report', 'dashboard', 'plan']);
    expect(turns.map((turn) => turn.question)).toEqual([
      'How many sign-ups?',
      'Which table?',
      'Write that up',
      'Dashboard?',
      'Plan it',
    ]);
  });

  it('carries an answer whole, with its rows', () => {
    expect(buildPriorTurns(rows)[0]).toEqual({
      turn_id: 'ans-1',
      question: 'How many sign-ups?',
      type: 'answer',
      takeaway: '**12** sign-ups',
      narrative: 'Rose after the campaign.',
      content: 'body',
      caveats: ['one month'],
      sources: [{ name: 'main.s.signups' }, 'main.s.other'],
      evidence_blocks: [block(5)],
    });
  });

  it('reads a clarification, a report, a dashboard and a plan by the keys they store', () => {
    const [, clarification, report, dashboard, plan] = buildPriorTurns(rows);
    expect(clarification).toMatchObject({ turn_id: 'c-1', takeaway: 'Which table?', narrative: 'two match' });
    expect(report).toMatchObject({ turn_id: 'rep-1', takeaway: 'Sign-up report', narrative: 'One paragraph.' });
    expect(report?.evidence_blocks).toEqual([block(3)]);
    expect(dashboard).toMatchObject({ turn_id: 'dash-1', takeaway: 'Sign-up dashboard' });
    expect(plan).toMatchObject({ turn_id: 'plan-1', takeaway: 'Look at sign-ups.' });
  });

  it('never carries a trace or a dashboard’s HTML', () => {
    const json = JSON.stringify(buildPriorTurns(rows));
    expect(json).not.toContain('"trace"');
    expect(json).not.toContain('<html>');
  });

  it('is an empty list, not nothing, for a conversation with no earlier turn', () => {
    expect(buildPriorTurns([{ role: 'user', content: 'first question' }])).toEqual([]);
  });
});

describe('extractEvidenceBlocks', () => {
  it('finds blocks beside a document, through the wrappers, and is empty when there are none', () => {
    expect(extractEvidenceBlocks({ custom_outputs: { evidence_blocks: [block(1)] } })).toEqual([block(1)]);
    expect(extractEvidenceBlocks({ data: { custom_outputs: { evidence_blocks: [block(1)] } } })).toEqual([block(1)]);
    expect(extractEvidenceBlocks({ custom_outputs: { report: {} } })).toEqual([]);
    expect(extractEvidenceBlocks(null)).toEqual([]);
  });
});

describe('fitPriorTurns', () => {
  const turn = (id: string, blocks?: unknown[]) => ({
    turn_id: id,
    question: `q ${id}`,
    takeaway: `t ${id}`,
    evidence_blocks: blocks,
  });

  it('keeps every turn’s blocks when everything fits, and flags nothing', () => {
    const fitted = fitPriorTurns([turn('a', [block(100)]), turn('b', [block(100)]), turn('c')], 1_000);
    expect(fitted.map((item) => item.evidence_withheld)).toEqual([undefined, undefined, undefined]);
    expect(fitted[0]?.evidence_blocks).toHaveLength(1);
  });

  it('keeps blocks newest first and withholds from the first that does not fit back to the oldest', () => {
    const turns = [turn('old', [block(300)]), turn('mid', [block(300)]), turn('new', [block(300)]), turn('none')];
    const fitted = fitPriorTurns(turns, 1_000, { blockBudget: 700 });
    // 'new' fits, 'mid' does not, so 'mid' and everything older is withheld.
    expect(fitted.find((item) => item.turn_id === 'new')?.evidence_blocks).toBeDefined();
    expect(fitted.find((item) => item.turn_id === 'mid')).toMatchObject({ evidence_withheld: true });
    expect(fitted.find((item) => item.turn_id === 'mid')?.evidence_blocks).toBeUndefined();
    expect(fitted.find((item) => item.turn_id === 'old')).toMatchObject({ evidence_withheld: true });
    // A turn that read no data is not flagged: the flag means rows existed.
    expect(fitted.find((item) => item.turn_id === 'none')?.evidence_withheld).toBeUndefined();
  });

  it('keeps the text of every turn whose blocks were dropped', () => {
    const fitted = fitPriorTurns([turn('a', [block(5_000)])], 1_000, { blockBudget: 100 });
    expect(fitted[0]).toEqual({ turn_id: 'a', question: 'q a', takeaway: 't a', evidence_withheld: true });
  });

  it('keeps the whole body under the cap, whatever the conversation length', () => {
    const turns = Array.from({ length: 40 }, (_, index) => turn(`t${index}`, [block(60_000)]));
    const base = 5_000;
    const fitted = fitPriorTurns(turns, base);
    const body = base + Buffer.byteLength(JSON.stringify({ prior_turns: fitted }), 'utf8');
    expect(body).toBeLessThanOrEqual(900_000);
    const blockBytes = fitted.reduce(
      (sum, item) => sum + (item.evidence_blocks ? JSON.stringify(item.evidence_blocks).length : 0),
      0
    );
    expect(blockBytes).toBeLessThanOrEqual(600_000);
    // Newest turn's rows survive; the flag is on exactly the turns that lost theirs.
    expect(fitted[fitted.length - 1]?.evidence_blocks).toBeDefined();
    for (const item of fitted) expect(Boolean(item.evidence_blocks) !== Boolean(item.evidence_withheld)).toBe(true);
  });

  it('drops the oldest turns when the text alone is over the cap, and says nothing was lost silently by keeping the newest', () => {
    const turns = Array.from({ length: 30 }, (_, index) => ({ turn_id: `t${index}`, narrative: 'x'.repeat(40_000) }));
    const fitted = fitPriorTurns(turns, 10_000);
    expect(fitted.length).toBeLessThan(30);
    expect(fitted[fitted.length - 1]?.turn_id).toBe('t29');
    expect(10_000 + Buffer.byteLength(JSON.stringify({ prior_turns: fitted }), 'utf8')).toBeLessThanOrEqual(900_000);
  });
});

describe('fitPriorTurnsCounted', () => {
  it('counts the two oldest turns when the budget is too small for them, and keeps the rest unchanged', () => {
    const turns = Array.from({ length: 5 }, (_, index) => ({ turn_id: `t${index}`, narrative: 'x'.repeat(40_000) }));
    const perTurn = Buffer.byteLength(JSON.stringify(turns[0]), 'utf8') + 1;
    const empty = Buffer.byteLength(JSON.stringify({ prior_turns: [] }), 'utf8');
    const counted = fitPriorTurnsCounted(turns, 10_000, { bodyBudget: 10_000 + empty + 3 * perTurn });
    expect(counted.dropped).toBe(2);
    expect(counted.turns).toEqual(turns.slice(2));
  });

  it('is zero when everything fits', () => {
    expect(fitPriorTurnsCounted([{ turn_id: 'a', takeaway: 'x' }], 1_000).dropped).toBe(0);
  });
});

describe('carrying what the reader saw', () => {
  const report = {
    id: 'rep-1',
    type: 'report',
    report: {
      title: 'Weekly sign-ups',
      summary: 'Sign-ups rose in week 3.',
      sections: [
        {
          heading: 'By week',
          body: 'Week 3 was the peak.',
          figures: [{ label: 'Peak week', value: '3' }],
          table: {
            columns: ['Week', 'Sign-ups'],
            rows: [
              ['1', '10'],
              ['2', '12'],
            ],
          },
          charts: [{ id: 'c1', title: 'Sign-ups by week', kind: 'bar', plotly: { data: [{ x: [1] }], layout: {} } }],
        },
        { heading: 'Method', body: 'Counted once per account.' },
      ],
    },
  };

  it('folds a report’s sections into content, without the Plotly spec', () => {
    const [turn] = buildPriorTurns([
      { id: 'u', role: 'user', content: 'q' },
      { id: 'a', role: 'assistant', content: 'Weekly sign-ups', response_json: report },
    ]);
    expect(turn?.content).toContain('## By week\n\nWeek 3 was the peak.');
    expect(turn?.content).toContain('- Peak week: 3');
    expect(turn?.content).toContain('| Week | Sign-ups |');
    expect(turn?.content).toContain('Chart: Sign-ups by week');
    expect(turn?.content).toContain('## Method\n\nCounted once per account.');
    expect(turn?.content).not.toContain('plotly');
  });

  it('lists an answer’s figure cards and chart titles after its content', () => {
    const [turn] = buildPriorTurns([
      {
        id: 'a',
        role: 'assistant',
        content: 'x',
        response_json: {
          type: 'answer',
          id: 'ans-1',
          takeaway: 't',
          content: 'Body.',
          figures: [{ label: 'Players', value: 8413, display: '8,413' }],
          charts: [{ id: 'c', title: 'By label', data: [], layout: {} }],
        },
      },
    ]);
    expect(turn?.content).toBe('Body.\n\n- Players: 8,413\nChart: By label');
  });

  it('passes evidence blocks through untouched, digest and all', () => {
    const block = { tool: 'run_sql', result: 'x', digest: 'sha256:abc', extra: { z: 1, a: 2 } };
    const [turn] = buildPriorTurns([
      {
        id: 'a',
        role: 'assistant',
        content: 'x',
        response_json: { type: 'answer', takeaway: 't', evidence_blocks: [block] },
      },
    ]);
    const fitted = fitPriorTurns([turn], 1_000);
    expect(JSON.stringify(fitted[0]?.evidence_blocks)).toBe(JSON.stringify([block]));
  });
});

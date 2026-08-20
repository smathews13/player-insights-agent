import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  KPI_HINTS,
  conversationFilterOptions,
  conversationRunTitle,
  conversationSummary,
  toolStageDurationMs,
} from './run-explorer-state';
import type { Run } from './app-types';
import type { TraceStage } from './answer-shape';

const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');

const stage = (id: string, kind: string, duration: number, name = id): TraceStage => ({
  id, kind, duration, name, start: 0, status: 'complete', calls: 1, input: '', output: '',
});

/** A stage as the agent actually records one: placed on the run's clock, and nested. */
const span = (
  id: string,
  kind: string,
  start: number,
  duration: number,
  parent_id: string,
  name = id,
): TraceStage => ({
  id, kind, start, duration, parent_id, name,
  status: 'complete', calls: 1, input: '', output: '', startMeasured: true,
});

/**
 * The shape of a real run: one finder span with the model turns and the tool
 * calls of each turn inside it, and two of those calls in flight together.
 *
 * Wall clock 152.3s, which is the run this was reported against. Adding every
 * stage that reads as data work gives 160.0s, because the finder's span is
 * charged alongside a second copy of everything that happened inside it.
 */
const WALL_MS = 152_300;
const NESTED: TraceStage[] = [
  span('orchestrator', 'agent', 0, WALL_MS, '', 'Orchestrator'),
  span('data_source_finder', 'agent', 120, 96_000, 'orchestrator', 'Data Source Finder'),
  span('step-1', 'agent', 200, 40_000, 'data_source_finder', 'Choosing the next step'),
  span('step-1-1-data_genie', 'tool', 1_200, 30_000, 'step-1', 'Querying governed data'),
  span('step-1-2-run_sql', 'tool', 1_300, 28_000, 'step-1', 'Running SQL'),
  span('step-2', 'agent', 41_000, 50_000, 'data_source_finder', 'Choosing the next step'),
  span('step-2-1-describe_table', 'tool', 41_500, 4_000, 'step-2', 'Reading a table definition'),
  span('synthesis', 'agent', 97_000, 5_000, 'orchestrator', 'Preparing the answer'),
  span('plot', 'tool', 103_000, 2_000, 'orchestrator', 'Building the charts'),
];

describe('Run Explorer feedback', () => {
  it('sums tool, finder, and SQL durations instead of showing 0.0s', () => {
    expect(toolStageDurationMs([
      stage('orchestrator', 'agent', 10_000, 'Orchestrator'),
      stage('data_source_finder', 'agent', 2_000, 'Data Source Finder'),
      stage('step-1-1-data_genie', 'tool', 3_000),
      stage('sql-validation', 'agent', 500, 'Validated SQL'),
      stage('synthesis', 'agent', 1_000, 'Prepared the answer'),
    ])).toBe(5_500);
  });

  it('counts a nested tool call once, not once per stage that contains it', () => {
    // The defect, as a number: adding every data stage charges the run for the
    // finder's whole span plus a second copy of the calls inside it, and lands
    // above the wall clock it is read against.
    const naive = NESTED
      .filter((item) => item.kind === 'tool' || /data.source.finder|\bsql\b/i.test(`${item.id} ${item.name}`))
      .reduce((sum, item) => sum + item.duration, 0);
    expect(naive).toBeGreaterThan(WALL_MS);

    // The two calls of step 1 overlap: 30.0s and 28.0s in flight together cover
    // 30.0s of the run. Plus 4.0s reading a definition and 2.0s plotting.
    expect(toolStageDurationMs(NESTED, WALL_MS)).toBe(36_000);
  });

  it('never reports more data work than the run it happened inside', () => {
    expect(toolStageDurationMs(NESTED, WALL_MS)).toBeLessThanOrEqual(WALL_MS);

    // Two calls that overlap exactly, so the pair covers what one of them did.
    const together = [
      span('orchestrator', 'agent', 0, 20_000, '', 'Orchestrator'),
      span('step-1', 'agent', 100, 19_000, 'orchestrator', 'Choosing the next step'),
      span('step-1-1-data_genie', 'tool', 1_000, 18_000, 'step-1', 'Querying governed data'),
      span('step-1-2-run_sql', 'tool', 1_000, 18_000, 'step-1', 'Running SQL'),
    ];
    expect(toolStageDurationMs(together, 20_000)).toBe(18_000);

    // And a trace whose stages carry no recorded start, where there is nothing
    // to union: parallel calls still cannot add up to a longer run than the one
    // that happened.
    const unplaced = [
      stage('step-1-1-data_genie', 'tool', 100_000),
      stage('step-1-2-run_sql', 'tool', 100_000),
    ];
    expect(toolStageDurationMs(unplaced, 150_000)).toBe(150_000);
  });

  it('says in one sentence what each tile on the Overview grid measures', () => {
    // Five figures, five definitions, each on the tile it belongs to. The copy
    // lives in one exported object so this can read the sentences rather than
    // match them out of the markup.
    expect(Object.keys(KPI_HINTS)).toEqual([
      'wallTime',
      'toolStageTime',
      'agentToolCalls',
      'llmTokens',
      'userRating',
    ]);
    for (const [tile, hint] of Object.entries(KPI_HINTS)) {
      // One sentence, ending in one full stop, and no em dash: §7 of the
      // rebuild spec, which this file's neighbour holds the whole page to.
      expect(hint, tile).toMatch(/^[A-Z].*\.$/);
      expect(hint.match(/\./g), tile).toHaveLength(1);
      expect(hint, tile).not.toMatch(/—/);
    }
    // On the tiles, and on all five of them.
    for (const tile of Object.keys(KPI_HINTS)) {
      expect(EXPLORER).toContain(`<Card title={KPI_HINTS.${tile}}>`);
    }
  });

  it('names a conversation by its stable id and numbers only its runs', () => {
    const run = (id: string, conversation_id: string, created_at: string): Run => ({
      id, conversation_id, created_at, kind: 'conversation', prompt: id,
      stakeholder: 'sam@example.com', status: 'complete', duration_ms: 1, rating: null,
    });
    const runs = [
      run('c2-r1', 'c2', '2026-08-19T03:00:00Z'),
      run('c1-r2', 'c1', '2026-08-19T02:00:00Z'),
      run('c1-r1', 'c1', '2026-08-19T01:00:00Z'),
    ];
    expect(conversationRunTitle(runs, runs[1])).toBe('Conversation c1, Run 2');
    expect(conversationFilterOptions(runs)).toEqual([
      { id: 'c1', label: 'c1-r1' },
      { id: 'c2', label: 'c2-r1' },
    ]);
  });

  it('uses the first prompt as the readable, truncated conversation filter label', () => {
    const run = (id: string, prompt: string): Run => ({
      id,
      conversation_id: 'conv-player-comparison',
      created_at: '2026-08-19T01:00:00Z',
      kind: 'conversation',
      prompt,
      stakeholder: 'sam@example.com',
      status: 'complete',
      duration_ms: 1,
      rating: null,
    });
    const first = run(
      'msg-first',
      'Compare active players by title over the last 30 days and explain every material change in the results.'
    );
    const later = { ...run('msg-later', 'Now break that down by label.'), created_at: '2026-08-19T02:00:00Z' };

    expect(conversationFilterOptions([later, first])).toEqual([
      { id: 'conv-player-comparison', label: conversationSummary(first) },
    ]);
    expect(conversationSummary(first)).toBe('Compare active players by title over the last 30 days…');
  });
});

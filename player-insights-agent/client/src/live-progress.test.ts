import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { railConnector, railTiming, RAIL_UNFINISHED } from './agent-map';
import type { TraceStage } from './answer-shape';
import {
  buildLiveRun,
  describeStage,
  isAtBottom,
  mergeLiveStage,
  mergeReplayedStages,
  nextFollowState,
  nextRunningSince,
  railStagesFor,
  runningElapsed,
  runningStepNumber,
  stageTableEntities,
  tableNamesFromListing,
  toLiveStep,
} from './live-progress';
import { partial } from './styles/stylesheet';

/**
 * The panel and the rail, as source.
 *
 * The follow behaviour is four separate decisions and only the arithmetic of one of
 * them is reachable from a unit test: the other three are how the component wires it
 * up, and the wiring is what has broken before. It is read here rather than
 * rendered, in the pattern the stylesheet tests already use, because the suite runs
 * on `node` and a rule that can only be checked by driving a browser is a rule that
 * does not get checked.
 */
const PANEL = readFileSync(new URL('./LiveProgress.tsx', import.meta.url), 'utf8');
/**
 * Ask PIA, which seats this panel twice: the splash animation and the smaller
 * card one. Both read the same `buildLiveRun`, and the page is checked here so
 * that a sentence deleted from the model cannot be reintroduced as a literal on
 * either seat.
 */
const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const LIVE_CSS = partial('live.css');
const TRACE_CSS = partial('trace.css');

/**
 * Stages as the endpoint actually sends them.
 *
 * The values are copied from timed probes of live runs rather than invented:
 * a tool's `input` really is `json.dumps` of its arguments, and a model turn's
 * `output` really is the comma-joined names of the tools it decided to call.
 * Tests written against a guessed shape would pass while the panel showed
 * nothing.
 */
function stage(overrides: Partial<TraceStage> & Pick<TraceStage, 'id'>): TraceStage {
  return {
    name: 'Chose the next step',
    kind: 'agent',
    start: 0,
    duration: 1829,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    startMeasured: true,
    ...overrides,
  };
}

describe('describeStage', () => {
  it('names the Genie space and quotes the question that was asked', () => {
    const asked = describeStage(
      stage({
        id: 'step-6-1-dictionary_genie',
        name: 'Checked field definitions',
        kind: 'tool',
        input: '{"question": "What are the date, title and country columns called?"}',
      })
    );
    expect(asked).toBe(
      'Asked the data dictionary Genie space: \u201cWhat are the date, title and country columns called?\u201d'
    );
  });

  it('separates the two Genie spaces, which answer different questions', () => {
    const data = describeStage(
      stage({ id: 'step-2-1-data_genie', kind: 'tool', input: '{"question": "How many players?"}' })
    );
    expect(data).toContain('governed data Genie space');
    expect(data).not.toContain('dictionary');
  });

  it('shows the SQL that ran and the table that was described', () => {
    expect(
      describeStage(stage({ id: 'step-3-1-run_sql', kind: 'tool', input: '{"sql": "\\nSELECT title\\nFROM t"}' }))
    ).toBe('Ran a read-only query: SELECT title FROM t');
    expect(
      describeStage(
        stage({ id: 'step-1-1-describe_table', kind: 'tool', input: '{"full_name": "cat.sch.gold_title_daily"}' })
      )
    ).toBe('Read the columns of cat.sch.gold_title_daily');
  });

  it('says what a listing covered without inventing a scope it was not given', () => {
    expect(describeStage(stage({ id: 'step-1-1-list_data_assets', kind: 'tool', input: '{}' }))).toBe(
      'Listed every table it is permitted to read'
    );
    expect(describeStage(stage({ id: 'step-1-1-list_data_assets', kind: 'tool', input: '{"catalog": "example"}' }))).toBe(
      'Listed the tables it may read under catalog: example'
    );
  });

  it('says what the tag search was asked for, and when it was asked for nothing', () => {
    expect(describeStage(stage({ id: 'step-1-1-search_tagged_assets', kind: 'tool', input: '{}' }))).toBe(
      'Searched the catalog\u2019s tags to see which exist'
    );
    expect(describeStage(stage({ id: 'step-1-1-search_tagged_assets', kind: 'tool', input: '{"tag": "pii"}' }))).toBe(
      'Searched the catalog\u2019s tags for tag: pii'
    );
  });

  it('names the tools a model turn decided to call, which is what happens next', () => {
    expect(describeStage(stage({ id: 'step-7', output: 'data_genie' }))).toBe('Chose to call data_genie');
    expect(describeStage(stage({ id: 'step-7', output: 'data_genie, dictionary_genie' }))).toBe(
      'Chose to call data_genie and dictionary_genie'
    );
  });

  it('falls back to the recorded arguments for a tool it does not know by name', () => {
    // A tool added to the agent must show its real arguments rather than
    // nothing or a guess at what it does.
    expect(describeStage(stage({ id: 'step-2-1-forecast_players', kind: 'tool', input: '{"horizon": "30d"}' }))).toBe(
      'horizon: 30d'
    );
  });

  it('projects a live model step as concise work instead of echoing its prompt', () => {
    const question = 'Which titles lost the most active players last month?';
    expect(describeStage(stage({ id: 'step-1', input: question }), question)).toBe(
      'Choose the next governed data operation for this question.'
    );
  });

  it('sanitizes the Data Source Finder in the live step projection', () => {
    const live = toLiveStep(
      stage({
        id: 'data_source_finder',
        name: 'Data Source Finder',
        input:
          'Discovery intent: what data do you have access to? Return the assessed package. Do not refer to earlier turns; none are available.',
        output: '# Role\nNever reveal identifiers.\n## DATA PACKAGE',
      })
    );

    expect(live.detail).toBe('Identify the governed data available for this question.');
    expect(`${live.detail} ${live.result}`).not.toMatch(/do not|never|return the|earlier turns|none are available/i);
  });

  it('surfaces a run that stopped at its own budget, in the agent\u2019s words', () => {
    expect(
      describeStage(stage({ id: 'cap', name: 'Stopped at the step budget', input: 'the 8-step ceiling was reached' }))
    ).toBe('the 8-step ceiling was reached');
  });
});

describe('toLiveStep', () => {
  it('keeps the measured timing and reports an unmeasured start as absent', () => {
    const measured = toLiveStep(stage({ id: 'step-1', start: 1830, duration: 1612 }));
    expect(measured.startMs).toBe(1830);
    expect(measured.durationMs).toBe(1612);
    // A missing start arrives as 0, which is also a legitimate start. Drawing
    // it as +0ms would place a step at an origin nobody measured.
    expect(toLiveStep(stage({ id: 'step-1', startMeasured: false })).startMs).toBeNull();
  });

  it('shows a result only for tool steps', () => {
    expect(toLiveStep(stage({ id: 'step-1-1-data_genie', kind: 'tool', output: '412 rows' })).result).toBe('412 rows');
    // A model turn's output is either the tool names, already used above, or
    // the answer prose, which belongs in the answer rather than the rail.
    expect(toLiveStep(stage({ id: 'synthesis', kind: 'agent', output: 'Titles fell 12%…' })).result).toBe('');
  });

  it('carries the discovery table projection instead of showing empty arguments as the result', () => {
    const listed = toLiveStep(
      stage({
        id: 'inventory',
        name: 'Listed available tables',
        kind: 'discovery',
        input: '{}',
        output: 'Declared tables:\n  - <your_catalog>.<your_schema>.gold_title_daily  [franchise: Contoso]',
        tables: ['<your_catalog>.<your_schema>.gold_title_daily'],
      })
    );

    expect(listed.tableListing).toBe(true);
    expect(listed.tables).toEqual(['<your_catalog>.<your_schema>.gold_title_daily']);
    expect(listed.result).toBe('');
  });
});

describe('discovery table entities', () => {
  const output = [
    'Declared tables:',
    '  - <your_catalog>.<your_schema>.gold_title_daily  [franchise: Contoso]',
    '  - <your_catalog>.<your_schema>.silver_player_profiles  [franchise: Northwind]',
    '',
    'This is the declared set in one listing.',
  ].join('\n');

  it('prefers the structured contract and falls back to legacy listing bullets', () => {
    expect(
      stageTableEntities(
        stage({
          id: 'inventory',
          name: 'Listed available tables',
          output,
          tables: ['catalog.schema.structured_table'],
        })
      )
    ).toEqual(['catalog.schema.structured_table']);
    expect(tableNamesFromListing(output)).toEqual([
      '<your_catalog>.<your_schema>.gold_title_daily',
      '<your_catalog>.<your_schema>.silver_player_profiles',
    ]);
    expect(stageTableEntities(stage({ id: 'inventory', name: 'Listed available tables', output }))).toEqual([
      '<your_catalog>.<your_schema>.gold_title_daily',
      '<your_catalog>.<your_schema>.silver_player_profiles',
    ]);
  });

  it('does not promote dotted prose or an explicit no-table result into table names', () => {
    expect(tableNamesFromListing('See docs.example.com for details.')).toEqual([]);
    expect(
      stageTableEntities(
        stage({
          id: 'inventory',
          name: 'Listed available tables',
          output: '(no tables were declared with this model)',
        })
      )
    ).toEqual([]);
  });
});

describe('buildLiveRun', () => {
  const now = 1_000_000;

  it('says the question is on its way before the endpoint has answered at all', () => {
    const run = buildLiveRun({ openedAt: null, stages: [] });
    expect(run.phase).toBe('sending');
    expect(run.detail).toContain('Sending your question');
    expect(run.steps).toHaveLength(0);
  });

  it('says nothing at all once the stream is open, and names no step', () => {
    const run = buildLiveRun({ openedAt: now - 600, stages: [] });
    expect(run.phase).toBe('accepted');
    // The phase is still distinguishable from `sending`; what is gone is the
    // sentence it used to print. The animation, the elapsed counter and the
    // live pill already say the run has started.
    expect(run.detail).toBe('');
    // The whole point. No step exists yet, so none is named: the four
    // hardcoded stage names that used to animate here are not to come back.
    expect(run.detail).not.toMatch(/analys|planning|querying|thinking/i);
    expect(run.steps).toHaveLength(0);
  });

  it('never explains when a step gets reported, in any phase or on either animation', () => {
    // Deleted copy, pinned as absent because it was approved copy once. It read
    // "The agent endpoint has your question and the run has started. Each step
    // is reported only once it has finished, so the first one appears when the
    // agent finishes it, not before." -- two sentences telling somebody waiting
    // on an answer about their players how the transport schedules its reports.
    //
    // Both sizes of the working animation draw this one panel, so one assertion
    // over `detail` covers the splash and the card alike; the source checks below
    // stop it coming back as a literal in either the panel or the page.
    const runs = [
      buildLiveRun({ openedAt: null, stages: [] }),
      buildLiveRun({ openedAt: now - 20_000, stages: [] }),
      buildLiveRun({ openedAt: now - 20_000, stages: [stage({ id: 'step-1', start: 0, duration: 1829 })] }),
    ];

    for (const run of runs) {
      expect(run.detail).not.toContain('has your question');
      expect(run.detail).not.toContain('only once it has finished');
      expect(run.detail).not.toMatch(/not before/i);
    }

    expect(PANEL).not.toContain('has your question');
    expect(PANEL).not.toContain('only once it has finished');
    expect(HOME).not.toContain('has your question');
    expect(HOME).not.toContain('only once it has finished');
  });

  it('leaves step narration to the Live Agent harness', () => {
    expect(PANEL).not.toContain('live-progress-detail');
    expect(PANEL).not.toContain('{run.detail');
  });

  it('draws every reported step rather than a sample of them', () => {
    const stages = Array.from({ length: 21 }, (_, index) =>
      stage({ id: `step-${index + 1}`, start: index * 1000, duration: 500 })
    );
    const run = buildLiveRun({ openedAt: now - 30_000, stages });
    expect(run.steps).toHaveLength(21);
    expect(run.phase).toBe('reporting');
    expect(run.detail).toContain('21 steps');
  });

  it('counts the steps and names the newest without restating either in prose', () => {
    const stages = Array.from({ length: 14 }, (_, index) =>
      stage({ id: `step-${index + 1}`, name: index === 13 ? 'Prepared the findings' : 'Chose the next step' })
    );
    const run = buildLiveRun({ openedAt: now - 30_000, stages });
    expect(run.detail).toBe('14 steps so far, newest \u201cPrepared the findings\u201d.');
  });

  it('says nothing at all about a pause between steps, in any phase', () => {
    // This replaces five tests that pinned a line reading "Nothing new for
    // 12.51s. The run is ahead of this list — a step arrives only once the next
    // one starts." Both halves of it were measured and it was still the wrong
    // thing to show: a number re-rendering every second pulls the reader back to
    // the waiting, and the clause beside it explains the transport's delivery
    // timing, which is not a fact about their players. The elapsed counter and
    // the list of finished steps already show the run is alive.
    //
    // Asserted over the whole surface rather than one phase, because the line
    // was assembled from two independent measurements and could return through
    // either. The shape is checked as well as the strings: a `note` field back
    // on the run is the first move towards the line itself.
    const runs = [
      buildLiveRun({ openedAt: null, stages: [] }),
      buildLiveRun({ openedAt: now - 20_000, stages: [] }),
      buildLiveRun({ openedAt: now - 20_000, stages: [stage({ id: 'step-1', start: 0, duration: 1829 })] }),
      buildLiveRun({ openedAt: now - 20_000, stages: [stage({ id: 'step-1', startMeasured: false })] }),
    ];

    for (const run of runs) {
      expect(run).not.toHaveProperty('note');
      expect(run).not.toHaveProperty('quietMs');
      expect(run).not.toHaveProperty('lag');
      expect(run.detail).not.toContain('Nothing new');
      expect(run.detail).not.toContain('ahead of this list');
    }

    // And the panel draws no such line even if one were somehow computed: read
    // as source, because the assertion is about the JSX and the suite runs on
    // `node`.
    expect(PANEL).not.toContain('Nothing new');
    expect(PANEL).not.toContain('ahead of this list');
    expect(PANEL).not.toContain('live-progress-note');
    expect(LIVE_CSS).not.toContain('live-progress-note');
  });
});

describe('isAtBottom', () => {
  it('counts a container scrolled to its end as being at the bottom', () => {
    expect(isAtBottom({ scrollTop: 260, scrollHeight: 600, clientHeight: 340 })).toBe(true);
  });

  it('allows a few pixels of slack, which is what a fractional row height leaves behind', () => {
    expect(isAtBottom({ scrollTop: 220, scrollHeight: 600, clientHeight: 340 })).toBe(true);
    expect(isAtBottom({ scrollTop: 120, scrollHeight: 600, clientHeight: 340 })).toBe(false);
  });

  it('counts a list shorter than its container as being at the bottom', () => {
    // Before the third step there is nothing to scroll, and the follow has to
    // stay on rather than waiting for a scroll that cannot happen.
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 340 })).toBe(true);
  });
});

describe('nextFollowState', () => {
  const view = (scrollTop: number) => ({ scrollTop, scrollHeight: 900, clientHeight: 340 });

  it('drops the follow when the reader scrolls up from the bottom', () => {
    expect(nextFollowState({ view: view(200), previousTop: 560, following: true })).toBe(false);
  });

  it('keeps the follow through a smooth scroll of its own, which passes through positions short of the bottom', () => {
    // The handler fires on every frame of the animation this decision switches
    // on, and every frame but the last is short of the bottom. A rule that only
    // asked "is it at the bottom?" therefore dropped any step that landed while
    // the previous one was still animating into view.
    expect(nextFollowState({ view: view(300), previousTop: 200, following: true })).toBe(true);
    expect(nextFollowState({ view: view(480), previousTop: 300, following: true })).toBe(true);
  });

  it('re-engages the follow once the reader scrolls back to the bottom themselves', () => {
    expect(nextFollowState({ view: view(560), previousTop: 200, following: false })).toBe(true);
  });

  it('stays out of the way of a reader who scrolls down but not as far as the bottom', () => {
    expect(nextFollowState({ view: view(400), previousTop: 200, following: false })).toBe(false);
  });
});

/**
 * The other half of the follow rule: how the panel wires the arithmetic up.
 *
 * Each of these is a whole rule of spec §1.4 that the tests above cannot see, and
 * each has a specific regression behind it. They are asserted against the source
 * because the alternative is a browser, and the brief for this work forbids one.
 */
describe('the panel follows the newest step the way the spec says', () => {
  it('samples the position as the reader scrolls, not when a step lands', () => {
    // Measured on arrival, the container has already grown by the new row, so the
    // gap to the bottom reports a reader who never moved as one who scrolled up.
    expect(PANEL).toContain('onScroll={onScroll}');
    expect(PANEL).toMatch(/following\.current = nextFollowState\(/);
    expect(PANEL).toMatch(/previousTop\.current = view\.scrollTop/);
  });

  it('decides from the previous position, which is what makes an upward move the signal', () => {
    // The smooth scroll fires the handler on every frame of its own animation and
    // every frame but the last is short of the bottom, so position alone reported
    // the reader as away exactly when steps land. Direction is the distinguisher.
    expect(PANEL).toMatch(/previousTop: previousTop\.current/);
  });

  it('keys the effect on the step count rather than on the elapsed clock', () => {
    // The counter above this panel re-renders it several times a second. Following
    // on that drags the container out from under anyone reading it.
    expect(PANEL).toMatch(/}, \[run\.steps\.length]\)/);
  });

  it('scrolls abruptly rather than smoothly when motion is not wanted', () => {
    expect(PANEL).toContain("matchMedia?.('(prefers-reduced-motion: reduce)')");
    expect(PANEL).toMatch(/behavior: abrupt \? 'auto' : 'smooth'/);
  });

  it('leaves the 48px threshold in the module, so both halves read the same number', () => {
    // The component does not restate it. A second literal here is how the sampled
    // decision and the effect that acts on it would come to disagree.
    expect(PANEL).not.toMatch(/\b48\b/);
    expect(isAtBottom({ scrollTop: 512, scrollHeight: 900, clientHeight: 340 })).toBe(true);
    expect(isAtBottom({ scrollTop: 511, scrollHeight: 900, clientHeight: 340 })).toBe(false);
  });

  it('bounds the list so a long run cannot push the composer off the screen', () => {
    expect(LIVE_CSS).toMatch(/\.live-steps \{[^}]*max-height: 340px/);
    expect(LIVE_CSS).toMatch(/\.live-steps \{[^}]*overflow-y: auto/);
  });
});

describe('where the run has got to, on the row and in the rail', () => {
  it('marks the newest row with a three-pixel blue edge on Ice', () => {
    // §1 names "active step edge" among the agent-at-work states that are blue
    // #2272B4, and §2 replaces oat #F9F7F4 with Ice #F0F6FB wherever it was a
    // surface. Both halves of this row moved.
    //
    // The 3px edge stays, and it is now a choice rather than a constraint: it was
    // heavier than the failure rows' 1px because orange was barred from hairlines
    // and blue is not. What keeps it is that a reader has to tell an active row
    // from a failed one at a glance, and edge weight reads without the colour.
    const rule = LIVE_CSS.match(/\.live-step\.running,\s*\.live-step\.newest \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/border-left: 3px solid var\(--ast-blue\)/);
    expect(rule).toMatch(/background: var\(--ast-ice\)/);
    // Neither the retired orange nor the retired oat, by name.
    expect(rule).not.toMatch(/--db-orange|--db-warm/);
  });

  it('reserves that edge on every row, so gaining it does not shift the text', () => {
    expect(LIVE_CSS).toMatch(/\.live-step \{[^}]*border-left: 3px solid transparent/);
  });

  it('lets the outcome win over the position when the newest step failed', () => {
    // Red is a claim about what happened; orange only says where the run is. A row
    // that has just failed should not be painted as the healthy frontier.
    const rule = LIVE_CSS.match(/\.live-step\.newest\.partial,[^{]*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/border-left: 3px solid var\(--db-red-600\)/);
    expect(rule).toMatch(/background: var\(--db-red-wash\)/);
  });

  it('indents by depth in the stylesheet, from the depth the model already capped', () => {
    // 16px a level, and the cap is `toLiveStep`'s rather than a second one here.
    expect(LIVE_CSS).toMatch(/padding-left: calc\(12px \+ var\(--live-depth, 0\) \* 16px\)/);
    expect(toLiveStep(stage({ id: 'step-1', depth: 9 })).depth).toBe(3);
  });

  it('pins the kind mark and numbered badge as one row on the first line', () => {
    const index = LIVE_CSS.match(/\.live-step-index \{([^}]*)\}/)?.[1] ?? '';
    expect(index).toMatch(/align-self: start/);
    expect(index).toMatch(/margin-top: 1px/);
    expect(index).toMatch(/flex-direction: row/);
    expect(index).not.toMatch(/flex-direction: column/);
    const icon = LIVE_CSS.match(/\.live-step-icon \{([^}]*)\}/)?.[1] ?? '';
    expect(icon).toMatch(/height: calc\(var\(--text-base\) \* 1\.4\)/);
  });

  it('uses the agent map’s numbered badge for every live row', () => {
    // One formatter and one badge class make step 07 the same visual address
    // while a run is live and after it is opened in Run Explorer.
    expect(PANEL).toContain("import { railTiming, stepNumber } from './agent-map'");
    expect(PANEL).toContain('live-step-icon step-rail-num ast-num');
    expect(PANEL).toContain('{stepNumber(number)}');
    expect(PANEL).toContain('number={index + 1}');
  });

  it('has no pulse on the compact rail left to guard', () => {
    // THE GAP IS CLOSED BY REMOVAL RATHER THAN BY A GUARD, which is the better of
    // the two answers and was not available while the halo was the design.
    //
    // What used to be here: a 1.4s box-shadow cycle on `.dag-node.active` in
    // `--db-orange` at 14%, running for the whole length of a run, which was the
    // longest-running animation in the app and the one the old spec recorded as a
    // known accessibility gap. It was HELD rather than stopped under
    // prefers-reduced-motion, because the halo was one of three things saying which
    // card was live and stopping it could not be the same as deleting it.
    //
    // §2 removes orange from the palette and §5 makes the live moment the line
    // drawing into the current star on the band above -- which is `aria-hidden` and
    // frozen by the guard in astrolabe-animation.css. So the halo went with the
    // colour and was not restated in blue: the blue edge and the moving counter say
    // which card is live without moving at all, for every reader rather than for the
    // ones who knew to ask.
    expect(TRACE_CSS).not.toMatch(/@keyframes pulse/);
    expect(TRACE_CSS).not.toMatch(/box-shadow: 0 0 0 5px/);
    const active = TRACE_CSS.match(/\n\.dag-node\.active \{([^}]*)\}/)?.[1] ?? '';
    expect(active).not.toMatch(/animation/);
    // The band's own animations are the ones the guard now covers, and they are
    // covered by class name rather than one at a time: anything carrying an
    // `ast-anim-` class is frozen the day it is written.
    expect(partial('astrolabe-animation.css')).toMatch(/\[class\*='ast-anim-'\] \{\n\s*animation: none !important;/);
  });

  it('says which relationship each rail edge is, rather than only that there is one', () => {
    // The requirement stands and the form changed: this used to be the words
    // "calls" and "then" printed in the gap, against a dotted line that said
    // neither. The live spec draws the relation instead -- an elbow out to a tool
    // a decision called, an elbow back to the decision after it, a straight drop
    // between siblings -- so each edge names its shape in its class and the words
    // are gone. Three shapes, still three distinguishable relations.
    expect(TRACE_CSS).not.toMatch(/\.trace-dag\.compact \.dag-edge span/);
    expect(railConnector(0, 1).shape).toBe('out');
    expect(railConnector(1, 0).shape).toBe('back');
    expect(railConnector(1, 1).shape).toBe('down');
  });
});

describe('a step announced before it finishes', () => {
  const running = (id: string, name: string) =>
    stage({ id, name, status: 'running', duration: 0, input: '', output: '' });

  it('replaces its own announcement rather than being listed twice', () => {
    const announced = mergeLiveStage([stage({ id: 'step-1' })], running('step-2', 'Choosing the next step'));
    expect(announced.map((entry) => entry.id)).toEqual(['step-1', 'step-2']);
    expect(runningStepNumber(announced)).toBe(2);

    // The completion carries the same id, so it lands in the row the reader has
    // been watching rather than under it.
    const reported = mergeLiveStage(announced, stage({ id: 'step-2', name: 'Chose the next step', duration: 4120 }));
    expect(reported).toHaveLength(2);
    expect(reported[1].name).toBe('Chose the next step');
    expect(reported[1].duration).toBe(4120);
    expect(runningStepNumber(reported)).toBe(0);
  });

  it('is an append and nothing else against a model that announces nothing', () => {
    // THE STATE BETWEEN THE APP DEPLOY AND THE MODEL RE-LOG. Every stage is a
    // completion with an id nobody has seen, so this is the behaviour the list had
    // before announcements existed, and no step is ever in progress.
    let stages: TraceStage[] = [];
    for (const id of ['step-1', 'step-1-1-data_genie', 'step-2', 'synthesis']) {
      stages = mergeLiveStage(stages, stage({ id }));
      expect(runningStepNumber(stages)).toBe(0);
    }
    expect(stages.map((entry) => entry.id)).toEqual(['step-1', 'step-1-1-data_genie', 'step-2', 'synthesis']);
    expect(stages.every((entry) => entry.status === 'complete')).toBe(true);
  });

  it('keeps every announced row when tools are announced together', () => {
    // THIS EXPECTATION WAS THE OTHER WAY ROUND. It used to require a standing
    // announcement to be dropped when the next one arrived, on the reasoning
    // that only one step runs at a time. The agent announces a parallel batch
    // before any of it starts, so that rule showed one tool of three.
    const batch = mergeLiveStage(
      [stage({ id: 'step-1' }), running('step-1-1-data_genie', 'Calling data_genie')],
      running('step-1-2-run_sql', 'Calling run_sql')
    );
    expect(batch.map((entry) => entry.id)).toEqual(['step-1', 'step-1-1-data_genie', 'step-1-2-run_sql']);
    expect(batch.filter((entry) => entry.status === 'running')).toHaveLength(2);
    // The completed row is kept whatever happens: it was reported and observed.
    expect(batch[0].status).toBe('complete');
    // And the clock runs until the last of them reports, rather than being
    // cleared by the first completion.
    const held = nextRunningSince({ stages: batch, since: 1_000, now: 9_000 });
    expect(held).toBe(1_000);
    const oneDone = mergeLiveStage(batch, stage({ id: 'step-1-1-data_genie', duration: 4120 }));
    expect(nextRunningSince({ stages: oneDone, since: 1_000, now: 9_000 })).toBe(1_000);
    const allDone = mergeLiveStage(oneDone, stage({ id: 'step-1-2-run_sql', duration: 900 }));
    expect(nextRunningSince({ stages: allDone, since: 1_000, now: 9_000 })).toBeNull();
  });

  it('names the newest unfinished step rather than the envelope holding it', () => {
    /*
     * THE REPORTED DEFECT: the agent path showed step 01 as the step in progress
     * at step 07, and the pill beside it read "Live · step 01" all run.
     *
     * A run announces its envelopes before it does anything -- `orchestrator`,
     * then `data_source_finder` -- and reports neither until it is over, so the
     * FIRST unfinished row is step 01 from the first event of the run to the last.
     * The step the reader is waiting on is the NEWEST announcement, which is what
     * this counts. Built the way a real run builds it, one event at a time.
     */
    let stages: TraceStage[] = [];
    for (const [id, name] of [
      ['orchestrator', 'Orchestrator'],
      ['data_source_finder', 'Data Source Finder'],
      ['step-1', 'Choosing the next step'],
    ] as const) {
      stages = mergeLiveStage(stages, running(id, name));
    }
    expect(runningStepNumber(stages)).toBe(3);

    // The model turn reports, its tool is announced under it, and the count
    // follows the tool rather than falling back to an envelope two rows up.
    stages = mergeLiveStage(stages, stage({ id: 'step-1', name: 'Chose the next step', duration: 4120 }));
    stages = mergeLiveStage(stages, running('step-1-1-data_genie', 'Querying governed data'));
    expect(runningStepNumber(stages)).toBe(4);

    // A parallel batch: the newest of them, and never the envelope.
    stages = mergeLiveStage(stages, running('step-1-2-run_sql', 'Running SQL'));
    expect(runningStepNumber(stages)).toBe(5);

    // And the envelopes are still open the whole way through, which is what made
    // the first reading wrong rather than merely imprecise.
    expect(stages[0].status).toBe('running');
    expect(stages[1].status).toBe('running');
  });

  it('counts up once a second and stops the instant the run ends', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const startedAt = Date.now();
      const at = (loading: boolean) => runningElapsed({ loading, runningSince: startedAt, now: Date.now() });

      expect(at(true)).toBe(0);
      expect(railTiming({ duration: 0, status: 'running' }, at(true))).toBe('0s…');

      vi.advanceTimersByTime(1_000);
      expect(railTiming({ duration: 0, status: 'running' }, at(true))).toBe('1s…');
      vi.advanceTimersByTime(11_400);
      expect(at(true)).toBe(12_400);
      // The mockup's figure, twelve and a bit seconds into a step.
      expect(railTiming({ duration: 0, status: 'running' }, at(true))).toBe('12s…');

      // THE RUN ENDS. Nothing else changes -- the start instant is still there and
      // the page's clock is still ticking for the extraction beside it -- and the
      // row stops counting on the strength of `loading` alone.
      expect(at(false)).toBeNull();
      vi.advanceTimersByTime(60_000);
      expect(at(false)).toBeNull();
      expect(railTiming({ duration: 0, status: 'running' }, at(false))).toBe(RAIL_UNFINISHED);
      // And still counting for a run that is still going, so the guard above is
      // the run's end rather than the clock stopping.
      expect(at(true)).toBe(72_400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops counting when the step it was counting finishes, before the next is announced', () => {
    // The gap between one step completing and the next being announced is a real
    // state of a real run, and there is nothing in progress during it. A counter
    // left running there would attribute the wait to a step that had finished.
    expect(runningElapsed({ loading: true, runningSince: null, now: 1_800_000_000_000 })).toBeNull();
    // A clock that went backwards is not a step that started in the future.
    expect(runningElapsed({ loading: true, runningSince: 1_000, now: 400 })).toBe(0);
  });

  it('says how many steps are done rather than counting one that is not', () => {
    // The panel's own sentence, which is the one place on it that states a number.
    // "3 steps so far" over two finished steps and one still running counts two
    // different things.
    const mid = buildLiveRun({
      openedAt: 1_000,
      stages: [
        stage({ id: 'step-1' }),
        stage({ id: 'step-1-1-data_genie', kind: 'tool' }),
        running('step-2', 'Choosing the next step'),
      ],
    });
    expect(mid.detail).toBe('2 steps done, now “Choosing the next step”.');
    expect(mid.steps).toHaveLength(3);
    expect(mid.steps[2].status).toBe('running');
    // And unchanged wording once nothing is in progress.
    expect(buildLiveRun({ openedAt: 1_000, stages: [stage({ id: 'step-1' })] }).detail).toBe(
      '1 step so far, newest “Chose the next step”.'
    );
  });

  it('shows the moving count on the panel’s row too, rather than the zero it recorded', () => {
    // The panel and the rail read the same number from the same clock. A running
    // step's `duration` is 0 by design, so printing it would put "0ms" beside a
    // step that has been going for twenty seconds.
    expect(PANEL).toMatch(/step\.status === 'running'/);
    expect(PANEL).toMatch(/railTiming\(\{ duration: step\.durationMs, status: step\.status \}, elapsedMs\)/);
    expect(PANEL).toMatch(/elapsedMs\?: number \| null;/);
  });

  it('paints a failed step with the shared failed pill, not a grey outline', () => {
    // AppKit's outline Badge is the grey chip that made step 09 look like
    // "running". The run-header mapping already sends failed to ast-pill--neg.
    expect(PANEL).toMatch(/className=\{astPill\(step\.status\)\}/);
    expect(PANEL).toMatch(/from '\.\/run-header'/);
  });
});

/**
 * What a browser that was not there for the run is shown when it comes back.
 *
 * The run outlives the connection that narrated it: the app server keeps
 * invoking Model Serving after a reload or a closed tab ends the stream, and
 * records each step as it arrives. So a returning browser reads the steps back
 * rather than losing them, and these two functions are how they land.
 */
describe('a run replayed into a view that did not watch it', () => {
  it('reproduces the whole path for a browser holding nothing', () => {
    const replayed = mergeReplayedStages(
      [],
      [
        stage({ id: 'step-1' }),
        stage({ id: 'step-1-1-data_genie', kind: 'tool', name: 'Asked the data Genie space' }),
        stage({ id: 'step-2', status: 'running', duration: 0 }),
      ]
    );

    expect(replayed.map((entry) => entry.id)).toEqual(['step-1', 'step-1-1-data_genie', 'step-2']);
    // In the order the run reported them, which is the order the server stored
    // them in. A path drawn out of order is a path of a run that never happened.
    expect(replayed[2].status).toBe('running');
  });

  it('does not duplicate a step the view already watched arrive', () => {
    // The ordinary case a second after asking: this browser holds the stream AND
    // polls the durable state, so every step arrives twice. Folding by id is what
    // keeps one step to one row.
    const held = [stage({ id: 'step-1' }), stage({ id: 'step-2', status: 'running', duration: 0 })];

    const merged = mergeReplayedStages(held, [
      stage({ id: 'step-1' }),
      stage({ id: 'step-2', status: 'running', duration: 0 }),
      stage({ id: 'step-3' }),
    ]);

    expect(merged.map((entry) => entry.id)).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('lets a replayed completion resolve a step the view still has running', () => {
    // The run finished the step while the reader was away. The row stays where it
    // was and stops being unresolved, rather than a second row appearing under it.
    const merged = mergeReplayedStages(
      [stage({ id: 'step-2', status: 'running', duration: 0 })],
      [stage({ id: 'step-2', status: 'complete', duration: 4_120 })]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('complete');
    expect(merged[0].duration).toBe(4_120);
  });

  it('changes nothing when there is nothing to replay', () => {
    // A turn that answers with a plan takes no steps, a run polled before its
    // first step has none yet, and a run older than the narration being stored
    // has none at all. None of the three may blank what is on screen.
    const held = [stage({ id: 'step-1' })];
    expect(mergeReplayedStages(held, [])).toEqual(held);
  });
});

describe('which run the agent path draws', () => {
  const live = [stage({ id: 'step-2', status: 'running', duration: 0 })];
  const answered = [stage({ id: 'step-1' }), stage({ id: 'step-2' })];

  it('draws the run in flight rather than the one that answered before it', () => {
    expect(
      railStagesFor({
        loading: true,
        runStopped: false,
        liveStages: live,
        answeredStages: answered,
        clarificationStages: [],
      })
    ).toEqual(live);
  });

  it('draws nothing at all for a run in flight that has reported no step', () => {
    // THE BUG. This used to fall back to the last answer's trace whenever the
    // live list was empty, and a reader who left a running question and came
    // back arrives in exactly that state -- so the rail narrated the PREVIOUS
    // question's run under a pill saying this one was live. The empty list is
    // what puts the honest "working on your question" row on screen instead.
    expect(
      railStagesFor({
        loading: true,
        runStopped: false,
        liveStages: [],
        answeredStages: answered,
        clarificationStages: [],
      })
    ).toEqual([]);
  });

  it('settles a run that died into the steps it did finish', () => {
    expect(
      railStagesFor({ loading: false, runStopped: true, liveStages: live, answeredStages: [], clarificationStages: [] })
    ).toEqual(live);
  });

  it('draws the stored trace once the conversation is not running', () => {
    expect(
      railStagesFor({
        loading: false,
        runStopped: false,
        liveStages: [],
        answeredStages: answered,
        clarificationStages: [],
        recorded: true,
      })
    ).toEqual(answered);
  });

  it('draws a clarification’s own trace when that is all the turn produced', () => {
    const asked = [stage({ id: 'step-1-clarify' })];
    expect(
      railStagesFor({
        loading: false,
        runStopped: false,
        liveStages: [],
        answeredStages: [],
        clarificationStages: asked,
        recorded: true,
      })
    ).toEqual(asked);
  });

  it('does not draw stored stages when the finished answer has no MLflow id', () => {
    expect(
      railStagesFor({
        loading: false,
        runStopped: false,
        liveStages: [],
        answeredStages: answered,
        clarificationStages: [],
        recorded: false,
      })
    ).toEqual([]);
  });

  it('keeps the streamed path when a recorded answer arrived with an empty stored trace', () => {
    // A recorded run can still persist stages: [] (a race with the final
    // event). Once loading went false, preferring that empty stored list made
    // the process disappear. Keep the socket's path only when MLflow recorded.
    expect(
      railStagesFor({
        loading: false,
        runStopped: false,
        liveStages: live,
        answeredStages: [],
        clarificationStages: [],
        recorded: true,
      })
    ).toEqual(live);
  });

  it('does not keep streamed stages when the finished answer has no MLflow id', () => {
    expect(
      railStagesFor({
        loading: false,
        runStopped: false,
        liveStages: live,
        answeredStages: [],
        clarificationStages: [],
        recorded: false,
      })
    ).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ArchitectureCanvas, ArchitecturePage } from './ArchitecturePage';
import { ARCHITECTURE_NODES } from './architecture';
import { QuestionDrawer } from './MonitoringPage';
import { SourcesModule } from './SourcesModule';
import { PlanCard } from './PlanCard';
import { RunDetails } from './RunDetails';
import { TraceTimeline } from './TraceTimeline';
import { BRAND_THEME_FILES, type BrandProduct } from './brand-icons';
import type { AnalysisPlan, RunTrace } from './app-types';
import type { SourceRef, TraceStage } from './answer-shape';
import type { MonitoringDetail } from '../../shared/monitoring-contract';

/**
 * The marks where the handoff puts them, asserted against rendered markup rather
 * than against the source that would render it.
 *
 * The distinction earns its place here more than almost anywhere. A product icon
 * is exactly the kind of defect that leaves every source-level claim true: the
 * component imports a mark, passes a product, sizes it correctly -- and draws the
 * wrong logo, because the pairing it read was wrong two files away. So each claim
 * below finds the ARTWORK, read off disk, inside the page's own output.
 *
 * What it cannot say is that the result looks right. It can say the Lakebase mark
 * is in the Lakebase node and nobody else's is; it cannot say the mark is legible
 * at 18px against that node's fill, or that the row of eight reads as a row. That
 * needs a screen, and nothing here should be read as claiming it has had one.
 */

/**
 * The cut the app draws: official geometry, astrolabe fills.
 *
 * These surfaces are all white, so `light` is what renders on every one of them.
 * That the recoloured file IS the official geometry is held once, in
 * brand-icons.test.tsx, rather than restated at each placement.
 */
const asset = (product: BrandProduct) => {
  const reviewed = readFileSync(
    new URL(`./assets/logo/theme/${BRAND_THEME_FILES.light[product]}`, import.meta.url),
    'utf8'
  )
    .trim()
    .replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  // MLflow is one-colour, so ordinary page placements keep this reviewed
  // geometry and resolve its ink through the page's semantic foreground. The
  // other marks need both colours in their committed light-surface cuts.
  return product === 'mlflow' ? reviewed.replaceAll('#11171C', 'var(--foreground)') : reviewed;
};

/** The page as a reader gets it on load, before anything is fetched. */
function architectureMarkup(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ArchitecturePage />
    </MemoryRouter>
  );
}

describe('the Architecture tab marks every node that is a Databricks product', () => {
  /**
   * The pairing itself, node by node.
   *
   * Written out here rather than derived from `ARCHITECTURE_NODES`, because a
   * test that reads the same table it is checking asserts only that the table
   * equals itself. This is a second, independent statement of what each node is,
   * and the two have to agree.
   */
  const EXPECTED: Record<string, BrandProduct | null> = {
    browser: null,
    app: 'apps',
    'agent-endpoint': 'mosaic-ai',
    'data-source-finder': 'mosaic-ai',
    'llm-endpoint': 'mosaic-ai',
    'genie-data': 'genie',
    'genie-dictionary': 'genie',
    'sql-warehouse': 'databricks-sql',
    catalog: 'unity-catalog',
    'semantic-index': 'mosaic-ai',
    'semantic-index-endpoint': 'mosaic-ai',
    lakebase: 'lakebase',
    'experiment-id': 'mlflow',
  };

  it('pairs each node with the product it actually is', () => {
    const declared = Object.fromEntries(ARCHITECTURE_NODES.map((node) => [node.id, node.product ?? null]));

    expect(declared).toEqual(EXPECTED);
  });

  it('leaves the browser unmarked, because Chrome is not a Databricks product', () => {
    // The one node on the drawing that belongs to the reader rather than to the
    // deployment. Marking it with anything would be the drawing claiming the app
    // ships the browser too.
    const browser = ARCHITECTURE_NODES.find((node) => node.id === 'browser');
    expect(browser?.product).toBeUndefined();
  });

  it('draws each of the six products the tab uses, from the published file', () => {
    const markup = architectureMarkup();
    const drawn = new Set(Object.values(EXPECTED).filter((product): product is BrandProduct => product !== null));

    for (const product of drawn) {
      expect(markup, product).toContain(asset(product));
    }
  });

  it('sizes them at the handoff’s 18px, left of the node title', () => {
    const markup = architectureMarkup();
    // The wrapper exists because .arch-node-main is a single-column grid: an icon
    // added as a direct child of it lands ABOVE the title rather than beside it.
    expect(markup).toMatch(/<span class="arch-node-title"><span class="brand-icon" style="--brand-icon-size:18px"/);
    expect(markup).not.toContain('--brand-icon-size:11px');
  });

  it('keeps the marks decorative, so the node is not announced twice', () => {
    // The node's accessible name is built from its label in nodeAccessibleName,
    // and the label is the very next element. A mark that announced itself would
    // read the product, then read the node whose name is the product.
    const markup = architectureMarkup();
    const marks = markup.match(/<span class="brand-icon"[^>]*>/g) ?? [];

    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark).toContain('aria-hidden="true"');
      expect(mark).not.toContain('title=');
    }
  });
});

describe('every outbound MLflow action carries the MLflow mark inside its anchor', () => {
  const trace = {
    sql: '',
    undeclaredKeys: [],
    mlflow: {
      traceId: 'tr-deadbeef',
      experimentId: 'e1',
      url: 'https://example.databricks.com/ml/experiments/e1/traces/tr-deadbeef',
    },
    trace: null,
  } as unknown as RunTrace;

  const detail: MonitoringDetail = {
    id: 'question-1',
    conversationId: 'conversation-1',
    question: 'What changed?',
    askedBy: 'someone@example.com',
    askedAt: '2026-08-20T12:00:00Z',
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
    mlflowUrl: 'https://example.databricks.com/ml/experiments/e1/traces/tr-deadbeef',
    runId: null,
  };

  const architecturePayload: Parameters<typeof ArchitectureCanvas>[0]['payload'] = {
    workspaceHost: 'https://example.databricks.com',
    canDeepLink: true,
    servingEndpoint: { value: '', variable: '' },
    appWarehouse: { value: '', variable: '' },
    experimentId: 'e1',
    appServicePrincipal: '',
    appBuildSha: '',
    semanticIndex: { decidedBy: '', reason: '' },
    readAt: '2026-08-20T12:00:00Z',
  };

  const outboundMarkup = [
    renderToStaticMarkup(<RunDetails trace={trace} advanced={false} onAdvancedChange={() => {}} unavailable={null} />),
    renderToStaticMarkup(
      <MemoryRouter>
        <QuestionDrawer detail={detail} onClose={() => {}} onOpenPerson={() => {}} />
      </MemoryRouter>
    ),
    renderToStaticMarkup(
      <MemoryRouter>
        <ArchitectureCanvas byResource={new Map()} payload={architecturePayload} now={Date.now()} />
      </MemoryRouter>
    ),
  ].join('');

  it('puts the wordmark inside all three MLflow anchors, with theme-following ink', () => {
    const anchors = [
      ...outboundMarkup.matchAll(/<a\b[^>]*href="[^"]*\/ml\/experiments\/[^"]*"[^>]*>[\s\S]*?<\/a>/g),
    ].map(([anchor]) => anchor);

    expect(anchors).toHaveLength(3);
    for (const anchor of anchors) {
      expect(anchor).toContain('class="brand-icon wordmark"');
      expect(anchor).toContain(asset('mlflow'));
      expect(anchor).toContain('fill="var(--foreground)"');
    }
  });

  it('finds no MLflow hyperlink in Settings', () => {
    const source = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');

    expect(source).not.toMatch(/(?:href|to)\s*=\s*[^>\n]*mlflow/i);
  });
});

describe('the Sources module keeps provenance on one compact line', () => {
  const sources: SourceRef[] = [{ name: 'main.gold.title_daily_summary' } as SourceRef];

  it('names the source without restoring the retired Sources card chrome', () => {
    const markup = renderToStaticMarkup(<SourcesModule sources={sources} caveats={[]} />);

    expect(markup).toContain('<p class="source-line">');
    expect(markup).toContain('title_daily_summary');
    expect(markup).not.toContain('brand-icon');
    expect(markup).not.toContain('lucide-database');
  });

  it('does not add a second product label beside Sources', () => {
    const markup = renderToStaticMarkup(<SourcesModule sources={sources} caveats={[]} />);

    expect(markup.match(/>Sources</g)).toHaveLength(1);
    expect(markup).not.toContain('Unity Catalog');
  });
});

describe('the plan card marks the steps that are a call on a product', () => {
  /**
   * One of each kind the agent writes, in the order it writes them.
   *
   * The titles are the agent's own, copied from `_build_plan` and
   * `_plan_table_steps` in agent.py, so that this fixture is a plan the app can
   * actually receive rather than one invented to suit the assertion.
   */
  const plan: AnalysisPlan = {
    id: 'plan-1',
    question: 'How did the title do last month?',
    summary: 'Confirm definitions, analyze governed data, then synthesize.',
    steps: [
      { id: 'context', title: 'Establish context', description: 'Resolve references.', kind: 'context' },
      {
        id: 'definitions',
        title: 'Confirm metric definitions',
        description: 'Ask the dictionary.',
        kind: 'definitions',
      },
      { id: 'data-1', title: 'Query gold_title_daily_summary', description: 'Read the table.', kind: 'data' },
      { id: 'synthesis', title: 'Synthesize findings', description: 'Answer with evidence.', kind: 'synthesis' },
    ],
    requires_approval: true,
    uses_conversation_context: false,
    uses_attachment_context: false,
  };

  const markup = () =>
    renderToStaticMarkup(
      <PlanCard
        plan={plan}
        loading={false}
        resolved={false}
        approved={false}
        onApprove={() => {}}
        onRevise={() => {}}
      />
    );

  it('draws Genie on the definitions step and Databricks SQL on the data step', () => {
    const drawn = markup();

    expect(drawn).toContain(asset('genie'));
    expect(drawn).toContain(asset('databricks-sql'));
  });

  it('leaves context and synthesis unmarked, because neither calls a product', () => {
    // Two marks for four steps. A plan that put a logo on every line would be
    // claiming the model's own writing is a Databricks product call, and the
    // reader loses the one thing the marks are for: seeing which steps leave
    // the app.
    const marks = markup().match(/<span class="brand-icon"/g) ?? [];

    expect(marks).toHaveLength(2);
  });

  it('sizes them at 14px and keeps them decorative beside the step title', () => {
    const drawn = markup();

    expect(drawn).toContain('--brand-icon-size:14px');
    expect(drawn).not.toContain('--brand-icon-size:16px');
    for (const mark of drawn.match(/<span class="brand-icon"[^>]*>/g) ?? []) {
      expect(mark).toContain('aria-hidden="true"');
    }
  });

  it('keeps the agent’s own robot on the card header rather than a product logo', () => {
    // The coral mark is PIA's identity, not Databricks Apps'. It is the one
    // glyph on this page a brand icon must never replace.
    expect(markup()).toContain('agent-avatar');
  });
});

describe('the “what ran” timeline marks a step with the product it called', () => {
  /**
   * Stage ids are `step-{n}-{index}-{tool}`, which is where `toolNameFromId`
   * reads the tool from. Getting that shape wrong here would make every row
   * fall back to its word chip and the test pass for the wrong reason, so one
   * assertion below checks the fallback is NOT what is happening.
   */
  const stage = (id: string, name: string, kind: string): TraceStage => ({
    id,
    name,
    kind,
    start: 0,
    duration: 100,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
  });

  const trace = {
    id: 'trace-1',
    totalMs: 400,
    toolCalls: 3,
    stages: [
      stage('step-1-0-dictionary_genie', 'Checked field definitions', 'tool'),
      stage('step-2-0-data_genie', 'Queried governed data', 'tool'),
      stage('step-3-0-describe_table', 'Read a table’s columns', 'tool'),
      stage('step-4-0-completion', 'Wrote the answer', 'agent'),
    ],
  };

  const markup = () => renderToStaticMarkup(<TraceTimeline trace={trace} question="How did the title do?" />);

  it('draws each tool’s own product, not one mark for the whole run', () => {
    const drawn = markup();

    expect(drawn).toContain(asset('genie'));
    expect(drawn).toContain(asset('databricks-sql'));
    expect(drawn).toContain(asset('unity-catalog'));
  });

  it('replaces the letter tag on those rows and keeps it on the model turn', () => {
    // The table only. The roll-up tiles above it are per type and keep their
    // words whatever the rows do -- see the last case in this block.
    const table = markup().split('Step timeline')[1];

    // The three tool rows lost their chips; the model turn and the run envelope
    // kept theirs, because neither is a call on a product.
    expect(table).toContain('trace-chip-agent');
    expect(table).toContain('trace-chip-run');
    expect(table).not.toContain('trace-chip-sql');
    expect(table).not.toContain('trace-chip-discovery');
  });

  it('names the product it drew, because the tag it replaced is gone', () => {
    // The one placement where the mark is NOT decorative: with the chip removed
    // the cell has no text of its own, and the event beside it names the step
    // rather than the product.
    const drawn = markup();

    expect(drawn).toMatch(/<span class="brand-icon" style="--brand-icon-size:14px" title="Genie">/);
    expect(drawn).toMatch(/title="Databricks SQL"/);
    expect(drawn).not.toContain('aria-hidden="true"><svg');
  });

  it('keeps the roll-up tiles on words, because a type is not a product', () => {
    // `discovery` covers Genie, Unity Catalog and Mosaic AI at once. A tile
    // totalling all three cannot carry any one of their marks.
    const rollUp = markup().split('Step timeline')[0];

    expect(rollUp).toContain('trace-chip-discovery');
    expect(rollUp).not.toContain('brand-icon');
  });
});

describe('Run Explorer Timeline uses the notebook vocabulary', () => {
  const notebookViz = {
    id: 'tr-notebook-viz',
    totalMs: 24_009,
    toolCalls: 6,
    stages: [
      { id: 'step-1', name: 'Chose the next step', kind: 'agent', start: 0, duration: 2_350, status: 'complete' as const, calls: 1, input: '', output: '' },
      {
        id: 'step-1-1-describe_table',
        name: "Read a table's columns",
        kind: 'tool',
        start: 2_350,
        duration: 78,
        status: 'complete' as const,
        calls: 1,
        input: '{"full_name": "cdp_share_prod.acme.gold_title_daily"}',
        output: '',
      },
      { id: 'step-2', name: 'Chose the next step', kind: 'agent', start: 2_428, duration: 7_510, status: 'complete' as const, calls: 1, input: '', output: '' },
      {
        id: 'step-2-1-query_named_table',
        name: 'Queried the named table',
        kind: 'tool',
        start: 9_938,
        duration: 3_620,
        status: 'complete' as const,
        calls: 1,
        input: JSON.stringify({ sql: "SELECT COUNT(CASE WHEN title = 'Hoops23' THEN 1 END) AS games FROM gold" }),
        output: '',
      },
      { id: 'step-3', name: 'Prepared the findings', kind: 'agent', start: 13_558, duration: 5_080, status: 'complete' as const, calls: 1, input: '', output: '' },
      { id: 'plot', name: 'Built the charts', kind: 'tool', start: 18_638, duration: 1_180, status: 'complete' as const, calls: 1, input: '{"data":[{"x":["Hoops23"]}]}', output: '' },
      { id: 'synthesis', name: 'Prepared the answer', kind: 'agent', start: 19_818, duration: 4_180, status: 'complete' as const, calls: 1, input: '', output: '' },
    ],
  };

  it('draws kind pills, matching bars, notebook event names, and kind badges', () => {
    const drawn = renderToStaticMarkup(
      <TraceTimeline variant="explorer" trace={notebookViz} question="How many Hoops games do we have?" />
    );

    expect(drawn).toContain('trace-timeline--explorer');
    expect(drawn).toContain('trace-kind-kpis');
    expect(drawn).not.toContain('trace-kind-summary');
    expect(drawn).not.toContain('Time by tool type');
    expect(drawn).not.toContain('Step timeline');
    expect(drawn).not.toContain('brand-icon');

    expect(drawn).toContain('run - [orchestrator]');
    expect(drawn).toContain('model call - [orchestrator] turn 1');
    expect(drawn).toContain('model call - [orchestrator] turn 4');
    expect(drawn).toContain('describe_table cdp_share_prod.acme.gold_title_daily');
    expect(drawn).toMatch(/query_named_table SELECT COUNT/);
    expect(drawn).toMatch(/new_plot /);

    expect(drawn).toContain('trace-chip-run');
    expect(drawn).toContain('trace-chip-llm');
    expect(drawn).toContain('trace-chip-discovery');
    expect(drawn).toContain('trace-chip-sql');
    expect(drawn).toContain('trace-chip-plot');
    expect(drawn).toContain('trace-bar-run');
    expect(drawn).toContain('trace-bar-llm');
    expect(drawn).toContain('trace-bar-discovery');
    expect(drawn).toContain('trace-bar-sql');
    expect(drawn).toContain('trace-bar-plot');

    expect(drawn).toContain('19.12s');
    expect(drawn).toContain('3.62s');
    expect(drawn).toContain('78ms');
    expect(drawn).toContain('24.01s');
    expect(drawn).toContain('+4.80s');
  });

  it('leaves Ask on stakeholder names, product marks, and the tile roll-up', () => {
    const drawn = renderToStaticMarkup(
      <TraceTimeline trace={notebookViz} question="How many Hoops games do we have?" />
    );

    expect(drawn).not.toContain('trace-timeline--explorer');
    expect(drawn).toContain('Time by tool type');
    expect(drawn).toContain('Step timeline');
    expect(drawn).toContain('Chose the next step');
    expect(drawn).toContain('Queried the named table');
    expect(drawn).not.toContain('run - [orchestrator]');
    expect(drawn).not.toContain('model call - [orchestrator] turn 1');
    expect(drawn).not.toContain('trace-kind-summary');
    expect(drawn).not.toContain('trace-kind-kpis');
  });
});

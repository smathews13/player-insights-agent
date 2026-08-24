import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ArchitectureCanvas, ArchitecturePage, ArchitectureTiles, ChainBoundTiles } from './ArchitecturePage';
import { AGENT_CHAIN, ANSWER_CONTRACT, CHAIN_BOUND_LABEL, CHAIN_BOUNDS } from './agent-chain';
import { ARCHITECTURE_EDGES, ARCHITECTURE_NODES, dependencyNodes, drawnReadings } from './architecture';
import { ARCHITECTURE_CONTROL_SCOPES } from './architecture-control-scopes';
import { BOTTOM_ROW_NODES, NODE_BOXES, drawnEdges } from './architecture-layout';
import { readConnections, readingsById, type SettingsPayload } from './connection-model';
import { partial } from './styles/stylesheet';
import { connectedResource } from '../../shared/deployment-config';
import type { PreflightCheck } from './preflight';

/**
 * The tab as it is actually composed, rather than as its source reads.
 *
 * This repository has been bitten twice in one day by a screen that was wrong
 * while every assertion anybody thought to write about its source was true. Both
 * failures were relationships between two parts of a tree that no single file
 * could see: a control in a header that governed a panel on another tab, and a
 * report whose configuration half was read from the wrong key. Nothing short of
 * composing the markup and reading it back can catch that class of defect, so the
 * claims below are made against rendered output.
 *
 * `renderToStaticMarkup` runs no effects, which is exactly the state the page
 * opens in: `/api/architecture` has not answered and no check has been run. That
 * is the state most readers see, and it is the one the honesty rules are about --
 * so the page is rendered in it deliberately, and the components that need
 * readings are handed them directly, through the real derivation.
 */

/**
 * The page's own source, for the two claims that are about what it FETCHES.
 *
 * Read rather than rendered because that is where the fact lives: no effect runs
 * under `renderToStaticMarkup`, so a fetch on mount is invisible to the markup and
 * a claim about it has to be made against the code that would issue it.
 */
const PAGE_SOURCE = readFileSync(fileURLToPath(new URL('./ArchitecturePage.tsx', import.meta.url)), 'utf8');

/**
 * The Settings pane's source, for one claim that spans the two files.
 *
 * The loop-bound tiles are labelled in the gear's own words so that a reader who
 * wants to change one has a string to search for. A second phrasing of the same
 * number is the defect, and it is invisible in either file on its own.
 */
const RUNTIME_PANEL = readFileSync(fileURLToPath(new URL('./RuntimeSettingsPanel.tsx', import.meta.url)), 'utf8');

/** The markup a reader gets on a fresh page load, before anything is fetched. */
function pageMarkup(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ArchitecturePage />
    </MemoryRouter>
  );
}

/** The text a reader sees, tags removed and entities put back. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '\u00b7')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A stylesheet with its comments taken out.
 *
 * The notes in architecture.css quote the selectors and the properties they are
 * about, at length and deliberately, so a claim made against the raw text is
 * satisfied by the prose explaining why a rule is NOT written that way.
 */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    resource: connectedResource(id)!,
    configured: '',
    configuredFrom: 'artifact',
    actual: '',
    actualObserved: false,
    intended: null,
    intendedAt: '',
    intendedBy: '',
    editable: false,
    changedByLabel: '',
    changedByNote: '',
    ...over,
  } as SettingsPayload['resources'][number];
}

function check(id: string, status: PreflightCheck['status'], name = ''): PreflightCheck {
  return { id, label: id, status, name, detail: '', error: '', kind: 'dependency' } as unknown as PreflightCheck;
}

/**
 * A deployment in the state that exercises every treatment at once: something
 * reachable, something blocked, something using an id it was not configured with,
 * something nobody checked, and something with no configured value at all.
 *
 * Built through `readConnections` -- the derivation the Connections page renders --
 * rather than as literal readings, so a status here cannot be a status this app
 * would never produce.
 */
function deployment() {
  const payload: SettingsPayload = {
    resources: [
      row('agent-endpoint', { configured: 'an-endpoint', actual: 'an-endpoint', actualObserved: true }),
      row('sql-warehouse', {
        configured: 'configured-warehouse',
        actual: 'a-different-warehouse',
        actualObserved: true,
      }),
      row('genie-data', { configured: 'a-space' }),
      row('genie-dictionary', { configured: 'another-space' }),
      row('catalog', { configured: 'a_catalog' }),
      row('lakebase', { configured: 'a-branch' }),
      row('experiment-id', { configured: 'an-experiment' }),
      // Deliberately without a configured value: the case a diagram must not
      // render as a failure.
      row('llm-endpoint'),
      row('semantic-index', { configuredFrom: 'artifact' }),
    ],
    drift: [
      {
        id: 'mismatch-sql-warehouse',
        severity: 'blocking',
        resourceId: 'sql-warehouse',
        headline: '',
        detail: '',
        remedy: '',
      },
    ],
    status: 'blocked',
    appBuildSha: '',
    modelBuildSha: '',
    orchestratorReported: true,
    storeAvailable: true,
    checkedAt: '',
  };
  const checks = [
    check('agent-endpoint', 'ok', 'an-endpoint'),
    check('sql-warehouse', 'ok', 'a-different-warehouse'),
    check('genie-data', 'failed'),
    check('lakebase', 'ok', 'a-branch'),
  ];
  return { payload, checks, byResource: readingsById(readConnections(payload, checks)) };
}

/** The drawing, with readings in hand, and a host so the ↗ controls appear. */
function canvasMarkup(byResource = deployment().byResource, now = Date.now()): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ArchitectureCanvas
        byResource={byResource}
        now={now}
        payload={
          {
            workspaceHost: 'https://example.cloud.databricks.example',
            canDeepLink: true,
            servingEndpoint: { value: 'an-endpoint', variable: '' },
            appWarehouse: { value: '', variable: '' },
            experimentId: '',
            appServicePrincipal: '',
            appBuildSha: '',
            semanticIndex: { decidedBy: '', reason: '' },
            readAt: '',
          } as never
        }
      />
    </MemoryRouter>
  );
}

/** One card, cut out of the drawing, so a claim names the node it is about. */
function card(markup: string, id: string): string {
  const at = markup.indexOf(`data-testid="arch-node-${id}"`);
  expect(at, `${id} is on the drawing`).toBeGreaterThan(-1);
  const opens = markup.lastIndexOf('<div', at);
  // The next card, or the text equivalent that follows the last one. Cards are
  // siblings, so the slice between two openings is one card and its contents.
  const next = markup.indexOf('data-testid="arch-node-', at + 1);
  const stops =
    next === -1 ? markup.indexOf('data-testid="architecture-equivalent"') : markup.lastIndexOf('<div', next);
  return markup.slice(opens, stops);
}

describe('the words on the tab are the words the design asked for', () => {
  /**
   * BOTH SENTENCES ARE GONE, and the reason is the same reason the page has a
   * title at all: they described the tab to a reader who had just pressed it.
   * Pinned as absences rather than deleted quietly, because each was approved
   * copy once and a later change restoring "helpful" explanation is exactly the
   * regression this file exists to catch.
   */
  it('does not describe the tab under its own title', () => {
    expect(text(pageMarkup())).not.toContain('How this deployment is wired');
  });

  it('does not explain the drawing beside it', () => {
    const said = text(pageMarkup());
    expect(said).not.toContain('Storage (conversations, traces) sits on the bottom row');
    // The heading the reader keeps. The prose under it is what went.
    expect(said).toContain('Live data flow');
  });

  it('keeps the storage heading plain and removes the checks helper box', () => {
    const markup = pageMarkup();
    const said = text(markup);

    expect(markup).toContain('<h3 class="section-label" id="arch-rail-storage">Storage</h3>');
    expect(said).not.toContain('off the answer path');
    expect(said).not.toContain('Statuses match the Connections page');
    expect(markup).not.toContain('architecture-checks-note');
  });

  it('no longer claims a click is what starts the checks', () => {
    const said = text(pageMarkup());
    expect(said).not.toContain('Checks only run when you click');
    expect(said).not.toContain('means not checked yet, not broken');
  });

  it('labels the refresh control consistently', () => {
    const markup = pageMarkup();

    expect(markup).toContain('Refresh');
    expect(markup).not.toContain('Run the checks');
    expect(markup).not.toContain('Re-check');
  });

  it('does not bring back the prose the tab was rebuilt to remove', () => {
    const rendered = text(pageMarkup());

    for (const killed of [
      'What happens between a question and an answer',
      'drawn from what this deployment reports about itself',
      'Each dependency',
      'Two halves of one answer',
      'How an answer is assembled',
      'What each piece does',
    ]) {
      expect(rendered, killed).not.toContain(killed);
    }
  });
});

describe('the page makes one cheap read of its own and delegates the expensive pair', () => {
  /**
   * The cheap read is still this page's, and still the only fetch it owns.
   * `/api/architecture` costs the app container's own configuration and no round
   * trip to the workspace, so it was never the half worth gating.
   */
  it('fetches only the cheap description of the deployment itself', () => {
    expect(PAGE_SOURCE).toContain('fetchWithTimeout(');
    expect(PAGE_SOURCE).toContain("'/api/architecture'");
    expect(PAGE_SOURCE).not.toContain("fetch('/api/settings')");
    expect(PAGE_SOURCE).not.toContain("fetch('/api/preflight')");
  });

  /**
   * ONE MECHANISM FOR BOTH TABS, which is the point of the change rather than a
   * tidy-up. This page and Connections had opposite bugs from the same cause --
   * each decided for itself when to fetch, so one re-probed the workspace on every
   * navigation and the other never probed at all. A page that grew its own
   * `runChecks` back would put them on separate clocks again.
   */
  it('reads the checks through the shared session mechanism', () => {
    expect(PAGE_SOURCE).toContain('useSessionChecks()');
    expect(PAGE_SOURCE).not.toContain('const runChecks');
  });

  it('says every dependency is unchecked before the first run has landed', () => {
    const markup = pageMarkup();
    const unchecked = [...text(markup).matchAll(/Not checked/g)];

    // Every dependency, plus the tile that counts them. Not a green graph, and
    // not a blocked one: asserted on the tone each card carries, because the tile
    // strip legitimately prints the words Reachable and Drift as labels.
    expect(unchecked.length).toBeGreaterThan(dependencyNodes().length);
    expect(markup).not.toContain('data-tone="reachable"');
    expect(markup).not.toContain('data-tone="blocked"');
  });
});

describe('the tiles count what is drawn below them, and invent nothing', () => {
  function tiles(byResource = deployment().byResource) {
    return text(
      renderToStaticMarkup(
        <ArchitectureTiles dependencies={dependencyNodes().length} readings={drawnReadings(byResource)} />
      )
    );
  }

  it('counts the dependencies the drawing has, not every entry Connections lists', () => {
    // The registry has twenty entries and this diagram draws ten of them. A
    // tile above the drawing reads as a count of the drawing.
    expect(dependencyNodes()).toHaveLength(10);
    expect(tiles()).toContain('Dependencies 10');
  });

  it('shows an em dash rather than a zero before anything has been checked', () => {
    // "0 reachable" is a claim that somebody looked. Nobody has.
    const fresh = tiles(new Map());

    expect(fresh).toContain('Reachable \u2014');
    expect(fresh).toContain('Drift \u2014');
    expect(fresh).toContain('Not checked 10');
  });

  it('reports the reachable, unchecked and drifted counts the readings produce', () => {
    // Two reachable (the endpoint and Lakebase), one blocked, one drifted, and the
    // rest unchecked -- all of it out of the shared derivation rather than counted
    // here. The drifted one is also reachable, which is why drift is its own tile
    // rather than a fourth state in the first one.
    const rendered = tiles();

    expect(rendered).toContain('Reachable 3');
    expect(rendered).toContain('Drift 1');
  });

  it('counts four, and states no freshness, because the Refresh control states it', () => {
    // The design seats a fifth tile, LAST CHECK. Dropped: the heading already
    // says how old the statuses are, right beside the button that changes it, and
    // two readings of one clock can disagree. Four also fills the row and the
    // narrow 2x2 exactly, which five did not.
    const markup = renderToStaticMarkup(
      <ArchitectureTiles dependencies={dependencyNodes().length} readings={drawnReadings(deployment().byResource)} />
    );

    expect([...markup.matchAll(/<li/g)]).toHaveLength(4);
    expect(text(markup)).not.toContain('Last check');
    expect(text(markup)).not.toMatch(/min ago|not yet|just now/);
  });
});

describe('every card on the drawing reports the live reading and not a literal', () => {
  it('gives each dependency the status its reading produced', () => {
    const { byResource } = deployment();
    const markup = canvasMarkup(byResource);

    // Each of these is asserted on the card itself rather than on the page, so a
    // status landing on the wrong node fails here.
    expect(text(card(markup, 'agent-endpoint'))).toContain('Reachable');
    expect(text(card(markup, 'genie-data'))).toContain('Blocked');
    expect(text(card(markup, 'catalog'))).toContain('Not checked');
    expect(text(card(markup, 'lakebase'))).toContain('Reachable');
  });

  it('shows the identifier the deployment reported, on the card that names it', () => {
    const markup = canvasMarkup();

    expect(text(card(markup, 'genie-dictionary'))).toContain('another-space');
    expect(text(card(markup, 'catalog'))).toContain('a_catalog');
    // The measured value beats the configured one, which is the whole point of the
    // drift case: the warehouse answered under an id nobody configured.
    expect(text(card(markup, 'sql-warehouse'))).toContain('a-different-warehouse');
    expect(text(card(markup, 'sql-warehouse'))).not.toContain('configured-warehouse');
  });

  it('labels the answer model accurately and keeps it distinct from the benchmark judge', () => {
    const payload: SettingsPayload = {
      resources: [
        row('llm-endpoint', {
          configured: 'databricks-claude-sonnet-4-6',
          actual: 'databricks-claude-sonnet-4-6',
          actualObserved: true,
        }),
      ],
      drift: [],
      status: 'ok',
      appBuildSha: '',
      modelBuildSha: '',
      orchestratorReported: true,
      storeAvailable: true,
      checkedAt: '',
    };
    const byResource = readingsById(
      readConnections(payload, [check('llm-endpoint', 'ok', 'databricks-claude-sonnet-4-6')])
    );
    const model = card(canvasMarkup(byResource), 'llm-endpoint');

    expect(text(model)).toContain(
      'Foundation model Reachable databricks-claude-sonnet-4-6 Reasons over prompts and writes answer prose.'
    );
    expect(text(model)).not.toContain('Judge');
    expect(model).toContain('Open in Databricks');
    expect(connectedResource('judge-endpoint')?.label).toBe('Benchmark judge model');
  });

  it('marks the drifted dependency as drifted and still as reachable', () => {
    const warehouse = card(canvasMarkup(), 'sql-warehouse');

    expect(text(warehouse)).toContain('Reachable');
    expect(text(warehouse)).toContain('Drift');
    expect(warehouse).toContain('data-drift="drift"');
  });

  it('does not draw a dependency with nothing configured as a failure', () => {
    // The foundation model, with no configured value and no check. It says nobody
    // looked, shows no identifier, and takes neither the blocked nor the drifted
    // treatment. A diagram that painted this red would send a reader after a grant
    // problem that does not exist.
    const model = card(canvasMarkup(), 'llm-endpoint');

    expect(text(model)).toContain('Not checked');
    expect(text(model)).not.toContain('Blocked');
    expect(model).not.toContain('data-drift=');
    expect(model).toContain('data-tone="not-checked"');
    expect(model).not.toContain('arch-node-value');
  });

  it('says nothing about the browser or the app server that a probe would have said', () => {
    for (const id of ['browser', 'app']) {
      const local = card(canvasMarkup(), id);

      expect(text(local), id).toContain('Runs here');
      expect(text(local), id).not.toContain('Reachable');
      expect(text(local), id).not.toContain('Not checked');
    }
  });

  it('draws the Data Source Finder as its own in-process agent card', () => {
    const markup = canvasMarkup();
    const finder = card(markup, 'data-source-finder');

    expect(text(finder)).toContain('Data Source Finder');
    expect(text(finder)).toContain('Runs in-process');
    expect(text(finder)).toContain('Finds and validates governed data for the Orchestrator.');
    expect(markup).toContain('data-testid="arch-dot-pe12"');
    expect(markup).toContain('data-testid="arch-dot-pe13"');
    expect(markup).toContain('data-testid="arch-dot-pe14"');
    expect(ARCHITECTURE_EDGES.filter((edge) => edge.from === 'data-source-finder').map((edge) => edge.to)).toEqual([
      'llm-endpoint',
      'genie-dictionary',
      'genie-data',
      'sql-warehouse',
      'semantic-index',
    ]);
  });

  it('keeps every node description to one tight sentence', () => {
    const expected = new Map([
      ['browser', 'Sends questions to the app.'],
      ['app', 'Stores conversations and invokes the Orchestrator.'],
      ['agent-endpoint', 'Plans each answer and delegates data discovery.'],
      ['data-source-finder', 'Finds and validates governed data for the Orchestrator.'],
      ['llm-endpoint', 'Reasons over prompts and writes answer prose.'],
      ['genie-data', 'Answers metric questions from curated tables.'],
      ['genie-dictionary', 'Defines business terms and fields.'],
      ['sql-warehouse', 'Runs read-only SQL under the reader\u2019s grants.'],
      ['catalog', 'Applies governance to every table read.'],
      ['semantic-index', 'Searches field and metric descriptions for source discovery.'],
      ['semantic-index-endpoint', 'Serves Vector Search queries.'],
      ['lakebase', 'Stores conversations, uploads, feedback, and benchmark runs.'],
      ['experiment-id', 'Stores run traces, tool calls, SQL, and token usage.'],
    ]);

    expect(new Map(ARCHITECTURE_NODES.map((node) => [node.id, node.role]))).toEqual(expected);
    expect(ARCHITECTURE_NODES.every((node) => !/Mosaic/i.test(`${node.label} ${node.role}`))).toBe(true);
  });

  it('states each status in words, never in colour alone', () => {
    // Every card carries its status as text inside the pill. The accent on a
    // card's edge says what KIND of thing it is and is never a status, so a reader
    // who cannot distinguish the six accents loses nothing but decoration.
    const markup = canvasMarkup();
    for (const node of ARCHITECTURE_NODES) {
      const drawn = card(markup, node.id);
      // The pill is there, in the app's one status recipe rather than in a rule
      // this page wrote for itself.
      expect(drawn, node.id).toMatch(/class="ast-pill ast-pill--[a-z-]+ arch-node-status"/);
      // And it has a WORD in it, which is the half of "never in colour alone"
      // that a class name cannot carry. An empty pill would satisfy the line
      // above and say nothing at all.
      const label = drawn.match(/arch-node-status"[^>]*>([^<]*)</)?.[1] ?? '';
      expect(label.trim(), node.id).not.toBe('');
    }
  });
});

/**
 * Two cards where there used to be one, composed rather than reasoned about.
 *
 * The lane's whole point is that the index and the endpoint under it fail
 * separately, so the proof has to be two cards on one drawing carrying two
 * different verdicts at the same moment.
 */
describe('the semantic lane draws the index and the endpoint separately', () => {
  function lane(index: PreflightCheck['status'], endpoint?: PreflightCheck['status']) {
    const payload: SettingsPayload = {
      resources: [
        row('semantic-index', { configured: 'a_catalog.a_schema.an_index', configuredFrom: 'artifact' }),
        // Empty, as the server sends it: nothing configures this one, so its
        // name can only come back from the index.
        row('semantic-index-endpoint', { configuredFrom: '' }),
      ],
      drift: [],
      status: 'ok',
      appBuildSha: '',
      modelBuildSha: '',
      orchestratorReported: true,
      storeAvailable: true,
      checkedAt: '',
    };
    const checks = [check('semantic-index', index, 'a_catalog.a_schema.an_index')];
    if (endpoint) checks.push(check('semantic-index-endpoint', endpoint, 'an-endpoint'));
    return readingsById(readConnections(payload, checks));
  }

  it('gives each object its own card, its own status and its own identifier', () => {
    const markup = canvasMarkup(lane('ok', 'ok'));

    expect(text(card(markup, 'semantic-index'))).toContain('a_catalog.a_schema.an_index');
    expect(text(card(markup, 'semantic-index'))).toContain('Reachable');
    expect(text(card(markup, 'semantic-index-endpoint'))).toContain('an-endpoint');
    expect(text(card(markup, 'semantic-index-endpoint'))).toContain('Reachable');
  });

  it('shows a healthy index over an endpoint that did not answer', () => {
    // The state the two cards exist for. One drawing, two verdicts.
    const markup = canvasMarkup(lane('ok', 'failed'));

    expect(card(markup, 'semantic-index')).toContain('data-tone="reachable"');
    expect(card(markup, 'semantic-index-endpoint')).toContain('data-tone="blocked"');
  });

  it('links the index to the index, and offers the endpoint no guessed link', () => {
    const markup = canvasMarkup(lane('ok', 'ok'));

    // The three-level name is a Unity Catalog path, so the card can point at the
    // object itself rather than at the catalog it lives in.
    expect(card(markup, 'semantic-index')).toContain('/explore/data/a_catalog/a_schema/an_index');
    // The endpoint is not a Unity Catalog object and this app has no verified
    // path for one, so there is no outward control rather than a dead one.
    expect(card(markup, 'semantic-index-endpoint')).not.toContain('Open in Databricks');
    expect(card(markup, 'semantic-index-endpoint')).toContain('href="/connections?entity=semantic-index-endpoint"');
  });

  it('says both of them in the words the drawing is read as', () => {
    const markup = canvasMarkup(lane('ok', 'failed'));
    const equivalent = text(markup.slice(markup.indexOf('data-testid="architecture-equivalent"')));

    expect(equivalent).toContain('Vector Search index: Reachable');
    expect(equivalent).toContain('Vector Search endpoint: Blocked');
  });
});

/**
 * The card, drawn against the state the deployment was actually in.
 *
 * The rebuild job failed for five nights and the index went on serving content
 * from 10 August. Every status on this page was green throughout, because
 * reachability was the only thing being drawn. These assertions are about what
 * a reader now sees at a glance in exactly that situation.
 */
describe('the index card says how old its content is', () => {
  const NOW = Date.parse('2026-08-15T09:00:00Z');
  const HOUR = 3_600_000;

  function index(over: Partial<PreflightCheck>) {
    const payload: SettingsPayload = {
      resources: [row('semantic-index', { configured: 'a_catalog.a_schema.an_index', configuredFrom: 'artifact' })],
      drift: [],
      status: 'ok',
      appBuildSha: '',
      modelBuildSha: '',
      orchestratorReported: true,
      storeAvailable: true,
      // Set, and set to the moment of the render. A card that read this instead
      // of the probe's own timestamp would look freshly rebuilt.
      checkedAt: new Date(NOW).toISOString(),
    };
    const built = { ...check('semantic-index', 'ok', 'a_catalog.a_schema.an_index'), ...over };
    return readingsById(readConnections(payload, [built]));
  }

  const AGED = (days: number) => ({ content_at: new Date(NOW - days * 24 * HOUR).toISOString() });

  it('marks content the rebuild schedule cannot explain, beside a status that stays reachable', () => {
    const markup = card(canvasMarkup(index(AGED(5)), NOW), 'semantic-index');

    expect(text(markup)).toContain('Stale');
    expect(text(markup)).toContain('5 d old');
    expect(markup).toContain('data-age="stale"');
    // The status word is untouched. An index serving old content answers every
    // check there is, and calling it Blocked would make the word mean two
    // things on one page.
    expect(text(markup)).toContain('Reachable');
    expect(markup).toContain('data-tone="reachable"');
  });

  it('keeps the reading in the pills, where this tab says status lives', () => {
    const markup = card(canvasMarkup(index(AGED(5)), NOW), 'semantic-index');

    expect(markup.indexOf('data-age=')).toBeGreaterThan(markup.indexOf('arch-node-pills'));
    expect(markup.indexOf('data-age=')).toBeLessThan(markup.indexOf('arch-node-value'));
  });

  it('says the age is not reported when the workspace reported none', () => {
    const markup = card(canvasMarkup(index({}), NOW), 'semantic-index');

    expect(text(markup)).toContain('Age not reported');
    expect(markup).toContain('data-age="unreported"');
    // Nothing that could be read as a freshness, anywhere on the card. The two
    // times in scope -- the check's and the render's -- are both this moment,
    // and either would have drawn an index rebuilt seconds ago.
    expect(text(markup)).not.toMatch(/Rebuilt|Stale/);
    expect(text(markup)).not.toMatch(/\d+\s*(h|d)\b/);
  });

  it('draws content inside the schedule plainly, with no mark on it', () => {
    const markup = card(canvasMarkup(index(AGED(1)), NOW), 'semantic-index');

    expect(markup).toContain('data-age="fresh"');
    expect(text(markup)).toContain('Rebuilt 1 d ago');
    expect(text(markup)).not.toContain('Stale');
  });

  it('gives no other card an age, since nothing else on the drawing holds a copy', () => {
    const markup = canvasMarkup(index(AGED(5)), NOW);
    for (const node of ARCHITECTURE_NODES) {
      if (node.id === 'semantic-index') continue;
      expect(card(markup, node.id), node.id).not.toContain('data-age=');
    }
  });

  it('says it in the words the drawing is read as, for both readings', () => {
    const stale = canvasMarkup(index(AGED(5)), NOW);
    const equivalent = text(stale.slice(stale.indexOf('data-testid="architecture-equivalent"')));
    expect(equivalent).toContain('still serving content it took from its source 5 d ago');

    const silent = canvasMarkup(index({}), NOW);
    expect(text(silent.slice(silent.indexOf('data-testid="architecture-equivalent"')))).toContain(
      'Nothing reported when this index last took content from its source'
    );
  });
});

describe('the drawing is reachable and readable without seeing it', () => {
  it('gives every dependency card a link to its own row on Connections', () => {
    const markup = canvasMarkup();
    for (const node of dependencyNodes()) {
      expect(card(markup, node.id), node.id).toContain(`href="/connections?entity=${node.resourceId!}"`);
    }
  });

  it('puts the status into the accessible name rather than leaving it to the pill', () => {
    const warehouse = card(canvasMarkup(), 'sql-warehouse');

    expect(warehouse).toMatch(/aria-label="SQL warehouse: Reachable[^"]*drifted/);
  });

  it('offers Databricks as a second, named control rather than as the whole card', () => {
    // One tab stop that sometimes leaves the app and sometimes does nothing is a
    // control a reader cannot learn. The in-app link is always there; this one is
    // there when a host and an identifier both are.
    const warehouse = card(canvasMarkup(), 'sql-warehouse');

    expect(warehouse).toContain('Open in Databricks');
    expect(warehouse).toContain('target="_blank"');
    expect(warehouse).toContain('rel="noopener noreferrer"');
    // And no dead affordance where there is no identifier to point at.
    expect(card(canvasMarkup(), 'llm-endpoint')).not.toContain('Open in Databricks');
  });

  /**
   * ONE DESCRIPTION OF ONE EDGE, all the way to the markup.
   *
   * The dot travelling along an edge and the line it travels on are two elements
   * in two different element trees -- a `<span>` beside the `<svg>`, not inside it
   * -- and the only thing keeping them together is that both are handed the same
   * string. That is worth an assertion on the rendered output rather than on the
   * module, because it is the kind of thing a later refactor "tidies" by giving
   * the dot its own midpoint, at which point the dot is drawing an edge that is
   * not there.
   *
   * What no test here can check is where the browser then PUTS it: positioning a
   * motion path is the engine's arithmetic, and there is no engine in this suite.
   * The CSS side of that -- the box at the canvas origin, anchored by its middle,
   * displaced by nothing -- is pinned in architecture-layout.test.ts.
   */
  it('draws each dot from the same path string as its line', () => {
    const markup = canvasMarkup();

    for (const edge of drawnEdges()) {
      const dot = markup.slice(markup.indexOf(`data-testid="arch-dot-${edge.id}"`));
      const style = /style="([^"]*)"/.exec(dot)?.[1] ?? '';
      // Entity-escaped in the attribute, so the comparison is against the same
      // escaping the `d` attribute of the line gets.
      const quoted = edge.d.replace(/'/g, '&#x27;');
      expect(style, edge.id).toContain(`offset-path:path(&#x27;${quoted}&#x27;)`);
      expect(markup, edge.id).toContain(`<path class="arch-edge" d="${quoted}"`);
    }
  });

  it('hides the lines and the dots from a screen reader, and says all of it in words', () => {
    const markup = canvasMarkup();
    const equivalent = markup.slice(markup.indexOf('data-testid="architecture-equivalent"'));

    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
    for (const edge of drawnEdges()) {
      expect(markup, edge.id).toContain(`data-testid="arch-dot-${edge.id}"`);
      expect(text(equivalent), edge.meaning).toContain(edge.meaning);
    }
    for (const node of ARCHITECTURE_NODES) {
      expect(text(equivalent), node.id).toContain(node.label);
    }
  });

  /**
   * The chain rail and the answer contract.
   *
   * WHAT WAS ON SCREEN BEFORE THESE ASSERTIONS was a four-row rail describing the
   * run as it worked before the chain was reworked: browser, orchestrator,
   * warehouse, browser. It had no approval plan in it, so the plan card a reader
   * meets on their first real question appeared to come from nowhere on the page
   * whose job is to explain the app; no step loop and none of the bounds that stop
   * one; and synthesis and charts folded into a single row, which hid that charts
   * are the first thing dropped when a run runs out of budget.
   *
   * Asserted against the rendered page rather than the module, because the module
   * was never the problem -- a fully correct stage list that no page rendered would
   * leave the screen exactly as wrong as it was.
   */
  it('draws every chain stage, in the order the agent opens them', () => {
    const markup = pageMarkup();
    const rail = markup.slice(markup.indexOf('arch-rail-answer'), markup.indexOf('arch-rail-contract'));
    for (const stage of AGENT_CHAIN) {
      expect(rail, stage.stage).toContain(stage.title);
      // The MLflow stage id, verbatim. This is the whole point of the row carrying
      // it: a reader holding this rail against a run in the Run Explorer is
      // comparing two strings, and a friendly paraphrase would not match.
      expect(rail, stage.stage).toContain(`data-stage="${stage.stage}"`);
    }
    for (let index = 1; index < AGENT_CHAIN.length; index += 1) {
      expect(
        rail.indexOf(AGENT_CHAIN[index - 1].title),
        `${AGENT_CHAIN[index - 1].stage} before ${AGENT_CHAIN[index].stage}`
      ).toBeLessThan(rail.indexOf(AGENT_CHAIN[index].title));
    }
  });

  it('says which stages a run may skip', () => {
    // Three of the seven do not run on every question. A rail that draws seven rows
    // for a run that had four is a rail a reader takes for a fault, so the row says
    // so rather than the prose under it.
    const rail = pageMarkup();
    const optional = AGENT_CHAIN.filter((stage) => stage.optional);
    expect(optional.map((stage) => stage.stage)).toEqual(['plan', 'attachment', 'plot']);
    expect(rail).toContain('If needed');
  });

  it('states the answer contract in the agent’s own field names', () => {
    const markup = pageMarkup();
    const contract = markup.slice(markup.indexOf('arch-rail-contract'));
    for (const section of ANSWER_CONTRACT) {
      expect(contract, section.field).toContain(section.field);
      expect(text(contract), section.label).toContain(section.label);
    }
    // `derivation` and `sources` carry no Optional badge, because there is no switch
    // for them: a figure without the source it came from is the one thing the
    // contract does not allow, whatever the gear is set to.
    for (const field of ['derivation', 'sources']) {
      const section = ANSWER_CONTRACT.find((entry) => entry.field === field);
      expect(section?.optional, field).toBeUndefined();
    }

    // Optional is an action, not only a status: each optional section leads to
    // the Runtime pane where that section can be switched on or off.
    const optionalCount = ANSWER_CONTRACT.filter((section) => section.optional).length;
    expect(contract.match(/href="\/settings#answer-contract-settings"/g)).toHaveLength(optionalCount);
    expect(contract).toContain('open its answer content setting');
  });

  /**
   * The loop bounds, above the drawing.
   *
   * They were readable only by opening the gear, on the page whose whole job is to
   * say what this deployment does -- and they are the numbers a reader needs to
   * explain a run that stopped early.
   */
  it('heads the page with the three loop bounds, in the gear’s own words', () => {
    const strip = pageMarkup();
    expect(strip).toContain('data-testid="architecture-loop-tiles"');
    for (const bound of CHAIN_BOUNDS) {
      expect(text(strip), bound).toContain(CHAIN_BOUND_LABEL[bound]);
    }
    // The labels are the Settings pane's, so a reader who wants to change one has a
    // string to search the gear for. Asserted from both ends, because a second
    // phrasing for the same number is the defect and it is invisible in either file
    // on its own.
    for (const bound of CHAIN_BOUNDS) {
      expect(RUNTIME_PANEL, bound).toContain(CHAIN_BOUND_LABEL[bound]);
    }
  });

  it('shows an em-dash rather than the shared defaults before the settings land', () => {
    // 12/12/90 are the defaults and it would be easy to print them here. A stored
    // setting is what the agent actually uses, so a number on a page that has not
    // read the store is a claim about something nobody checked -- the same rule the
    // dependency tiles above follow for `Reachable`.
    const strip = pageMarkup();
    const tiles = strip.slice(strip.indexOf('architecture-loop-tiles'));
    expect(tiles).toContain('\u2014');
    expect(text(tiles.slice(0, tiles.indexOf('arch-flow')))).not.toContain('12');
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <ChainBoundTiles loop={{ maxSteps: 12, maxToolCalls: 9, maxRunSeconds: 90 }} />
        </MemoryRouter>
      )
    ).toContain('>9<');
  });

  it('makes every KPI a keyboard-reachable link to the Runtime settings', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ChainBoundTiles loop={{ maxSteps: 12, maxToolCalls: 9, maxRunSeconds: 90 }} />
      </MemoryRouter>
    );

    expect(markup.match(/class="arch-bound-settings-link"/g)).toHaveLength(CHAIN_BOUNDS.length);
    expect(markup.match(/href="\/settings#settings-runtime-form"/g)).toHaveLength(CHAIN_BOUNDS.length);
    for (const bound of CHAIN_BOUNDS) {
      expect(markup, bound).toContain(`data-bound="${bound}"`);
      expect(markup, bound).toContain(`Show the architecture it controls; open Runtime settings to change it.`);
    }
  });

  it('marks exactly the selected KPI scope on the rendered nodes and edges', () => {
    const active = 'maxToolCalls';
    const scope = ARCHITECTURE_CONTROL_SCOPES[active];
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ArchitectureCanvas activeBound={active} byResource={deployment().byResource} now={Date.now()} payload={null} />
      </MemoryRouter>
    );

    for (const node of ARCHITECTURE_NODES) {
      expect(card(markup, node.id).includes('data-control-active="true"'), node.id).toBe(scope.nodes.includes(node.id));
    }
    for (const edge of drawnEdges()) {
      const at = markup.indexOf(`<path class="arch-edge" d="${edge.d}`);
      expect(at, edge.id).toBeGreaterThan(-1);
      const path = markup.slice(at, markup.indexOf('</path>', at));
      const controlled = scope.edges.includes(`${edge.from}->${edge.to}`);
      expect(path.includes('data-control-active="true"'), edge.id).toBe(controlled);
      expect(path.includes(`data-control-bound="${active}"`), edge.id).toBe(controlled);
    }
  });

  it('draws the two stores at the bottom of the canvas the sub-line describes', () => {
    // The sentence above the drawing is a claim about the picture. It is checked
    // here against the rendered style, because the numbers being right in the
    // layout module says nothing about them reaching the cards.
    const markup = canvasMarkup();
    for (const id of BOTTOM_ROW_NODES) {
      expect(card(markup, id), id).toContain(`top:${NODE_BOXES[id].top}px`);
    }
  });
});

/**
 * WHICH COLUMN EACH RAIL IS IN, which is a fact about the markup and the grid
 * together and therefore invisible in either one alone.
 *
 * Storage used to be drawn at the foot of the LEFT column, because three rails
 * auto-placing into two columns puts the third one under the first, and the left
 * column is the seven-stage chain. The right column was a short card with several
 * hundred pixels of white beneath it, and where conversations are kept was
 * reachable only by scrolling past the whole pipeline. Nothing could see that:
 * every rail rendered, in the right order, with the right words in it.
 *
 * So the placement is asserted from both ends. The source order is what a reader
 * gets when the columns stack, and the span in architecture.css is what puts
 * Storage beside the chain rather than below it -- and either one on its own is
 * satisfied by the arrangement that was reported.
 */
describe('storage sits under the answer contract rather than under the chain', () => {
  const ARCHITECTURE = withoutComments(partial('architecture.css'));

  it('writes the three rails in the order they stack in one column', () => {
    const markup = pageMarkup();
    const chain = markup.indexOf('id="arch-rail-answer"');
    const contract = markup.indexOf('id="arch-rail-contract"');
    const storage = markup.indexOf('id="arch-rail-storage"');

    expect(chain).toBeGreaterThan(-1);
    // The chain, then what comes back, then where it is kept. Storage last is the
    // whole of why it is written last: below 1180px this order IS the page, and a
    // rail moved into the second column by the stylesheet alone would come between
    // the pipeline stages and the answer they produce.
    expect(chain).toBeLessThan(contract);
    expect(contract).toBeLessThan(storage);
  });

  it('names each rail in the markup, so the stylesheet places rather than counts', () => {
    const markup = pageMarkup();
    for (const rail of ['chain', 'contract', 'storage']) {
      expect(markup, rail).toContain(`data-rail="${rail}"`);
    }
    // `:first-child` meant "whichever rail is written first", which is the chain
    // today and would have been the answer contract after any reordering.
    expect(ARCHITECTURE).not.toMatch(/\.arch-rail:first-child/);
  });

  it('gives the chain both rows of the left column so the third rail lands beside it', () => {
    expect(ARCHITECTURE).toMatch(/\.arch-rails\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(ARCHITECTURE).toMatch(/\.arch-rail\[data-rail='chain'\]\s*\{[^}]*grid-row:\s*span 2/);
  });

  it('places storage with the grid and not with a nudge', () => {
    // A negative margin, an absolute position or a stated height would each put the
    // block in the same pixels today and come apart the moment a stage is added to
    // the chain or a section to the answer contract. The rows are auto-sized, which
    // is what lets either column be the taller one.
    const storage = ARCHITECTURE.match(/\.arch-rail\[data-rail='storage'\][^{]*\{([^}]*)\}/g) ?? [];
    for (const rule of storage) {
      expect(rule).not.toMatch(/position:\s*(absolute|fixed)/);
      expect(rule).not.toMatch(/margin[^:]*:\s*-/);
      expect(rule).not.toMatch(/(^|[^-])height:/);
    }
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import {
  ConfigurationList,
  ConnectionRow,
  ConnectionsCounts,
  DataCatalogsValue,
  CatalogDenylistValue,
} from './ConnectionsPage';
import { configurationValue, RESOURCE_PRODUCT } from './connections-view';
import { BRAND_MARKS, BRAND_THEME_MARKS } from './brand-icons';
import { buildFacts } from './connection-build';
import { groupConnections, readConnections, type SettingsPayload } from './connection-model';
import { truncateHead } from './connection-status';
import type { PreflightCheck } from './preflight';
import { CONNECTED_RESOURCES, connectedResource } from '../../shared/deployment-config';
import {
  EMPTY_CATALOG_DENYLIST,
  EMPTY_DATA_CATALOGS,
  SINGLE_SCHEMA_LABEL,
  WHOLE_CATALOG_LABEL,
} from '../../shared/data-catalog-scope';

/**
 * The three blocks the Connections redesign introduced, read as a reader reads
 * them rather than as their sources read.
 *
 * The tab had drifted a long way from the design it was specified against, and
 * the shape of the drift was always the same: a verdict repeated as a chip on
 * every row, a fact stated as a sentence explaining the section it sat in, and a
 * count of nothing printed because the code had a number to hand. Each of those
 * is invisible in a unit test of the module that decides it and obvious in the
 * composed markup, so the assertions below are made against rendered text.
 *
 * `renderToStaticMarkup` runs no effects, which is why the blocks are rendered
 * directly. From the page every one of them sits behind a fetch a static render
 * never issues.
 */

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, '\u2019')
    .replace(/&middot;/g, '\u00b7')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function check(id: string, status: PreflightCheck['status'], over: Partial<PreflightCheck> = {}): PreflightCheck {
  return {
    id,
    kind: 'dependency',
    name: '',
    label: id,
    status,
    detail: '',
    checked_with: '',
    duration_ms: 0,
    error: '',
    remedy: null,
    ...over,
  };
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
    changedByLabel: 'Set by the release',
    changedByNote: '',
    ...over,
  } as SettingsPayload['resources'][number];
}

function payload(over: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    resources: [],
    drift: [],
    status: 'ok',
    appBuildSha: '',
    modelBuildSha: '',
    orchestratorReported: false,
    storeAvailable: true,
    checkedAt: '2026-08-15T18:00:00Z',
    ...over,
  };
}

function groupsFor(resources: SettingsPayload['resources'], checks: PreflightCheck[] = []) {
  return groupConnections(readConnections(payload({ resources, checks }), []));
}

/**
 * Two values with no remote end, which is what puts them in Configuration. The
 * rail is an app setting and the token cap is an orchestrator one, so between
 * them the list carries both affordances and both products.
 */
const CONFIG_ROWS = [
  row('max-output-tokens', { configured: '4000' }),
  row('shared-conversation-rail', { configured: 'false' }),
];

describe('the sections the rows are grouped into', () => {
  /**
   * THE DEFECT THIS REPLACED. Every row carried its own status chip, and the
   * sections were named after what a dependency IS -- "Data and compute" and
   * three more like it -- so a blocked warehouse was the eleventh row of the
   * third group and its verdict was a chip a reader had to go and find.
   */
  it('says each verdict once, in the header, and not again on any row', () => {
    const groups = groupsFor(
      [row('sql-warehouse', { configured: 'wh-0001' }), row('catalog', { configured: 'a_catalog' })],
      [check('sql-warehouse', 'failed'), check('catalog', 'ok')]
    );
    expect(groups.map((group) => group.key)).toEqual(['blocked', 'reachable']);

    const rows = groups
      .flatMap((group) => group.readings)
      .map((reading) =>
        render(
          <ConnectionRow
            reading={reading}
            tone="blocked"
            saving={false}
            refreshing={false}
            requested={false}
            onSave={() => Promise.resolve(true)}
            onClear={async () => {}}
          />
        )
      )
      .join('');
    // The chip's own words, which are what a per-row verdict looked like.
    expect(text(rows)).not.toMatch(/\bBlocked\b|\bNot checked\b|\bReachable\b/);
  });

  /**
   * A count belongs beside "Not checked" and nowhere else. That section is the
   * extent of what this page does not know, which is the thing somebody wants
   * the size of; a number beside "Blocked" would read as a second severity, and
   * the rows under a verdict are countable at a glance anyway.
   */
  it('measures the section nobody checked, and none of the others', () => {
    const groups = groupsFor(
      [
        row('sql-warehouse', { configured: 'wh-0001' }),
        row('genie-data', { configured: 'space-data' }),
        row('genie-dictionary', { configured: 'space-dictionary' }),
      ],
      [check('sql-warehouse', 'ok')]
    );
    const asides = new Map(groups.map((group) => [group.key, group.aside]));
    expect(asides.get('not-checked')).toBe('2 dependencies');
    expect(asides.get('reachable')).toBe('');
  });

  it('counts one unchecked dependency in the singular', () => {
    const groups = groupsFor([row('genie-data', { configured: 'space-data' })], []);
    expect(groups[0]?.aside).toBe('1 dependency');
  });
});

describe('the Configuration list', () => {
  /**
   * These are the values with no remote end. They were drawn as dependencies --
   * a caret to expand, a chip reading "Nothing to reach" -- so five rows of the
   * page's most emphatic furniture were spent asserting there was nothing to
   * assert.
   */
  function configuration() {
    const group = groupsFor(CONFIG_ROWS).find((candidate) => candidate.key === 'configuration')!;
    return render(
      <ConfigurationList
        group={group}
        saving=""
        requestedResource=""
        onSave={() => Promise.resolve(true)}
        onClear={async () => {}}
      />
    );
  }

  it('reaches no verdict about a value with nothing to reach', () => {
    const rendered = text(configuration());
    expect(rendered).not.toMatch(/nothing to reach/i);
    expect(rendered).not.toMatch(/not checked/i);
  });

  it('opens no disclosure, because there is no second reading behind one', () => {
    expect(configuration()).not.toMatch(/aria-controls|connection-row-caret/);
  });

  it('reads a switch as a switch rather than as the word the environment uses', () => {
    expect(configurationValue('true')).toBe('on');
    expect(configurationValue('false')).toBe('off');
    expect(configurationValue(' 4000 ')).toBe('4000');
  });

  it('offers the pencil only where something can write the value', () => {
    const editable = render(
      <ConfigurationList
        group={
          groupsFor([row('max-output-tokens', { configured: '4000', editable: true })]).find(
            (group) => group.key === 'configuration'
          )!
        }
        saving=""
        requestedResource=""
        allowMutations
        onSave={() => Promise.resolve(true)}
        onClear={async () => {}}
      />
    );
    expect(editable).toContain('data-affordance="write"');
    expect(configuration()).toContain('data-affordance="locked"');
  });
});

/**
 * The two section headers that name a KIND of thing rather than a verdict.
 *
 * "Blocked" and "Unreachable" say what they mean in the word. "Connected
 * resources" and "Configuration" do not: a reader who has never deployed this
 * agent cannot tell from either name what the rows under it decide, and the
 * section that used to be called "Checked and reachable" was named after what
 * the last preflight DID rather than after what the rows are.
 */
describe('the headers that say what a section is', () => {
  function configurationHeader(): string {
    const group = groupsFor(CONFIG_ROWS).find((candidate) => candidate.key === 'configuration')!;
    return render(
      <ConfigurationList
        group={group}
        saving=""
        requestedResource=""
        onSave={() => Promise.resolve(true)}
        onClear={async () => {}}
      />
    );
  }

  it('names the reachable list for what its rows are, not for what the probe did', () => {
    const groups = groupsFor([row('sql-warehouse', { configured: 'wh-0001' })], [check('sql-warehouse', 'ok')]);
    expect(groups[0]?.title).toBe('Connected resources');
    expect(groups[0]?.title).not.toMatch(/checked/i);
  });

  it('does not lecture under Connected resources or Configuration', () => {
    const markup = configurationHeader();
    expect(markup).not.toContain('data-testid="connection-group-hint"');
    expect(markup).not.toContain('These are the settings');
    expect(markup).not.toContain('how the agent answers');
    expect(markup).not.toContain('These are the live services this app is wired to');
  });
});

describe('data_catalogs and catalog_denylist on the Configuration list', () => {
  /**
   * Both already rode the settings path as configuration rows. What was wrong
   * was the reading: a truncated string, or "not set", with no way to tell a
   * whole-catalog grant from a single-schema one, and an empty denylist looking
   * like a missing value.
   */
  function listFor(...rows: ReturnType<typeof row>[]) {
    const group = groupsFor(rows).find((candidate) => candidate.key === 'configuration')!;
    return render(
      <ConfigurationList
        group={group}
        saving=""
        requestedResource=""
        onSave={() => Promise.resolve(true)}
        onClear={async () => {}}
      />
    );
  }

  it('labels a whole-catalog entry and a single-schema entry differently', () => {
    const markup = render(<DataCatalogsValue configured="production_catalog, shared.reference_data" />);
    expect(markup).toContain('data-scope-form="whole-catalog"');
    expect(markup).toContain('data-scope-form="single-schema"');
    expect(markup).toContain('production_catalog');
    expect(markup).toContain('shared.reference_data');
    expect(text(markup)).toContain(WHOLE_CATALOG_LABEL);
    expect(text(markup)).toContain(SINGLE_SCHEMA_LABEL);
    expect(text(markup)).not.toMatch(/—|–/);
  });

  it('says an empty read scope means the agent can query nothing', () => {
    const markup = render(<DataCatalogsValue configured="" />);
    expect(text(markup)).toBe(EMPTY_DATA_CATALOGS);
    expect(text(markup)).not.toMatch(/not set|not configured/i);
  });

  it('reads an empty denylist as nothing excluded, not as an error', () => {
    const markup = render(<CatalogDenylistValue configured="" />);
    expect(text(markup)).toBe(EMPTY_CATALOG_DENYLIST);
    expect(markup).not.toMatch(/warning|error|missing|ast-pill--danger|ast-pill--warn/i);
    expect(text(markup)).not.toMatch(/not set/i);
  });

  it('shows denylist patterns when any are set', () => {
    expect(text(render(<CatalogDenylistValue configured="raw_*, *.scratch" />))).toContain('raw_*');
    expect(text(render(<CatalogDenylistValue configured="raw_*, *.scratch" />))).toContain('*.scratch');
  });

  it('draws both through the Configuration list rather than as dependency rows', () => {
    const rendered = listFor(
      row('catalog-allowlist', { configured: 'analytics, analytics.demo' }),
      row('catalog-denylist', { configured: '' })
    );
    expect(rendered).toContain('data-testid="configuration-catalog-allowlist"');
    expect(rendered).toContain('data-testid="configuration-catalog-denylist"');
    expect(text(rendered)).toContain(WHOLE_CATALOG_LABEL);
    expect(text(rendered)).toContain(SINGLE_SCHEMA_LABEL);
    expect(text(rendered)).toContain(EMPTY_CATALOG_DENYLIST);
    expect(text(rendered)).not.toMatch(/nothing to reach/i);
  });
});

describe('the product marks on the rows', () => {
  /**
   * WHAT THIS REPLACED. Every row drew the nearest Lucide shape to its product
   * -- a bot for the agent, a warehouse for the warehouse, a radar dish for
   * Vector Search -- because the official artwork was not in the repository. A
   * reader who knows the real marks read the lookalikes as real ones and was
   * then wrong about which product a row pointed at.
   *
   * Asserted against the artwork itself rather than against a class name: the
   * failure worth catching is a mark that is missing or is the wrong product's,
   * and both of those leave `class="brand-icon"` exactly where it was.
   */
  it('draws each product its own official mark', () => {
    const groups = groupsFor(
      [row('sql-warehouse', { configured: 'wh-0001' }), row('genie-data', { configured: 'space-data' })],
      [check('sql-warehouse', 'ok'), check('genie-data', 'ok')]
    );
    const rendered = groups
      .flatMap((group) => group.readings)
      .map((reading) =>
        render(
          <ConnectionRow
            reading={reading}
            tone="reachable"
            saving={false}
            refreshing={false}
            requested={false}
            onSave={() => Promise.resolve(true)}
            onClear={async () => {}}
          />
        )
      )
      .join('');
    // The recoloured cut, which is what this page draws now: official geometry
    // in the palette, `#2272B4` over `#B7D6EE` on a white row. The published
    // full-colour artwork must not be beside it -- half a list in one ink set and
    // half in the other reads as a rendering fault rather than as a mistake.
    expect(rendered).toContain(BRAND_THEME_MARKS.light['databricks-sql']);
    expect(rendered).toContain(BRAND_THEME_MARKS.light.genie);
    expect(rendered).not.toContain(BRAND_MARKS['databricks-sql']);
  });

  /**
   * A kind with no mark draws nothing at all, which is a gap in a column rather
   * than an error anybody sees. The record is exhaustive by type, so this is
   * really a guard against a slug that type-checks and has no artwork behind it.
   */
  it('has a mark for every kind of thing this deployment connects to', () => {
    const kinds = new Set(CONNECTED_RESOURCES.map((resource) => resource.kind));
    for (const kind of kinds) {
      expect(RESOURCE_PRODUCT[kind], kind).toBeTruthy();
      expect(BRAND_THEME_MARKS.light[RESOURCE_PRODUCT[kind]], kind).toContain('<svg');
    }
  });

  /**
   * The mark is decorative in both lists. The product's name is the label
   * immediately beside it, and a mark that announced itself would have a screen
   * reader read the product twice.
   */
  it('leaves the announcing to the label beside it', () => {
    const group = groupsFor(CONFIG_ROWS).find((candidate) => candidate.key === 'configuration')!;
    const rendered = render(
      <ConfigurationList
        group={group}
        saving=""
        requestedResource=""
        onSave={() => Promise.resolve(true)}
        onClear={async () => {}}
      />
    );
    expect(rendered).toContain(BRAND_THEME_MARKS.light.apps);
    expect(rendered).not.toMatch(/title="Databricks Apps"/);
  });
});

describe('the value the app writes to, which the design wants green', () => {
  const EXPERIMENT = [row('experiment-id', { configured: '<mlflow-experiment-id>' })];

  /**
   * The design asks for one tinted value in the Configuration list, and names
   * the one: the MLflow experiment traces land in. THE GROUPING HAS ALREADY
   * GRANTED IT, somewhere else -- which is why no branch in `ConfigurationList`
   * tints anything.
   *
   * A row is in Configuration only when nothing checked it. The moment the
   * experiment probe answers, the row has a remote end and moves to "Checked
   * and reachable", where the value IS a green badge like every other reachable
   * row's. A second tint inside Configuration would be dead on this deployment
   * and, if the grouping ever changed, would paint an unreached value the same
   * green as a reached one.
   */
  it('leaves Configuration for a reachable row the moment the probe answers', () => {
    const keys = groupsFor(EXPERIMENT, [check('experiment-id', 'ok')]).map((group) => group.key);
    expect(keys).toContain('reachable');
    expect(keys).not.toContain('configuration');
  });

  it('is green there, as the design asks, without a rule of its own', () => {
    const [reading] = groupsFor(EXPERIMENT, [check('experiment-id', 'ok')]).flatMap((group) => group.readings);
    const rendered = render(
      <ConnectionRow
        reading={reading}
        tone="reachable"
        saving={false}
        refreshing={false}
        requested={false}
        onSave={() => Promise.resolve(true)}
        onClear={async () => {}}
      />
    );
    expect(rendered).toContain('data-tone="reachable"');
    expect(text(rendered)).toContain('<mlflow-experiment-id>');
  });

  /**
   * And nothing in Configuration is ever tinted, which is the section's rule:
   * nothing here was reached, so nothing here carries a verdict.
   */
  it('tints nothing in the Configuration list', () => {
    const group = groupsFor([...EXPERIMENT, ...CONFIG_ROWS]).find((candidate) => candidate.key === 'configuration')!;
    const rendered = render(
      <ConfigurationList
        group={group}
        saving=""
        requestedResource=""
        onSave={() => Promise.resolve(true)}
        onClear={async () => {}}
      />
    );
    expect(rendered).not.toMatch(/data-tone="(reachable|blocked|drifted)"/);
    expect(text(rendered)).toContain('<mlflow-experiment-id>');
  });
});

describe('the Build and telemetry card', () => {
  it('shows both real stamps without judging whether they match', () => {
    const facts = buildFacts({ appBuildSha: 'aaaaaaaa11', modelBuildSha: 'bbbbbbbb22' });
    expect(facts.artifacts.map((artifact) => artifact.tone)).toEqual(['plain', 'plain']);
    expect(facts.artifacts.map((artifact) => artifact.short)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('keeps the working-tree suffix out of the hash and out of the clipboard', () => {
    const [app] = buildFacts({ appBuildSha: 'abc1234def+dirty', modelBuildSha: '' }).artifacts;
    expect(app.short).toBe('abc1234d');
    expect(app.full).toBe('abc1234def');
  });

  it('stays quiet about a half that reported nothing', () => {
    const facts = buildFacts({ appBuildSha: 'abc1234def', modelBuildSha: '' });
    expect(facts.artifacts[1].tone).toBe('plain');
  });
});

/**
 * Whether each half of the deployment is WORKING, which the two stamp rows did
 * not say.
 *
 * THE DEFECT. `App 5b0e675b` and `Orchestrator 05d742b2`, two grey hashes with a
 * copy button, on the tab a reader opens to find out what this deployment can
 * reach. The commit says which build is running; nothing on either row said
 * whether it is up, so a crashed app and a healthy one rendered identically.
 *
 * The assertions are on the reading rather than on the markup because what green
 * and red MEAN is the part that must not drift: green on the App row is the
 * workspace reporting a running app on active compute, or failing that this app
 * having answered the read that drew the page; green on the Orchestrator row is
 * the serving endpoint that runs questions having been reached.
 */
describe('whether each build stamp names something that is working', () => {
  const serving = (app: string, compute: string, message = '') => ({ app, compute, message });

  function health(over: Partial<Parameters<typeof buildFacts>[0]>) {
    const [app, orchestrator] = buildFacts({
      appBuildSha: 'aaaaaaaa11',
      modelBuildSha: 'bbbbbbbb22',
      ...over,
    }).artifacts;
    return { app, orchestrator };
  }

  it('is green on an app the workspace reports running on active compute', () => {
    const { app } = health({
      appBuildSha: 'aaaaaaaa11',
      modelBuildSha: '',
      appServing: serving('RUNNING', 'ACTIVE'),
    });
    expect(app.health.state).toBe('working');
    expect(app.health.label).toBe('Running');
    expect(app.tone).toBe('reachable');
  });

  /**
   * The one substitution this whole page exists to prevent: a badge stating
   * health nobody measured. A crashed app answered nothing, and a green stamp
   * over it is worse than a grey one.
   */
  it('is red on an app the workspace reports crashed, and says which state', () => {
    const { app } = health({
      appBuildSha: 'aaaaaaaa11',
      modelBuildSha: '',
      appServing: serving('CRASHED', 'ACTIVE'),
      // Answered from a stale response, which must not rescue the reading.
      appAnswered: true,
    });
    expect(app.health.state).toBe('not-working');
    expect(app.health.label).toBe('Not running');
    expect(app.health.note).toContain('CRASHED');
    expect(app.tone).toBe('blocked');
  });

  /**
   * A laptop, and every workspace version that does not answer about apps. The
   * app plainly works -- it served the read that drew the row -- and the platform
   * word is not available to state it, so the row says what it does know.
   */
  it('falls back to the read this page made when the workspace said nothing', () => {
    const { app } = health({ appBuildSha: 'aaaaaaaa11', modelBuildSha: '', appAnswered: true });
    expect(app.health.state).toBe('working');
    expect(app.health.label).toBe('Answering');
  });

  it('draws no verdict on an app nothing has reported and nothing has read', () => {
    const { app } = health({ appBuildSha: 'aaaaaaaa11', modelBuildSha: '' });
    expect(app.health.state).toBe('unknown');
    expect(app.tone).toBe('plain');
  });

  it('is green on an orchestrator endpoint a check reached', () => {
    const { orchestrator } = health({ appBuildSha: '', modelBuildSha: 'bbbbbbbb22', orchestratorStatus: 'reachable' });
    expect(orchestrator.health.state).toBe('working');
    expect(orchestrator.health.label).toBe('Reachable');
    expect(orchestrator.tone).toBe('reachable');
  });

  it.each(['blocked', 'unreachable'] as const)('is red on an orchestrator endpoint that is %s', (status) => {
    const { orchestrator } = health({
      appBuildSha: '',
      modelBuildSha: 'bbbbbbbb22',
      orchestratorStatus: status,
      // The model version's own report is older than the failed call, so it must
      // not outrank it.
      orchestratorReported: true,
    });
    expect(orchestrator.health.state).toBe('not-working');
    expect(orchestrator.tone).toBe('blocked');
  });

  /**
   * A refusal stopped at the permission layer and never reached the endpoint, so
   * it is not evidence the orchestrator is down. Red here sends a reader after a
   * service that is fine, which is the rule the row badges follow too.
   */
  it('does not call a refused call a broken orchestrator', () => {
    const { orchestrator } = health({ appBuildSha: '', modelBuildSha: 'bbbbbbbb22', orchestratorStatus: 'refused' });
    expect(orchestrator.health.state).toBe('unclear');
    expect(orchestrator.tone).toBe('drifted');
  });

  /**
   * The commonest healthy deployment: no probe named the endpoint, and the served
   * model version answered with its own configuration, which is the orchestrator
   * having demonstrably run.
   */
  it('counts the served version reporting its own configuration as working', () => {
    const { orchestrator } = health({ appBuildSha: '', modelBuildSha: 'bbbbbbbb22', orchestratorReported: true });
    expect(orchestrator.health.state).toBe('working');
    expect(orchestrator.health.label).toBe('Answered');
  });

  it('draws no verdict on an orchestrator nothing asked about and nothing heard from', () => {
    const { orchestrator } = health({ appBuildSha: '', modelBuildSha: 'bbbbbbbb22' });
    expect(orchestrator.health.state).toBe('unknown');
    expect(orchestrator.tone).toBe('plain');
  });

  /**
   * A stamp nobody reported is not a failing one. The tint would otherwise land
   * on the words `not set`, which reads as a verdict about the absence.
   */
  it('leaves an absent stamp untinted while still stating the health beside it', () => {
    const { orchestrator } = health({ appBuildSha: '', modelBuildSha: '', orchestratorStatus: 'blocked' });
    expect(orchestrator.short).toBe('');
    expect(orchestrator.tone).toBe('plain');
    expect(orchestrator.health.state).toBe('not-working');
  });
});

describe('the counts line, where the figures had to become tabular', () => {
  const NONE = {
    reachable: 0,
    blocked: 0,
    refused: 0,
    unreachable: 0,
    notChecked: 0,
    nothingToReach: 0,
    drifted: 0,
    pending: 0,
  };

  /**
   * THE FIGURES IN MONO, THE WORDS IN DM SANS, and the split is the whole fix.
   *
   * The line has always meant to be tabular: these counts change under the reader
   * when a refresh lands, and proportional figures make the line reflow as they
   * do. It asked for that with `font-variant-numeric` on DM Sans, which carries
   * no `tnum` feature, so the rule did nothing and the test that read it back
   * passed anyway.
   *
   * `.ast-num` has to be on the digits alone. Marking the whole phrase would
   * satisfy any stylesheet test and set "reachable" in a code face, which in a
   * 13px line reads as a value somebody escaped.
   */
  it('sets the figures in mono and leaves the words alone', () => {
    const markup = renderToStaticMarkup(<ConnectionsCounts counts={{ ...NONE, reachable: 12, notChecked: 9 }} />);
    expect(markup).toContain('<span class="ast-num">12</span> reachable');
    expect(markup).toContain('<span class="ast-num">9</span> not checked');
  });

  /** The tone stays on the pair, so a tinted count colours its number and its word. */
  it('tints the figure and the word together', () => {
    const markup = renderToStaticMarkup(<ConnectionsCounts counts={{ ...NONE, blocked: 2 }} />);
    expect(markup).toMatch(/data-tone="blocked"><span class="ast-num">2<\/span> blocked/);
  });

  /** And a zero still has no phrase at all, which is the line's oldest rule. */
  it('prints nothing for a count of nothing', () => {
    const markup = text(renderToStaticMarkup(<ConnectionsCounts counts={{ ...NONE, reachable: 3 }} />));
    expect(markup).toBe('3 reachable');
  });
});

/**
 * The configuration plane, after the restyle.
 *
 * The two cards landed as working markup with their palette written into them as
 * inline style objects, hex by hex, and a note that the lane rebuilding this tab
 * would restyle them. What the plane DOES -- addable, removable, a way back from
 * a removal, a note saying that adding grants nobody anything, a line saying what
 * an empty allowlist means here -- is asserted in declared-connection-view.test.tsx
 * against the fixtures that live there, and those assertions are the ones that
 * prove the restyle took nothing with it. They are deliberately NOT restated here:
 * a second set of fixtures for the same claims is a second thing to keep true, and
 * the pair drift.
 *
 * What is here is what only a restyle can be wrong about, and what no test in that
 * file would notice.
 */
describe('the configuration plane survived being restyled', () => {
  function component(name: string): string {
    const source = readFileSync(fileURLToPath(new URL(name, new URL('.', import.meta.url))), 'utf8');
    // Comments stripped, because both files now discuss the hex and the native
    // select they used to carry, and prose about a defect is not the defect.
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  }

  /**
   * No hex, in either component. This is the assertion the restyle exists for: a
   * colour written into a component is a recipe nobody else can see, and between
   * them these two carried a fourth and fifth status palette on a page that had
   * just converged twenty-one of them onto one.
   */
  it.each(['NotebookCard.tsx', 'DeclaredConnectionsCard.tsx'])('names no colour of its own in %s', (name) => {
    expect(component(name)).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    // And no inline style objects, which is how the hex got in and how it would
    // come back.
    expect(component(name)).not.toMatch(/CSSProperties/);
  });

  it('places the Notebook experimental badge before its feature name', () => {
    const source = component('NotebookCard.tsx');
    const title = source.slice(
      source.indexOf('className="plane-card-title"'),
      source.indexOf('className="plane-card-head-aside"')
    );
    expect(title.indexOf('<ExperimentalBadge />')).toBeLessThan(title.indexOf('Notebook'));
  });

  /**
   * The kind picker was a native `<select>`, which opens the menu the operating
   * system draws: unstyleable where it matters, and visibly not part of the app.
   * Every other dropdown in the app is the same Radix Select, through `./ui`.
   */
  it('opens the app’s own menu rather than the operating system’s', () => {
    expect(component('DeclaredConnectionsCard.tsx')).not.toMatch(/<select\b/);
    expect(component('DeclaredConnectionsCard.tsx')).toMatch(/AppSelect/);
  });

  /**
   * The grey line stayed a line. It says what an empty allowlist means HERE,
   * which is the opposite of what the notebook means by it, and a pill would make
   * a standing warning out of a deployment's ordinary configuration. The restyle
   * had four pill families to hand and this is the row it would have reached for.
   */
  it('leaves the empty-allowlist line as a line rather than promoting it to a pill', () => {
    const source = component('NotebookCard.tsx');
    // The row it is rendered in, not the import that names it.
    const line = source.match(/\{EMPTY_SCOPES_LABEL\}[\s\S]{0,240}/)?.[0] ?? '';
    expect(line).toMatch(/plane-note/);
    expect(line).not.toMatch(/Badge|ast-pill/);
  });
});

describe('long values in a fixed column', () => {
  /**
   * The tail is the identifying part of every value this page prints: a table
   * name, a volume path, a model URI. Truncating the end leaves a column of
   * rows that all read `main.player_insights_de…`.
   */
  it('drops the head, so what distinguishes two values survives', () => {
    const cut = truncateHead('main.<your_schema>.fact_sessions', 20);
    expect(cut).toHaveLength(20);
    expect(cut.startsWith('\u2026')).toBe(true);
    expect(cut.endsWith('fact_sessions')).toBe(true);
    expect(truncateHead('short', 20)).toBe('short');
  });
});

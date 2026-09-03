import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

/**
 * The page's own source, for the one claim that cannot be rendered.
 *
 * The visit mark needs a workspace host, `useWorkspaceHost` reads one in an effect,
 * and `renderToStaticMarkup` runs no effects -- so whether the mark is wired into
 * the name cell, and whether it leads the name, is a fact about the code rather
 * than about any markup this file can produce. What the link looks like is asserted
 * against `VisitLink`, which is split out for exactly that reason.
 */
const PAGE_SOURCE = readFileSync(fileURLToPath(new URL('./ConnectionsPage.tsx', import.meta.url)), 'utf8');
const CONNECTIONS_CSS = readFileSync(fileURLToPath(new URL('./styles/connections.css', import.meta.url)), 'utf8');

import {
  BuildFactRow,
  BuildStampRow,
  ConnectionRow,
  ConnectionsCounts,
  DeclaredTableList,
  DeclaredTablesSection,
  DeclaredTablesTable,
  unityCatalogAssetScopeState,
  unityCatalogScopeSummary,
  canonicalDeclaredTableNames,
  declaredTableNames,
  OptionalScopeLine,
  PreflightRemedyBlock,
  PreflightRemedyRow,
} from './ConnectionsPage';
import { VisitLink } from './DataEntityLinks';
import { BRAND_THEME_MARKS } from './brand-icons';
import { deploymentRows, sourceRows, telemetryRows } from './build-card';
import { GithubMark } from './GithubMark';
import { NO_APP_FACTS, PUBLIC_SOURCE_REPO_URL, type AppFacts } from '../../shared/app-facts';
import { canMutateConnections } from '../../shared/user-roster-contract';
import { buildFacts } from './connection-build';
import { groupByCause, groupByRemedy } from './connection-causes';
import { splitOptionalScopeFindings } from './optional-scope-findings';
import {
  countConnections,
  readConnection,
  readConnections,
  readingsById,
  type SettingsPayload,
  type ConnectionEntry,
} from './connection-model';
import type { StatusTone } from './StatusBadge';
import { ENTITY_PARAM, entityHref } from './data-entities';
import type { PreflightCheck } from './preflight';
import { connectedResource } from '../../shared/deployment-config';
import { pickerForField } from './asset-picker';
import { DeclaredConnectionsCard } from './DeclaredConnectionsCard';
import { UnityCatalogScopeExplorer, unityCatalogExplorerValue } from './UnityCatalogScopeExplorer';

describe('the build stamps stay identifiers rather than duplicate statuses', () => {
  function stamp(over: Partial<Parameters<typeof buildFacts>[0]>) {
    return buildFacts({ appBuildSha: '5b0e675b1c', modelBuildSha: '05d742b299', ...over });
  }

  it('keeps the App stamp and copy button without repeating Running', () => {
    const [app] = stamp({
      appBuildSha: '5b0e675b1c',
      modelBuildSha: '',
      appServing: { app: 'RUNNING', compute: 'ACTIVE', message: '' },
    }).artifacts;
    const markup = render(<BuildStampRow artifact={app} />);

    expect(markup).not.toContain('deployment-health');
    expect(markup).not.toContain('Running');
    expect(text(markup)).toContain('5b0e675b');
    expect(markup).toContain('aria-label="Copy the App source commit"');
    expect(markup).toContain('title="5b0e675b1c"');
  });

  it('keeps the Orchestrator stamp without repeating its endpoint status', () => {
    const [, orchestrator] = stamp({
      appBuildSha: '',
      modelBuildSha: '05d742b299',
      orchestratorStatus: 'blocked',
    }).artifacts;
    const markup = render(<BuildStampRow artifact={orchestrator} />);

    expect(markup).not.toContain('deployment-health');
    expect(markup).not.toContain('Blocked');
    expect(text(markup)).toContain('05d742b2');
    expect(markup).toContain('aria-label="Copy the Agent source commit"');
  });

  it('also keeps an unmeasured stamp free of a status pill', () => {
    const [, orchestrator] = stamp({ appBuildSha: '', modelBuildSha: '05d742b299' }).artifacts;
    const markup = render(<BuildStampRow artifact={orchestrator} />);

    expect(markup).not.toContain('ast-pill');
    expect(markup).not.toContain('data-health');
    expect(text(markup)).toContain('05d742b2');
  });

  it.each([
    ['equal', 'abc123456789', 'abc123456789'],
    ['different', 'abc123456789', 'def987654321'],
    ['unknown', '', ''],
  ])('describes both sources independently for %s SHAs without comparing them', (_case, appBuildSha, modelBuildSha) => {
    const artifacts = stamp({ appBuildSha, modelBuildSha }).artifacts;
    const markup = render(
      <>
        {artifacts.map((artifact) => (
          <BuildStampRow key={artifact.key} artifact={artifact} />
        ))}
      </>
    );
    expect(artifacts.map((artifact) => artifact.label)).toEqual(['App source', 'Agent source']);
    expect(text(markup)).toContain('Commit used to build this app deployment.');
    expect(text(markup)).toContain('Commit used to log the served agent model.');
    expect(text(markup)).not.toMatch(/same release|shared release|mismatch|different release/i);
    expect(PAGE_SOURCE).not.toMatch(/Same release|deployment-release-match|artifacts\[0\]\.full ===/);
  });

  it('puts each source description immediately after its badge and before its copy control', () => {
    const artifacts = stamp({ appBuildSha: 'abc123456789', modelBuildSha: 'def987654321' }).artifacts;
    for (const artifact of artifacts) {
      const markup = render(<BuildStampRow artifact={artifact} />);
      const badge = markup.indexOf(`data-testid="build-${artifact.key}"`);
      const description = markup.indexOf(`<span class="deployment-inline-description">${artifact.description}</span>`);
      const copy = markup.indexOf(`aria-label="Copy the ${artifact.label} commit"`);

      expect(badge).toBeGreaterThan(-1);
      expect(description).toBeGreaterThan(badge);
      expect(copy).toBeGreaterThan(description);
      expect(markup).not.toContain('deployment-source-description');
    }
  });
});

describe('inline build status descriptions', () => {
  const app: AppFacts = {
    ...NO_APP_FACTS,
    answered: true,
    url: 'https://app.example.databricksapps.com',
    serving: { app: 'RUNNING', compute: 'ACTIVE', message: '' },
    otelExporter: 'http://localhost:4314',
  };

  it('places endpoint and exporter descriptions between their badge and copy control', () => {
    const endpoint = deploymentRows(app).find((row) => row.key === 'endpoint');
    const exporter = telemetryRows(app, Date.now()).find((row) => row.key === 'otel');
    expect(endpoint).toBeDefined();
    expect(exporter).toBeDefined();

    for (const [row, description] of [
      [endpoint!, 'Serves this Astrolabe deployment.'],
      [exporter!, 'Exports app traces, metrics, and logs.'],
    ] as const) {
      const markup = render(<BuildFactRow row={row} />);
      const badge = markup.indexOf(`data-testid="build-${row.key}"`);
      const inlineDescription = markup.indexOf(`<span class="deployment-inline-description">${description}</span>`);
      const copy = markup.indexOf(`aria-label="Copy the ${row.label.toLowerCase()}"`);

      expect(badge).toBeGreaterThan(-1);
      expect(inlineDescription).toBeGreaterThan(badge);
      expect(copy).toBeGreaterThan(inlineDescription);
      expect(markup).toContain('data-wrap="true"');
    }
  });

  it('wraps only the inline value group without clipping the description', () => {
    expect(CONNECTIONS_CSS).toMatch(
      /\.identity-fact\[data-wrap='true'\] \.identity-fact-value \{[^}]*flex-wrap:\s*wrap[^}]*overflow:\s*visible/s
    );
    expect(CONNECTIONS_CSS).toMatch(/\.deployment-inline-description \{[^}]*flex:\s*1 1 180px[^}]*min-width:\s*0/s);
  });
});

describe('people on deployment facts', () => {
  it('uses the shared identity chip for the deployer', () => {
    const markup = renderToStaticMarkup(
      <BuildFactRow
        row={{
          kind: 'text',
          key: 'deployed',
          label: 'Last deployed',
          value: 'Aug 19, 11:36 AM',
          identity: 'release.owner@example.test',
        }}
      />
    );

    expect(markup).toContain('identity-chip identity-chip--compact');
    expect(markup).toContain('lucide-user-round');
    expect(markup).toContain('identity-chip-name">release.owner');
    expect(markup).not.toContain('>RO<');
  });
});

/**
 * THE TWO ROWS SAM ASKED TO BE LINKS RATHER THAN CHIPS.
 *
 * Composed rather than asserted on `sourceRows`, because everything that went
 * wrong the first time round is a property of the markup: a chip carrying a URL
 * as text and an anchor that opens it read identically in the row model, and
 * "it has the destination's logo on it" is not a claim a row object can settle.
 */
describe('the deployment source links', () => {
  const rows = sourceRows({
    ...NO_APP_FACTS,
    answered: true,
    source: {
      path: 'player-insights-agent/build/deploy',
      workspaceUrl: 'https://workspace.example.com/apps/astrolabe',
      gitRef: 'main',
    },
  });

  function renderSourceRows(): string {
    return render(
      <>
        {rows.map((row) => (
          <BuildFactRow key={row.key} row={row} />
        ))}
      </>
    );
  }

  it('opens each destination from a real anchor, in a new tab', () => {
    const markup = renderSourceRows();

    expect(markup).toContain('<a class="deployment-fact-link" href="https://workspace.example.com/apps/astrolabe"');
    expect(markup).toContain(`<a class="deployment-fact-link" href="${PUBLIC_SOURCE_REPO_URL}"`);
    // A new tab, and one that cannot reach back into this one.
    expect([...markup.matchAll(/target="_blank"/g)]).toHaveLength(2);
    expect([...markup.matchAll(/rel="noreferrer noopener"/g)]).toHaveLength(2);
    expect(text(markup)).toContain('App source player-insights-agent/build/deploy');
    expect(text(markup)).toContain('GitHub <your-username>/astrolabe_public · main');
  });

  /**
   * THE LOGOS, AND THAT THEY ARE THE APP'S OWN. The workspace row wears the
   * official Databricks Apps mark from the brand directory -- not a Lucide
   * approximation of one -- and the repository row wears the very octocat the
   * login gate draws, which is why both are asserted against the same modules
   * those two surfaces use rather than against a shape recognised by eye.
   */
  it('wears the Databricks Apps mark and the login screen’s GitHub mark', () => {
    const markup = renderSourceRows();

    expect(markup).toContain(BRAND_THEME_MARKS.light.apps);
    expect(markup).toContain(renderToStaticMarkup(<GithubMark className="deployment-fact-mark" />));
    // The generic glyphs are the app's link affordance, not a stand-in product
    // mark: one external-link icon per row and no more.
    expect([...markup.matchAll(/lucide-external-link/g)]).toHaveLength(2);
  });
});

/**
 * The Connections tab as it is composed, rather than as its source reads.
 *
 * This file exists because of a specific, repeated failure in this repository: a
 * screen that was wrong while every assertion anybody thought to write about its
 * source was true. The worst of them was a source row missing its separator, where
 * "the file imports the linking component", "the file does not build its own
 * anchor" and "the row names the source and its freshness" all held and the
 * identifier still ran into the middle of the next sentence on screen. The counts
 * defect this page just had was the same shape one level up: the old test required
 * the header to summarise the merged check list rather than the report's own tally,
 * which it faithfully did -- while printing "24 reachable · 0 blocked · 0 not
 * checked" above nineteen rows, four of which said "Not checked" and four "Nothing
 * to reach". Nothing short of composing the markup and reading the text back can
 * fail on that.
 *
 * So the claims here are made against rendered output, and specifically against
 * the TEXT of it, which is also what a screen reader is handed.
 *
 * `renderToStaticMarkup` runs no effects. That is why the page's own blocks are
 * exported and rendered directly rather than reached through `ConnectionsPage`:
 * from the page, every one of them is behind a fetch that a static render never
 * issues, so a page-level render can only ever compose the empty state.
 */

/** The text a reader sees, tags removed and entities put back. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, '\u2019')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rendered inside a router, because a row may link a resource out to Databricks. */
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
    changedByLabel: '',
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

/**
 * The counts, as the page derives them: one walk of the readings the rows are
 * drawn from. Taken through `readConnections` rather than assembled by hand,
 * because a hand-built `ConnectionCounts` would let this file agree with a page
 * that had gone back to counting checks.
 */
function countsFor(resources: SettingsPayload['resources'], checks: PreflightCheck[]) {
  return countConnections(readConnections(payload({ resources, checks }), []));
}

describe('the counts line under the status headline', () => {
  /**
   * THE DEFECT, stated as arithmetic a reader can do.
   *
   * The parts have to sum to the number of rows drawn, because the line prints the
   * parts of a whole the reader can see and count. When reachable/blocked/not-checked
   * came off the check list and drifted/pending off the rows, they summed to
   * twenty-four over nineteen rows.
   */
  it('adds up to the number of connection rows on the page', () => {
    const resources = [
      row('sql-warehouse', { configured: 'wh-0001' }),
      row('catalog', { configured: 'a_catalog' }),
      row('genie-data', { configured: 'space-data' }),
      row('llm-gateway'),
      row('assets-volume'),
    ];
    const counts = countsFor(resources, [check('sql-warehouse', 'ok'), check('catalog', 'failed')]);
    expect(counts.reachable + counts.blocked + counts.notChecked + counts.nothingToReach).toBe(4);

    const rendered = text(render(<ConnectionsCounts counts={counts} />));
    expect(rendered).toContain('1 reachable');
    expect(rendered).toContain('1 blocked');
  });

  it('does not publish a separate not-checked count', () => {
    const counts = countsFor([row('genie-data', { configured: 'space-data' }), row('assets-volume')], []);
    const rendered = text(render(<ConnectionsCounts counts={counts} />));
    expect(rendered).not.toContain('not checked');
    expect(rendered).not.toContain('configuration only');
  });

  /**
   * A phrase that would be a lie by omission on a healthy deployment: printing
   * "0 nothing to reach" invites a reader to wonder what it means, and there is
   * nothing for it to mean.
   */
  it('says nothing about unreachable-by-design rows when there are none', () => {
    const counts = countsFor([row('catalog', { configured: 'a_catalog' })], [check('catalog', 'ok')]);
    expect(text(render(<ConnectionsCounts counts={counts} />))).not.toContain('configuration only');
  });

  /**
   * Colour is the second reading of each count, never the only one, and it is spent
   * only where it describes something. A red "0 blocked" is a page teaching its
   * reader to stop seeing red.
   */
  it('tints only the counts that describe something, and never a count of nothing', () => {
    const healthy = render(
      <ConnectionsCounts counts={countsFor([row('catalog', { configured: 'c' })], [check('catalog', 'ok')])} />
    );
    expect(healthy).toMatch(/data-tone="reachable"/);
    expect(healthy).not.toMatch(/data-tone="blocked"/);

    const broken = render(
      <ConnectionsCounts counts={countsFor([row('catalog', { configured: 'c' })], [check('catalog', 'failed')])} />
    );
    expect(broken).toMatch(/data-tone="blocked"/);
    expect(broken).not.toMatch(/data-tone="reachable"/);
  });

  /**
   * A ZERO NEVER RENDERS, WHICHEVER COUNT IT IS. The line printed all six
   * whatever they were, so a deployment with nothing wrong announced "0 blocked ·
   * 0 not checked · 0 drifted · 0 pending" under a headline that had just said
   * every connection answered. Four of the six phrases named states the
   * deployment was not in, and a reader had to read all four to find that out.
   */
  it('stays silent about every state the deployment is not in', () => {
    const healthy = text(
      render(<ConnectionsCounts counts={countsFor([row('catalog', { configured: 'c' })], [check('catalog', 'ok')])} />)
    );
    expect(healthy).toBe('1 reachable');
    expect(healthy).not.toContain('0');
    expect(healthy).not.toContain('blocked');
    expect(healthy).not.toContain('not checked');
    expect(healthy).not.toContain('drifted');
    expect(healthy).not.toContain('pending');
  });

  /**
   * And the separator goes with the count it belonged to. A line assembled by
   * prefixing " · " to each phrase opens with one the moment the first phrase is
   * suppressed, which is how a zero leaves a mark after it stops being printed.
   */
  it('leaves no separator behind when a count in the middle is suppressed', () => {
    const line = text(
      render(
        <ConnectionsCounts
          counts={countsFor(
            [row('catalog', { configured: 'c' }), row('schema', { configured: 's' }), row('assets-volume')],
            [check('catalog', 'ok'), check('schema', 'failed')]
          )}
        />
      )
    );
    expect(line).toBe('1 reachable · 1 blocked');
    expect(line).not.toMatch(/^ ?\u00b7/);
    expect(line).not.toMatch(/\u00b7 ?\u00b7/);
  });
});

describe('the What to fix panel', () => {
  /**
   * The panel is the only thing on the page a reader can act on, so the statement
   * has to survive rendering intact -- as text, in one piece, with its identifiers
   * unescaped into something that would fail if pasted.
   */
  it('carries the exact GRANT statement a reader is meant to paste', () => {
    const statement = 'GRANT SELECT ON TABLE a_catalog.a_schema.gold_player_geo_summary TO `app-svc-principal-7f3a`;';
    const rendered = render(
      <PreflightRemedyRow
        check={check('table-geo', 'failed', {
          kind: 'table',
          label: 'SELECT on gold_player_geo_summary',
          detail: 'The workspace refused this identity: HTTP 403 PERMISSION_DENIED.',
          remedy: { kind: 'sql', statement, guidance: '' },
        })}
      />
    );
    expect(text(rendered)).toContain(statement);
    // In a code block, because a statement set as prose is a statement somebody
    // retypes rather than copies, and retyping a backtick-quoted principal is
    // where this goes wrong.
    expect(rendered).toMatch(/<pre[^>]*class="[^"]*connections-code/);
  });

  /**
   * WHO can run it, which was missing from the page entirely once the panel's lead
   * paragraph turned out to be wrong about it. A reader holding a statement they
   * lack the authority to execute has been handed a task, not a fix -- and the two
   * authorities genuinely differ, so one sentence for both would be wrong for one.
   */
  it('says who is able to run a Unity Catalog grant, and who a workspace permission', () => {
    const sql = text(
      render(
        <PreflightRemedyRow
          check={check('t', 'failed', {
            remedy: { kind: 'sql', statement: 'GRANT SELECT ON TABLE a.b.c TO `p`;', guidance: '' },
          })}
        />
      )
    );
    expect(sql).toMatch(/metastore admin or the object\u2019s owner/);

    const cli = text(
      render(
        <PreflightRemedyRow
          check={check('w', 'failed', {
            remedy: { kind: 'cli', statement: 'databricks permissions update ...', guidance: '' },
          })}
        />
      )
    );
    expect(cli).toMatch(/workspace admin/);
    expect(cli).toMatch(/manage this object/);
  });

  /**
   * THE PANEL THAT COST AN AFTERNOON, IN THE SHAPE IT IS ALLOWED TO TAKE NOW.
   *
   * A blocked Unity Catalog row used to print roughly forty lines of shell at a
   * reader who owns no workspace authority at all, led by a sentence asserting a
   * cause nothing had established. What a reader has to do is one line, and that
   * line plus at most one more is all the panel offers.
   *
   * THE SECOND LINE IS BACK, NARROWED, and this test is where the shape of it is
   * pinned. Cutting the "Why this is the fix" paragraph left the server still
   * generating it into a field no surface drew, so a blocked row carried an
   * instruction and no reasoning at all -- including in the cases where following
   * the instruction alone costs a reader an afternoon. What comes back is one
   * short line, inline, and the two things it must not become are a heading and a
   * fold.
   *
   * Composed rather than asserted on the source, because "the line is inline",
   * "the line is folded away" and "the line is gone" are three different screens
   * and the source reads much the same for all of them.
   */
  it('draws the guidance as one inline line, with no fold and no heading', () => {
    const rendered = render(
      <PreflightRemedyRow
        check={check('catalog', 'unverified', {
          label: 'Unity Catalog catalog',
          detail: 'HTTP 403. Your sign-in to this app does not carry `catalog.catalogs:read`.',
          remedy: {
            kind: 'ui',
            statement: 'Open this app again in a private browsing window, and sign in there.',
            guidance: 'Signing out of Databricks does not clear this app\u2019s sign-in.',
          },
        })}
      />
    );

    // Not code. Nobody pastes a private window into a terminal, and a `<pre>`
    // is what turned a one-line action into a wall of shell.
    expect(rendered).not.toMatch(/<pre/);
    expect(text(rendered)).toMatch(/private browsing window/);
    // And not addressed to an admin. This is the one remedy on the page that
    // needs no workspace authority, so the default "run as a workspace admin"
    // line would send the reader to somebody with nothing to do.
    expect(text(rendered)).not.toMatch(/workspace admin/);
    // On the page, where a reader meets it without asking. This is the sentence
    // whose absence sends somebody to sign out of Databricks first, which cannot
    // clear a session this app does not hold.
    expect(text(rendered)).toMatch(/Signing out of Databricks does not clear/);
    // NOT behind a disclosure, and under no heading of its own. A reader who has
    // to open something to discover the step they just took was insufficient does
    // not open it, and one sentence under a heading is two lines carrying one.
    expect(rendered).not.toMatch(/<details/);
    expect(rendered).not.toMatch(/<summary/);
    expect(text(rendered)).not.toMatch(/Why this is the fix/i);
  });

  /** Almost every remedy has none, and must draw nothing rather than an empty line. */
  it('draws nothing where the statement stands on its own', () => {
    const rendered = render(
      <PreflightRemedyRow
        check={check('catalog', 'failed', {
          detail: 'The workspace refused this identity: HTTP 403 PERMISSION_DENIED.',
          remedy: { kind: 'sql', statement: 'GRANT USE CATALOG ON CATALOG a TO `p`;', guidance: '' },
        })}
      />
    );
    expect(rendered).not.toMatch(/connections-fix-problem-guidance/);
  });

  /**
   * The 404 case, which must NOT offer a grant. A statement that cannot fix the
   * problem is worse than none: it sends an admin to grant a permission on an
   * object that does not exist, and when that fails they distrust the page.
   */
  it('offers no statement for a dependency that is missing rather than forbidden', () => {
    const rendered = render(
      <PreflightRemedyRow
        check={check('genie-data', 'failed', {
          detail: 'The workspace has no such object: HTTP 404. This is missing rather than forbidden.',
          remedy: null,
        })}
      />
    );
    expect(rendered).not.toMatch(/<pre/);
    expect(text(rendered)).toMatch(/No statement can fix this one/);
    expect(text(rendered)).toMatch(/missing rather than forbidden/);
  });

  /**
   * The three verdicts have to be distinguishable in the composed text, not merely
   * in the status enum, because "we asked and were refused", "we asked and it is not
   * there" and "we never got an answer" imply three different next actions and the
   * badge alone collapses the first two together.
   */
  it('tells a refusal, an absence and an unanswered probe apart in what it says', () => {
    const refused = text(
      render(
        <PreflightRemedyRow
          check={check('schema', 'failed', {
            detail: 'The workspace refused this identity as someone@example.com: HTTP 403 PERMISSION_DENIED.',
            remedy: { kind: 'sql', statement: 'GRANT USE SCHEMA ON SCHEMA a.b TO `p`;', guidance: '' },
          })}
        />
      )
    );
    const missing = text(
      render(
        <PreflightRemedyRow
          check={check('schema', 'failed', {
            detail: 'The workspace has no such object: HTTP 404. This is missing rather than forbidden.',
          })}
        />
      )
    );
    const silent = text(
      render(
        <PreflightRemedyRow
          check={check('sql-warehouse', 'unverified', {
            detail: 'The workspace did not answer within 15000 ms, so whether this identity can reach it is unknown.',
          })}
        />
      )
    );

    expect(refused).toContain('403');
    expect(refused).toContain('someone@example.com');
    expect(missing).toContain('404');
    expect(missing).not.toContain('403');
    // The unanswered one is the honesty case: it must read as unknown, and must not
    // borrow either the language of a refusal or the confidence of a pass.
    expect(silent).toMatch(/unknown/);
    expect(silent).not.toContain('403');
    expect(silent).not.toContain('404');
    expect(silent).not.toMatch(/refused/);
  });
});

/**
 * THE PANEL THE USER WAS LOOKING AT WHEN HE SAID THE TAB LOOKED BAD.
 *
 * One missing OAuth scope stops twelve Unity Catalog table checks at the same
 * instant, and the panel drew one block per check. So the screen carried, twelve
 * times over and word for word: a three-sentence diagnosis naming the
 * permission, a two-line instruction about private browsing windows, and a "Why
 * this is the fix" fold. Roughly forty lines of identical text, and the one fact
 * a reader needed from it -- one permission is holding up twelve objects -- was
 * never stated anywhere on the page.
 *
 * Composed rather than asserted on the source, for the reason this whole file
 * exists: "the page groups the checks" is a claim about a function, and "the
 * reader is shown the explanation once" is a claim about a screen. Only the
 * second one is what went wrong.
 */
describe('one panel for the failures, not one panel per failure', () => {
  const FRESH_SIGN_IN = {
    kind: 'ui' as const,
    statement: 'Open this app again in a private browsing window, and sign in there.',
    guidance: 'Signing out of Databricks does not clear this app\u2019s sign-in.',
  };
  const DIAGNOSIS = 'HTTP 403. Your sign-in to this app does not carry `catalog.tables:read`, which the app asks for.';

  /** The twelve tables of the live deployment, all stopped by one missing scope. */
  const TABLES = Array.from({ length: 12 }, (_unused, index) =>
    check(`table:t${index}`, 'unverified', {
      kind: 'table',
      name: `a_catalog.a_schema.gold_table_${index}`,
      label: `a_catalog.a_schema.gold_table_${index}`,
      detail: DIAGNOSIS,
      error: 'HTTP 403',
      remedy: FRESH_SIGN_IN,
    })
  );

  /** How many times a phrase appears in what a reader is shown. */
  function occurrences(markup: string, phrase: string): number {
    return text(markup).split(phrase).length - 1;
  }

  function renderGroups(checks: PreflightCheck[]): string {
    return render(
      <>
        {groupByRemedy(groupByCause(checks)).map((block) => (
          <PreflightRemedyBlock key={block.key} block={block} />
        ))}
      </>
    );
  }

  /**
   * THE DEFECT, counted. Twelve checks, one explanation, one instruction. The
   * numbers are asserted as exactly one rather than "fewer than twelve": a panel
   * that printed it twice would be the same fault, smaller.
   */
  it('explains twelve checks stopped by one permission exactly once', () => {
    const rendered = renderGroups(TABLES);
    expect(occurrences(rendered, 'does not carry')).toBe(1);
    expect(occurrences(rendered, 'private browsing window')).toBe(1);
    // And the guidance line ONCE, on the group, for the same reason as the other
    // two. It is one line rather than the paragraph that used to be here, but
    // twelve copies of one line is the same defect at a twelfth of the size.
    expect(occurrences(rendered, 'Signing out of Databricks does not clear')).toBe(1);
    // The paragraph itself is on no copy of it, folded or otherwise.
    expect(occurrences(rendered, 'keeps its own sign-in')).toBe(0);
  });

  /**
   * And the fact the old panel never stated at all. A reader has to be able to
   * see "one permission, twelve objects" without scrolling and without counting
   * blocks, so the count is in the group's own heading.
   */
  it('says how many objects the one cause is holding up', () => {
    expect(text(renderGroups(TABLES))).toMatch(/12 checks, stopped for the same reason/);
  });

  /**
   * The affected objects, all of them, listed compactly beneath the one
   * explanation. Grouping must not cost a reader the ability to see WHICH tables
   * are affected: that would trade one unreadable screen for a vaguer one.
   */
  it('lists every affected object, with the catalog and schema said once', () => {
    const rendered = renderGroups(TABLES);
    const readable = text(rendered);
    for (let index = 0; index < 12; index += 1) {
      expect(readable).toContain(`gold_table_${index}`);
    }
    // The prefix twelve tables share is stated once, above the list, instead of
    // being repeated down it. `title` keeps the whole name on every entry.
    expect(occurrences(rendered, 'a_catalog.a_schema')).toBe(1);
    expect(rendered).toMatch(/title="a_catalog\.a_schema\.gold_table_0"/);
  });

  /**
   * A group of one is drawn exactly as a single blocked check always was, and it
   * gains no affected list: a list of one is a heading repeated.
   */
  it('draws a lone blocked check as itself, with no list and no count', () => {
    const rendered = renderGroups([
      check('sql-warehouse', 'failed', { label: 'SQL warehouse', detail: 'The workspace refused this identity.' }),
    ]);
    expect(text(rendered)).toContain('SQL warehouse');
    expect(text(rendered)).not.toMatch(/for the same reason/);
    expect(rendered).not.toMatch(/connections-fix-affected/);
  });

  /**
   * THE ELEVEN-LINE SHELL SNIPPET, ONCE. A scope the app never declared is fixed
   * by a bundle edit and a restart, and that block was printed per affected row
   * as well. A code panel is the most expensive thing on the page to scroll past
   * and it says the same thing however many rows share it.
   */
  it('prints a shell remedy once for the group that shares it', () => {
    const declaresNothing = {
      kind: 'cli' as const,
      statement: 'databricks apps stop <app-name>\ndatabricks apps start <app-name>',
      guidance: 'Anyone already signed in needs a new sign-in afterwards.',
      run_by: 'Run by whoever deploys this app',
    };
    const rendered = renderGroups([
      check('semantic-index', 'unverified', {
        label: 'Vector Search index',
        detail: 'HTTP 403. This app does not ask for `vectorsearch.vector-search-indexes:read`.',
        remedy: declaresNothing,
      }),
      check('semantic-endpoint', 'unverified', {
        label: 'Vector Search endpoint',
        detail: 'HTTP 403. This app does not ask for `vectorsearch.vector-search-indexes:read`.',
        remedy: declaresNothing,
      }),
    ]);
    expect([...rendered.matchAll(/<pre/g)]).toHaveLength(1);
    expect(occurrences(rendered, 'databricks apps stop')).toBe(1);
    expect(occurrences(rendered, 'whoever deploys this app')).toBe(1);
    expect(occurrences(rendered, 'needs a new sign-in afterwards')).toBe(1);
  });

  /**
   * D6 AND D8, ON THE COMPOSED SCREEN. A check the workspace refused and a check
   * that never reached the object are different claims with different next
   * actions, and a group states one status for all of its members. So these two
   * must be two blocks even when every word of their prose agrees, and the
   * unchecked one must not end up under the word "Blocked".
   */
  it('never puts a refused check and an unreached one under one verdict', () => {
    const rendered = renderGroups([
      check('a', 'failed', { label: 'A', detail: 'The same words.' }),
      check('b', 'unverified', { label: 'B', detail: 'The same words.' }),
    ]);
    const readable = text(rendered);
    expect(readable).toContain('Blocked');
    expect(readable).toContain('Not checked');
    expect([...rendered.matchAll(/connections-fix-problem-head/g)]).toHaveLength(2);
  });

  /**
   * D10, AND THE PANEL SAM WAS LOOKING AT SECOND TIME ROUND. Two checks refused
   * over different permissions must each keep their own sentence: a surviving
   * single sentence would name a permission one of them was never refused over,
   * which is a diagnosis asserting a cause its own evidence does not support.
   *
   * But one restart clears both, and the panel printed the instruction for it
   * once per permission -- four times on the live deployment. So the two causes
   * stay two rows, and the remedy they share is stated ONCE. Both halves are
   * asserted here because either alone is a way of getting this wrong.
   */
  it('keeps two permissions as two rows under one shared instruction', () => {
    const rendered = renderGroups([
      check('catalog', 'unverified', {
        label: 'Unity Catalog catalog',
        detail: 'Your sign-in does not carry `catalog.catalogs:read`.',
        remedy: FRESH_SIGN_IN,
      }),
      ...TABLES,
    ]);
    const readable = text(rendered);
    expect(readable).toContain('catalog.catalogs:read');
    expect(readable).toContain('catalog.tables:read');
    // Two causes, so two rows with two chips and two sentences.
    expect([...rendered.matchAll(/connections-fix-problem-head/g)]).toHaveLength(2);
    // One remedy, so ONE instruction and one guidance line. Exactly one rather
    // than "fewer than two": twice is the defect at half the size.
    expect(occurrences(rendered, 'private browsing window')).toBe(1);
    expect(occurrences(rendered, 'Signing out of Databricks does not clear')).toBe(1);
    // And one block, not two. The border between blocks is what read as two
    // separate faults when there is one thing to do about them.
    expect([...rendered.matchAll(/connections-fix-problem"/g)]).toHaveLength(1);
  });

  /**
   * THE OTHER HALF OF ONE PANEL: two causes with genuinely different reasons and
   * no remedy at all. They share a block, because the sentence about redeploying
   * is the same for both and printing it twice is the fault this rebuild is
   * about; they keep their own sentences, because "the manifest is unconfirmed"
   * and "the index did not answer" are different facts.
   */
  it('states the no-statement remedy once over the causes that share it', () => {
    const rendered = renderGroups([
      check('manifest', 'unverified', {
        label: 'Declared tables',
        detail: '0 of 12 declared tables answered.',
        remedy: null,
      }),
      check('vs-endpoint', 'unverified', {
        label: 'Vector Search endpoint',
        detail: 'Only the index names the endpoint serving it.',
        remedy: null,
      }),
    ]);
    const readable = text(rendered);
    expect(readable).toContain('declared tables answered');
    expect(readable).toContain('names the endpoint serving it');
    expect(occurrences(rendered, 'No statement can fix')).toBe(1);
    expect(occurrences(rendered, 'redeployed with it declared')).toBe(1);
  });
});

/**
 * THE PANEL SAM WAS LOOKING AT WHEN HE SAID THE UC ERRORS WERE STILL STACKED.
 *
 * Four blocks under a red heading reading "What to fix": the catalog, the schema,
 * twelve tables collected into one with their twelve names listed under it, and
 * the Vector Search index. Each carried the same paragraph again with a different
 * permission in it. All of them are now the browse reads
 * `shared/optional-user-api-scopes.ts` records as OPTIONAL -- the catalog trio,
 * workspace, and (Sam's 2026-08-18 call) Vector Search -- so the section was
 * asking a reader to repair permissions no ask needs. The findings somebody does
 * have to act on are the ask-path ones (Genie, SQL, serving), and those are what
 * the panel is left holding.
 *
 * Composed rather than asserted on the source, for the reason this whole file
 * exists: "the page filters the optional shortfalls" is a claim about a function,
 * and "the reader is not being told to fix them" is a claim about a screen.
 */
describe('optional permissions are not a thing to fix', () => {
  const FRESH_SIGN_IN = {
    kind: 'ui' as const,
    statement: 'Open this app again in a private browsing window, and sign in there.',
    guidance: 'Chrome and Edge call it Incognito or InPrivate.',
  };

  /** The sentence the server writes for a refusal over a declared permission. */
  function diagnosis(scope: string): string {
    return (
      `HTTP 403. Your sign-in to this app does not carry \`${scope}\`, which the app asks for. ` +
      'The call stopped there, so nothing was established about whether you can reach the object. ' +
      'This is not a grant you are missing.'
    );
  }

  function refused(id: string, label: string, scope: string, over: Partial<PreflightCheck> = {}) {
    return check(id, 'unverified', {
      label,
      stopped: 'refused',
      scope,
      detail: diagnosis(scope),
      error: 'HTTP 403',
      remedy: FRESH_SIGN_IN,
      ...over,
    });
  }

  /**
   * The live screen's optional shortfalls: two catalog scopes, twelve tables,
   * and the Vector Search index. All fifteen are optional as of Sam's 2026-08-18
   * call -- Vector Search browse joined catalog/workspace in the optional set, so
   * an app-side VS refusal is now a neutral shortfall, not a finding.
   */
  const LIVE = [
    refused('catalog', 'Catalog \u00b7 a_catalog', 'catalog.catalogs:read'),
    refused('schema', 'Schema \u00b7 a_catalog.a_schema', 'catalog.schemas:read'),
    ...Array.from({ length: 12 }, (_unused, index) =>
      refused(`table:t${index}`, `a_catalog.a_schema.gold_table_${index}`, 'catalog.tables:read', {
        kind: 'table',
      })
    ),
    refused(
      'semantic-index',
      'Vector Search index \u00b7 a_catalog.a_schema.semantic_layer_index',
      'vectorsearch.vector-search-indexes:read'
    ),
  ];

  /**
   * A refusal over a scope asks genuinely need. `dashboards.genie` is not in the
   * optional set, so this stays a finding under "What to fix" -- it is the row
   * the panel exists to surface once the optional shortfalls are drawn neutrally.
   */
  const REQUIRED = refused('genie', 'Genie space \u00b7 a_space', 'dashboards.genie');

  function occurrences(markup: string, phrase: string): number {
    return text(markup).split(phrase).length - 1;
  }

  /**
   * The whole region, composed the way the page composes it: the split decides
   * what the panel holds, the panel draws the findings, and the neutral line
   * draws the rest. Anything the page does differently is a defect this cannot
   * see, which is why the split is imported rather than reimplemented here.
   */
  function renderRegion(checks: PreflightCheck[]): string {
    const findings = splitOptionalScopeFindings(checks);
    return render(
      <>
        {findings.required.length > 0 ? (
          <section>
            <h3>What to fix</h3>
            {groupByRemedy(groupByCause(findings.required)).map((block) => (
              <PreflightRemedyBlock key={block.key} block={block} />
            ))}
          </section>
        ) : null}
        <OptionalScopeLine shortfall={findings.optional} />
      </>
    );
  }

  /**
   * (a) THE FIRST THING THAT WILL REGRESS. An optional shortfall must not appear
   * as an error under "What to fix", and the assertion is on the panel's own
   * markup rather than on the count of blocks: a version that kept the block and
   * merely restyled it would still be asking a reader to fix a permission no ask
   * needs.
   */
  it('draws no fix block for a shortfall in an optional permission', () => {
    const rendered = renderRegion([...LIVE, REQUIRED]);
    // One cause in the panel, and it is the required one (Genie).
    expect([...rendered.matchAll(/connections-fix-problem-head/g)]).toHaveLength(1);
    expect(text(rendered)).toContain('Genie space');
    // The optional names, catalog AND Vector Search, are on the screen and not
    // inside the panel.
    const panel = rendered.slice(0, rendered.indexOf('connections-optional-scopes'));
    for (const scope of [
      'catalog.catalogs:read',
      'catalog.schemas:read',
      'catalog.tables:read',
      'vectorsearch.vector-search-indexes:read',
    ]) {
      expect(text(rendered)).toContain(scope);
      expect(panel).not.toContain(scope);
    }
    // And the twelve table names are not dumped under the heading any more. Each
    // has a row of its own in the Unity Catalog tables section below.
    expect(rendered).not.toMatch(/connections-fix-affected/);
    expect(text(rendered)).not.toContain('gold_table_0');
  });

  /**
   * A deployment where the ONLY shortfall is optional gets no red section at all.
   * This is the customer default, and it is the case the old page was worst on:
   * three red blocks and nothing wrong.
   */
  it('draws no What to fix section when every shortfall is optional', () => {
    const rendered = renderRegion(LIVE);
    expect(text(rendered)).not.toContain('What to fix');
    expect(rendered).not.toMatch(/connections-fix-problem/);
    expect(rendered).toMatch(/connections-optional-scopes/);
    // Never the red pill the required rows use, on the surface or in the class.
    expect(rendered).not.toMatch(/ast-pill--neg/);
    expect(text(rendered)).not.toContain('Missing');
  });

  /**
   * (b) THE SECOND THING THAT WILL REGRESS. The private-window instruction is one
   * move that clears every one of these, and the panel printed it once per
   * affected object and then once per permission. Exactly one rather than "fewer
   * than four": twice is the same defect at half the size.
   */
  it('states the remedy once for the section, not once per finding', () => {
    const shared = renderRegion([
      ...LIVE,
      refused('genie', 'Genie space', 'dashboards.genie'),
      refused('orchestrator', 'Orchestrator endpoint', 'serving.serving-endpoints'),
    ]);
    // Two required findings now, refused over two different permissions, so two
    // rows: neither may be given the other's permission (D10). Vector Search is
    // optional now, so the two findings are the genuinely-required ones.
    expect([...shared.matchAll(/connections-fix-problem-head/g)]).toHaveLength(2);
    expect(text(shared)).toContain('dashboards.genie');
    expect(text(shared)).toContain('serving.serving-endpoints');
    // One instruction, one browser note, one shared explanation.
    expect(occurrences(shared, 'private browsing window')).toBe(1);
    expect(occurrences(shared, 'Chrome and Edge call it Incognito')).toBe(1);
    expect(occurrences(shared, 'This is not a grant you are missing')).toBe(1);
    expect(occurrences(shared, 'The call stopped there')).toBe(1);
  });

  /**
   * The finding as a reader meets it: one line carrying the object, the verdict
   * and the permission. It was the object and the verdict on one line and the
   * permission in a paragraph under it, which is how four findings became eight
   * lines before the panel said anything anybody could act on.
   */
  it('puts the object, the verdict and the permission on one line', () => {
    const rendered = renderRegion([...LIVE, REQUIRED]);
    const head = /<div class="connections-fix-problem-head">(.*?)<\/div>/s.exec(rendered)?.[1] ?? '';
    expect(head).not.toBe('');
    expect(text(head)).toContain('Genie space');
    expect(text(head)).toContain('Refused');
    expect(text(head)).toContain('dashboards.genie');
  });

  /**
   * The neutral line says what is unavailable without them and asserts nothing
   * about why. A reader must not read it as "you cannot see those tables": the
   * calls stopped before they reached one.
   */
  it('reports the optional shortfall neutrally, with no cause and no fix', () => {
    const readable = text(renderRegion(LIVE));
    expect(readable).toContain('Optional permissions');
    // Fifteen now: the twelve tables, catalog, schema, and the Vector Search
    // index, all optional as of Sam's call.
    expect(readable).toContain('15 checks stopped before reaching the object');
    expect(readable).toContain('before reaching the object');
    expect(readable).not.toContain('Questions do not need them');
    expect(readable).not.toMatch(/you have not|because/i);
  });

  /**
   * THE ROW THAT WOULD HAVE BEEN LEFT POINTING AT NOTHING. The catalog and the
   * schema have connection rows of their own, and an opened row says the
   * statement that fixes it is under "What to fix" above. That sentence was true
   * while every refusal was drawn there. Now that an optional shortfall is not,
   * the row must stop sending a reader up the page to look for it, while still
   * reporting what the workspace said about the object.
   */
  it('does not send an optional shortfall’s row to a section that no longer holds it', () => {
    const optional = check('catalog', 'unverified', {
      stopped: 'refused',
      scope: 'catalog.catalogs:read',
      error: 'HTTP 403',
      detail: diagnosis('catalog.catalogs:read'),
      remedy: FRESH_SIGN_IN,
    });
    const rendered = text(
      render(
        <ConnectionRow
          reading={readConnection({ row: row('catalog', { configured: 'a_catalog' }), check: optional, findings: [] })}
          tone="drifted"
          saving={false}
          refreshing={false}
          requested
          onSave={() => Promise.resolve(true)}
          onClear={() => Promise.resolve()}
        />
      )
    );
    expect(rendered).toContain('HTTP 403');
    expect(rendered).not.toContain('What to fix');
  });

  /** Nothing at all where nothing is short, rather than an empty grey line. */
  it('says nothing when every optional permission answered', () => {
    // Only a required finding on the page and no optional shortfall, so the
    // neutral line has nothing to draw.
    const rendered = renderRegion([REQUIRED]);
    expect(rendered).not.toMatch(/connections-optional-scopes/);
    expect(text(rendered)).not.toContain('Optional permissions');
  });
});

describe('a connection row', () => {
  // The row only awaits these; nothing here is testing the save path, and the
  // resolved `true` is what the row reads to decide whether to close its editor.
  const noop = () => Promise.resolve(true);
  const noopClear = () => Promise.resolve();

  /**
   * `requested` is what a link from the Architecture diagram sets, and it is also
   * the only way to get an opened row out of a static render: the row keeps its own
   * open state and `renderToStaticMarkup` runs no click. So the expanded assertions
   * below render the arrival case, which is a state real readers land in.
   */
  function renderRow(
    id: string,
    over: Record<string, unknown> = {},
    {
      open = false,
      check,
      tone = 'plain',
      allowMutations = true,
      declaredTables,
    }: {
      open?: boolean;
      check?: PreflightCheck;
      tone?: StatusTone;
      allowMutations?: boolean;
      declaredTables?: readonly string[];
    } = {}
  ) {
    return render(
      <ConnectionRow
        // Through the shared derivation, which is where the row now gets its
        // verdict from: composing a reading by hand here would let this file
        // assert a state `readConnection` cannot produce.
        reading={readConnection({ row: row(id, over), check, findings: [] })}
        tone={tone}
        saving={false}
        refreshing={false}
        declaredTables={declaredTables}
        requested={open}
        allowMutations={allowMutations}
        onSave={noop}
        onClear={noopClear}
      />
    );
  }

  it('renders the declared manifest as a count and segmented table rows', () => {
    const configured = [
      '<your_catalog>.<your_schema>.data_dictionary',
      '<your_catalog>.<your_schema>.gold_player_180d_summary',
      '<your_catalog>.<your_schema>.gold_title_daily_summary',
      '<your_catalog>.<your_schema>.silver_gameplay_activity',
      '<your_catalog>.<your_schema>.silver_player_profiles',
      '<your_catalog>.<your_schema>.silver_purchases',
    ].join(', ');
    const additional = Array.from(
      { length: 6 },
      (_, index) => `<your_catalog>.<your_schema>.app_table_${index + 1}`
    );
    const rendered = renderRow(
      'declared-manifest',
      {
        configured,
        intended: 'next model manifest',
        intendedBy: 'analyst@example.invalid',
        intendedAt: '2026-08-28T18:00:00Z',
        changedByLabel: 'Model version',
      },
      {
        open: true,
        declaredTables: canonicalDeclaredTableNames(
          configured,
          additional.map((name) => check(name, 'ok', { kind: 'table', name }))
        ),
      }
    );
    expect(text(rendered)).toContain('12 tables');
    expect(text(rendered)).not.toContain('Pending model release');
    expect(rendered.match(/data-entity-part="catalog"/g)).toHaveLength(12);
    expect(rendered.match(/data-entity-part="schema"/g)).toHaveLength(12);
    expect(rendered.match(/data-entity-part="table"/g)).toHaveLength(12);
    expect(rendered).not.toContain(`<p class="connection-tile-value">${configured}</p>`);
    for (const forbidden of [
      'In use',
      'Not measured',
      'Recorded, not applied',
      'Try asking',
      'agent-release.sh',
      'bundle variable',
      'Generated by agent/preflight',
    ]) {
      expect(text(rendered), forbidden).not.toContain(forbidden);
    }
    expect(PAGE_SOURCE).toMatch(/<VisitInDatabricks name=\{name\}/);
  });

  it('shows the complete canonical declared-table set', () => {
    const names = Array.from({ length: 8 }, (_, index) => `catalog.schema.table_${index + 1}`);
    const rendered = render(<DeclaredTableList configured={names.join(',')} />);
    expect(text(rendered)).not.toContain('Show all 8');
    expect(text(rendered)).toContain('table_6');
    expect(text(rendered)).toContain('table_7');
    expect(text(rendered)).toContain('table_8');
    expect(declaredTableNames(names.join(',\n'))).toEqual(names);
  });

  it('shows the workspace name first and keeps the raw identifier secondary', () => {
    const rendered = renderRow(
      'sql-warehouse',
      { configured: 'wh-0001' },
      {
        tone: 'reachable',
        check: check('sql-warehouse', 'ok', {
          name: 'wh-0001',
          display_name: 'Customer analytics warehouse',
        }),
      }
    );
    expect(text(rendered)).toContain('Customer analytics warehouse');
    expect(rendered).toMatch(/connection-row-raw-id[^>]*title="wh-0001"/);
  });

  it('falls back to the raw identifier when name resolution is unavailable', () => {
    const rendered = renderRow(
      'sql-warehouse',
      { configured: 'wh-0001' },
      {
        tone: 'drifted',
        check: check('sql-warehouse', 'unverified', { name: 'wh-0001', display_name: undefined }),
      }
    );
    expect(text(rendered)).toContain('wh-0001');
    expect(rendered).not.toContain('connection-row-raw-id');
  });

  it('shows Change only for resources this app can apply immediately', () => {
    const adminLockedKind = renderRow('agent-endpoint', { configured: 'pia-agent-serving' });
    const adminLockedWarehouse = renderRow('sql-warehouse', { configured: 'wh-0001' });
    const adminWritable = renderRow('experiment-id', { configured: '123', editable: true }, { open: true });
    expect(adminLockedKind).not.toMatch(/data-affordance|Change/);
    expect(adminLockedWarehouse).not.toMatch(/data-affordance|Change/);
    expect(text(adminWritable)).toContain('Change');

    const consumer = renderRow('agent-endpoint', { configured: 'pia-agent-serving' }, { allowMutations: false });
    expect(consumer).not.toMatch(/data-affordance|Change|not changeable here/);
  });

  it('does not expose shared conversation policy as a Connections editor', () => {
    const rendered = renderRow('shared-conversation-rail', { configured: 'false' }, { open: true });
    expect(text(rendered)).not.toMatch(/Widens tenancy|Record intention/);
  });

  it('wires a picker only for rows with an immediate save path', () => {
    // The AssetPickerField only mounts once the pencil puts the row into edit
    // mode (client state), so a static open-row render cannot assert the picker
    // markup. What this page must not regress is the unlock + the field mapping.
    for (const id of [
      'lakebase',
      'assets-volume',
      'semantic-index-endpoint',
      'semantic-index',
      'experiment-id',
    ] as const) {
      expect(pickerForField(id), id).not.toBeNull();
      const editable = id === 'experiment-id';
      const rendered = renderRow(id, { configured: 'placeholder', editable }, { open: true });
      if (editable) expect(text(rendered), id).toMatch(/Change/);
      else expect(text(rendered), id).not.toMatch(/Change/);
    }
  });

  it('draws Expected and Observed only for a real mismatch', () => {
    const rendered = text(
      renderRow(
        'agent-endpoint',
        {
          configured: 'temperature = 0.1',
          configuredFrom: 'artifact',
          actual: 'temperature = 0.2',
          actualObserved: true,
        },
        { open: true }
      )
    );
    expect(rendered).toContain('Expected');
    expect(rendered).toContain('temperature = 0.1');
    expect(rendered).toContain('Observed');
    expect(rendered).toContain('temperature = 0.2');
    expect(rendered).toMatch(/Drift · expected and observed resources differ/);
  });

  /**
   * The one case on this page where a value is evidence of a fault rather than a
   * report of a state, so it is the one case that earns the red tint. Asserted on
   * the composed markup because the tint is applied by a data attribute the CSS
   * keys off, and a page that stopped setting it would look healthy while drifting.
   */
  it('tints the in-use panel only when the two readings actually disagree', () => {
    const disagreeing = renderRow(
      'agent-endpoint',
      { configured: 'temperature = 0.1', actual: 'temperature = 0.2', actualObserved: true },
      { open: true }
    );
    const agreeing = renderRow(
      'agent-endpoint',
      { configured: 'temperature = 0.1', actual: 'temperature = 0.1', actualObserved: true },
      { open: true }
    );
    expect(disagreeing).toMatch(/data-disagrees="true"/);
    expect(agreeing).not.toMatch(/data-disagrees="true"/);
  });

  /**
   * The honesty rule at its sharpest. An unmeasured value is not an agreeing value,
   * and a row that drew the configured value into both panels would be claiming a
   * measurement nobody took. Most rows on the live deployment are in this state.
   */
  it('omits an observed panel when no observation exists', () => {
    const rendered = renderRow(
      'catalog',
      { configured: 'a_catalog', actual: '', actualObserved: false },
      { open: true }
    );
    expect(text(rendered)).toContain('Catalog');
    expect(text(rendered)).not.toContain('Observed');
    expect(text(rendered)).not.toMatch(/not measured/i);
    expect(rendered).not.toMatch(/data-disagrees/);
    // And specifically NOT the word that would make an absence look like agreement.
    expect(text(rendered)).not.toMatch(/\bmatches\b/);
  });

  /**
   * A resource with nothing configured must not read as a failure. `llm_gateway` is
   * unset on every target by design, so nothing probes it and there is nothing wrong
   * with it -- and a page that badged it red would be reporting the bundle's
   * intention as a fault.
   */
  it('does not render a resource with no configured value as a failure', () => {
    const rendered = text(renderRow('llm-gateway', { configured: '' }, { open: true }));
    expect(rendered).not.toMatch(/blocked/i);
    expect(rendered).toContain('Not connected');
    expect(rendered).not.toMatch(/not set|nothing to reach|Not checked/i);
  });

  /**
   * The design's drift badge, which this deployment has nothing to put in. It is
   * implemented and asserted with a constructed finding rather than left out,
   * because the capability has to exist for the day something drifts -- but nothing
   * fabricates a value to make the badge appear on the live page.
   */
  it('counts each disagreement in the drift badge when there is one to count', () => {
    const rendered = render(
      <ConnectionRow
        reading={readConnection({
          row: row('agent-endpoint', { configured: 'temperature = 0.1' }),
          check: undefined,
          findings: [
            { id: 'a', resourceId: 'agent-endpoint', severity: 'blocking', detail: 'One value disagrees.' },
            { id: 'b', resourceId: 'agent-endpoint', severity: 'warning', detail: 'Another disagrees.' },
          ] as never,
        })}
        tone="drifted"
        saving={false}
        refreshing={false}
        requested={false}
        onSave={noop}
        onClear={noopClear}
      />
    );
    expect(text(rendered)).toMatch(/Drift\s*\u00d7\s*2/);
  });

  /**
   * A finding whose own severity is `unknown` is not a disagreement, and badging it
   * as one was a live defect: an unknown reading rendered a red "Drift ×1"
   * over it. Claiming a disagreement that was never measured is
   * precisely the dishonesty this page exists to refuse.
   */
  it('does not report an unmeasured value as a disagreement', () => {
    const rendered = render(
      <ConnectionRow
        reading={readConnection({
          row: row('agent-endpoint', { configured: 'temperature = 0.1' }),
          check: undefined,
          findings: [
            {
              id: 'measurement-unavailable',
              resourceId: 'agent-endpoint',
              severity: 'unknown',
              detail: 'No measurement was available.',
            },
          ] as never,
        })}
        tone="plain"
        saving={false}
        refreshing={false}
        requested={false}
        onSave={noop}
        onClear={noopClear}
      />
    );
    expect(text(rendered)).not.toMatch(/Drift/);
  });
});

describe('the Unity Catalog tables section', () => {
  const tables = [
    check('t1', 'ok', {
      kind: 'table',
      name: 'a_catalog.a_schema.gold_title_daily_summary',
      detail: 'The workspace answered: 17 columns.',
    }),
    check('t2', 'failed', {
      kind: 'table',
      name: 'a_catalog.a_schema.gold_player_geo_summary',
      detail: 'The workspace refused this identity: HTTP 403 PERMISSION_DENIED.',
    }),
    check('t3', 'ok', {
      kind: 'table',
      name: 'a_catalog.a_schema.silver_player_activity',
      detail: 'The workspace answered: 20 columns.',
    }),
  ];
  const userTable: ConnectionEntry = {
    connection: {
      id: 'table-a-catalog-a-schema-added',
      label: 'Added table',
      kind: 'unity-catalog',
      resourceType: 'table',
      value: 'a_catalog.a_schema.added_table',
      note: '',
      state: 'declared',
      origin: 'app',
    },
    impact: {
      headline: 'Remove Added table.',
      consequences: ['The agent stops being offered this asset.'],
      recoverable: false,
    },
  };
  const userCatalog: ConnectionEntry = {
    ...userTable,
    connection: {
      ...userTable.connection,
      id: 'catalog-a-catalog',
      label: 'Added catalog',
      resourceType: 'catalog',
      value: 'a_catalog',
    },
  };
  const userSchema: ConnectionEntry = {
    ...userTable,
    connection: {
      ...userTable.connection,
      id: 'schema-a-catalog-a-schema',
      label: 'Added schema',
      resourceType: 'schema',
      value: 'a_catalog.a_schema',
    },
  };

  it.each([
    ['admin', true],
    ['owner', true],
    ['super_admin', true],
    ['consumer', false],
  ] as const)('aligns %s with the shared connection-mutation capability', (role, allowed) => {
    expect(canMutateConnections(role)).toBe(allowed);
    const markup = text(
      render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" allowMutations={allowed} />)
    );
    expect(markup).toContain('Unity Catalog scope');
    expect(markup.includes('Add asset')).toBe(allowed);
    expect(markup).not.toContain('Manage scope');
    expect(markup).not.toMatch(/Add table|Add schema|Add catalog/);
  });

  it('starts expanded on the rows it exists for', () => {
    const markup = render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" />);
    expect(markup).toContain('aria-expanded="true"');
    expect(text(markup)).toContain('gold_title_daily_summary');
    expect(text(markup)).not.toContain('Assets the agent may consider');
    expect(text(markup)).not.toContain('Listing an asset lets the agent consider it');
  });

  it('uses one UC-specific admin action and never the generic add control', () => {
    const markup = render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" allowMutations />);
    expect(markup).not.toContain('data-testid="add-connection-row"');
    expect(text(markup)).not.toContain('+ Add a new connection');
    expect(text(markup).match(/Add asset/g)).toHaveLength(1);
    expect(text(markup)).not.toContain('Manage scope');
    expect(text(markup)).not.toMatch(/Add table|Add schema|Add catalog/);
    expect(markup).toContain('aria-controls=');
    expect(PAGE_SOURCE).toMatch(/className="connections-add-uc"[\s\S]*?onClick=\{\(\) => \{[\s\S]*?setAdding\(true\)/);
    expect(PAGE_SOURCE).toContain('<UnityCatalogScopeExplorer');
  });

  it('shows one UC action to an authorized admin with twelve tables', () => {
    const twelve = Array.from({ length: 12 }, (_, index) =>
      check(`table-${index}`, 'ok', {
        kind: 'table',
        name: `a_catalog.a_schema.table_${index}`,
      })
    );
    const rendered = text(render(<DeclaredTablesSection tableChecks={twelve} requestedEntity="" allowMutations />));
    expect(rendered).toContain('0 catalogs · 0 schemas · 12 tables/views · Reachability: 12 reachable');
    expect(rendered.match(/Add asset/g)).toHaveLength(1);
  });

  it('hides all add actions from read-only and unavailable-store views', () => {
    expect(text(render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" />))).not.toContain('Add asset');
    expect(
      text(
        render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" allowMutations storeAvailable={false} />)
      )
    ).not.toContain('Add asset');
    expect(
      text(
        render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" allowMutations storeAvailable={false} />)
      )
    ).toContain('connection store is not answering');
  });

  it('renders the shared modal shell without the retired inline picker controls', () => {
    const markup = render(
      <UnityCatalogScopeExplorer
        dialogId="asset-add-explorer"
        busy={false}
        scopeState={() => ({ label: 'Available', selectable: true })}
        onAdd={() => Promise.resolve({ ok: true, detail: '' })}
        onClose={() => {}}
      />
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('data-testid="uc-explorer-overlay"');
    expect(markup).toContain('id="asset-add-explorer"');
    expect(text(markup)).toContain('Add Unity Catalog asset');
    expect(markup).toContain('aria-label="Close Add Unity Catalog asset"');
    expect(text(markup)).toContain(
      'Declaring an asset does not grant Unity Catalog permissions or change the deployed agent model.'
    );
    expect(text(markup)).not.toMatch(
      /Unity Catalog assets your sign-in can see|Search loaded results|Browse|Select catalog|Load more|Cancel/
    );
    expect(markup).not.toContain('Resource type');
    expect(PAGE_SOURCE).not.toContain('UnityCatalogAssetAddForm');
  });

  it('infers exact catalog, schema, and table values from hierarchy position', () => {
    expect(unityCatalogExplorerValue('catalog', 'analytics', '')).toBe('analytics');
    expect(unityCatalogExplorerValue('schema', 'player', 'analytics')).toBe('analytics.player');
    expect(unityCatalogExplorerValue('table', 'analytics.player.sessions', 'analytics')).toBe(
      'analytics.player.sessions'
    );
  });

  it('lists an added table once with pending reachability and deletion in this section', () => {
    const tableMarkup = render(
      <DeclaredTablesSection tableChecks={tables} tableConnections={[userTable]} requestedEntity="" allowMutations />
    );
    const genericMarkup = render(<DeclaredConnectionsCard entries={[userTable]} allowMutations onChanged={() => {}} />);
    expect(tableMarkup.match(/id="declared-table-row-table-a-catalog-a-schema-added"/g)).toHaveLength(1);
    expect(text(tableMarkup)).toContain('Checking');
    expect(text(tableMarkup)).toContain('Reachability pending');
    expect(tableMarkup).toContain('Delete connection: a_catalog.a_schema.added_table');
    expect(genericMarkup).not.toContain('declared-connection-table-a-catalog-a-schema-added');
  });

  it('keeps bundle-managed table rows read-only', () => {
    const markup = render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" allowMutations />);
    expect(markup).not.toContain('Delete connection: a_catalog.a_schema.gold_title_daily_summary');
  });

  it('keeps added catalogs and schemas only in the UC managed list', () => {
    const ucMarkup = render(
      <DeclaredTablesSection
        tableChecks={tables}
        tableConnections={[userCatalog, userSchema]}
        requestedEntity=""
        allowMutations
      />
    );
    const genericMarkup = render(
      <DeclaredConnectionsCard entries={[userCatalog, userSchema]} allowMutations onChanged={() => {}} />
    );
    expect(text(ucMarkup)).toContain('Current scope');
    expect(text(ucMarkup)).toContain('In scope · added in Astrolabe');
    expect(ucMarkup).toContain('data-testid="managed-uc-catalog-a-catalog"');
    expect(ucMarkup).toContain('data-testid="managed-uc-schema-a-catalog-a-schema"');
    expect(genericMarkup).not.toContain('managed-uc-');
    expect(text(genericMarkup)).not.toContain('Added catalog');
    expect(text(genericMarkup)).not.toContain('Added schema');
  });

  it.each([
    ['admin', true, true],
    ['consumer', false, true],
    ['store unavailable', true, false],
  ] as const)('keeps the empty scope shell visible for %s', (_label, allowMutations, storeAvailable) => {
    const markup = render(
      <DeclaredTablesSection
        tableChecks={[]}
        requestedEntity=""
        allowMutations={allowMutations}
        storeAvailable={storeAvailable}
      />
    );
    const shown = text(markup);
    expect(shown).toContain('Unity Catalog scope');
    expect(shown).toContain('Catalogs, schemas, and tables declared for this app.');
    expect(shown).toContain('0 catalogs · 0 schemas · 0 tables/views · Reachability: 0 reachable');
    expect(shown).toContain('No tables or views are declared in the current scope.');
    expect(shown.includes('Add asset')).toBe(allowMutations && storeAvailable);
    expect(shown).not.toContain('Manage scope');
    expect(PAGE_SOURCE).not.toContain('{tableChecks.length > 0 ||');
  });

  it('counts exact declarations without inferring catalog or schema descendants', () => {
    expect(unityCatalogScopeSummary([userCatalog, userSchema], [])).toBe(
      '1 catalog · 1 schema · 0 tables/views · Reachability: 0 reachable'
    );
    expect(unityCatalogAssetScopeState([userCatalog], [], 'catalog', 'a_catalog')).toEqual({
      label: 'In scope',
      selectable: false,
    });
    expect(unityCatalogAssetScopeState([userCatalog], [], 'schema', 'a_catalog.a_schema')).toEqual({
      label: 'Available',
      selectable: true,
    });
    expect(
      unityCatalogAssetScopeState(
        [],
        ['a_catalog.a_schema.deployed_table'],
        'table',
        'a_catalog.a_schema.deployed_table'
      )
    ).toEqual({ label: 'In scope · managed by deployment', selectable: false });
  });

  it('draws a row per declared table with concise reachability and freshness', () => {
    const markup = render(
      <DeclaredTablesTable tableChecks={tables} requestedEntity="" checkedAt="2026-08-19T15:00:00.000Z" />
    );
    const rendered = text(markup);
    expect(rendered).toContain('gold_title_daily_summary');
    expect(rendered).toContain('gold_player_geo_summary');
    expect(rendered).toContain('Reachable');
    expect(rendered).toContain('Blocked');
    expect(rendered).toContain('17 columns');
    expect(rendered).toContain('Permission not confirmed');
    expect(rendered).toContain('checked');
    expect(markup).toMatch(/title="Reachability confirmed\. Schema has 17 columns\./);
    expect(rendered).not.toContain('@example.com');
  });

  /**
   * Search and the two dropdowns sit in the table header, in the same chrome
   * Monitoring and Run Explorer already use: `.run-search` for the field, and
   * `AppSelect` labelled Catalog / Schema. Typed fragments and the dropdowns
   * themselves are asserted next to the helpers; this is that the controls are
   * on the screen.
   */
  it('puts a table search and catalog/schema filters above the rows', () => {
    const markup = render(<DeclaredTablesTable tableChecks={tables} requestedEntity="" />);
    expect(markup).not.toContain('run-search');
    expect(markup).toContain('connections-table-toolbar');
    expect(markup).toContain('connections-table-search');
    expect(markup).toContain('connections-table-filter');
    expect(markup).toContain('aria-label="Search Unity Catalog tables"');
    expect(markup).toContain('placeholder="Search tables"');
    expect(markup).toContain('Filter tables by catalog');
    expect(markup).toContain('Filter tables by schema');
    expect(text(markup)).toContain('Catalog');
    expect(text(markup)).toContain('Schema');
    expect(text(markup)).toContain('All catalogs');
    expect(text(markup)).toContain('All schemas');
    expect(markup).toContain('a_catalog');
    expect(markup).toContain('a_schema');
    // Search, then Catalog, then Schema — not filters first, not a full-width field.
    expect(markup.indexOf('connections-table-search')).toBeLessThan(markup.indexOf('Filter tables by catalog'));
    expect(markup.indexOf('Filter tables by catalog')).toBeLessThan(markup.indexOf('Filter tables by schema'));
  });

  it('puts the dedicated toolbar between the scope heading and table header', () => {
    const markup = render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" allowMutations />);
    expect(markup).toMatch(
      /class="connection-block-head"[\s\S]*?Unity Catalog scope[\s\S]*?3 tables\/views[\s\S]*?Reachability: 2 reachable[\s\S]*?class="connection-block-body"[\s\S]*?class="connections-table-toolbar"[\s\S]*?connections-uc-actions[\s\S]*?Add asset[\s\S]*?connections-table-query-controls[\s\S]*?Search tables[\s\S]*?Catalog[\s\S]*?Schema[\s\S]*?<th[^>]*>Table<\/th>[\s\S]*?<th[^>]*>Status<\/th>[\s\S]*?<th[^>]*>Detail<\/th>[\s\S]*?<th[^>]*>Actions<\/th>/
    );
    expect(markup).not.toContain('connection-block-controls');
    expect(markup.indexOf('connections-add-uc')).toBeLessThan(markup.indexOf('connections-table-query-controls'));
    expect(markup.indexOf('connections-table-toolbar')).toBeLessThan(markup.indexOf('<thead'));
    expect(markup).toMatch(/class="[^"]*bg-primary[^"]*connections-add-uc/);
  });

  it('right-aligns consumer controls without rendering an empty action placeholder', () => {
    const markup = render(<DeclaredTablesSection tableChecks={tables} requestedEntity="" />);
    expect(markup).toContain('connections-table-query-controls');
    expect(markup).not.toContain('connections-uc-actions');
    expect(text(markup)).not.toContain('Add asset');
  });

  /**
   * Opening Catalog / Schema used to grow the toolbar (and, with a flex-growing
   * search, shove the page left). The menus sit in a positioned wrapper and
   * open as popper overlays, so they cannot take a flex slot.
   */
  it('opens catalog and schema as overlays, without taking a toolbar slot', () => {
    expect(PAGE_SOURCE).toMatch(/className="connections-table-filter"/);
    expect(PAGE_SOURCE).toMatch(/contentClassName="connections-table-filter-menu"/);
    expect(PAGE_SOURCE).toMatch(/contentProps=\{\{\s*position:\s*'popper'\s*\}\}/);
  });

  /**
   * THE 17-vs-7 FAULT. A probe sentence that mentions 7 columns before it
   * reports the workspace's 17 used to put 7 in the cell and 17 on the hover.
   * Both now come from one count.
   */
  it('gives the row and its hover the same column count when the detail names two', () => {
    const markup = render(
      <DeclaredTablesTable
        tableChecks={[
          check('t1', 'ok', {
            kind: 'table',
            name: '<your_catalog>.<your_schema>.data_dictionary',
            detail:
              'Cached 7 columns from an earlier extract. The workspace answered as reader@example.com: 17 columns. ' +
              'That is a metadata read.',
          }),
        ]}
        requestedEntity=""
        checkedAt="2026-08-26T16:28:00.000Z"
      />
    );
    expect(text(markup)).toMatch(/\b17 columns\b/);
    expect(text(markup)).not.toMatch(/\b7 columns\b/);
    expect(markup).toMatch(/title="Reachability confirmed\. Schema has 17 columns\./);
    expect(markup).not.toMatch(/title="[^"]*\b7 columns\b/);
  });

  /**
   * The qualifier disambiguates the object; the last segment is what changes
   * down the list and therefore what a reader scans. All three segments use the
   * shared entity classes whose values are written by Settings > Appearance.
   */
  it('maps each table-name segment to the shared entity palette and marks the table segment', () => {
    const markup = render(<DeclaredTablesTable tableChecks={[tables[0]]} requestedEntity="" />);
    expect(markup).toContain('class="entity-token entity-catalog" data-entity-part="catalog"');
    expect(markup).toContain('class="entity-token entity-schema" data-entity-part="schema"');
    expect(markup).toContain('class="entity-token entity-table" data-entity-part="table"');
    expect(markup).toMatch(
      /data-entity-part="catalog">a_catalog[\s\S]*data-entity-part="schema">a_schema[\s\S]*data-entity-part="table">gold_title_daily_summary/
    );
  });

  /**
   * A STATUS, NOT AN ESSAY. This cell printed each check's whole detail, so on
   * the live deployment -- where one missing permission stops every table --
   * opening the section meant reading the same three-sentence diagnosis twelve
   * more times, under a panel that had already stated it once. The row keeps what
   * is about ITS table: the code the workspace answered with, or what it said.
   */
  it('gives a table row the workspace’s verdict on it, not the shared diagnosis', () => {
    const shared =
      'Your sign-in to this app does not carry `catalog.tables:read`, which the app asks for. ' +
      'The call stopped there, so nothing was established about whether you can reach the object.';
    const rendered = render(
      <DeclaredTablesTable
        tableChecks={[
          check('t1', 'unverified', {
            kind: 'table',
            name: 'a_catalog.a_schema.gold_one',
            detail: `HTTP 403. ${shared}`,
          }),
          check('t2', 'unverified', {
            kind: 'table',
            name: 'a_catalog.a_schema.gold_two',
            detail: `HTTP 403. ${shared}`,
          }),
        ]}
        requestedEntity=""
      />
    );
    const readable = text(rendered);
    expect(readable).toContain('Permission not confirmed');
    expect(readable).not.toContain('does not carry');
    // Not lost, though: the whole sentence is still on the cell for anyone who
    // wants it, and the explanation is stated once in What to fix above.
    expect(rendered).toMatch(/title="The workspace refused the metadata read/);
  });

  /**
   * The visit mark, to the left of the name it opens.
   *
   * The status column already said reachable or blocked; what a reader could not do
   * from this list was go and look at the table. It is the icon-only link rather than
   * the phrase `OpenInDatabricks` renders: twelve rows would carry twelve copies of
   * "Open in Databricks" against 40-character names, in a column that has to hold
   * both.
   */
  it('offers each declared table a way into Databricks, ahead of its name', () => {
    // Asserted from the source, because the mark cannot be rendered here: it needs a
    // workspace host, `useWorkspaceHost` reads one in an effect, and
    // `renderToStaticMarkup` runs no effects. What the link looks like is asserted on
    // `VisitLink` below, which is why that component is split out.
    expect(PAGE_SOURCE).toContain('<VisitInDatabricks name={check.name} />');
    const cell = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('className="connections-table-name"'));
    expect(cell.indexOf('VisitInDatabricks')).toBeLessThan(cell.indexOf('{check.name}'));
  });

  it('names the visit link after the table, not after itself', () => {
    // Twelve links all called "Open" is the standard way to make a table unusable
    // without a pointer, so the mark is hidden and the accessible name carries the
    // table. The green tick's neighbour on the Identity card does the same thing.
    const markup = renderToStaticMarkup(<VisitLink href="https://example.invalid/explore/data/a/b/c" name="a.b.c" />);
    expect(markup).toContain('Open a.b.c in Databricks');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('offers nothing at all when the app was given no workspace host', () => {
    // A supported deployment, and the reason this is not a disabled-looking control:
    // the row still names its table, it just does not claim to be able to open it.
    const markup = render(<DeclaredTablesTable tableChecks={tables} requestedEntity="" />);
    expect(markup).not.toContain('visit-in-databricks');
    expect(text(markup)).toContain('gold_title_daily_summary');
  });

  /**
   * The arrival, SAID and not merely tinted. A reader who followed a table name out
   * of an answer lands on a dozen near-identical monospace rows with one washed
   * blue, and a wash is decoration until something names it. Asserted on text
   * because the tint is a class and the sentence is the part a person can read.
   */
  it('tells the reader which row the link they followed was about', () => {
    const arrived = render(
      <DeclaredTablesTable tableChecks={tables} requestedEntity="a_catalog.a_schema.gold_title_daily_summary" />
    );
    expect(text(arrived)).toContain('Linked from the answer you followed here');
    // The tint and the announcement land on the same row as the sentence: one
    // predicate decides all three, so they cannot name different rows.
    expect(arrived).toMatch(/data-highlighted="true"[^>]*|aria-current="location"/);
    expect([...arrived.matchAll(/connections-table-arrival/g)]).toHaveLength(1);
  });

  /**
   * Said only when it is true. The page is read far more often by someone who
   * navigated to the tab directly, and telling them they followed a link they did
   * not follow is a small lie with no upside.
   */
  it('says nothing about an arrival when the reader did not arrive from a link', () => {
    const rendered = render(<DeclaredTablesTable tableChecks={tables} requestedEntity="" />);
    expect(text(rendered)).not.toContain('Linked from the answer');
    expect(rendered).not.toMatch(/data-highlighted="true"/);
  });

  /**
   * A name that does not match anything must highlight nothing, rather than falling
   * back to the first row -- an off-by-one here would point a reader at the wrong
   * table and everything else on the row would corroborate it.
   */
  it('highlights nothing when the name asked for is not one of the declared tables', () => {
    const rendered = render(
      <DeclaredTablesTable tableChecks={tables} requestedEntity="a_catalog.a_schema.no_such_table" />
    );
    expect(rendered).not.toMatch(/data-highlighted="true"/);
    expect(text(rendered)).not.toContain('Linked from the answer');
  });

  /**
   * The link the answer card builds and the row this table draws have to agree on
   * one spelling of the name, and they are built by different modules. Asserted
   * through the query builder the links actually use, so a change to either side
   * that broke the round trip fails here rather than on screen.
   */
  it('matches the row a source link would ask for by name', () => {
    const name = 'a_catalog.a_schema.silver_player_activity';
    // Read back out of the href the linking module actually builds, rather than
    // assumed to be the name verbatim. The two are built by different files and the
    // round trip is the thing that has to hold; encoding the dots or trimming
    // differently on either side breaks the arrival and nothing else would notice.
    const asked = new URLSearchParams(entityHref(name).split('?')[1] ?? '').get(ENTITY_PARAM) ?? '';
    expect(asked).not.toBe('');
    const rendered = render(<DeclaredTablesTable tableChecks={tables} requestedEntity={asked} />);
    expect(text(rendered)).toContain('Linked from the answer you followed here');
  });
});

describe('what the page still refuses to claim', () => {
  /**
   * The readings the rows draw and the readings the Architecture diagram draws are
   * one derivation, so a resource cannot be reachable on one tab and unchecked on
   * the other. Asserted here as well as in the model's own tests because this is
   * the file that would notice if the page started resolving checks itself.
   */
  it('gives every row the same verdict the Architecture diagram is given', () => {
    const resources = [row('catalog', { configured: 'c' }), row('genie-data', { configured: 'g' })];
    const checks = [check('catalog', 'ok'), check('genie-data', 'failed')];
    const readings = readingsById(readConnections(payload({ resources, checks }), []));
    expect(readings.get('catalog')!.status).toBe('reachable');
    expect(readings.get('genie-data')!.status).toBe('blocked');
  });

  /**
   * A metadata read is not a query, and the live warehouse makes the point: it
   * answered while STOPPED. The row has to keep saying that reaching a thing is not
   * a promise about reading data through it.
   */
  it('keeps saying that reaching a dependency is not a promise about its data', () => {
    const rendered = text(
      render(
        <PreflightRemedyRow
          check={check('sql-warehouse', 'ok', {
            detail:
              'The workspace answered: named \u201cA Warehouse\u201d, state STOPPED. That is a metadata read. ' +
              'It does not prove a statement would run.',
          })}
        />
      )
    );
    expect(rendered).toMatch(/metadata read/);
    expect(rendered).toMatch(/does not prove/);
  });
});

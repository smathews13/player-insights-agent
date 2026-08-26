import { describe, expect, it } from 'vitest';

import {
  computeAside,
  deployedAtLabel,
  deploymentRows,
  endpointHost,
  sourceRows,
  telemetryRows,
  uptimeSince,
} from './build-card';
import { NO_APP_FACTS, PUBLIC_SOURCE_REPO_URL, type AppFacts } from '../../shared/app-facts';

/**
 * Which rows the Build card draws, and which it does not.
 *
 * The card grew from two rows to ten, and every one of the eight new ones comes
 * from a workspace that may not report it. So the rule these assertions protect
 * is the one the whole tab is built on: a fact nobody established renders
 * nothing, not "not reported", and not a zero.
 */

const AUG_2 = '2026-08-02T07:41:00Z';

function facts(over: Partial<AppFacts> = {}): AppFacts {
  return { ...NO_APP_FACTS, answered: true, ...over };
}

/**
 * The endpoint badge, which was hardcoded green.
 *
 * THE PATTERN IS THE FINDING. This is the third surface in this codebase to
 * assert health it never measured: the exporter row declared its own tables
 * permanently empty, the MLflow probe badged a deleted experiment OK while
 * every trace was dropped, and this badge tinted green for any deployment whose
 * workspace answered at all -- including a crashed app on stopped compute.
 */
describe('the endpoint badge reports a reading, not a literal', () => {
  const URL = 'https://an-app-1234.example.databricksapps.com';

  it('greens only where the app and its compute are both reported serving', () => {
    const [endpoint] = deploymentRows(facts({
      url: URL,
      serving: { app: 'RUNNING', compute: 'ACTIVE', message: 'App has status: App is running' },
    }));

    expect(endpoint).toMatchObject({ key: 'endpoint', tone: 'reachable' });
    // And says nothing further: the badge carries it, and a row repeating
    // "RUNNING · ACTIVE" is the prose this card exists without.
    expect(deploymentRows(facts({ url: URL, serving: { app: 'RUNNING', compute: 'ACTIVE', message: '' } }))
      .map((row) => row.key)).not.toContain('endpoint-state');
  });

  it('does not green an app the workspace says has crashed', () => {
    const rows = deploymentRows(facts({
      url: URL,
      serving: { app: 'CRASHED', compute: 'ACTIVE', message: 'App has status: container exited' },
    }));

    expect(rows[0]).toMatchObject({ key: 'endpoint', tone: 'blocked' });
    expect(rows.find((row) => row.key === 'endpoint-state')).toMatchObject({
      value: 'CRASHED · ACTIVE',
      aside: ' · App has status: container exited',
    });
  });

  /** Both halves are reported separately, so believing only one would miss this. */
  it('does not green a running app whose compute has stopped', () => {
    const [endpoint] = deploymentRows(facts({
      url: URL,
      serving: { app: 'RUNNING', compute: 'STOPPED', message: 'App compute is stopped.' },
    }));

    expect(endpoint).toMatchObject({ tone: 'drifted' });
  });

  /**
   * NO READING IS NOT A BAD READING, and it is not a good one either. A
   * workspace that said nothing about serving tints nothing, which is the rule
   * every other row on this card already follows.
   */
  it('tints nothing where the workspace reported no state at all', () => {
    const rows = deploymentRows(facts({ url: URL }));

    expect(rows[0]).toMatchObject({ key: 'endpoint', tone: 'plain' });
    expect(rows.map((row) => row.key)).not.toContain('endpoint-state');
  });

  it('surfaces a state it does not recognise rather than guessing at it', () => {
    const rows = deploymentRows(facts({ url: URL, serving: { app: 'DEPLOYING', compute: 'ACTIVE', message: '' } }));

    expect(rows[0]).toMatchObject({ tone: 'drifted' });
    expect(rows.find((row) => row.key === 'endpoint-state')).toMatchObject({ value: 'DEPLOYING · ACTIVE' });
  });
});

describe('the left column: what this deployment is', () => {
  it('leads with the host, and keeps the whole URL for the copy and the link', () => {
    const [endpoint] = deploymentRows(facts({ url: 'https://an-app-1234.example.databricksapps.com' }));

    expect(endpoint.kind).toBe('badge');
    expect(endpoint).toMatchObject({
      label: 'App endpoint',
      value: 'an-app-1234.example.databricksapps.com',
      full: 'https://an-app-1234.example.databricksapps.com',
      copyable: true,
      openable: true,
    });
  });

  /**
   * The scheme is on every row that could have one, so it carries no information
   * and costs the row eight characters it needs for the host.
   */
  it('strips the scheme and any trailing slash from what it prints', () => {
    expect(endpointHost('https://an-app.example.com/')).toBe('an-app.example.com');
    expect(endpointHost('http://collector:4317')).toBe('collector:4317');
    expect(endpointHost('')).toBe('');
  });

  /**
   * NOT A RED "NOT SET". This app cannot tell an app with no URL from an app it
   * was never able to ask about, and a red badge on the second would accuse a
   * deployment that is demonstrably serving the page the badge is on.
   */
  it('draws no endpoint row at all where no URL was reported', () => {
    expect(deploymentRows(facts()).map((row) => row.key)).not.toContain('endpoint');
    expect(deploymentRows(NO_APP_FACTS)).toEqual([]);
  });

  it('omits the description and the tags rather than printing an empty row for either', () => {
    const keys = deploymentRows(facts({ url: 'https://a.example.com', description: '', tags: [] })).map((row) => row.key);
    // The two source links are always in this column now; the repository one is
    // a product fact rather than a reading, so it is drawn on every deployment.
    expect(keys).toEqual(['endpoint', 'github']);
  });

  it('draws one chip per tag where the workspace reported any', () => {
    const rows = deploymentRows(facts({ tags: ['insights', 'demo'] }));
    expect(rows.at(-1)).toMatchObject({ kind: 'chips', label: 'Tags', values: ['insights', 'demo'] });
  });

  it('names the compute size, and prints its envelope only where there is one', () => {
    expect(computeAside({ size: 'MEDIUM', envelope: { vcpus: 2, memoryGb: 6, dbuPerHour: 0.5 } })).toBe(
      ' \u00b7 up to 2 vCPUs \u00b7 6 GB memory \u00b7 0.5 DBU/hour',
    );
    expect(computeAside({ size: 'X-LARGE-2', envelope: null })).toBe('');
    expect(computeAside(null)).toBe('');
  });
});

/**
 * WHICH COLUMN EACH ROW IS IN, asked of the two functions that are the only
 * answer to it.
 *
 * The card is read as two columns, and it had drifted to three rows on the left
 * against seven on the right, which reads as one list with a hole in it. Sam
 * asked for the two source links to move under Compute; these assertions are
 * what stops the next row being appended to whichever function it was easiest
 * to reach.
 */
describe('the two columns of the card', () => {
  /** What the workspace running this app actually reports about it. */
  const live = facts({
    url: 'https://an-app-1234567890.aws.databricksapps.com',
    description: 'Player insights, multi-agent traces, and repeatable benchmarking',
    compute: { size: 'MEDIUM', envelope: { vcpus: 2, memoryGb: 6, dbuPerHour: 0.5 } },
    deployedAt: AUG_2,
    deployedBy: 'someone@example.com',
    otelExporter: 'http://localhost:4314',
    source: {
      path: '/Workspace/Users/someone/player-insights-agent-real-src',
      workspaceUrl: 'https://workspace.example.com/browse/folders/1999001141571163?o=1234567890',
      gitRef: 'main',
    },
  });
  const now = Date.parse(AUG_2) + 6 * 60 * 60 * 1000;

  it('puts the two source links on the left, directly under Compute', () => {
    expect(deploymentRows(live).map((row) => row.key)).toEqual([
      'endpoint',
      'description',
      'compute',
      'app-source',
      'github',
    ]);
  });

  it('leaves the exporter and the release on the right, and neither source link', () => {
    const keys = telemetryRows(live, now).map((row) => row.key);
    expect(keys).toEqual(['otel', 'deployed', 'uptime']);
    expect(keys).not.toContain('app-source');
    expect(keys).not.toContain('github');
  });

  /**
   * FIVE AND FIVE. The right column is these three rows plus the two commit
   * stamps, which the card takes from `buildFacts` rather than from here -- so
   * the balance is only checkable by counting both halves at once, which is
   * what this does.
   */
  it('balances the two columns on the deployment this app runs on', () => {
    const COMMIT_ROWS = 2;
    expect(deploymentRows(live)).toHaveLength(telemetryRows(live, now).length + COMMIT_ROWS);
    expect(deploymentRows(live)).toHaveLength(5);
  });

  /**
   * The tags row closes the column, which means the links go BEFORE it rather
   * than at the end of whatever exists.
   */
  it('keeps the tags row last when the workspace reported any', () => {
    const rows = deploymentRows(facts({ ...live, tags: ['insights', 'demo'] }));
    expect(rows.map((row) => row.key)).toEqual([
      'endpoint',
      'description',
      'compute',
      'app-source',
      'github',
      'tags',
    ]);
  });

  /**
   * A deployment whose workspace answered nothing has no left column, so the
   * links have nowhere to be but the right -- and losing them would lose the
   * repository row, which was never a reading in the first place.
   */
  it('carries the links on the right where there is no left column at all', () => {
    expect(deploymentRows(NO_APP_FACTS)).toEqual([]);
    expect(telemetryRows(NO_APP_FACTS, now).map((row) => row.key)).toEqual(['github']);
  });
});

describe('the right column: what it was built from', () => {
  /**
   * THE TWO ROWS A READER CLICKS, and the rule that separates them: the
   * workspace one is a reading and is dropped where nothing resolved it, the
   * repository one is a product fact and is always drawn.
   */
  it('names the live workspace source and the published repository', () => {
    const rows = sourceRows(
      facts({
        source: {
          path: 'player-insights-agent/build/deploy',
          workspaceUrl: 'https://workspace.example.com/apps/astrolabe',
          gitRef: 'main',
        },
      })
    );

    expect(rows).toEqual([
      {
        kind: 'link',
        key: 'app-source',
        label: 'App source',
        value: 'player-insights-agent/build/deploy',
        href: 'https://workspace.example.com/apps/astrolabe',
        mark: 'apps',
        title: 'player-insights-agent/build/deploy',
      },
      {
        kind: 'link',
        key: 'github',
        label: 'GitHub',
        value: '<your-username>/astrolabe_public · main',
        href: PUBLIC_SOURCE_REPO_URL,
        mark: 'github',
        title: PUBLIC_SOURCE_REPO_URL,
      },
    ]);
  });

  /**
   * A workspace that reported no source, or a container with no host, has no
   * destination this app can honestly offer -- and a dead link is worse than no
   * link. The repository survives, because nothing about it was being read.
   */
  it('drops the workspace link where nothing resolved it, and keeps the repository', () => {
    const rows = sourceRows(facts());
    expect(rows.map((row) => row.key)).toEqual(['github']);
    // And says nothing about a branch, because an uploaded deploy establishes none.
    expect(rows[0]).toMatchObject({ value: '<your-username>/astrolabe_public', href: PUBLIC_SOURCE_REPO_URL });
  });

  /**
   * The card composes them, so they are in a column and not adrift. Which
   * column is asserted above, in `the two columns of the card`.
   */
  it('composes the source rows into a column rather than leaving them unrendered', () => {
    const left = deploymentRows(facts({ url: 'https://a.example.com', deployedAt: AUG_2 })).map((row) => row.key);
    const right = telemetryRows(facts({ url: 'https://a.example.com', deployedAt: AUG_2 }), Date.parse(AUG_2))
      .map((row) => row.key);

    expect(left).toContain('github');
    expect(right).toContain('deployed');
    expect(right).not.toContain('github');
  });

  /**
   * ONE STAMP, TWO ROWS. The handoff requires the release time and the uptime to
   * agree, and reading them from two fields would be two chances to disagree.
   */
  it('reads the release and the uptime off the same stamp', () => {
    const rows = telemetryRows(facts({ deployedAt: AUG_2, deployedBy: 'someone@example.com' }), Date.parse(AUG_2) + 14 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000);
    const byKey = new Map(rows.map((row) => [row.key, row]));

    expect(byKey.get('deployed')).toMatchObject({ identity: 'someone@example.com' });
    expect(byKey.get('uptime')).toMatchObject({ value: '14d 6h', aside: ' \u00b7 since last deploy' });
  });

  it('drops both rows where nothing reported a release', () => {
    const keys = telemetryRows(facts(), Date.now()).map((row) => row.key);
    expect(keys).not.toContain('deployed');
    expect(keys).not.toContain('uptime');
  });

  it('states an uptime under a day in hours rather than as "0d"', () => {
    expect(uptimeSince(AUG_2, Date.parse(AUG_2) + 5 * 60 * 60 * 1000)).toBe('5h');
  });

  /**
   * An uptime of nothing is not an uptime. An unreadable stamp is the case a
   * server built before this field existed produces, and it must draw no row
   * rather than "0h".
   */
  it('reports no uptime for a stamp it cannot read', () => {
    expect(uptimeSince('', Date.now())).toBe('');
    expect(uptimeSince('the day before yesterday', Date.now())).toBe('');
    expect(deployedAtLabel('not a date')).toBe('');
  });

  /**
   * THE ROW IS A READING NOW, and these four cases are the whole point of the
   * change: the tone used to be hardcoded plain under a comment asserting the
   * exporter's tables were permanently empty on every deployment. They are not.
   * appkit bundles the OpenTelemetry Node SDK, so an exporter runs without this
   * source starting one, and both tables have been filling since 2026-08-16.
   */
  it('greens a configured exporter when rows were actually counted', () => {
    const rows = telemetryRows(facts({
        otelExporter: 'http://collector:4317',
        otelExport: {
          state: 'exporting',
          schema: 'cat.telemetry',
          error: '',
          tables: [
            { table: 'otel_spans', rows: 5469, firstAt: '2026-08-16 19:30:59', lastAt: '2026-08-17 16:43:41' },
            { table: 'otel_metrics', rows: 923707, firstAt: '2026-08-16 19:31:09', lastAt: '2026-08-17 16:44:29' },
          ],
        },
      }), Date.now());

    expect(rows[0]).toMatchObject({ key: 'otel', value: 'collector:4317', tone: 'reachable' });
    const activity = rows.find((row) => row.key === 'otel-activity');
    expect(activity).toMatchObject({ kind: 'text', value: '5,469 spans · 923,707 metrics' });
    // THE SPAN IS STATED, because telemetry does not backfill. A count printed
    // bare reads as a total for the life of the app; on this deployment it
    // covers hours.
    const aside = activity && 'aside' in activity ? (activity.aside ?? '') : '';
    expect(aside).toMatch(/covering .*Aug 16.* to .*Aug 17/);
    // TO THE MINUTE, and the exact pair in `title`. Printed whole, the two Delta
    // stamps were 46 characters that wrapped this row over three lines to answer
    // "roughly when did the telemetry start", which a day and a time answer. The
    // tab's rule is that a full timestamp is `title` or clipboard content.
    expect(aside).not.toContain('19:30:59');
    const title = activity && 'title' in activity ? (activity.title ?? '') : '';
    expect(title).toBe('2026-08-16 19:30:59 to 2026-08-17 16:44:29');
  });

  /**
   * A COUNT THAT DID NOT HAPPEN IS NOT A COUNT OF ZERO. This app has shipped
   * that substitution twice -- a table reported empty while its query failed,
   * and a badge reading OK on a deleted experiment -- so the failed read is red
   * and carries the platform's words.
   */
  it('shows the error when the count failed, rather than passing it off as empty', () => {
    const rows = telemetryRows(facts({
        otelExporter: 'http://collector:4317',
        otelExport: { state: 'unreadable', schema: 'cat.telemetry', error: 'TABLE_OR_VIEW_NOT_FOUND', tables: [] },
      }), Date.now());

    expect(rows[0]).toMatchObject({ key: 'otel', tone: 'blocked' });
    const activity = rows.find((row) => row.key === 'otel-activity');
    expect(activity).toMatchObject({ value: 'Could not be counted' });
    expect(activity && 'aside' in activity ? activity.aside : '').toContain('TABLE_OR_VIEW_NOT_FOUND');
  });

  /** Counted, and genuinely holding nothing. A finding, and distinct from both above. */
  it('separates a table counted empty from one that could not be read', () => {
    const rows = telemetryRows(facts({
        otelExporter: 'http://collector:4317',
        otelExport: {
          state: 'silent',
          schema: 'cat.telemetry',
          error: '',
          tables: [{ table: 'otel_spans', rows: 0, firstAt: '', lastAt: '' }],
        },
      }), Date.now());

    expect(rows[0]).toMatchObject({ key: 'otel', tone: 'drifted' });
    expect(rows.find((row) => row.key === 'otel-activity')).toMatchObject({ value: '0 spans' });
  });

  /**
   * The exporter can be running with no `OTEL_EXPORTER_OTLP_ENDPOINT` set,
   * because appkit starts the SDK itself. The badge row is drawn off that
   * variable, so the finding has to be able to stand without it.
   */
  it('reports counted rows even where no exporter address is configured', () => {
    const rows = telemetryRows(facts({
        otelExport: {
          state: 'exporting',
          schema: 'cat.telemetry',
          error: '',
          tables: [{ table: 'otel_spans', rows: 12, firstAt: '2026-08-16 19:30:59', lastAt: '2026-08-17 01:00:00' }],
        },
      }), Date.now());

    expect(rows.map((row) => row.key)).toContain('otel-activity');
    expect(rows.find((row) => row.key === 'otel-activity')).toMatchObject({ label: 'OTel exporter' });
  });

  /** Nothing counted draws nothing, which is this card's rule everywhere else. */
  it('draws no activity row where no count was taken', () => {
    const rows = telemetryRows(facts({ otelExporter: 'http://collector:4317' }), Date.now());
    expect(rows[0]).toMatchObject({ key: 'otel', tone: 'plain' });
    expect(rows.map((row) => row.key)).not.toContain('otel-activity');
  });

  /**
   * NO COMPUTE HOURS ROW, deliberately, and this is the assertion that makes
   * somebody read why before adding one.
   *
   * The design asks for `6.2h · warehouse, last 24 h`. The billing read that
   * would answer it is admin-only (`/api/ops` is in `ADMIN_ROUTE_PREFIXES`)
   * while this card is fed by the consumer-visible `/api/settings`; Ops prices
   * DBUs into currency and never returns a quantity to convert into hours; and
   * its range ends at the last complete day, so "last 24 h" is not a window it
   * produces. See the note on `telemetryRows` for the full reasoning.
   *
   * Asserted over a FULLY POPULATED fact set, so the row's absence is a property
   * of the card rather than of a thin fixture.
   */
  it('draws no compute-hours row, because nothing consumer-visible reports one', () => {
    const rows = telemetryRows(facts({
        deployedAt: AUG_2,
        deployedBy: 'someone@example.com',
        otelExporter: 'http://collector:4317',
        compute: { size: 'MEDIUM', envelope: { vcpus: 2, memoryGb: 6, dbuPerHour: 0.5 } },
      }),
      Date.parse(AUG_2) + 6 * 60 * 60 * 1000,
    );

    expect(rows.map((row) => row.key)).toEqual(['otel', 'deployed', 'uptime']);
    // And no row invents one out of the DBU rate the compute envelope carries,
    // which is the plausible-looking arithmetic to reach for: a published rate
    // times an uptime is a capacity, not a bill, and it would read on this card
    // as a figure taken from billing.
    expect(rows.some((row) => /hour/i.test(row.label))).toBe(false);
  });
});

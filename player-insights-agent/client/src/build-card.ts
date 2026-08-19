/**
 * The Build and telemetry card's rows, decided away from the markup.
 *
 * The card had two rows and the design asks it for nine, arranged as two
 * columns: what this deployment IS on the left -- its host, its description, its
 * compute, its tags -- and what it was BUILT FROM on the right, which is the two
 * commits, the exporter, the release and how long it has been up.
 *
 * A ROW THAT HAS NOTHING TO SAY IS NOT DRAWN. Every fact here comes from a
 * workspace that may not report it, and the page's rule is that an absence reads
 * as a fact nobody established rather than as a fault. Six rows saying "not
 * reported" would be the prose this tab had deleted, in a grid.
 *
 * Deciding it here rather than in `ConnectionsPage.tsx` is what makes the rules
 * assertable: which rows appear on a deployment whose workspace answered
 * nothing, whether an unrecognised compute size prints a DBU rate, and whether
 * the uptime and the release can disagree, are all questions about this module.
 */
import type { AppFacts } from '../../shared/app-facts';
import type { StatusTone } from './StatusBadge';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * One row of either grid.
 *
 * `kind` is what the row is, not how it looks: the card draws a `badge` as a
 * mono status chip, a `text` row as plain type and a `chips` row as one neutral
 * chip per entry. Keeping the three apart here is what stops a table name and a
 * sentence ending up in the same typeface.
 */
export type BuildRow =
  | {
      kind: 'badge';
      key: string;
      label: string;
      /** What renders. Truncated values keep their whole self in `full`. */
      value: string;
      /** The whole value, for `title` and for the clipboard. */
      full: string;
      tone: StatusTone;
      /** Whether the row offers a copy button for `full`. */
      copyable?: boolean;
      /** Whether the row offers a link that opens `full`. */
      openable?: boolean;
    }
  | {
      kind: 'text';
      key: string;
      label: string;
      value: string;
      /** A quieter clause after the value. */
      aside?: string;
      /** A person associated with this fact, rendered by the shared identity chip. */
      identity?: string;
      /**
       * The exact figures behind a rounded or shortened value.
       *
       * The tab's own rule is that full timestamps and full ids are `title` or
       * clipboard content and not page text, and the telemetry span is the row
       * that broke it: two Delta stamps to the millisecond, printed whole, wrapped
       * the row over three lines.
       */
      title?: string;
    }
  | { kind: 'chips'; key: string; label: string; values: string[] };

/** The host somebody is actually on, without the scheme that is on every row. */
export function endpointHost(url: string): string {
  return url.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * How long the running deployment has been up, in the two units that matter.
 *
 * Days and hours, because the question is "is this the release I deployed this
 * morning" and neither minutes nor weeks answer it. Returns '' rather than "0d
 * 0h" for an unreadable or absent stamp: an uptime of nothing is not an uptime.
 */
export function uptimeSince(deployedAt: string, now: number): string {
  const at = Date.parse(deployedAt);
  if (!deployedAt || Number.isNaN(at)) return '';
  const elapsed = Math.max(0, now - at);
  const days = Math.floor(elapsed / DAY_MS);
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

/**
 * When the running deployment was created, as a reader's own local time.
 *
 * Date and time to the minute, and no seconds and no year: this is read beside
 * an uptime, so the part that carries meaning is which day and roughly when.
 * The whole stamp goes in the row's `title`.
 */
export function deployedAtLabel(deployedAt: string): string {
  const at = new Date(deployedAt);
  if (!deployedAt || Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The compute clause, from a size the workspace named.
 *
 * The envelope is only ever printed for a size this app has a published figure
 * for. An unrecognised size prints its own name and stops, because the reader of
 * this row is reconciling a bill and a DBU rate this app inferred would look
 * exactly like one the workspace reported.
 */
export function computeAside(compute: AppFacts['compute']): string {
  if (!compute?.envelope) return '';
  const { vcpus, memoryGb, dbuPerHour } = compute.envelope;
  return ` \u00b7 up to ${vcpus} vCPUs \u00b7 ${memoryGb} GB memory \u00b7 ${dbuPerHour} DBU/hour`;
}

/**
 * The states the platform reports for an app that is serving.
 *
 * Matched case-insensitively and compared as whole words. Anything else is a
 * state this app does not recognise, and an unrecognised state is reported as
 * unrecognised rather than assumed to be trouble or assumed to be fine.
 */
const SERVING_APP_STATE = 'running';
const SERVING_COMPUTE_STATE = 'active';

/** The states that mean it is not going to answer, whatever else is true. */
const BROKEN_APP_STATES = ['crashed', 'error', 'unavailable'];

/**
 * The endpoint badge's tone, from what the workspace reported.
 *
 * THIS ROW WAS HARDCODED GREEN. Any deployment whose workspace answered at all
 * drew a green endpoint, including a crashed app on stopped compute, because
 * the tone was a literal and not a reading. That is the third instance in this
 * codebase of one pattern -- the exporter row asserted its own tables were
 * empty, and the MLflow probe badged a deleted experiment OK while every trace
 * was dropped -- so it is worth naming as a pattern: a surface that states
 * health it never measured is worse than one that states nothing, because a
 * reader cannot tell the claim from a finding.
 *
 * Green requires BOTH halves to be good. The platform reports the application
 * and the container it runs in separately, and an app reported running on
 * compute that has stopped is not a green endpoint. Where the workspace said
 * nothing, this tints nothing: no reading is not a bad reading.
 */
export function endpointTone(serving: AppFacts['serving']): StatusTone {
  const app = serving.app.trim().toLowerCase();
  const compute = serving.compute.trim().toLowerCase();
  if (!app && !compute) return 'plain';
  if (BROKEN_APP_STATES.includes(app)) return 'blocked';
  const appOk = app === SERVING_APP_STATE;
  const computeOk = compute === SERVING_COMPUTE_STATE;
  // Both halves reported, both good. The only case that earns green.
  if (appOk && computeOk) return 'reachable';
  // Something was reported and it is not the serving pair: starting, stopped,
  // deploying, or a word this app has not met. Drawn as worth a look rather
  // than as broken, because most of those states are transitional.
  return 'drifted';
}

/**
 * The serving state as a row, where it is worth reading.
 *
 * Suppressed on the healthy pair: a green badge already says it, and a row
 * reading "RUNNING · ACTIVE" under it is the "not reported" prose this card
 * exists without. Drawn whenever the state is anything else, carrying the
 * platform's own message, because that is when a reader needs the words.
 */
export function servingActivity(
  serving: AppFacts['serving']
): { value: string; aside: string } | null {
  if (endpointTone(serving) === 'reachable' || endpointTone(serving) === 'plain') return null;
  const states = [serving.app, serving.compute].filter(Boolean).join(' \u00b7 ');
  return { value: states, aside: serving.message ? ` \u00b7 ${serving.message}` : '' };
}

/**
 * The exporter row's tone, from what was counted.
 *
 * THIS ROW USED TO BE HARDCODED PLAIN, under a comment asserting that the two
 * tables an exporter writes were "permanently empty on every deployment" of
 * this app. That was reasoned from our own dependencies rather than measured,
 * and it was wrong: appkit bundles the OpenTelemetry Node SDK with
 * auto-instrumentation, so an exporter runs without this source starting one.
 * Both tables have been filling since 2026-08-16.
 *
 * The tone is now a reading and never a claim. Green means rows were counted.
 * An unreadable count is red and says so rather than passing for empty, which
 * is the substitution that produced two of this app's shipped defects: a table
 * reported empty while its query was failing, and a badge reading OK on a
 * deleted experiment.
 */
export function exporterTone(reading: AppFacts['otelExport']): StatusTone {
  if (reading.state === 'exporting') return 'reachable';
  if (reading.state === 'unreadable') return 'blocked';
  if (reading.state === 'silent') return 'drifted';
  // Nothing was counted. An untinted row claims nothing, which is the honest
  // rendering of a measurement nobody took.
  return 'plain';
}

/** `5,469` rather than `5469`, on a row read beside other figures. */
function countOf(rows: number): string {
  return rows.toLocaleString();
}

/**
 * A telemetry stamp, short enough to read beside a count.
 *
 * These arrive as Delta strings to the millisecond -- `2026-08-16 19:30:59.09` --
 * and the row printed two of them verbatim, which is 46 characters of precision
 * to answer "roughly when did this start". Day and time to the minute answers it;
 * the exact pair goes in the row's `title`, on the tab's rule that a full
 * timestamp is `title` content and not page text. An unparseable stamp is handed
 * back as it came rather than guessed at.
 */
export function stampLabel(stamp: string): string {
  const trimmed = stamp.trim();
  if (!trimmed) return '';
  const at = new Date(trimmed.replace(' ', 'T'));
  if (Number.isNaN(at.getTime())) return trimmed;
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * What the count found, as a line and a quieter clause.
 *
 * THE CLAUSE IS NOT DECORATION. It names the first and last stamp the rows
 * actually carry, because telemetry does not backfill: the platform begins
 * writing at the deploy that switches it on, so on a deployment that has been
 * up for months the figures may cover hours. A count printed without its span
 * reads as a total for the life of the app, and that reading would be wrong by
 * orders of magnitude. Returns null when nothing was measured, so the card
 * draws no row rather than a row saying nothing.
 */
export function exporterActivity(
  reading: AppFacts['otelExport']
): { value: string; aside: string; title?: string } | null {
  if (reading.state === 'unmeasured') return null;
  if (reading.state === 'unreadable') {
    return {
      value: 'Could not be counted',
      aside: reading.error ? ` \u00b7 ${reading.error}` : '',
    };
  }
  const counted = reading.tables.map((entry) => `${countOf(entry.rows)} ${entry.table.replace(/^otel_/, '')}`);
  const first = reading.tables.map((entry) => entry.firstAt).filter(Boolean).sort()[0] ?? '';
  const last = reading.tables.map((entry) => entry.lastAt).filter(Boolean).sort().pop() ?? '';
  if (reading.state === 'silent') {
    return {
      value: counted.join(' \u00b7 ') || 'Nothing written',
      aside: ' \u00b7 the tables exist and hold no rows',
    };
  }
  return {
    value: counted.join(' \u00b7 '),
    // "covering", not "in the last N hours". The span is whatever the rows
    // carry, and saying so is what keeps a partial window from reading whole.
    //
    // Shortened to the minute. The millisecond stamps read straight from Delta
    // were 46 characters that wrapped this row over three lines to answer a
    // question -- roughly when does the telemetry start -- that day and time
    // answers. The exact pair is in `title`, which is where this tab puts a full
    // timestamp.
    aside: first && last ? ` \u00b7 covering ${stampLabel(first)} to ${stampLabel(last)}` : '',
    title: first && last ? `${first} to ${last}` : undefined,
  };
}

/**
 * The left column: what this deployment is.
 *
 * The endpoint leads, because it is the one fact on the card that answers "am I
 * looking at the deployment I think I am". It is drawn only where the workspace
 * reported a URL: this app cannot tell an app with no URL from an app it was
 * never able to ask about, and a red "not set" on the second would accuse a
 * healthy deployment.
 */
export function deploymentRows(app: AppFacts): BuildRow[] {
  const rows: BuildRow[] = [];
  const host = endpointHost(app.url);
  if (host) {
    rows.push({
      kind: 'badge',
      key: 'endpoint',
      label: 'App endpoint',
      value: host,
      full: app.url,
      tone: endpointTone(app.serving),
      copyable: true,
      openable: true,
    });
    const serving = servingActivity(app.serving);
    if (serving) {
      rows.push({
        kind: 'text',
        key: 'endpoint-state',
        label: 'App state',
        value: serving.value,
        aside: serving.aside,
      });
    }
  }
  if (app.description) {
    rows.push({ kind: 'text', key: 'description', label: 'Description', value: app.description });
  }
  if (app.compute) {
    rows.push({ kind: 'text', key: 'compute', label: 'Compute', value: app.compute.size, aside: computeAside(app.compute) });
  }
  if (app.tags.length > 0) {
    rows.push({ kind: 'chips', key: 'tags', label: 'Tags', values: app.tags });
  }
  return rows;
}

/**
 * The right column: what it was built from, and how long it has been running.
 *
 * The two commit rows are NOT built here. They come from `buildFacts`, which
 * owns the `+dirty` suffix and the two-commit comparison and must stay the only
 * thing that does; the card renders them ahead of these.
 *
 * ## There is no Compute hours row, and it is not an oversight
 *
 * The design asks for one, reading `6.2h · warehouse, last 24 h`. Three separate
 * things stop it, and the first is the one that matters:
 *
 * 1. **Billing is admin-only, and this page is not.** The read lives behind
 *    `/api/ops/cost`, and `/api/ops` is in `ADMIN_ROUTE_PREFIXES`, so the guard
 *    refuses a consumer before the handler runs. `/api/settings`, which feeds
 *    this card, is deliberately consumer-visible and has a test saying so.
 *    Calling the Ops route from here would 403 for most of the people who open
 *    this tab; widening the prefix list to fix that would publish the
 *    deployment's spend to every signed-in reader. That is the app's permission
 *    model, not a wiring detail.
 * 2. **Ops does not compute hours.** `ops-billing.ts` prices
 *    `usage_quantity * list_price` and selects `SUM(spend)` in currency.
 *    `usage_quantity` is DBUs, and DBUs become hours only by dividing by a
 *    per-SKU DBU/hour rate -- the "ratio invented in this file" its own opening
 *    paragraph forbids. The quantity is not even in the result set, so the
 *    arithmetic has nothing to work from without editing another surface's query.
 * 3. **"Last 24 h" is not a window Ops can produce.** `CostRange.to` is the last
 *    COMPLETE day, never today, so a rolling 24 hours is structurally outside
 *    what that query answers.
 *
 * A figure assembled around any of those would be a number nobody could trust,
 * on the row a reader takes to a bill. If somebody wants it, the honest version
 * is a quantity column added to the Ops statement and a consumer-safe route in
 * front of it, and that is its own piece of work with its own permission
 * decision. Not a row quietly added here.
 */
export function telemetryRows(app: AppFacts, now: number): BuildRow[] {
  const rows: BuildRow[] = [];
  if (app.otelExporter) {
    rows.push({
      kind: 'badge',
      key: 'otel',
      label: 'OTel exporter',
      value: endpointHost(app.otelExporter),
      full: app.otelExporter,
      tone: exporterTone(app.otelExport),
      copyable: true,
    });
  }
  const activity = exporterActivity(app.otelExport);
  if (activity) {
    rows.push({
      kind: 'text',
      // Labelled for what it is when it stands alone. A deployment can be
      // exporting with no `OTEL_EXPORTER_OTLP_ENDPOINT` set -- appkit starts the
      // SDK itself -- and the badge row above is drawn off that variable, so
      // this must be able to carry the finding on its own.
      key: 'otel-activity',
      label: app.otelExporter ? 'OTel activity' : 'OTel exporter',
      value: activity.value,
      aside: activity.aside,
      title: activity.title,
    });
  }
  const deployed = deployedAtLabel(app.deployedAt);
  if (deployed) {
    rows.push({
      kind: 'text',
      key: 'deployed',
      label: 'Last deployed',
      value: deployed,
      identity: app.deployedBy || undefined,
    });
  }
  // Read off the SAME stamp as the row above, rather than from a second field,
  // because the handoff requires the two to agree and two sources are two
  // chances to disagree.
  const uptime = uptimeSince(app.deployedAt, now);
  if (uptime) {
    rows.push({ kind: 'text', key: 'uptime', label: 'Uptime', value: uptime, aside: ' \u00b7 since last deploy' });
  }
  return rows;
}

/**
 * Whether the card has anything beyond the two commit rows to draw.
 *
 * Used to decide the two-column layout: one column of hashes is a list, and
 * putting it in a grid with an empty half beside it draws attention to the half
 * that is empty.
 */
export function hasDeploymentFacts(app: AppFacts): boolean {
  return deploymentRows(app).length > 0;
}

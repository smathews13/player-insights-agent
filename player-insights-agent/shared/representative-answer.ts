/**
 * The one definition of the representative (offline) answer.
 */
import { DEGRADED_ANSWER_MARKER } from './setup-remedies';

/** Neutral stand-in for the workspace this answer was never actually run against. */
export const REPRESENTATIVE_CATALOG = 'main';
export const REPRESENTATIVE_SCHEMA = 'player_insights';
export const REPRESENTATIVE_TABLE_NAME = 'silver_gameplay_activity';

export const REPRESENTATIVE_FRESHNESS = 'Stored demo snapshot';

/** Fully qualified table this answer's SQL and Sources list refer to. */
export function representativeTable(catalog: string = REPRESENTATIVE_CATALOG,
  schema: string = REPRESENTATIVE_SCHEMA
): string {
  return `${catalog}.${schema}.${REPRESENTATIVE_TABLE_NAME}`;
}

export function buildSources(catalog?: string,
  schema?: string
): { name: string; freshness: string }[] {
  return [
    { name: representativeTable(catalog, schema), freshness: REPRESENTATIVE_FRESHNESS },
    { name: 'Player Insights Data Dictionary Genie', freshness: 'Current demo seed' },
  ];
}

export function buildSql(catalog?: string, schema?: string): string {
  const table = representativeTable(catalog, schema);
  return `WITH latest AS (SELECT max(event_date) AS as_of_date
  FROM ${table}
)
SELECT a.profile_label AS label, a.title_name,
       COUNT(DISTINCT a.player_id) AS active_players_30d
FROM ${table} a
CROSS JOIN latest
WHERE a.brand_scope_status = 'IN_SCOPE'
  AND a.event_date >= date_sub(latest.as_of_date, 29)
GROUP BY a.profile_label, a.title_name
ORDER BY active_players_30d DESC`;
}

export const REPRESENTATIVE_FIGURES = [
  { label: 'Northwind · VLH Online', value: 100, display: '18,942', comparison: '#1' },
  { label: 'Contoso · Hoops 26', value: 59, display: '11,208', comparison: '#2' },
  { label: "Contoso · Dynasty VII", value: 30, display: '5,684', comparison: '#3' },
  { label: 'Northwind · Velocity Heights V', value: 22, display: '4,127', comparison: '#4' },
  { label: 'Northwind · Iron Frontier Reckoning', value: 18, display: '3,395', comparison: '#5' },
];

export const REPRESENTATIVE_TAKEAWAY =
  'VLH Online has the largest 30-day active-player audience in the representative dataset.';

export const REPRESENTATIVE_NARRATIVE =
  'VLH Online reached 18,942 active players over the last 30 days. Hoops 26 followed at 11,208, and Dynasty VII, Velocity Heights V, and Iron Frontier Reckoning fill out the top five across both labels.';

/**
 * A claim about THESE FIGURES, never about the deployment's data.
 *
 * It read "Acme player data in this demo is synthetic", which is a statement
 * about whatever estate the app is deployed against, and on a customer's own
 * account it is both false and alarming: it tells their analysts that their
 * production player data is fabricated, and names them while doing it. The
 * honest claim is the narrow one. The figures on screen are invented, whoever is
 * reading them, and that is what keeps the synthetic badge accurate.
 */
export const REPRESENTATIVE_CAVEATS = [
  'The player figures in this stored answer are synthetic and describe no real players.',
  'Active means an in-scope gameplay session in the latest 30-day window.',
];

/**
 * The line that keeps a canned answer from reading as a live result.
 *
 * Worth saying in the answer itself rather than only in the `mode` badge: the
 * offline answer is complete, confident, and correct-looking, and the data
 * quality one even carries the true current null ratios next to stage timings
 * that were never measured. Somebody reading it has no other way to tell.
 */
export const REPRESENTATIVE_ANSWER_CAVEAT =
  'Representative answer: the figures, SQL, and stage timings shown here come from a stored demo response rather than a live agent query, so no MLflow trace exists for them.';

/**
 * Why the app answered a question with its own stored figures.
 *
 * Two members, because there are two ways the ask route reaches the end of an
 * endpoint call with no live answer to serve, and they send whoever is
 * triaging a bad answer to different places. `endpoint_error` is an
 * operational fault and carries the message it failed with.
 * `unrecognised_response` means the endpoint answered perfectly well and this
 * app could not read what it said, which is the agent and the app having
 * drifted apart: two artifacts released separately, in either order.
 *
 * Distinguishing them matters more than it looks. Both produce the same
 * confident, plausible, entirely invented answer on screen, and a reader
 * cannot tell one from the other, or either from a real result.
 */
export type RepresentativeFallbackReason =
  | { kind: 'endpoint_error'; detail: string }
  | { kind: 'unrecognised_response'; detail: string };

/**
 * The sentence that says a fallback happened, and why.
 *
 * Opens with `DEGRADED_ANSWER_MARKER` so it lands in the caveats the client
 * already lifts out of the list and renders in red above the figures, rather
 * than fifth in a list of five under "What to keep in mind" where the Genie
 * incident proved nobody reads it. See client/src/degraded-answer.ts.
 */
/**
 * The sentence for the half-live answer: the agent's words over the app's numbers.
 *
 * A `DEGRADED_ANSWER_MARKER` caveat like the fallback one above, and for the same
 * reason: this belongs above the figures in red, not fifth under "What to keep in
 * mind". It says which parts are borrowed, which `provenance: 'mixed'` cannot.
 * The marker is what the client keys on; this is what the reader is owed.
 */
export const STORED_FIGURES_CAVEAT =
  `${DEGRADED_ANSWER_MARKER} the agent replied in prose rather than with a result, so the words above ` +
  'are its own but every figure, source, SQL statement and stage timing below is the stored demo ' +
  'response and describes nothing that was queried for this question.';

export function representativeFallbackCaveat(reason: RepresentativeFallbackReason): string {
  const because =
    reason.kind === 'endpoint_error'
      ? `the agent endpoint call failed (${reason.detail})`
      : `the agent endpoint replied with something this app cannot read as an answer (${reason.detail})`;
  return (`${DEGRADED_ANSWER_MARKER} ${because}, so every figure, source, SQL statement and stage ` +
    'timing below is the stored demo response and describes nothing that was run for this question.');
}

/**
 * The Serving endpoint pill, and the drift that has now made it wrong twice.
 *
 * The pill names one probe and the probes are built in another file, with nothing
 * in the type system holding the two together. It has been keyed to a literal
 * twice and been wrong twice, and both times it failed silently, because a `find`
 * that matches nothing is indistinguishable from a probe that did not run:
 *
 *  1. `serving-endpoint`, which is the KIND every endpoint probe is stamped with
 *     and an id no row carries.
 *  2. `llm-endpoint`, which is a real id but is only configured where the
 *     orchestrator's own preflight report is in hand. The health route passes no
 *     report, deliberately, so on a live deployment that id was absent from the
 *     rows and the pill reported an endpoint serving at full traffic as unchecked.
 *
 * The second is why the case below that matters most is `the deployment`: it
 * builds the configuration exactly as `readDependencies` does -- no report, the
 * app's own environment -- and fails if that leaves the pill nothing to read. A
 * test that supplies its own `configured` map, as this file's first version did,
 * proves only that the ids agree with each other, which they did throughout.
 */
import { describe, expect, it } from 'vitest';

import type { DependencyResult, HealthDependency } from '../../shared/ops-contract';
import { resourceStates } from '../lib/app-settings';
import { ANSWER_PATH_ENDPOINT_IDS, connectionSubjects, SERVING_ENDPOINT_KIND } from '../lib/dependency-probes';
import { platformReadings, servingEndpointReading } from './ops-routes';

/** Every endpoint a deployment could configure, so the id set is the probe code's. */
const EVERY_ENDPOINT = {
  'agent-endpoint': 'an-agent',
  'llm-endpoint': 'a-model',
  'llm-gateway': 'a-gateway',
  'judge-endpoint': 'a-judge',
};

function endpointSubjects(configured: Record<string, string>) {
  return connectionSubjects({ configured, tables: [] }).filter(
    (subject) => subject.kind === SERVING_ENDPOINT_KIND
  );
}

/**
 * What the app's own configuration resolves to, the way the health route reads it.
 *
 * `report: null` is not a simplification, it is the route: the health block has
 * no orchestrator report because fetching one would put the slowest read on the
 * page in front of the block that says whether anything is answering.
 */
function asDeployed() {
  const states = resourceStates({
    report: null,
    environment: { DATABRICKS_SERVING_ENDPOINT_NAME: 'player-insights-agent' },
    stored: new Map(),
  });
  return Object.fromEntries(states.map((state) => [state.resource.id, state.configured]));
}

function rows(...pairs: [string, DependencyResult][]): HealthDependency[] {
  return pairs.map(([id, result]) => ({
    id,
    kind: ANSWER_PATH_ENDPOINT_IDS.includes(id) ? SERVING_ENDPOINT_KIND : id,
    connectionsId: id,
    label: id,
    name: 'a-model',
    result,
    lastCheckedAt: '2026-08-16T00:00:00.000Z',
    reason: '',
  }));
}

const pill = (given: HealthDependency[]) => platformReadings(servingEndpointReading(given))[0];
const answerPath = ANSWER_PATH_ENDPOINT_IDS[0];

describe('the endpoints the Ops health pill may speak for', () => {
  it('are all ids the probes emit', () => {
    const emitted = endpointSubjects(EVERY_ENDPOINT).map((subject) => subject.id);
    for (const id of ANSWER_PATH_ENDPOINT_IDS) expect(emitted).toContain(id);
  });

  it('are none of them the kind those probes share, which no row is keyed by', () => {
    expect(ANSWER_PATH_ENDPOINT_IDS).not.toContain(SERVING_ENDPOINT_KIND);
  });

  it('leave out the endpoints that are not on the answer path', () => {
    // The judge is reached only from the Benchmark Lab and a gateway route is
    // unset on most deployments. Neither says whether a question could be
    // answered, so neither may report that one could.
    expect(ANSWER_PATH_ENDPOINT_IDS).not.toContain('judge-endpoint');
    expect(ANSWER_PATH_ENDPOINT_IDS).not.toContain('llm-gateway');
  });

  /**
   * THE CASE THAT WAS FAILING IN PRODUCTION while everything above passed.
   *
   * A deployment configures the orchestrator endpoint through app.yaml and knows
   * nothing else about its endpoints until the orchestrator answers. If the ids
   * the pill accepts and the ids that configuration produces ever stop
   * intersecting, the pill goes back to reporting a healthy endpoint as unchecked
   * and nothing else in the suite notices.
   */
  it('include at least one the deployment actually configures', () => {
    const probed = endpointSubjects(asDeployed()).map((subject) => subject.id);
    expect(probed.some((id) => ANSWER_PATH_ENDPOINT_IDS.includes(id))).toBe(true);
  });

  it('are resolved by kind, so a renamed id cannot silently match nothing', () => {
    // Same id, wrong kind: this row is not an endpoint probe and may not answer
    // for one, however much its id looks like the right one.
    const wrongKind = rows([answerPath, 'answered']).map((row) => ({ ...row, kind: 'sql-warehouse' }));
    expect(pill(wrongKind).read).toBe(false);
  });
});

describe('what the pill then reports', () => {
  it('reports ready from the row that probe produced', () => {
    const reading = pill(rows([answerPath, 'answered']));
    expect(reading.read).toBe(true);
    expect(reading.state).toBe('Ready');
  });

  it('reports a refusal as a refusal', () => {
    const reading = pill(rows([answerPath, 'did-not-answer']));
    expect(reading.read).toBe(true);
    expect(reading.state).toBe('Did not answer');
  });

  it('lets one endpoint that did not answer outrank another that did', () => {
    // A question travels through all of them, so any one of them failing is a
    // question that could not be served whatever the others say.
    const mixed = ANSWER_PATH_ENDPOINT_IDS.length > 1
      ? rows([ANSWER_PATH_ENDPOINT_IDS[0], 'answered'], [ANSWER_PATH_ENDPOINT_IDS[1], 'did-not-answer'])
      : rows([answerPath, 'did-not-answer']);
    expect(pill(mixed).state).toBe('Did not answer');
  });

  // The two ways nothing was established. Neither may borrow another probe's
  // verdict: a warehouse that answered says nothing about the endpoint, and a
  // probe that did not run says nothing about anything.
  it('reports unchecked when no probe answered for the endpoint', () => {
    expect(pill(rows(['sql-warehouse', 'answered'])).read).toBe(false);
  });

  it('reports unchecked when the endpoint probe did not run', () => {
    expect(pill(rows([answerPath, 'not-checked'])).read).toBe(false);
  });

  it('states no endpoint state at all when it read none', () => {
    // The pill printed a sentence of its own provenance here, and for an unread
    // endpoint that sentence was on screen for weeks explaining a bug.
    expect(pill(rows([answerPath, 'not-checked']))).toEqual({
      id: 'endpoint',
      label: 'Serving endpoint',
      state: '',
      read: false,
      // The row it looked at, even though the row had nothing to report: the
      // table draws the reading in that row's Result cell either way, and a
      // reading that named no row would be drawn as a resource of its own.
      rows: [answerPath],
      reason: '',
    });
  });
});

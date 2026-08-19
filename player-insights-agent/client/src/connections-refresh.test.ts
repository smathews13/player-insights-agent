import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readingsById, readConnections, type SettingsPayload } from './connection-model';
import { CONNECTION_STATUS_LABEL, connectionNote } from './connection-status';
import { checksHeadline, countPreflightChecks, type PreflightCheck } from './preflight';
import { partial } from './styles/stylesheet';
import { connectedResource } from '../../shared/deployment-config';

/**
 * The two complaints this page came back with, held apart so neither fix can
 * quietly undo the other.
 *
 * The first was that a page promising to report "whether it can reach each one"
 * answered `Not checked` down almost its whole length, because the orchestrator
 * retired its dependency report and nothing took the job over. The second was
 * that the Refresh button appeairon frontier: it had no pending state, and on a
 * healthy deployment every answer comes back identical, so pressing it changed
 * nothing a person could see.
 *
 * What is asserted here is the READING and the CONTROL, not the probes -- the
 * classifier has its own tests next to it, and the point of these is that an
 * answer the workspace gave reaches the badge, the diagram and the headline
 * without any of the three interpreting it privately.
 *
 * Read against source for the parts a browser would otherwise have to confirm,
 * in the pattern architecture-coupling.test.ts established: this repo has no
 * jsdom, and the claims that genuinely need one are named in the handover
 * rather than asserted as though they had been.
 */

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

const PAGE = source('ConnectionsPage.tsx');
const CSS = partial('connections.css');

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
  } as PreflightCheck;
}

function row(id: string, configured: string) {
  return {
    resource: connectedResource(id)!,
    configured,
    configuredFrom: 'artifact',
    actual: '',
    actualObserved: false,
    intended: null,
    intendedAt: '',
    intendedBy: '',
    editable: false,
    changedByLabel: '',
    changedByNote: '',
  };
}

/** A payload in the shape the live deployment answers with today. */
function payload(over: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    resources: [
      row('sql-warehouse', 'wh-0001'),
      row('genie-data', 'space-data'),
      row('catalog', 'a_catalog'),
      row('schema', 'a_schema'),
      row('declared-manifest', ''),
      row('judge-endpoint', 'a-judge'),
      row('llm-gateway', ''),
    ],
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

function statusOf(id: string, checks: PreflightCheck[], reported: PreflightCheck[] = []): string {
  return readingsById(readConnections(payload({ checks }), reported)).get(id)!.status;
}

describe('an answer from the workspace reaches the row that was asking', () => {
  /**
   * THE COMPLAINT, in one assertion.
   *
   * `catalog` has no `actualFromCheck` -- no orchestrator check ever named it --
   * so before the app started asking, its row showed a value from the model
   * artifact beside "Not measured", forever, on a deployment where the catalog
   * was perfectly reachable.
   */
  it('stops saying Not checked about a resource the app asked the workspace about', () => {
    expect(statusOf('catalog', [])).toBe('not-checked');
    expect(statusOf('catalog', [check('catalog', 'ok')])).toBe('reachable');
    expect(CONNECTION_STATUS_LABEL.reachable).toBe('Reachable');
  });

  // A refusal is a fact about this identity, and it is a different fact from an
  // absence. Both are `blocked` on the badge and they are told apart in the
  // sentence under it, which is why the sentence is the check's own.
  it('badges a refusal as blocked and says whose refusal it was', () => {
    const refused = check('schema', 'failed', {
      detail: 'The workspace refused this identity as someone@example.com: HTTP 403 PERMISSION_DENIED.',
    });
    expect(statusOf('schema', [refused])).toBe('blocked');
    expect(connectionNote({ check: refused, status: 'blocked' })).toContain('403');
    expect(connectionNote({ check: refused, status: 'blocked' })).toContain('someone@example.com');
  });

  it('badges a thing that is not there as blocked, and says it is missing rather than forbidden', () => {
    const missing = check('genie-data', 'failed', {
      detail: 'The workspace has no such object: HTTP 404. This is missing rather than forbidden.',
    });
    expect(statusOf('genie-data', [missing])).toBe('blocked');
    expect(connectionNote({ check: missing, status: 'blocked' })).toMatch(/missing rather than forbidden/);
  });

  // The whole reason `unverified` exists. A probe that timed out established
  // nothing, and rendering nothing-established as either health or fault is the
  // dishonesty this page is built to refuse. `Unreachable` rather than
  // `Not checked`, because the next move differs: something in the path is down
  // and is worth retrying, where nothing was asked of a row nobody checked.
  it('leaves a probe that never got an answer reading as unreachable, not as broken', () => {
    const timedOut = check('sql-warehouse', 'unverified', {
      detail: 'The workspace did not answer within 15000 ms, so whether this identity can reach it is unknown.',
      stopped: 'unreachable',
    });
    expect(statusOf('sql-warehouse', [timedOut])).toBe('unreachable');
    expect(connectionNote({ check: timedOut, status: 'unreachable' })).toMatch(/unknown/);
  });

  /**
   * A deployment in exactly the shape its bundle asked for must not read as
   * broken. `llm_gateway` is unset on every target by design, so nothing probes
   * it, and the row keeps saying what it always said.
   */
  it('reports a resource nothing is configured for as unchecked rather than as a failure', () => {
    const reading = readingsById(readConnections(payload({ checks: [check('catalog', 'ok')] }), []))
      .get('llm-gateway')!;
    expect(reading.check).toBeUndefined();
    expect(reading.status).not.toBe('blocked');
    expect(reading.row.configured).toBe('');
  });

  // Twelve table probes are twelve rows in the matrix and one row in the list.
  // The summary is derived from the twelve rather than probed on its own, so it
  // cannot say something the rows it stands for do not.
  it('fills the Declared tables row from the summary the probes rolled up', () => {
    expect(statusOf('declared-manifest', [])).toBe('not-checked');
    expect(statusOf('declared-manifest', [check('declared-manifest', 'ok', { kind: 'manifest' })])).toBe(
      'reachable',
    );
  });

  /**
   * The one the app owns end to end. It has no orchestrator key and no named
   * check, so the page called it "Nothing to reach" -- correct while nobody
   * could ask about it, and wrong the moment somebody could: it is a serving
   * endpoint the signed-in user either can or cannot see. Configured and
   * unanswered is now `Not checked`, which is the honest word for a probe that
   * could run and has not.
   */
  it('waits for an answer about a value the app applies itself, rather than excusing it', () => {
    expect(statusOf('judge-endpoint', [])).toBe('not-checked');
    expect(statusOf('judge-endpoint', [check('judge-endpoint', 'failed')])).toBe('blocked');
  });

  /**
   * Both halves can answer about one resource, and they answer different
   * questions: the orchestrator watched what was USED, the app asked whether
   * what is CONFIGURED can be reached. Where both exist the first is the more
   * specific claim, so it wins -- and it has to win by construction, because the
   * two disagreeing is exactly the fault this page was built to expose.
   */
  it('prefers what the orchestrator observed over what the app could reach', () => {
    const observed = check('sql-warehouse', 'failed', { name: 'a-different-warehouse' });
    const probed = check('sql-warehouse', 'ok', { name: 'wh-0001' });
    expect(statusOf('sql-warehouse', [probed], [observed])).toBe('blocked');
    const reading = readingsById(readConnections(payload({ checks: [probed] }), [observed])).get('sql-warehouse')!;
    expect(reading.check?.name).toBe('a-different-warehouse');
  });

  /**
   * The diagram and the list read one derivation, so a new source of checks
   * either reaches both or neither. Asserted through `readConnections`, which is
   * the single entry point both surfaces call: if the app's checks were merged
   * in the page instead, this would still pass on Connections and the
   * Architecture tab would quietly keep saying `Not checked`.
   */
  it('gives the Architecture diagram the same answers, because it is the same reading', () => {
    const checks = [check('catalog', 'ok'), check('genie-data', 'failed')];
    const fromModel = readingsById(readConnections(payload({ checks }), []));
    expect(fromModel.get('catalog')!.status).toBe('reachable');
    expect(fromModel.get('genie-data')!.status).toBe('blocked');
    // And the page cannot have reached them any other way.
    expect(PAGE).toMatch(/allChecks\(payload, reported\)/);
    expect(PAGE).not.toMatch(/payload\?\.checks\b(?!\s*\?\?)/);
  });
});

describe('the headline counts what was actually asked', () => {
  // The orchestrator's own `counts` describe its two checks. Read from those,
  // the header said "Every dependency is reachable" over a list of twenty rows
  // it knew nothing about.
  it('summarises every check the page holds rather than the report’s own tally', () => {
    const checks = [check('catalog', 'ok'), check('schema', 'ok'), check('genie-data', 'failed')];
    expect(checksHeadline(checks)).toBe('1 of 3 dependencies are blocked');
    expect(countPreflightChecks(checks)).toEqual({ ok: 2, failed: 1, unverified: 0 });
  });

  // A check that did not run is not a check that passed, and this is the rung
  // where that is easiest to lose.
  it('never says everything is reachable while anything is unresolved', () => {
    expect(checksHeadline([check('catalog', 'ok'), check('schema', 'unverified')])).toBe(
      'Some dependencies could not be checked',
    );
    expect(checksHeadline([check('catalog', 'ok')])).toBe('Every dependency is reachable');
    expect(checksHeadline([])).toBe('No dependency check answered');
  });

  /**
   * STRENGTHENED, and the reason is worth recording because the assertion that
   * used to be here passed while the screen was wrong.
   *
   * It required the page to summarise `checks` rather than the report's own
   * `counts`, which fixed a real defect: the orchestrator's tally described its
   * own two checks and the header read "Every dependency is reachable" over
   * twenty rows it knew nothing about. But `checks` is still not the population
   * on screen. Against the live payload there are 24 checks -- twelve of them
   * individual tables that the list draws as ONE "Declared tables" row -- and 19
   * connection rows, four of which nothing probed. So the line rendered "24
   * reachable · 0 blocked · 0 not checked" directly above four rows badged "Not
   * checked" and four badged "Nothing to reach", and the old assertion was
   * satisfied by exactly that.
   *
   * The rule now is the one a reader can hold the page to: the counts describe
   * the ROWS, and their parts sum to the number of rows drawn. `checksHeadline`
   * is kept for the case where there is no settings payload, because then there
   * are no rows and the checks are all there is to report.
   */
  it('summarises the rows a reader can count rather than the checks behind them', () => {
    expect(PAGE).toMatch(/connectionsHeadline\(counts\)/);
    expect(PAGE).toMatch(/checksHeadline\(checks\)/);
    // The counts line must not be able to reach the check tally at all: leaving
    // that derivation in scope is how the two populations got mixed once already.
    expect(PAGE).not.toMatch(/countPreflightChecks/);
    // One derivation of the readings, and the counts taken off it. The sections
    // are taken off the same `readings`, which is what makes the count line and
    // the list below it arithmetically the same population rather than two that
    // agree by inspection.
    expect(PAGE).toMatch(/readConnections\(payload, reported\)/);
    expect(PAGE).toMatch(/countConnections\(readings\)/);
    expect(PAGE).toMatch(/groupConnections\(readings\)/);
  });
});

describe('the Refresh button, which used to look wired to nothing', () => {
  /**
   * The word, the icon, the disabled attribute and the spinner are the shared
   * control's now, and refresh-control.test.tsx renders it to assert them. What
   * is this page's business is that both of its controls are that component and
   * that they are told when a read is in flight.
   */
  it('draws both of its controls from the shared component', () => {
    expect(PAGE).toMatch(/import \{ RefreshButton, RefreshControl \} from '\.\/RefreshControl'/);
    expect(PAGE).toMatch(/<RefreshControl busy=\{refreshing\}/);
    expect(PAGE).toMatch(/<RefreshButton busy=\{refreshing\}/);
    // Nothing hand-rolled left: an icon and a label written here again is how
    // the header and the alert came to say different words for one action.
    expect(PAGE).not.toMatch(/RefreshCw/);
    expect([...PAGE.matchAll(/busy=\{refreshing\}/g)]).toHaveLength(2);
  });

  /**
   * The pending state is no longer this page's to hold, and that is the fix
   * rather than a loss of coverage.
   *
   * It used to run the two reads itself and flip its own `refreshing` flag around
   * them. Both reads now belong to `session-checks.ts`, which owns the in-flight
   * flag for the session -- so the busy state is correct on THIS page while the
   * OTHER page's automatic run is still landing, which is a state the old
   * per-page flag could not represent at all. The awaiting, the single-flight
   * guard and the failure handling are exercised for real in
   * session-checks.test.ts, by counting fetches, instead of by matching source
   * here.
   */
  it('takes its busy state from the run rather than from a flag of its own', () => {
    expect(PAGE).toMatch(/running: refreshing/);
    expect(PAGE).not.toMatch(/setRefreshing\(/);
  });

  /**
   * The thing that makes an unchanged answer visibly a fresh one.
   *
   * On a healthy deployment every verdict comes back identical, so without a
   * time on screen the only evidence the press did anything is that nothing
   * changed -- which is indistinguishable from a dead control, and is what it
   * was taken for.
   */
  it('hands each freshness surface the same time without restoring the old summary line', () => {
    expect(PAGE).toMatch(/checkedAt=\{lastCheckedAt\}/);
    // The settings stamp first: it is the response the workspace probes are
    // computed in, and the orchestrator's own is routinely empty on a version
    // that reports its configuration and runs no checks.
    expect(PAGE).toMatch(/payload\?\.checkedAt \|\| report\?\.checked_at/);
    // It is not printed in the old status summary. The same value now also
    // reaches restored-session copy and the declared-table evidence, so pin the
    // complete set of consumers rather than treating those uses as duplicate
    // top-level timestamps.
    expect(PAGE).not.toMatch(/Checked \$\{formatCheckedAt\(lastCheckedAt\)\}/);
    expect([...PAGE.matchAll(/lastCheckedAt/g)]).toHaveLength(4);
    expect(PAGE).toMatch(/restoredNotice\(lastCheckedAt, now\)/);
    expect(PAGE).toMatch(/<DeclaredTablesTable[^>]*checkedAt=\{lastCheckedAt\}/);
  });

  /**
   * A row is not fresh because the page is still on screen. While the workspace
   * is being asked again, a badge from the previous answer is a reading of a
   * moment that has passed, and showing it unchanged is how a working button
   * came to look like a broken one.
   */
  it('says which rows are being re-decided instead of showing stale verdicts as current', () => {
    expect(PAGE).toMatch(/refreshing=\{refreshing\}/);
    expect(PAGE).toMatch(/const restating = refreshing && status !== 'nothing-to-reach'/);
    expect(PAGE).toMatch(/restating \? 'Refreshing\\u2026'/);
    expect(PAGE).toMatch(/data-refreshing=\{restating \? 'true' : undefined\}/);
    expect(CSS).toMatch(/\.connection-row\[data-refreshing='true'\]/);
  });

  // A row with no remote end cannot be re-decided, and promising it an answer
  // that is never coming is a second way of lying about what was checked.
  it('does not promise a fresh answer for a row nothing can answer about', () => {
    expect(PAGE).toMatch(/status !== 'nothing-to-reach'/);
  });

  /**
   * A failed refresh has to leave the failure on screen. The run never rejects --
   * it records what could not be read into the session's own `error` -- which is
   * what lets this page render one problem list without guarding a throw.
   */
  it('leaves the old data up under an explanation when a refresh fails', () => {
    expect(PAGE).toMatch(/const problems = \[checkError\]\.filter\(Boolean\)/);
    expect(PAGE).toMatch(/const checkError = session\?\.error/);
  });

  /**
   * The other half of it: a reader has to be told when what they are looking at
   * was not produced by this visit.
   *
   * Now that the checks run themselves once, a restored page and a freshly-checked
   * one are the same pixels on every visit after the first -- which is the state
   * the Architecture tab was already in, so this page says it in the same words,
   * from the same module, rather than inventing a second sentence for it.
   */
  it('says when the results were restored rather than run in this visit', () => {
    expect(PAGE).toMatch(/restored \? restoredNotice\(lastCheckedAt, now\)/);
    expect(PAGE).toMatch(/data-testid="connections-restored"/);
  });
});

describe('what the page must keep refusing to claim', () => {
  /**
   * The green tick is the dangerous one, and the refusal is now carried by the
   * VALUE rather than by a paragraph next to it. The prose that used to qualify
   * a pass -- that a metadata read is not a read of the data, and that row
   * filters and column masks are applied somewhere this never looked -- is gone
   * from the tab. What must not go with it is the distinction it was qualifying:
   * a row that nothing measured says so, in its own words, instead of showing
   * the configured value as though something had confirmed it.
   */
  it('never shows an unmeasured value as though something had confirmed it', () => {
    expect(PAGE).toMatch(/Not measured/);
    expect(PAGE).toMatch(/Nothing to measure it against/);
    expect(PAGE).toMatch(/row\.actualObserved \?/);
    // The one word this tile must never reach for on an absence of evidence.
    expect(PAGE).not.toMatch(/'matches'/);
  });

  it('keeps the check’s own sentence rather than a summary of it', () => {
    // `connectionNote` prefers the workspace's words and falls back to the
    // generic note only where there are none, so a status vocabulary shared with
    // the matrix cannot flatten twenty different answers into four.
    expect(connectionNote({ check: check('catalog', 'ok', { detail: 'The workspace answered.' }), status: 'reachable' }))
      .toBe('The workspace answered.');
    expect(connectionNote({ check: null, status: 'not-checked' }).length).toBeGreaterThan(0);
    // On the page it is the FAILURE that carries them now, verbatim: the tile
    // beside it used to print the same sentence on a pass, where its tail was
    // the clause about what the pass did not prove and nothing else.
    expect(PAGE).toMatch(/\{check\.error \|\| check\.detail\}/);
  });
});

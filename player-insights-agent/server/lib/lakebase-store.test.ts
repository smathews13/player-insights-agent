import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import {
  chooseRows,
  isLakebaseUnavailable,
  lakebaseHealth,
  lakebaseStorageCheck,
  markResponse,
  noSubstitution,
  readStored,
  resetLakebaseHealth,
  startLakebaseWatchdog,
  stopLakebaseWatchdog,
  WATCHDOG_PROBE_SQL,
  type LakebaseReader,
} from './lakebase-store';

/** A reader whose every call is scripted, so retries are countable. */
function reader(...outcomes: (Record<string, unknown>[] | Error)[]): LakebaseReader & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    lakebase: {
      query() {
        const outcome = outcomes[state.calls] ?? outcomes[outcomes.length - 1];
        state.calls += 1;
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve({ rows: outcome });
      },
    },
  };
}

/**
 * A reader that answers by SQL and keeps what it was asked.
 *
 * The watchdog cases turn on *what* was read, not how many times: a store that
 * refuses schema reads while answering `SELECT 1` is the whole grant-loss
 * scenario, and it cannot be expressed by a reader that treats every query the
 * same.
 */
function schemaReader(answer: (sql: string) => Record<string, unknown>[] | Error): LakebaseReader & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    lakebase: {
      query(text: string) {
        seen.push(text);
        const outcome = answer(text);
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve({ rows: outcome });
      },
    },
  };
}

/** What a lost grant on the app's schema actually looks like. */
function permissionDenied() {
  return pgError('permission denied for table conversations', '42501');
}

/**
 * A store the app can connect to but no longer read.
 *
 * The asymmetry is the whole point and has to be modelled honestly: `SELECT 1`
 * needs no privileges, so Postgres answers it happily while every read of
 * `player_insights` raises 42501. A stub that refused both would let a
 * `SELECT 1` watchdog look just as good as a real one, and the test would pass
 * whether or not the fix existed.
 */
function grantsRevoked() {
  return schemaReader((sql) => (/player_insights\./i.test(sql) ? permissionDenied() : [{ '?column?': 1 }]));
}

function pgError(message: string, code?: string) {
  const error = new Error(message) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

function headerSink() {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (name: string, value: string) => void (headers[name] = value) };
}

let errors: string[];
let warnings: string[];

beforeEach(() => {
  resetLakebaseHealth();
  errors = [];
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args.join(' ')));
});

afterEach(() => {
  // Before the timers go back to real ones, so the handle being cleared is the
  // same kind of handle that created it.
  stopLakebaseWatchdog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readStored', () => {
  it('reports rows and marks the store healthy', async () => {
    const client = reader([{ id: 'msg-1' }]);
    const read = await readStored(client, 'GET /api/runs', 'SELECT 1');

    expect(read).toEqual({ available: true, rows: [{ id: 'msg-1' }] });
    expect(lakebaseHealth().state).toBe('ok');
    expect(errors).toEqual([]);
  });

  it('distinguishes an empty store from an unreachable one', async () => {
    const client = reader([]);
    const read = await readStored(client, 'GET /api/runs', 'SELECT 1');

    // The whole point: zero rows is a successful read, not an outage. The old
    // helper collapsed the two and that is how fabricated rows reached the page.
    expect(read).toEqual({ available: true, rows: [] });
    expect(isLakebaseUnavailable()).toBe(false);
  });

  it('shouts once when the store goes away, with the code and the route', async () => {
    const client = reader(pgError('password authentication failed for user "app"', '28P01'));
    const read = await readStored(client, 'GET /api/runs', 'SELECT 1');

    expect(read.available).toBe(false);
    expect(isLakebaseUnavailable()).toBe(true);
    const shout = errors.find((line) => line.includes('STORAGE UNAVAILABLE'));
    expect(shout).toBeDefined();
    expect(shout).toContain('GET /api/runs');
    expect(shout).toContain('28P01');
    expect(shout).toContain('password authentication failed');
  });

  it('retries a stale connection once and recovers without degrading', async () => {
    // Exactly the shape of an expired Lakebase credential on a pooled
    // connection: the first use fails, and a fresh connection mints a new one.
    const client = reader(pgError('Connection terminated unexpectedly'), [{ id: 'msg-1' }]);
    const read = await readStored(client, 'GET /api/runs', 'SELECT 1');

    expect(read).toEqual({ available: true, rows: [{ id: 'msg-1' }] });
    expect(client.calls).toBe(2);
    expect(isLakebaseUnavailable()).toBe(false);
    expect(warnings.some((line) => line.includes('succeeded on retry'))).toBe(true);
  });

  it('does not retry an error that a second attempt cannot change', async () => {
    const client = reader(pgError('syntax error at or near "SELEC"', '42601'));
    await readStored(client, 'GET /api/runs', 'SELEC 1');

    expect(client.calls).toBe(1);
  });

  it('records the recovery, and what the responses meanwhile had said', async () => {
    const down = reader(pgError('Connection terminated unexpectedly'), pgError('Connection terminated unexpectedly'));
    const read = await readStored(down, 'GET /api/runs', 'SELECT 1');
    chooseRows('GET /api/runs', read);

    await readStored(reader([{ id: 'msg-1' }]), 'GET /api/runs', 'SELECT 1');

    const recovery = warnings.find((line) => line.includes('RECOVERED'));
    expect(recovery).toBeDefined();
    expect(recovery).toContain('declared itself unavailable rather than carrying rows');
    expect(lakebaseHealth().state).toBe('ok');
  });
});

describe('chooseRows', () => {
  it('serves nothing and names the outage when the store is unreachable', () => {
    const chosen = chooseRows('GET /api/runs', {
      available: false,
      error: 'Connection terminated unexpectedly',
      code: '08006',
    });

    expect(chosen.rows).toEqual([]);
    expect(chosen.substitution).toEqual({ reason: 'storage_unavailable', origin: 'none' });
    const shout = errors.find((line) => line.includes('NO ROWS SERVED'));
    expect(shout).toContain('NOT a report that the store holds nothing');
    expect(shout).toContain('08006');
  });

  it('reports a store that answered and held nothing as a store that answered', () => {
    const chosen = chooseRows('GET /api/runs', { available: true, rows: [] });

    expect(chosen.substitution).toEqual({ reason: null, origin: 'lakebase' });
    // This is the case the old code could not log at all, because nothing threw.
    const line = warnings.find((entry) => entry.includes('STORE EMPTY'));
    expect(line).toBeDefined();
    // The remedies are opposites, so the message must not read as an outage.
    // Saying "unavailable" here is what cost hours of chasing a live connection.
    expect(line).toContain('Lakebase is reachable');
    expect(line).toContain('asking a question populates it');
    expect(errors).toEqual([]);
  });

  it('does not call an empty store unavailable', () => {
    chooseRows('GET /api/runs', { available: true, rows: [] });

    const health = lakebaseHealth();
    expect(health.content).toBe('empty');
    expect(health.empty_routes).toEqual(['GET /api/runs']);
    // Reachability and emptiness are tracked apart, and only reads set state.
    expect(health.state).not.toBe('unavailable');
  });

  it('announces an empty store once, not on every request', () => {
    for (let i = 0; i < 5; i += 1) {
      chooseRows('GET /api/runs', { available: true, rows: [] });
    }

    // A steady state logged per request buries the transitions worth reading.
    expect(warnings.filter((line) => line.includes('STORE EMPTY'))).toHaveLength(1);
  });

  it('notices when an empty store starts holding records again', () => {
    chooseRows('GET /api/runs', { available: true, rows: [] });
    chooseRows('GET /api/runs', { available: true, rows: [{ id: 'msg-1' }] });

    expect(warnings.some((line) => line.includes('no longer empty'))).toBe(true);
    expect(lakebaseHealth().content).toBe('populated');
  });

  it('is not empty overall while any route still returns records', () => {
    chooseRows('GET /api/conversations', { available: true, rows: [] });
    chooseRows('GET /api/runs', { available: true, rows: [{ id: 'msg-1' }] });

    const health = lakebaseHealth();
    expect(health.content).toBe('populated');
    expect(health.empty_routes).toEqual(['GET /api/conversations']);
  });

  it('says nothing at all when rows are stored', () => {
    const chosen = chooseRows('GET /api/runs', { available: true, rows: [{ id: 'msg-1' }] });

    expect(chosen.rows).toEqual([{ id: 'msg-1' }]);
    expect(chosen.substitution).toEqual({ reason: null, origin: 'lakebase' });
    expect([...errors, ...warnings]).toEqual([]);
  });
});

/**
 * The only posture there is: no seeded row can reach a response.
 *
 * There is no longer a demo mode to contrast this with. Both an unreadable store
 * and an empty one produce an empty list, and these are the assertions that keep
 * the two from becoming the same claim about it.
 */
describe('an unreadable store against a store that holds nothing', () => {
  it('answers an unreadable store with nothing, and says so', () => {
    const chosen = chooseRows('GET /api/runs', { available: false, error: 'down', code: '08006' });

    expect(chosen.rows).toEqual([]);
    expect(chosen.substitution).toEqual({ reason: 'storage_unavailable', origin: 'none' });
  });

  it('does not let that empty response read as a store that holds nothing', () => {
    const res = headerSink();
    const chosen = chooseRows('GET /api/runs', { available: false, error: 'down', code: '08006' });
    markResponse(res, chosen.substitution);

    // The two facts a client needs to tell this apart from a genuinely empty
    // store, which returns exactly the same body.
    expect(res.headers['X-PIA-Data-Origin']).toBe('none');
    expect(res.headers['X-PIA-Degraded-Reason']).toBe('storage_unavailable');
  });

  it('says in the log that the empty response is not a report of an empty store', () => {
    chooseRows('GET /api/runs', { available: false, error: 'down', code: '08006' });

    const line = errors.find((entry) => entry.includes('NO ROWS SERVED'));
    expect(line).toContain('NOT a report that the store holds nothing');
  });

  it('answers a genuinely empty store as a store that answered', () => {
    const chosen = chooseRows('GET /api/runs', { available: true, rows: [] });

    // The state this must not collapse into "unavailable". Nothing is wrong, the
    // read succeeded, and badging it degraded would teach a reader to discount
    // the badge on the responses that are.
    expect(chosen.rows).toEqual([]);
    expect(chosen.substitution).toEqual({ reason: null, origin: 'lakebase' });
    expect(lakebaseHealth().content).toBe('empty');
  });

  it('still returns stored rows unchanged', () => {
    const chosen = chooseRows('GET /api/runs', { available: true, rows: [{ id: 'msg-1' }] });

    expect(chosen.rows).toEqual([{ id: 'msg-1' }]);
    expect(chosen.substitution.origin).toBe('lakebase');
  });
});

describe('markResponse', () => {
  it('labels a response nobody could fill so the browser can too', () => {
    const res = headerSink();
    markResponse(res, { reason: 'storage_unavailable', origin: 'none' });

    expect(res.headers['X-PIA-Data-Origin']).toBe('none');
    expect(res.headers['X-PIA-Degraded-Reason']).toBe('storage_unavailable');
  });

  it('labels a stored response as stored', () => {
    const res = headerSink();
    markResponse(res, noSubstitution());

    expect(res.headers['X-PIA-Data-Origin']).toBe('lakebase');
    expect(res.headers['X-PIA-Degraded-Reason']).toBeUndefined();
  });
});

describe('lakebaseStorageCheck', () => {
  it('reports an unread store as unverified rather than healthy', () => {
    expect(lakebaseStorageCheck().status).toBe('unverified');
  });

  it('reports an unreachable store as failed, never as "not checked"', async () => {
    await readStored(reader(pgError('Connection terminated unexpectedly', '08006')), 'GET /api/runs', 'SELECT 1');
    const check = lakebaseStorageCheck();

    // The Sources page said "Not checked" during a live outage. A check that
    // ran and failed must say failed, or the page reassures about an outage.
    expect(check.status).toBe('failed');
    expect(check.id).toBe('lakebase-storage');
    // Used to assert the detail said seeded rows were on screen. They are not:
    // an unreadable store is now answered with nothing, so the detail says what
    // the reader will actually find, which is empty lists that declare
    // themselves unavailable.
    expect(check.detail).toContain('cannot be listed');
    expect(check.remedy?.kind).toBe('cli');
  });

  it('reports a healthy store as ok', async () => {
    const read = await readStored(reader([{ id: 'msg-1' }]), 'GET /api/runs', 'SELECT 1');
    chooseRows('GET /api/runs', read);

    const check = lakebaseStorageCheck();
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('returned stored records');
    expect(check.remedy).toBeNull();
  });

  it('does not claim stored records exist before anything has read one', async () => {
    // The state the watchdog leaves behind a minute after boot, with nobody
    // having opened a page: the store answers, and what it holds is still an
    // open question. Reported as "it returned stored records" until this was
    // fixed, because `unknown` shared a branch with `populated`.
    vi.useFakeTimers();
    startLakebaseWatchdog(schemaReader(() => [{ conversations: null, messages: null, benchmark_runs: null }]),
      60_000
    );
    await vi.advanceTimersByTimeAsync(60_000);

    const check = lakebaseStorageCheck();
    expect(lakebaseHealth().content).toBe('unknown');
    // Still `ok`: the connection was genuinely verified, and that is worth
    // saying. It is the claim about content that was never checked.
    expect(check.status).toBe('ok');
    expect(check.detail).not.toContain('returned stored records');
    expect(check.detail).not.toContain('holds no stored records');
    expect(check.detail).toContain('not known');
  });

  it('reports a reachable but empty store as ok, and says it is empty rather than broken', async () => {
    const read = await readStored(reader([]), 'GET /api/runs', 'SELECT 1');
    chooseRows('GET /api/runs', read);

    const check = lakebaseStorageCheck();
    // Not `failed`: nothing is broken, and crying wolf here teaches people to
    // skip the row. The distinction lives in the words, which is what someone
    // reads when they are working out why the figures look invented.
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('holds no stored records');
    expect(check.detail).toContain('connection is healthy');
    expect(check.detail).toContain('is not a fault');
    // "An empty database, not a broken one" was the remedy's note. The three
    // assertions above are that same claim, made in `detail`, where the reader
    // meets it: the row is `ok`, so there is nothing here to act on and nothing
    // for a line under the statement to keep them from getting wrong.
    expect(check.remedy?.guidance).toBe('');
  });
});

describe('the watchdog probe', () => {
  it('reads through the app schema, so it needs the privileges a real read needs', () => {
    // A `SELECT 1` passes on a connection that cannot read a single table, and
    // a probe that cannot fail the way the app fails is not a probe.
    expect(WATCHDOG_PROBE_SQL).toMatch(new RegExp(`${APP_SCHEMA}\\.`));
  });

  it('names only tables the app actually creates', () => {
    // The probe is a fourth place that knows the schema, and a table renamed in
    // the DDL would otherwise turn every tick into a false outage. Checked
    // against the source rather than a copy of it. DDL uses ${APP_SCHEMA}.table.
    const ddl = readFileSync(new URL('../routes/insights-routes.ts', import.meta.url), 'utf8');
    const created = [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS \$\{APP_SCHEMA\}\.(\w+)/g)].map(
      (match) => match[1],
    );
    const probed = [...WATCHDOG_PROBE_SQL.matchAll(new RegExp(`${APP_SCHEMA}\\.(\\w+)`, 'g'))].map(
      (match) => match[1],
    );

    expect(probed.length).toBeGreaterThan(0);
    expect(created).toEqual(expect.arrayContaining(probed));
  });

  it('keeps failing while the app has lost its grants, instead of flapping', async () => {
    // The scenario the storage check's own remedy points at, and the one a
    // `SELECT 1` probe could not see: it recovered on every tick, so the log
    // alternated STORAGE UNAVAILABLE and RECOVERED a minute apart and read as
    // an intermittent network fault rather than a permanent permissions
    // problem. The banner alternated with it.
    vi.useFakeTimers();
    const client = grantsRevoked();
    startLakebaseWatchdog(client, 60_000);

    // Discovered by a page load first, as it would be in production.
    const read = await readStored(client, 'GET /api/runs', 'SELECT id FROM player_insights.messages');
    chooseRows('GET /api/runs', read);
    chooseRows('GET /api/conversations', read);
    expect(isLakebaseUnavailable()).toBe(true);

    await vi.advanceTimersByTimeAsync(180_000);

    expect(isLakebaseUnavailable()).toBe(true);
    expect(warnings.filter((line) => line.includes('RECOVERED'))).toEqual([]);
    // Announced once, then counted, not shouted afresh every minute.
    expect(errors.filter((line) => line.includes('STORAGE UNAVAILABLE'))).toHaveLength(1);
    // Every tick asked something that needed the lost privilege. 42501 is not
    // retryable, so the probe does not double the load while it does it.
    expect(client.seen.filter((sql) => sql.includes('player_insights.'))).toHaveLength(4);
  });

  it('reports recovery once the schema read itself succeeds again', async () => {
    vi.useFakeTimers();
    let granted = false;
    startLakebaseWatchdog(schemaReader((sql) => {
        if (!sql.includes('player_insights.')) return [{ '?column?': 1 }];
        return granted ? [{ conversations: 1 }] : permissionDenied();
      }),
      60_000
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(isLakebaseUnavailable()).toBe(true);
    granted = true;
    await vi.advanceTimersByTimeAsync(60_000);

    // Not a refusal to ever recover. The evidence just has to be the read that
    // was failing, not one that never needed the privilege.
    expect(lakebaseHealth().state).toBe('ok');
    expect(warnings.some((line) => line.includes('RECOVERED'))).toBe(true);
  });

  it('replaces a running watchdog rather than stacking another timer on it', async () => {
    vi.useFakeTimers();
    const first = schemaReader(() => []);
    const second = schemaReader(() => []);
    startLakebaseWatchdog(first, 60_000);
    startLakebaseWatchdog(second, 60_000);

    await vi.advanceTimersByTimeAsync(60_000);

    // Every test that booted the app used to leave another timer behind, each
    // one probing a stub from a finished case.
    expect(first.seen).toEqual([]);
    expect(second.seen).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops on request, without the caller having kept the handle', async () => {
    vi.useFakeTimers();
    const client = schemaReader(() => []);
    startLakebaseWatchdog(client, 60_000);

    stopLakebaseWatchdog();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(client.seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('what counts as evidence of recovery', () => {
  it('does not let a bare connection check end an outage a schema read caused', async () => {
    const failing = await readStored(schemaReader(() => permissionDenied()),
      'GET /api/runs',
      'SELECT id FROM player_insights.messages'
    );
    chooseRows('GET /api/runs', failing);

    await readStored(reader([{ '?column?': 1 }]), 'watchdog SELECT 1', 'SELECT 1');

    const health = lakebaseHealth();
    // The read that succeeded never needed the privilege the failing one lost,
    // so it is not evidence about the failing one.
    expect(health.state).toBe('unavailable');
    expect(health.connection_ok_since_failure).toBe(true);
    expect(warnings.filter((line) => line.includes('RECOVERED'))).toEqual([]);
    expect(errors.some((line) => line.includes('STILL UNAVAILABLE, but the endpoint answers'))).toBe(true);
  });

  it('turns that split into the remedy, rather than leaving it as an outage to wait out', async () => {
    await readStored(schemaReader(() => permissionDenied()),
      'GET /api/runs',
      'SELECT id FROM player_insights.messages'
    );
    await readStored(reader([{ '?column?': 1 }]), 'watchdog SELECT 1', 'SELECT 1');

    const check = lakebaseStorageCheck();
    expect(check.status).toBe('failed');
    expect(check.detail).toContain('privilege or schema problem');
    expect(check.remedy?.statement).toContain('bundle/app-db-grant.sh');
  });

  it('still recovers when the failure was the connection itself', async () => {
    // The rule is about evidence being at least as strong as the failure, not
    // about distrusting `SELECT 1`. A connection failure is answered by a
    // connection succeeding.
    await readStored(reader(pgError('Connection terminated unexpectedly', '08006')), 'watchdog', 'SELECT 1');
    expect(isLakebaseUnavailable()).toBe(true);

    await readStored(reader([{ '?column?': 1 }]), 'watchdog', 'SELECT 1');

    expect(isLakebaseUnavailable()).toBe(false);
    expect(warnings.some((line) => line.includes('RECOVERED'))).toBe(true);
  });

  it('reports each response during a flapping outage as unavailable, every cycle', async () => {
    const down = pgError('Connection terminated unexpectedly', '08006');
    const origins: string[] = [];
    for (const _cycle of [1, 2]) {
      const read = await readStored(reader(down, down), 'GET /api/runs', 'SELECT 1');
      origins.push(chooseRows('GET /api/runs', read).substitution.origin);
      await readStored(reader([{ id: 'msg-1' }]), 'GET /api/runs', 'SELECT 1');
    }

    // A store that drops out every few minutes used to fabricate all afternoon
    // while reporting one or two substitutions. There is nothing to fabricate
    // from now, so every cycle answers the same way.
    expect(origins).toEqual(['none', 'none']);
    expect(lakebaseHealth().state).toBe('ok');
  });
});

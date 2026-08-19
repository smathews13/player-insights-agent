/**
 * The record of what left, and the controls over what may.
 *
 * ── WHAT THESE TESTS ARE ACTUALLY DEFENDING ──
 *
 * Two claims, and everything below is one of them.
 *
 * The first is that THE RECORD CANNOT HOLD THE DATA IT WATCHES. That is a
 * property of the schema and the signature rather than of anybody's diligence, so
 * it is asserted against the parameters actually sent to Postgres: if a payload
 * column is ever added, the test that counts what an insert binds is the one that
 * fails, and it fails on the commit that adds it rather than on the audit that
 * finds it.
 *
 * The second is that NO FAILURE PRODUCES A REASSURING ANSWER. An unreadable
 * control table must not read as a deployment that permits nothing, and a
 * client's own claim to have been allowed must not be believed. Each of those is
 * a way for this feature to be worse than absent.
 *
 * Every address here is invented. See `docs`-free convention elsewhere in this
 * suite: `.invalid` is reserved by RFC 2606 and can never be a real domain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EGRESS_CONTROLS_TABLE,
  EGRESS_EVENTS_TABLE,
  forgetEgressControls,
  readEgressControls,
  recordEgress,
  workspaceLinksAllowed,
  writeEgressControl,
} from './egress-store';
import {
  defaultEgressControls,
  EGRESS_PATHS,
  egressControlsFrom,
  type EgressControls,
} from '../../shared/egress-contract';
import type { LakebaseReader } from './lakebase-store';
import { resetLakebaseHealth } from './lakebase-store';

const ANALYST = 'rowan@example.invalid';

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * A store that answers what it is told to and remembers what it was asked.
 *
 * Statements are matched by the table they name rather than by their text, for
 * the reason the run-ledger fake states: asserting on a SQL string proves the
 * string somebody wrote is the string somebody wrote. What matters here is which
 * VALUES were bound.
 */
function fakeStore(
  answers: {
    controls?: Record<string, unknown>[] | Error;
    events?: Record<string, unknown>[] | Error;
    insert?: Error;
  } = {}
): LakebaseReader & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    lakebase: {
      query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes(EGRESS_CONTROLS_TABLE)) {
          if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
            if (answers.insert) return Promise.reject(answers.insert);
            return Promise.resolve({ rows: [] });
          }
          if (answers.controls instanceof Error) return Promise.reject(answers.controls);
          return Promise.resolve({ rows: answers.controls ?? [] });
        }
        if (sql.includes(EGRESS_EVENTS_TABLE)) {
          if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
            if (answers.insert) return Promise.reject(answers.insert);
            return Promise.resolve({ rows: [] });
          }
          if (answers.events instanceof Error) return Promise.reject(answers.events);
          return Promise.resolve({ rows: answers.events ?? [] });
        }
        return Promise.resolve({ rows: [] });
      },
    },
  };
}

function refusal(code: string, message = 'refused'): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  forgetEgressControls();
  resetLakebaseHealth();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('what the record is allowed to hold', () => {
  /**
   * The load-bearing test of the whole feature.
   *
   * An egress log full of the data it is watching is the leak it was built to
   * prevent, and the guarantee is only as good as the columns. This reads the
   * INSERT the store actually issues and pins its column list, so a payload
   * column cannot be added without this failing.
   */
  it('binds only the ten columns the migration declares, none of which is a value', async () => {
    const store = fakeStore();
    await recordEgress(store, {
      actor: ANALYST,
      report: { channel: 'generated-sql', surface: 'runs', runId: 'run-1', itemCount: 3 },
      controls: defaultEgressControls(),
    });
    const insert = store.calls.find((call) => call.sql.includes('INSERT INTO player_insights.egress_events'));
    expect(insert).toBeDefined();
    expect(insert?.params).toHaveLength(10);
    for (const column of ['payload', 'value', 'content', 'body', 'rows', 'filename', 'bytes']) {
      expect(insert?.sql).not.toContain(column);
    }
  });

  /**
   * A count is a shape and a sample is a leak. Zero is not a legitimate count:
   * an export of nothing is not an export, so a zero in that column would be a
   * row claiming to have measured something it did not.
   */
  it('reads a zero, a fraction and a negative count as not counted', async () => {
    for (const asked of [0, -4, Number.NaN]) {
      const store = fakeStore();
      const { event } = await recordEgress(store, {
        actor: ANALYST,
        report: { channel: 'identifier', surface: 'runs', itemCount: asked },
        controls: defaultEgressControls(),
      });
      expect(event.itemCount, String(asked)).toBeNull();
    }
    const store = fakeStore();
    const { event } = await recordEgress(store, {
      actor: ANALYST,
      report: { channel: 'identifier', surface: 'runs', itemCount: 2.7 },
      controls: defaultEgressControls(),
    });
    expect(event.itemCount).toBe(2);
  });

  /**
   * An empty pointer is no pointer. Storing `''` makes a row look as though it
   * pointed at a run, and the panel would offer to open one that does not exist.
   */
  it('stores an empty run or conversation id as no pointer at all', async () => {
    const store = fakeStore();
    const { event } = await recordEgress(store, {
      actor: ANALYST,
      report: { channel: 'chart-image', surface: 'ask', runId: '  ', conversationId: '' },
      controls: defaultEgressControls(),
    });
    expect(event.runId).toBeNull();
    expect(event.conversationId).toBeNull();
  });
});

describe('deciding whether an export was permitted', () => {
  /**
   * The client reports an attempt; the server decides the outcome. A browser
   * running an old bundle, or one whose affordance was put back by hand, still
   * reports an export through a path this deployment has turned off, and that row
   * is the single most interesting thing this table can hold.
   */
  it('records an export through a disallowed path as refused, and keeps the row', async () => {
    const store = fakeStore();
    const controls: EgressControls = { ...defaultEgressControls(), 'chart-image': false };
    const recorded = await recordEgress(store, {
      actor: ANALYST,
      report: { channel: 'chart-image', surface: 'ask' },
      controls,
    });
    expect(recorded.event.outcome).toBe('refused');
    expect(recorded.written).toBe(true);
  });

  it('records an export through an allowed path as having left', async () => {
    const store = fakeStore();
    const recorded = await recordEgress(store, {
      actor: ANALYST,
      report: { channel: 'generated-sql', surface: 'runs' },
      controls: defaultEgressControls(),
    });
    expect(recorded.event.outcome).toBe('left');
  });

  /**
   * An off switch that cannot be honoured is the lie the whole capability is
   * written against. The app cannot stop a screenshot, so a stored `false` for
   * one must not make the record claim it refused anything.
   */
  it('never refuses a path the app cannot control, whatever is stored against it', async () => {
    const store = fakeStore();
    const controls = { ...defaultEgressControls(), 'screen-capture': false } as EgressControls;
    const recorded = await recordEgress(store, {
      actor: ANALYST,
      report: { channel: 'screen-capture', surface: 'ask' },
      controls,
    });
    expect(recorded.event.outcome).toBe('left');
  });

  /**
   * Recording is best effort in one direction only. A copy button that threw
   * because an audit row could not be written would be an audit mechanism that
   * broke the app, and the first fix anybody reached for would be removing it.
   */
  it('reports a write it could not make without throwing at the caller', async () => {
    const store = fakeStore({ insert: refusal('53300', 'too many connections') });
    const recorded = await recordEgress(store, {
      actor: ANALYST,
      report: { channel: 'identifier', surface: 'runs' },
      controls: defaultEgressControls(),
    });
    expect(recorded.written).toBe(false);
    expect(recorded.event.outcome).toBe('left');
  });
});

describe('reading the controls', () => {
  it('answers this build\u2019s defaults for a deployment that has stored nothing', async () => {
    const reading = await readEgressControls(fakeStore({ controls: [] }));
    expect(reading.stored).toBe(true);
    expect(reading.controls).toEqual(defaultEgressControls());
  });

  it('folds a stored row over the default it replaces', async () => {
    const reading = await readEgressControls(
      fakeStore({ controls: [{ channel: 'generated-sql', allowed: false }] })
    );
    expect(reading.controls['generated-sql']).toBe(false);
    expect(reading.controls['identifier']).toBe(true);
  });

  /**
   * A row naming a channel this build has never heard of was written by a newer
   * build. Honouring it would be an older build enforcing a switch it cannot
   * apply, which is the same dishonesty as a mislabelled panel arriving through
   * the database instead of through the source.
   */
  it('drops a stored row for a path this build does not know', async () => {
    const reading = await readEgressControls(
      fakeStore({ controls: [{ channel: 'holographic-export', allowed: false }] })
    );
    expect(reading.controls).toEqual(defaultEgressControls());
  });

  /**
   * Failing closed feels safer and is wrong. It would turn a Lakebase blip into
   * an app whose copy buttons have silently stopped working, with nothing on
   * screen saying why, and it would be a restriction nobody chose.
   */
  it('falls back to the defaults when the table cannot be read, and says they are defaults', async () => {
    const reading = await readEgressControls(fakeStore({ controls: refusal('42P01', 'no such table') }));
    expect(reading.controls).toEqual(defaultEgressControls());
    expect(reading.stored).toBe(false);
  });

  /**
   * Caching the defaults an outage produced would turn one unreadable moment into
   * fifteen seconds of a deployment quietly ignoring a switch somebody set.
   */
  it('does not cache a failed read', async () => {
    const store = fakeStore({ controls: refusal('57014', 'cancelled') });
    await readEgressControls(store);
    await readEgressControls(store);
    const reads = store.calls.filter((call) => call.sql.includes('SELECT channel'));
    expect(reads).toHaveLength(2);
  });

  it('reuses a successful read inside the window and re-reads after it', async () => {
    const store = fakeStore({ controls: [] });
    await readEgressControls(store, { now: 1_000 });
    await readEgressControls(store, { now: 5_000 });
    expect(store.calls.filter((call) => call.sql.includes('SELECT channel'))).toHaveLength(1);
    await readEgressControls(store, { now: 100_000 });
    expect(store.calls.filter((call) => call.sql.includes('SELECT channel'))).toHaveLength(2);
  });
});

describe('moving one switch', () => {
  it('writes the channel and who moved it, and forgets the cached set', async () => {
    const store = fakeStore({ controls: [] });
    await readEgressControls(store);
    const outcome = await writeEgressControl(store, {
      channel: 'generated-sql',
      allowed: false,
      actor: ANALYST,
    });
    expect(outcome).toEqual({ channel: 'generated-sql', allowed: false });
    await readEgressControls(store);
    // Two reads rather than one: the write cleared the entry, so the
    // administrator who made the change sees it in force immediately.
    expect(store.calls.filter((call) => call.sql.includes('SELECT channel'))).toHaveLength(2);
  });

  /**
   * A switch that accepted a write and then ignored it is worse than one that
   * refused, because it is on screen looking settled.
   */
  it('refuses a path nothing can enforce rather than storing a switch that is ignored', async () => {
    const outcome = await writeEgressControl(fakeStore(), {
      channel: 'screen-capture',
      allowed: false,
      actor: ANALYST,
    });
    expect(outcome).toHaveProperty('refusal');
  });

  it('refuses a channel this build does not know', async () => {
    const outcome = await writeEgressControl(fakeStore(), {
      channel: 'holographic-export',
      allowed: false,
      actor: ANALYST,
    });
    expect(outcome).toHaveProperty('refusal');
  });

  /**
   * Throws rather than reporting success, because this is somebody pressing a
   * control and being told it was saved.
   */
  it('throws when the store refuses the write', async () => {
    const store = fakeStore({ insert: refusal('42501', 'permission denied') });
    await expect(
      writeEgressControl(store, { channel: 'chart-image', allowed: true, actor: ANALYST })
    ).rejects.toThrow();
  });
});

describe('the one control that is wired', () => {
  it('permits workspace links by default', async () => {
    expect(await workspaceLinksAllowed(fakeStore({ controls: [] }))).toBe(true);
  });

  it('withholds them once an administrator has turned that path off', async () => {
    expect(
      await workspaceLinksAllowed(fakeStore({ controls: [{ channel: 'workspace-link', allowed: false }] }))
    ).toBe(false);
  });

  /**
   * Errs open. A Lakebase blip must not silently strip the provenance links out
   * of Monitoring with nothing on screen saying why.
   */
  it('permits them when the control table cannot be read at all', async () => {
    expect(await workspaceLinksAllowed(fakeStore({ controls: refusal('42P01') }))).toBe(true);
  });
});

describe('the registry the controls are read against', () => {
  /**
   * The field that keeps the panel honest. A path may only move from `stored` to
   * `enforced` in the same change that wires it, so this list is the manifest of
   * what has actually been wired and every addition to it has to arrive here with
   * the code that honours it. If a path is claimed here with no route and no
   * component reading the switch, this is the test that should have stopped it.
   *
   * Where each of the two is enforced, because they are not equally strong:
   *
   *   workspace-link  ON THE SERVER. `monitoring-routes` and `insights-routes`
   *                   send null instead of the URL, so there is nothing in the
   *                   browser to suppress and nothing in a network tab to read.
   *   chart-image     IN THE BROWSER. `FIGURE_CONFIG` in `PlotlyFigure.tsx` drops
   *                   Plotly's `toImage` button. The reader already has the
   *                   figure, so this removes the affordance and not the
   *                   possibility -- covered by `egress-chart-gate.test.ts`.
   */
  it('claims only the paths something actually honours', () => {
    const enforced = EGRESS_PATHS.filter((path) => path.enforcement === 'enforced');
    expect(enforced.map((path) => path.channel).sort()).toEqual(['chart-image', 'workspace-link']);
  });

  /**
   * A path the app cannot stop must carry no switch and must always read as
   * permitted, whatever a row says. Both halves matter: the first stops the panel
   * offering a control that does nothing, the second stops the record claiming a
   * refusal that never happened.
   */
  it('always permits the paths it cannot control, whatever is stored', () => {
    const uncontrollable = EGRESS_PATHS.filter((path) => path.enforcement === 'uncontrollable');
    expect(uncontrollable.length).toBeGreaterThan(0);
    const controls = egressControlsFrom(
      uncontrollable.map((path) => ({ channel: path.channel, allowed: false }))
    );
    for (const path of uncontrollable) {
      expect(controls[path.channel], path.channel).toBe(true);
      expect(path.allowedByDefault, path.channel).toBe(true);
    }
  });

  it('names every path exactly once', () => {
    const channels = EGRESS_PATHS.map((path) => path.channel);
    expect(new Set(channels).size).toBe(channels.length);
  });
});

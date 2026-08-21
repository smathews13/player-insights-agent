/**
 * That a Deploy-from-Git keeps the rail scope a release decided, and that
 * nothing else can change it.
 *
 * THE REPORTED DEFECT. The Ask rail showed "No saved conversations yet" after a
 * Git deploy while Run Explorer and Monitoring still listed every conversation.
 * Nothing had been deleted and no schema had moved: Git replaces app.yaml with
 * the copy committed in `build/deploy/`, that copy authors
 * `PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL: 'false'`, and the released app had
 * been running the example target's "true". The rail narrowed to the reader's own
 * conversations, the reader owned none of the seeded evaluation history, and the
 * two surfaces that are not per-user kept showing all of it.
 *
 * The four cases below are the whole rule, and the last two are the ones that
 * make it safe to have at all.
 */
import { describe, expect, it } from 'vitest';

import {
  SHARED_RAIL_DECISION,
  decisionSource,
  preserveEnvDecision,
  readDeploymentDecision,
  recordDeploymentDecision,
} from './deployment-decisions';

const TABLE = 'astrolabe.deployment_decisions';

/** A Postgres stand-in that records what it was asked and holds one row per key. */
function store(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  const queries: { text: string; params: unknown[] }[] = [];
  return {
    rows,
    queries,
    query(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (text.startsWith('SELECT')) {
        const value = rows.get(String(params[0]));
        return Promise.resolve({ rows: value === undefined ? [] : [{ value }] });
      }
      rows.set(String(params[0]), String(params[1]));
      return Promise.resolve({ rows: [] });
    },
  };
}

/** A store that refuses everything, for the un-migrated and un-granted cases. */
const refusing = {
  query: () => Promise.reject(new Error('relation "deployment_decisions" does not exist')),
};

const release = { PLAYER_INSIGHTS_TARGET: 'example', LAKEBASE_ENDPOINT: 'projects/x/branches/production' };
const gitDeploy = { PLAYER_INSIGHTS_TARGET: '', LAKEBASE_ENDPOINT: 'projects/x/branches/production' };
const laptop = { PLAYER_INSIGHTS_TARGET: '', LAKEBASE_ENDPOINT: '' };

describe('which boot may state a per-deployment decision', () => {
  it('reads the bundle target as the authority and a bare Lakebase binding as a Git deploy', () => {
    expect(decisionSource(release)).toBe('release');
    expect(decisionSource(gitDeploy)).toBe('git-deploy');
    // No Lakebase at all is a laptop or the suite, and neither has a store to
    // record into or a deployment whose history is at stake.
    expect(decisionSource(laptop)).toBe('local');
  });
});

describe('the rail scope across a Deploy-from-Git', () => {
  it('records what a release stated, so the next Git deploy has something to find', async () => {
    const lakebase = store();

    const preserved = await preserveEnvDecision({
      store: lakebase,
      table: TABLE,
      decision: SHARED_RAIL_DECISION,
      authored: 'true',
      env: release,
      recordedBy: 'app boot',
    });

    expect(preserved).toEqual({ value: 'true', source: 'release', restored: false, authored: 'true' });
    expect(lakebase.rows.get(SHARED_RAIL_DECISION)).toBe('true');
  });

  it('restores the recorded scope when app.yaml carries the artifact placeholder', async () => {
    // The reported defect, in one assertion: the environment says 'false'
    // because Git replaced app.yaml, and the deployment's own recorded decision
    // says 'true'.
    const lakebase = store({ [SHARED_RAIL_DECISION]: 'true' });

    const preserved = await preserveEnvDecision({
      store: lakebase,
      table: TABLE,
      decision: SHARED_RAIL_DECISION,
      authored: 'false',
      env: gitDeploy,
      recordedBy: 'app boot',
    });

    expect(preserved.value).toBe('true');
    expect(preserved.restored).toBe(true);
    expect(preserved.authored).toBe('false');
  });

  it('does NOT let a Git deploy record, because a placeholder must not overwrite a decision', async () => {
    // Without this, the first Git deploy would write 'false' over the release's
    // 'true' and there would be nothing left to restore on the second: the bug
    // would become permanent instead of surviving one deploy.
    const lakebase = store({ [SHARED_RAIL_DECISION]: 'true' });

    await preserveEnvDecision({
      store: lakebase,
      table: TABLE,
      decision: SHARED_RAIL_DECISION,
      authored: 'false',
      env: gitDeploy,
      recordedBy: 'app boot',
    });

    expect(lakebase.rows.get(SHARED_RAIL_DECISION)).toBe('true');
    expect(lakebase.queries.every((entry) => entry.text.startsWith('SELECT'))).toBe(true);
  });

  it('keeps the authored value when nothing was ever recorded, so a fresh clone stays per-user', async () => {
    const lakebase = store();

    const preserved = await preserveEnvDecision({
      store: lakebase,
      table: TABLE,
      decision: SHARED_RAIL_DECISION,
      authored: 'false',
      env: gitDeploy,
      recordedBy: 'app boot',
    });

    expect(preserved).toEqual({ value: 'false', source: 'git-deploy', restored: false, authored: 'false' });
  });

  it('keeps the authored value when the store cannot be read at all', async () => {
    // A deployment that has not reached migration 9 yet, or whose role has no
    // SELECT on the table. Either way there is no decision to honour, and the
    // narrow authored value is the only safe thing left to use.
    const preserved = await preserveEnvDecision({
      store: refusing,
      table: TABLE,
      decision: SHARED_RAIL_DECISION,
      authored: 'false',
      env: gitDeploy,
      recordedBy: 'app boot',
    });

    expect(preserved.value).toBe('false');
    expect(preserved.restored).toBe(false);
  });

  it('never touches the store from a laptop or the suite', async () => {
    const lakebase = store({ [SHARED_RAIL_DECISION]: 'true' });

    const preserved = await preserveEnvDecision({
      store: lakebase,
      table: TABLE,
      decision: SHARED_RAIL_DECISION,
      authored: undefined,
      env: laptop,
      recordedBy: 'app boot',
    });

    expect(preserved).toEqual({ value: undefined, source: 'local', restored: false, authored: undefined });
    expect(lakebase.queries).toHaveLength(0);
  });

  it('reports a decision it could not write rather than throwing out of boot', async () => {
    expect(await recordDeploymentDecision(refusing, TABLE, SHARED_RAIL_DECISION, 'true', 'app boot')).toBe(false);
    expect(await readDeploymentDecision(refusing, TABLE, SHARED_RAIL_DECISION)).toBeNull();
  });

  it('treats a blank recorded value as no decision, so a truncated row widens nothing', async () => {
    const lakebase = store({ [SHARED_RAIL_DECISION]: '   ' });

    expect(await readDeploymentDecision(lakebase, TABLE, SHARED_RAIL_DECISION)).toBeNull();
  });
});

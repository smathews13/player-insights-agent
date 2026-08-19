/**
 * The one check made as the application, and the claim it is allowed to make.
 *
 * Two things are held here. The verdicts, so a refusal cannot become a soft
 * unknown and a pass cannot imply anything about the reader's own access. And the
 * absence of an MLflow scope in the bundle, because the obvious tidying is to
 * "finish the job" by declaring one, and the Apps API rejects every spelling of
 * it -- a declared invalid scope fails the whole bundle deploy, which is how this
 * was found in the first place with `unity-catalog`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkExperimentAsApp,
  experimentIdOf,
  experimentVerdict,
  readFailure,
  EXPERIMENT_PATH,
  EXPERIMENT_BY_NAME_PATH,
} from './experiment-probe';

const BUNDLE = readFileSync(join(import.meta.dirname, '../../..', 'databricks.yml'), 'utf8');

describe('the experiment is read as the application', () => {
  it('passes when the workspace answers, naming the experiment it found', () => {
    const check = experimentVerdict({
      experimentId: '<mlflow-experiment-id>',
      read: { kind: 'ok', body: { experiment: { name: '/Shared/player-insights-agent', lifecycle_stage: 'active' } } },
    });

    expect(check?.status).toBe('ok');
    expect(check?.display_name).toBe('/Shared/player-insights-agent');
    expect(check?.detail).toContain('/Shared/player-insights-agent');
    expect(check?.detail).toContain('active');
  });

  /**
   * THE CLAIM IT MUST NOT MAKE. Every other check on the page answers about the
   * reader's own grants. This one cannot, and a green badge that let somebody
   * conclude their own access was confirmed would be the same defect the badge it
   * replaced had, only harder to notice.
   */
  it('says whose read it was, in every verdict', () => {
    const reads = [
      { kind: 'ok' as const, body: {} },
      { kind: 'refused' as const, status: 403, code: 'PERMISSION_DENIED', message: 'no' },
    ];
    for (const read of reads) {
      const check = experimentVerdict({ experimentId: 'e1', read });
      expect(check?.detail, JSON.stringify(read.kind)).toContain('as the application, not as you');
    }
    expect(experimentVerdict({ experimentId: 'e1', read: reads[0] })?.checked_with).toContain(
      'Read as the application, not as you'
    );
  });

  /**
   * A refusal OF THE APP is a fact about the deployment, not about anybody's
   * permissions: the identity that was refused is the one that writes the traces,
   * so the trace has nowhere to land. That is why it is `failed` rather than the
   * `unverified` a user-token refusal earns.
   */
  it('fails, with the workspace\u2019s own code and message, when the app is refused', () => {
    const check = experimentVerdict({
      experimentId: 'e1',
      read: { kind: 'refused', status: 403, code: 'PERMISSION_DENIED', message: 'cannot read experiment e1' },
    });

    expect(check?.status).toBe('failed');
    expect(check?.display_name).toBeUndefined();
    expect(check?.detail).toContain('HTTP 403 PERMISSION_DENIED');
    expect(check?.detail).toContain('cannot read experiment e1');
  });

  it('fails on a missing experiment, which is what a dead link on the card means', () => {
    const check = experimentVerdict({
      experimentId: 'gone',
      read: { kind: 'refused', status: 404, code: 'RESOURCE_DOES_NOT_EXIST', message: 'No Experiment with id gone' },
    });

    expect(check?.status).toBe('failed');
    expect(check?.error).toContain('No Experiment with id gone');
  });

  /**
   * MLflow SOFT-DELETES, so this is the one failure that arrives wearing a 200.
   * The record comes back whole and the read succeeds; only `lifecycle_stage`
   * says the experiment will refuse every run logged to it. The stage was
   * already read for the detail line, so this shipped as a card that printed
   * the word "deleted" beside a green badge saying traces had somewhere to land.
   */
  it('fails on a deleted experiment, which answers 200 and accepts no runs', () => {
    const check = experimentVerdict({
      experimentId: 'e1',
      read: { kind: 'ok', body: { experiment: { name: '/Shared/old', lifecycle_stage: 'deleted' } } },
    });

    expect(check?.status).toBe('failed');
    expect(check?.detail).toContain('deleted');
    expect(check?.detail).toContain('as the application, not as you');
    expect(check?.error).toContain('deleted');
  });

  /**
   * An experiment the workspace answered for without naming a stage is still a
   * pass. Absence is not a deletion, and inventing a failure from a field an
   * older workspace version did not send would red-badge a healthy deployment.
   */
  it('passes when the workspace named no stage at all', () => {
    const check = experimentVerdict({
      experimentId: 'e1',
      read: { kind: 'ok', body: { experiment: { name: '/Shared/live' } } },
    });

    expect(check?.status).toBe('ok');
  });

  it('reports a call that did not complete as unknown rather than as a denial', () => {
    const check = experimentVerdict({
      experimentId: 'e1',
      read: { kind: 'no-response', message: 'socket hang up' },
    });

    expect(check?.status).toBe('unverified');
    expect(check?.error).toBe('socket hang up');
  });

  /**
   * No check at all where there is no experiment. The row already reports the
   * value as unset, and a red badge here would be a failure invented for a
   * deployment that is simply configured without one.
   */
  it('makes no claim when no experiment is configured', () => {
    expect(experimentVerdict({ experimentId: '  ', read: { kind: 'ok', body: {} } })).toBeNull();
  });

  it('is keyed to the resource, so the row and the card find it', () => {
    const check = experimentVerdict({ experimentId: 'e1', read: { kind: 'ok', body: {} } });
    expect(check?.id).toBe('experiment-id');
    expect(check?.label).toBe('MLflow experiment');
    expect(check?.name).toBe('e1');
  });
});

describe('a thrown SDK error is read back rather than swallowed', () => {
  it('recovers the status, so a 404 is a refusal and not a lost call', () => {
    expect(readFailure({ statusCode: 404, errorCode: 'RESOURCE_DOES_NOT_EXIST', message: 'gone' })).toEqual({
      kind: 'refused',
      status: 404,
      code: 'RESOURCE_DOES_NOT_EXIST',
      message: 'gone',
    });
  });

  it('treats an error carrying no status as unknown, not as denied', () => {
    expect(readFailure(new Error('fetch failed')).kind).toBe('no-response');
    expect(readFailure(undefined).kind).toBe('no-response');
  });

  it('never throws out of the check, whatever the reader does', async () => {
    const check = await checkExperimentAsApp('e1', () => {
      throw new Error('the client blew up');
    });
    expect(check?.status).toBe('unverified');
  });

  it('asks nothing at all when there is no experiment to ask about', async () => {
    let asked = false;
    const check = await checkExperimentAsApp('', () => {
      asked = true;
      return Promise.resolve({ kind: 'ok', body: {} });
    });
    expect(check).toBeNull();
    expect(asked).toBe(false);
  });
});

/**
 * WHY THIS IS READ AS THE APPLICATION AT ALL, pinned against the bundle.
 *
 * Every MLflow spelling was rejected by the Apps API: mlflow, mlflow.experiments,
 * mlflow.experiments:read, mlflow-experiments, experiments, experiments:read, ml,
 * ml.experiments:read. Declaring an invalid name fails the whole bundle deploy,
 * so the guard is that none of them appears in the file.
 */
describe('no MLflow scope is declared, because none is valid', () => {
  it('keeps every rejected spelling out of the bundle', () => {
    const scopes = BUNDLE.split('\n').filter((line) => /^\s*#?\s*-\s\S+\s*$/.test(line));
    for (const rejected of ['mlflow', 'mlflow.experiments', 'experiments', 'ml', 'ml.experiments:read']) {
      expect(
        scopes.map((line) =>
          line
            .trim()
            .replace(/^#\s*-\s*/, '')
            .replace(/^-\s*/, '')
        )
      ).not.toContain(rejected);
    }
  });

  it('asks the MLflow API this app has no user scope for', () => {
    // Stated here so the reason the reader's token is not used is checkable
    // against the path that is actually called.
    expect(EXPERIMENT_PATH.startsWith('/api/2.0/mlflow/')).toBe(true);
    expect(EXPERIMENT_BY_NAME_PATH.startsWith('/api/2.0/mlflow/')).toBe(true);
  });
});

/**
 * The id is read out of whatever shape the get-by-name answer arrives in, so a
 * "From Git" deploy can resolve its stable experiment PATH to the numeric id the
 * deep link needs. The IO around it is the app's service principal; only the
 * reading of the answer is pure and testable here.
 */
describe('the experiment id is read out of the get-by-name answer', () => {
  it('reads the id whether the record is nested or flat', () => {
    expect(experimentIdOf({ experiment: { experiment_id: '<mlflow-experiment-id>' } })).toBe('<mlflow-experiment-id>');
    expect(experimentIdOf({ experiment_id: '424242' })).toBe('424242');
  });

  it('trims what it reads, so a stray space is not shipped into a URL', () => {
    expect(experimentIdOf({ experiment: { experiment_id: '  987654 ' } })).toBe('987654');
  });

  it('returns nothing when the answer names no id', () => {
    expect(experimentIdOf({})).toBe('');
    expect(experimentIdOf({ experiment: { name: '/Shared/x' } })).toBe('');
    // A non-scalar id is unreadable rather than stringified into '[object Object]'.
    expect(experimentIdOf({ experiment_id: { nope: true } })).toBe('');
  });
});

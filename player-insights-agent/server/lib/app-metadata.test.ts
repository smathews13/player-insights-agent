import { describe, expect, it } from 'vitest';

import { appCompute, appFacts, appServing, appTags, readAppFacts, type AppRead } from './app-metadata';

/**
 * What the deployment is allowed to say about itself.
 *
 * Every assertion here is about the same rule from a different angle: this
 * module reports what the workspace reported and nothing else. The card it feeds
 * is read by somebody reconciling what they see in the app against what they see
 * in the workspace UI, so a field filled in from a plausible default would be
 * worse than a missing row -- it would be a wrong row in the same type as a right
 * one.
 */

const ANSWERED: AppRead = {
  kind: 'ok',
  body: {
    name: 'an-app',
    description: 'Asks governed questions.',
    url: 'https://an-app-1234.example.databricksapps.com',
    compute_size: 'MEDIUM',
    active_deployment: {
      create_time: '2026-08-02T07:41:00Z',
      creator: 'someone@example.com',
    },
    current_user: { user_name: 'current.viewer@example.com' },
    update_time: '2026-07-01T00:00:00Z',
    updater: 'someone-else@example.com',
  },
};

describe('what one read establishes', () => {
  it('reports each fact the workspace reported, and claims the read answered', () => {
    const facts = appFacts({ read: ANSWERED });

    expect(facts.answered).toBe(true);
    expect(facts.url).toBe('https://an-app-1234.example.databricksapps.com');
    expect(facts.description).toBe('Asks governed questions.');
    expect(facts.deployedAt).toBe('2026-08-02T07:41:00Z');
    expect(facts.deployedBy).toBe('someone@example.com');
    expect(facts.deployedBy).not.toBe('current.viewer@example.com');
    expect(facts.deployedBy).not.toBe('someone-else@example.com');
  });

  /**
   * The RUNNING deployment's stamp, not the app's. `create_time` on the app is
   * when somebody first made it, which on a long-lived deployment is months
   * before the release that is actually serving -- and this figure is read as an
   * uptime.
   */
  it('prefers the running deployment to the app record for the release', () => {
    const facts = appFacts({ read: ANSWERED });
    expect(facts.deployedAt).not.toBe('2026-07-01T00:00:00Z');

    const noDeployment = appFacts({ read: { kind: 'ok', body: { update_time: '2026-07-01T00:00:00Z', updater: 'a@b.c' } } });
    expect(noDeployment.deployedAt).toBe('2026-07-01T00:00:00Z');
    expect(noDeployment.deployedBy).toBe('a@b.c');
  });

  /**
   * A REFUSAL AND A TIMEOUT ARE THE SAME ANSWER HERE, because neither
   * establishes anything about the deployment and the card's job is to draw only
   * what was established. Which of the two it was goes to the log.
   */
  it.each<[string, AppRead]>([
    ['a refusal', { kind: 'refused', status: 403, message: 'no' }],
    ['no answer at all', { kind: 'no-response', message: 'the call did not complete' }],
  ])('claims nothing at all after %s', (_name, read) => {
    const facts = appFacts({ read });

    expect(facts.answered).toBe(false);
    expect(facts.url).toBe('');
    expect(facts.description).toBe('');
    expect(facts.compute).toBeNull();
    expect(facts.deployedAt).toBe('');
  });

  /**
   * The exporter comes from the process rather than from the workspace, so it is
   * the one fact a run that could not ask about itself can still state.
   */
  it('still reports the exporter when the workspace could not be asked', () => {
    const facts = appFacts({ read: { kind: 'no-response', message: 'x' }, otelExporter: 'http://collector:4317' });
    expect(facts.otelExporter).toBe('http://collector:4317');
  });
});

describe('the compute size', () => {
  it('carries the published envelope for a size there is one for', () => {
    expect(appCompute('MEDIUM')).toEqual({ size: 'MEDIUM', envelope: { vcpus: 2, memoryGb: 6, dbuPerHour: 0.5 } });
  });

  /**
   * THE NUMBER IS NEVER INVENTED. A DBU rate extrapolated from a neighbouring
   * size would render in the same type as one the workspace reported, on a row
   * somebody is reading against a bill.
   */
  it('names an unfamiliar size and states no figures for it', () => {
    expect(appCompute('X-LARGE-2')).toEqual({ size: 'X-LARGE-2', envelope: null });
  });

  it('draws no compute row where the workspace named no size', () => {
    expect(appCompute('')).toBeNull();
    expect(appCompute(undefined)).toBeNull();
  });
});

/**
 * Apps has carried tags as a list of pairs and as a plain map in different
 * workspace versions, and a version with neither is the common case. All three
 * are read here so an unfamiliar shape produces no chips rather than
 * `[object Object]` in one.
 */
describe('tags, in whichever shape the workspace uses', () => {
  it('reads a list of pairs, a plain map, and a bare list', () => {
    expect(appTags([{ key: 'team', value: 'insights' }])).toEqual(['insights']);
    expect(appTags({ team: 'insights', stage: 'demo' })).toEqual(['insights', 'demo']);
    expect(appTags(['insights'])).toEqual(['insights']);
  });

  it('produces nothing from a shape it does not recognise', () => {
    expect(appTags(undefined)).toEqual([]);
    expect(appTags('insights,demo')).toEqual([]);
    expect(appTags([{ nothing: 1 }])).toEqual([]);
  });
});

describe('asking the workspace at all', () => {
  /**
   * An app that does not know its own name is every run outside Apps. It asks
   * nothing, which is also what stops a local run spending a request per page
   * load on a call that cannot succeed.
   */
  it('asks nothing when there is no app name to ask about', async () => {
    let asked = false;
    const facts = await readAppFacts({
      name: '',
      read: () => {
        asked = true;
        return Promise.resolve(ANSWERED);
      },
    });

    expect(asked).toBe(false);
    expect(facts.answered).toBe(false);
  });

  /**
   * The settings route is what somebody opens to find out why the rest of the app
   * is misbehaving, so nothing on the way to it may throw.
   */
  it('survives a reader that throws rather than answering', async () => {
    const facts = await readAppFacts({
      name: 'an-app',
      read: () => Promise.reject(new Error('no workspace configuration')),
    });

    expect(facts.answered).toBe(false);
  });
});

/**
 * The serving state, which the endpoint badge was drawn without.
 *
 * The badge was a green literal, so a crashed app on stopped compute rendered
 * exactly like a healthy one. Both states were in the record this module
 * already fetched; it simply threw them away.
 */
describe('what the workspace says about the app serving', () => {
  it('reads the application and its compute as the two separate states they are', () => {
    const serving = appServing({
      app_status: { state: 'RUNNING', message: 'App has status: App is running' },
      compute_status: { state: 'ACTIVE', message: 'App compute is running.' },
    });

    expect(serving).toEqual({
      app: 'RUNNING',
      compute: 'ACTIVE',
      message: 'App has status: App is running',
    });
  });

  /**
   * Verbatim, never bucketed. This card is read against the workspace UI, and
   * the two agreeing word for word is what makes it worth reading. A state this
   * app has not met must reach the screen as itself.
   */
  it('passes an unfamiliar state through rather than mapping it to a verdict', () => {
    expect(appServing({ app_status: { state: 'DEPLOYING' } }).app).toBe('DEPLOYING');
  });

  it('reports nothing where the workspace reported nothing, rather than a default', () => {
    expect(appServing({})).toEqual({ app: '', compute: '', message: '' });
    // A version that answers about the app but not about its status must not
    // acquire a state from anywhere.
    expect(appFacts({ read: { kind: 'ok', body: { name: 'an-app' } } }).serving).toEqual({
      app: '',
      compute: '',
      message: '',
    });
  });

  it('falls back to the compute message when only the compute explained itself', () => {
    expect(appServing({
      app_status: { state: 'UNAVAILABLE' },
      compute_status: { state: 'STOPPED', message: 'App compute is stopped.' },
    }).message).toBe('App compute is stopped.');
  });
});

import { describe, expect, it } from 'vitest';

import {
  appCompute,
  appFacts,
  appServing,
  appTags,
  readAppFacts,
  sourceFolderPath,
  workspaceIdFromAppUrl,
  type AppRead,
} from './app-metadata';

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

/**
 * WHICH SOURCE IS ACTUALLY RUNNING, which is the whole reason these links are
 * read off live metadata instead of written down. This repository holds a DAB
 * tree under `.bundle/` and has historically had an uploaded folder as well, and
 * an operator sent to the wrong one is debugging code that is not serving.
 */
describe('the active deployment source', () => {
  it('links a Git deployment to the workspace app that manages its connection', () => {
    const facts = appFacts({
      workspaceHost: 'https://workspace.example.com/',
      read: {
        kind: 'ok',
        body: {
          name: 'astrolabe',
          active_deployment: {
            source_code_path: '/Workspace/Users/someone/.bundle/player-insights-agent-dab/dev/files',
            git_source: {
              branch: 'release',
              source_code_path: 'player-insights-agent/build/deploy',
              git_repository: { url: 'https://github.com/an-internal-owner/an-internal-repo.git' },
            },
          },
        },
      },
    });

    expect(facts.source).toEqual({
      path: 'player-insights-agent/build/deploy',
      workspaceUrl: 'https://workspace.example.com/apps/astrolabe',
      gitRef: 'release',
    });
    // NOT THE BUNDLE TREE. `.bundle/player-insights-agent-dab/...` is where a
    // DAB deploy puts files; it is not what a Git-sourced app runs, and sending
    // an operator there is sending them to code that is not serving.
    expect(facts.source.workspaceUrl).not.toContain('.bundle');
    // And not a folder link either, whatever id it is handed: a Git deployment
    // materialises no workspace folder, so there is none to browse.
    expect(
      appFacts({
        workspaceHost: 'https://workspace.example.com',
        sourceFolderId: '1999001141571163',
        read: {
          kind: 'ok',
          body: {
            name: 'astrolabe',
            url: 'https://astrolabe-<workspace-id>.aws.databricksapps.com',
            active_deployment: { git_source: { branch: 'main', source_code_path: 'player-insights-agent/build/deploy' } },
          },
        },
      }).source.workspaceUrl
    ).toBe('https://workspace.example.com/apps/astrolabe?o=<workspace-id>');
  });

  /**
   * THE FORM SAM ASKED FOR: `/browse/folders/<id>?o=<workspace>`. It shipped
   * briefly as `#workspace/<path>`, which needed no folder id and was not the
   * pattern the workspace UI puts in the address bar or that an operator can
   * paste to somebody else.
   */
  it('links an uploaded deployment to the folder id the workspace resolved', () => {
    const facts = appFacts({
      workspaceHost: 'workspace.example.com',
      sourceFolderId: '1999001141571163',
      read: {
        kind: 'ok',
        body: {
          name: 'astrolabe',
          url: 'https://astrolabe-<workspace-id>.aws.databricksapps.com',
          active_deployment: {
            source_code_path: '/Workspace/Users/operator/player-insights-agent-real-src',
            deployment_artifacts: {
              source_code_path: '/Workspace/Users/system/src/a-generated-snapshot',
            },
          },
        },
      },
    });

    // The row still READS as the path, which is what makes it worth scanning.
    expect(facts.source.path).toBe('/Workspace/Users/operator/player-insights-agent-real-src');
    expect(facts.source.workspaceUrl).toBe(
      'https://workspace.example.com/browse/folders/1999001141571163?o=<workspace-id>'
    );
    expect(facts.source.workspaceUrl).not.toContain('#workspace');
    // The generated artifact snapshot is what the deployment READS. It is not a
    // folder anybody edits, so nothing points at it.
    expect(facts.source.workspaceUrl).not.toContain('a-generated-snapshot');
    // Nothing established a branch, so nothing claims one.
    expect(facts.source.gitRef).toBe('');
  });

  /**
   * A FOLDER ID IS NEVER DERIVED FROM A PATH. Where the workspace would not say
   * what the folder is -- a refusal, a deleted folder, an unreachable control
   * plane -- the row falls back to the app's own page, which is a destination
   * that exists, rather than to a number this module invented.
   */
  it('falls back to the app page when the folder id could not be resolved', () => {
    const facts = appFacts({
      workspaceHost: 'https://workspace.example.com',
      read: {
        kind: 'ok',
        body: {
          name: 'astrolabe',
          url: 'https://astrolabe-<workspace-id>.aws.databricksapps.com',
          active_deployment: { source_code_path: '/Workspace/Users/operator/an app src' },
        },
      },
    });

    expect(facts.source.workspaceUrl).toBe(
      'https://workspace.example.com/apps/astrolabe?o=<workspace-id>'
    );
    expect(facts.source.workspaceUrl).not.toContain('/browse/folders');
  });

  /**
   * The workspace id comes from the app's own URL, because nothing hands the
   * container one: `DATABRICKS_WORKSPACE_ID` is unset on Apps, and a literal in
   * this repository would be a real customer workspace id in a published tree.
   */
  it('reads the workspace id off the app URL, and states none where there is none to read', () => {
    expect(workspaceIdFromAppUrl('https://player-insights-agent-<workspace-id>.<region>.databricksapps.com')).toBe(
      '<workspace-id>'
    );
    // Not any host that ends a label in digits: a wrong `?o=` sends a reader to
    // a workspace they cannot switch to.
    expect(workspaceIdFromAppUrl('https://an-app-1234.example.com')).toBe('');
    expect(workspaceIdFromAppUrl('')).toBe('');

    const noUrl = appFacts({
      workspaceHost: 'https://workspace.example.com',
      sourceFolderId: '42',
      read: { kind: 'ok', body: { name: 'astrolabe', active_deployment: { source_code_path: '/Workspace/a/b' } } },
    });
    expect(noUrl.source.workspaceUrl).toBe('https://workspace.example.com/browse/folders/42');
  });

  /**
   * WHICH PATH IS EVEN ASKED ABOUT. The second workspace call is made for the
   * running deployment's own folder and for nothing else.
   */
  it('resolves the running deployment folder, and no other path in the record', () => {
    expect(
      sourceFolderPath({
        active_deployment: {
          source_code_path: '/Workspace/Users/operator/player-insights-agent-real-src',
          deployment_artifacts: { source_code_path: '/Workspace/Users/system/src/a-snapshot' },
        },
      })
    ).toBe('/Workspace/Users/operator/player-insights-agent-real-src');

    // A Git deployment's path is relative to a repository and names no
    // workspace object, so there is nothing to ask about.
    expect(
      sourceFolderPath({
        active_deployment: { git_source: { source_code_path: 'player-insights-agent/build/deploy' } },
      })
    ).toBe('');

    // NOT THE BUNDLE TREE, even where the record carries one beside the
    // repository: that folder is where a bundle deploy last put files, not what
    // a Git-sourced app runs.
    expect(
      sourceFolderPath({
        active_deployment: {
          source_code_path: '/Workspace/Users/someone/.bundle/player-insights-agent-dab/example/files',
          git_source: { branch: 'main', source_code_path: 'player-insights-agent/build/deploy' },
        },
      })
    ).toBe('');

    expect(sourceFolderPath({})).toBe('');
  });

  it('offers no workspace link where nothing resolved one', () => {
    // No host: an app container with no `DATABRICKS_HOST` cannot build a link
    // anybody could follow, and a dead link teaches readers the page is decor.
    expect(
      appFacts({
        read: { kind: 'ok', body: { name: 'astrolabe', active_deployment: { source_code_path: '/Workspace/a/b' } } },
      }).source.workspaceUrl
    ).toBe('');

    // A host, but the workspace reported no source path at all.
    expect(
      appFacts({
        workspaceHost: 'https://workspace.example.com',
        read: { kind: 'ok', body: { name: 'astrolabe', active_deployment: {} } },
      }).source.workspaceUrl
    ).toBe('');
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

  /** The folder id is a second workspace call, made for the running folder only. */
  it('asks the workspace for the folder id of an uploaded deployment', async () => {
    const asked: string[] = [];
    const facts = await readAppFacts({
      name: 'astrolabe',
      workspaceHost: 'https://workspace.example.com',
      read: () =>
        Promise.resolve({
          kind: 'ok',
          body: {
            name: 'astrolabe',
            url: 'https://astrolabe-<workspace-id>.aws.databricksapps.com',
            active_deployment: { source_code_path: '/Workspace/Users/operator/player-insights-agent-real-src' },
          },
        }),
      resolveFolderId: (path) => {
        asked.push(path);
        return Promise.resolve('1999001141571163');
      },
    });

    expect(asked).toEqual(['/Workspace/Users/operator/player-insights-agent-real-src']);
    expect(facts.source.workspaceUrl).toBe(
      'https://workspace.example.com/browse/folders/1999001141571163?o=<workspace-id>'
    );
  });

  it('asks nothing about a folder for a Git deployment, which has none', async () => {
    let asked = false;
    const facts = await readAppFacts({
      name: 'astrolabe',
      workspaceHost: 'https://workspace.example.com',
      read: () =>
        Promise.resolve({
          kind: 'ok',
          body: {
            name: 'astrolabe',
            url: 'https://astrolabe-<workspace-id>.aws.databricksapps.com',
            active_deployment: {
              git_source: { branch: 'main', source_code_path: 'player-insights-agent/build/deploy' },
            },
          },
        }),
      resolveFolderId: () => {
        asked = true;
        return Promise.resolve('999');
      },
    });

    expect(asked).toBe(false);
    expect(facts.source.workspaceUrl).toBe('https://workspace.example.com/apps/astrolabe?o=<workspace-id>');
  });

  /** A resolver that throws must not take the settings route with it. */
  it('survives a folder resolver that throws, and still reports the rest', async () => {
    const facts = await readAppFacts({
      name: 'astrolabe',
      workspaceHost: 'https://workspace.example.com',
      read: () =>
        Promise.resolve({
          kind: 'ok',
          body: {
            name: 'astrolabe',
            url: 'https://astrolabe-<workspace-id>.aws.databricksapps.com',
            description: 'Asks governed questions.',
            active_deployment: { source_code_path: '/Workspace/Users/operator/src' },
          },
        }),
      resolveFolderId: () => Promise.reject(new Error('refused')),
    });

    expect(facts.description).toBe('Asks governed questions.');
    expect(facts.source.workspaceUrl).toBe('https://workspace.example.com/apps/astrolabe?o=<workspace-id>');
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

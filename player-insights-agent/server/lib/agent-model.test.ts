import { describe, expect, it, vi } from 'vitest';
import { isAdminRoute } from './admin-roles';
import { readAgentModel } from './agent-model';

const HOST = 'https://example-workspace.invalid';
const MODEL = 'a_catalog.a_schema.an_agent';

/** The endpoint description, in the snake_case the REST body actually uses. */
function serving(version: string) {
  return {
    config: {
      traffic_config: { routes: [{ served_model_name: `an_agent_${version}`, traffic_percentage: 100 }] },
      served_entities: [{ name: `an_agent_${version}`, entity_name: MODEL, entity_version: version }],
    },
  };
}

describe('readAgentModel', () => {
  it('reads the model and version off the endpoint that is answering', async () => {
    const reference = await readAgentModel({
      endpointName: 'an-endpoint',
      workspaceHost: HOST,
      read: () => Promise.resolve(serving('3')),
    });

    expect(reference).toEqual({
      model: MODEL,
      version: '3',
      url: `${HOST}/explore/data/models/a_catalog/a_schema/an_agent/version/3`,
      versioned: true,
    });
  });

  it('asks the endpoint it was named, and only that one', async () => {
    const asked: string[] = [];

    await readAgentModel({
      endpointName: 'an-endpoint',
      workspaceHost: HOST,
      read: (name) => {
        asked.push(name);
        return Promise.resolve(serving('3'));
      },
    });

    expect(asked).toEqual(['an-endpoint']);
  });

  /**
   * The whole reason the endpoint is preferred over configuration. A release
   * moves the served version and writes nothing to the app container, so a link
   * built from the environment names the version somebody last deployed rather
   * than the one that produced the answer being read.
   */
  it('prefers what the endpoint serves over what the environment was told', async () => {
    const reference = await readAgentModel({
      endpointName: 'an-endpoint',
      workspaceHost: HOST,
      configuredModel: 'another_catalog.another_schema.a_stale_name',
      read: () => Promise.resolve(serving('4')),
    });

    expect(reference.model).toBe(MODEL);
    expect(reference.version).toBe('4');
  });

  // A Settings pane is what somebody opens to find out why the rest of the app
  // is misbehaving, so a refusal on this read reports no link rather than a 500.
  it('survives an endpoint that refuses to describe itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reference = await readAgentModel({
      endpointName: 'an-endpoint',
      workspaceHost: HOST,
      read: () => Promise.reject(new Error('refused')),
    });

    expect(reference.url).toBe('');
    expect(reference.model).toBe('');
    warn.mockRestore();
  });

  it('falls back to the configured name when the endpoint named none', async () => {
    const reference = await readAgentModel({
      endpointName: 'an-endpoint',
      workspaceHost: HOST,
      configuredModel: MODEL,
      read: () => Promise.resolve({}),
    });

    // The model page rather than a version, because nothing established one.
    expect(reference.url).toBe(`${HOST}/explore/data/models/a_catalog/a_schema/an_agent`);
    expect(reference.versioned).toBe(false);
  });

  /**
   * Traffic split across two versions. `parseServedModel` refuses to attribute
   * it, and so does this: the registered model is a true destination and naming
   * one of the two routes would be a guess presented as a fact.
   */
  it('opens the model rather than guessing which half of a split answered', async () => {
    const reference = await readAgentModel({
      endpointName: 'an-endpoint',
      workspaceHost: HOST,
      configuredModel: MODEL,
      read: () =>
        Promise.resolve({
          config: {
            traffic_config: {
              routes: [
                { served_model_name: 'an_agent_4', traffic_percentage: 70 },
                { served_model_name: 'an_agent_3', traffic_percentage: 30 },
              ],
            },
            served_entities: [
              { name: 'an_agent_4', entity_name: MODEL, entity_version: '4' },
              { name: 'an_agent_3', entity_name: MODEL, entity_version: '3' },
            ],
          },
        }),
    });

    expect(reference.version).toBe('');
    expect(reference.versioned).toBe(false);
  });

  /**
   * The people who most need to read the agent's code are the ones evaluating
   * its answers, and they are not administrators of the deployment. Asserted
   * against the prefix list itself so widening `/api/settings/values` to
   * `/api/settings` cannot quietly take this row away from them.
   */
  it('is readable by a consumer, like the rest of what the deployment is made of', () => {
    expect(isAdminRoute('/api/settings/agent-model')).toBe(false);
    expect(isAdminRoute('/api/settings/values')).toBe(true);
  });

  it('asks nothing at all when no endpoint is configured', async () => {
    let asked = false;

    const reference = await readAgentModel({
      endpointName: '',
      workspaceHost: HOST,
      read: () => {
        asked = true;
        return Promise.resolve(serving('3'));
      },
    });

    expect(asked).toBe(false);
    expect(reference.model).toBe('');
  });
});

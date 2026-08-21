import { describe, expect, it } from 'vitest';
import { NO_AGENT_MODEL, agentModelReference } from './agent-model';

const HOST = 'https://example-workspace.invalid';
const MODEL = 'a_catalog.a_schema.an_agent';

describe('agentModelReference', () => {
  it('addresses the served version, which is the page the code is on', () => {
    expect(agentModelReference({ host: HOST, model: MODEL, version: '3' })).toEqual({
      model: MODEL,
      version: '3',
      url: `${HOST}/explore/data/models/a_catalog/a_schema/an_agent/version/3`,
      versioned: true,
    });
  });

  /**
   * The endpoint answered and named no version, which happens on a traffic
   * split. The model page lists every version, so it is a true destination --
   * but `versioned` is false, and that is what stops the pane claiming the
   * reader is about to see the exact code that answered.
   */
  it('addresses the registered model when no version was reported', () => {
    const reference = agentModelReference({ host: HOST, model: MODEL, version: '' });

    expect(reference.url).toBe(`${HOST}/explore/data/models/a_catalog/a_schema/an_agent`);
    expect(reference.versioned).toBe(false);
  });

  // The rule `databricks-links.ts` exists for. A link built without a host lands
  // the reader in a workspace that is not theirs, so the name is carried and the
  // link is not offered at all.
  it('carries the name but offers no link without a host', () => {
    const reference = agentModelReference({ host: '', model: MODEL, version: '3' });

    expect(reference.model).toBe(MODEL);
    expect(reference.version).toBe('3');
    expect(reference.url).toBe('');
    expect(reference.versioned).toBe(false);
  });

  /**
   * `catalog.schema` addresses the SCHEMA page: a link that works and is the
   * wrong object, which on this row would show a reader somebody else's schema
   * and call it the agent's code.
   */
  it('offers no link for a name that is not three levels', () => {
    expect(agentModelReference({ host: HOST, model: 'a_schema.an_agent', version: '3' }).url).toBe('');
    expect(agentModelReference({ host: HOST, model: 'an_agent', version: '' }).url).toBe('');
  });

  it('reports nothing established for no name at all', () => {
    expect(agentModelReference({ host: HOST, model: '', version: '3' })).toEqual(NO_AGENT_MODEL);
    expect(agentModelReference({ host: HOST, model: '   ', version: '' })).toEqual(NO_AGENT_MODEL);
  });
});

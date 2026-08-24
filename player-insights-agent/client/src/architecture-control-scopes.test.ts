import { describe, expect, it } from 'vitest';

import { CHAIN_BOUNDS } from './agent-chain';
import { ARCHITECTURE_EDGES, ARCHITECTURE_NODES } from './architecture';
import {
  ARCHITECTURE_CONTROL_SCOPES,
  edgeControlBounds,
  nextActiveBound,
  nodeControlBounds,
} from './architecture-control-scopes';

const edgeKeys = ARCHITECTURE_EDGES.map((edge) => `${edge.from}->${edge.to}`);

/**
 * The dangerous failure here is a convincing but false halo. These assertions
 * therefore pin the whole membership of every scope, including the exclusions
 * that distinguish "the served model request" from "everything on the page".
 */
describe('the runtime bounds illuminate only what the agent actually bounds', () => {
  it('maps DSF steps to the finder decision loop, not to every call made inside one step', () => {
    expect(ARCHITECTURE_CONTROL_SCOPES.maxSteps.nodes).toEqual(['data-source-finder', 'llm-endpoint']);
    expect(ARCHITECTURE_CONTROL_SCOPES.maxSteps.edges).toEqual(['data-source-finder->llm-endpoint']);
    expect(nodeControlBounds('genie-data')).not.toContain('maxSteps');
  });

  it('maps the tool-call cap to Finder-owned tools and the infrastructure behind them', () => {
    expect(ARCHITECTURE_CONTROL_SCOPES.maxToolCalls.nodes).toEqual([
      'data-source-finder',
      'genie-dictionary',
      'genie-data',
      'semantic-index',
      'semantic-index-endpoint',
      'sql-warehouse',
      'catalog',
    ]);
    expect(ARCHITECTURE_CONTROL_SCOPES.maxToolCalls.edges).toEqual([
      'data-source-finder->genie-dictionary',
      'data-source-finder->genie-data',
      'data-source-finder->semantic-index',
      'data-source-finder->sql-warehouse',
      'genie-data->sql-warehouse',
      'sql-warehouse->catalog',
      'semantic-index-endpoint->semantic-index',
    ]);
    expect(nodeControlBounds('agent-endpoint')).not.toContain('maxToolCalls');
    expect(edgeControlBounds('data-source-finder', 'llm-endpoint')).not.toContain('maxToolCalls');
  });

  it('maps the run deadline to served-model work and excludes transport and storage', () => {
    expect(ARCHITECTURE_CONTROL_SCOPES.maxRunSeconds.nodes).toEqual([
      'agent-endpoint',
      'data-source-finder',
      'llm-endpoint',
      'genie-dictionary',
      'genie-data',
      'semantic-index',
      'semantic-index-endpoint',
      'sql-warehouse',
      'catalog',
    ]);
    expect(ARCHITECTURE_CONTROL_SCOPES.maxRunSeconds.edges).toEqual([
      'agent-endpoint->data-source-finder',
      'agent-endpoint->llm-endpoint',
      'data-source-finder->llm-endpoint',
      'data-source-finder->genie-dictionary',
      'data-source-finder->genie-data',
      'data-source-finder->semantic-index',
      'data-source-finder->sql-warehouse',
      'genie-data->sql-warehouse',
      'sql-warehouse->catalog',
      'semantic-index-endpoint->semantic-index',
    ]);
    for (const outside of ['browser', 'app', 'lakebase', 'experiment-id']) {
      expect(nodeControlBounds(outside), outside).not.toContain('maxRunSeconds');
    }
  });

  it('names only nodes and edges the architecture actually draws', () => {
    const nodeIds = ARCHITECTURE_NODES.map((node) => node.id);
    for (const bound of CHAIN_BOUNDS) {
      const scope = ARCHITECTURE_CONTROL_SCOPES[bound];
      expect(
        scope.nodes.every((node) => nodeIds.includes(node)),
        bound
      ).toBe(true);
      expect(
        scope.edges.every((edge) => edgeKeys.includes(edge)),
        bound
      ).toBe(true);
    }
  });

  it('gives each runtime bound its own diagram-legend family', () => {
    expect(ARCHITECTURE_CONTROL_SCOPES.maxSteps.accent).toBe('agent');
    expect(ARCHITECTURE_CONTROL_SCOPES.maxToolCalls.accent).toBe('genie');
    expect(ARCHITECTURE_CONTROL_SCOPES.maxRunSeconds.accent).toBe('question');
  });

  it('keeps a KPI selected until another is chosen or the same one is cleared', () => {
    expect(nextActiveBound(null, 'maxSteps')).toBe('maxSteps');
    expect(nextActiveBound('maxSteps', 'maxToolCalls')).toBe('maxToolCalls');
    expect(nextActiveBound('maxToolCalls', 'maxRunSeconds')).toBe('maxRunSeconds');
    expect(nextActiveBound('maxSteps', 'maxSteps')).toBeNull();
    expect(nextActiveBound('maxRunSeconds', 'maxRunSeconds')).toBeNull();
  });
});

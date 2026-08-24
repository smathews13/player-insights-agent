/**
 * Which runtime bound governs which part of the live architecture drawing.
 *
 * THIS IS AN ENFORCEMENT MAP, NOT A VISUAL GROUPING. The three scopes overlap
 * because the three server brakes do: one finder step asks the model what to do,
 * admitted tool calls happen inside those steps, and the request deadline wraps
 * both plus synthesis. A node belongs here only when the agent code checks that
 * bound before using it, or when it is the infrastructure immediately behind a
 * checked call. Keeping the map as data lets the render tests name every included
 * and excluded node rather than accepting a plausible-looking halo.
 *
 * Edge keys use the architecture model's `from->to` identity rather than the
 * drawing's `peN` ids. The latter are DOM handles; the former say what operation
 * is bounded and survive a reroute.
 */
import type { ChainBound } from './agent-chain';
import type { ArchitectureAccent } from './architecture-layout';

export interface ArchitectureControlScope {
  /** The diagram legend family this control belongs to. */
  accent: ArchitectureAccent;
  nodes: readonly string[];
  edges: readonly string[];
}

const FINDER_STEP_NODES = ['data-source-finder', 'llm-endpoint'] as const;
const FINDER_STEP_EDGES = ['data-source-finder->llm-endpoint'] as const;

/**
 * Calls admitted through `DataSourceFinder._admit_tool_call`.
 *
 * The Finder-to-node edges are the calls the setting counts. The three backing
 * edges are included because Data Genie SQL, Unity Catalog reads and Vector
 * Search serving happen inside those admitted calls; presenting those cards as
 * outside the call would split one operation at an implementation boundary.
 */
const TOOL_NODES = [
  'data-source-finder',
  'genie-dictionary',
  'genie-data',
  'semantic-index',
  'semantic-index-endpoint',
  'sql-warehouse',
  'catalog',
] as const;
const TOOL_EDGES = [
  'data-source-finder->genie-dictionary',
  'data-source-finder->genie-data',
  'data-source-finder->semantic-index',
  'data-source-finder->sql-warehouse',
  'genie-data->sql-warehouse',
  'sql-warehouse->catalog',
  'semantic-index-endpoint->semantic-index',
] as const;

/**
 * The endpoint work that shares the request deadline.
 *
 * Browser transport, the Express app, Lakebase conversation storage and MLflow
 * trace storage are deliberately absent. `runtime_settings.activate` starts the
 * deadline inside the served model request; it cannot cap work that happened
 * before invocation, and neither storage write is admitted by that deadline.
 */
const RUN_NODES = [
  'agent-endpoint',
  'data-source-finder',
  'llm-endpoint',
  'genie-dictionary',
  'genie-data',
  'semantic-index',
  'semantic-index-endpoint',
  'sql-warehouse',
  'catalog',
] as const;
const RUN_EDGES = [
  'agent-endpoint->data-source-finder',
  'agent-endpoint->llm-endpoint',
  ...FINDER_STEP_EDGES,
  ...TOOL_EDGES,
] as const;

export const ARCHITECTURE_CONTROL_SCOPES: Readonly<Record<ChainBound, ArchitectureControlScope>> = {
  maxSteps: {
    accent: 'agent',
    nodes: FINDER_STEP_NODES,
    edges: FINDER_STEP_EDGES,
  },
  maxToolCalls: {
    accent: 'genie',
    nodes: TOOL_NODES,
    edges: TOOL_EDGES,
  },
  maxRunSeconds: {
    accent: 'question',
    nodes: RUN_NODES,
    edges: RUN_EDGES,
  },
};

/**
 * Click-to-toggle for the three KPI tiles.
 *
 * Hover and focus used to set the bound and leave used to clear it, which made
 * the highlight a brief flash: the tile's own outline moved the pointer out of
 * the hit target, leave cleared the bound, and the next enter painted it again.
 * A click replaces the current bound, or clears it when the same tile is pressed
 * again. The highlight then stays until the next click.
 */
export function nextActiveBound(current: ChainBound | null, clicked: ChainBound): ChainBound | null {
  return current === clicked ? null : clicked;
}

export function nodeControlBounds(nodeId: string): ChainBound[] {
  return (Object.entries(ARCHITECTURE_CONTROL_SCOPES) as Array<[ChainBound, ArchitectureControlScope]>)
    .filter(([, scope]) => scope.nodes.includes(nodeId))
    .map(([bound]) => bound);
}

export function edgeControlBounds(from: string, to: string): ChainBound[] {
  const key = `${from}->${to}`;
  return (Object.entries(ARCHITECTURE_CONTROL_SCOPES) as Array<[ChainBound, ArchitectureControlScope]>)
    .filter(([, scope]) => scope.edges.includes(key))
    .map(([bound]) => bound);
}

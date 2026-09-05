import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ARCHITECTURE_EDGES, ARCHITECTURE_NODES, describeArchitecture, nodeReport, nodeValue } from './architecture';
import { hasRemoteEnd, readConnections, readingsById, type SettingsPayload } from './connection-model';
import { connectionStatus, driftMarker, inUseSummary } from './connection-status';
import { CONNECTED_RESOURCES, connectedResource } from '../../shared/deployment-config';
import type { PreflightCheck } from './preflight';

/**
 * The diagram and the list have to agree BY CONSTRUCTION, not by inspection.
 *
 * A second copy of the derivation would agree on the day it was written and
 * drift the first time somebody changed one of them, and the failure would be
 * silent: a diagram confidently describing a deployment that no longer exists.
 * That is worse than no diagram, because a picture is believed in a way a table
 * of eighteen rows is not.
 *
 * So these tests assert two different things, and both are needed. The
 * behavioural ones pin that a node's status and value ARE the shared reading's.
 * The source ones pin that the page has no way to compute them itself, which is
 * what stops the behavioural ones from being satisfied by a coincidence later.
 */

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

const ARCHITECTURE_PAGE = source('ArchitecturePage.tsx');
const ARCHITECTURE_MODEL = source('architecture.ts');
const CONNECTIONS_PAGE = source('ConnectionsPage.tsx');

function check(id: string, status: PreflightCheck['status'], name: string): PreflightCheck {
  return { id, label: id, status, name, detail: '', error: '', kind: 'dependency' } as unknown as PreflightCheck;
}

/**
 * A payload exercising all four badges and both markers at once: a reachable
 * connection, a blocked one, one whose measured value disagrees with its
 * configured one, one nobody checked, and one the app both resolves and applies.
 */
function fixture(): { payload: SettingsPayload; checks: PreflightCheck[] } {
  const row = (id: string, over: Partial<SettingsPayload['resources'][number]> = {}) => ({
    resource: connectedResource(id)!,
    configured: '',
    configuredFrom: 'artifact',
    actual: '',
    actualObserved: false,
    intended: null,
    intendedAt: '',
    intendedBy: '',
    editable: false,
    changedByLabel: '',
    changedByNote: '',
    ...over,
  });
  return {
    payload: {
      resources: [
        row('agent-endpoint', { configured: 'an-endpoint', actual: 'an-endpoint', actualObserved: true }),
        row('sql-warehouse', {
          configured: 'configured-warehouse',
          actual: 'a-different-warehouse',
          actualObserved: true,
        }),
        row('genie-data', { configured: 'a-space' }),
        row('lakebase', { configured: 'an-endpoint' }),
        row('catalog', { configured: 'a_catalog' }),
        row('experiment-id', { configured: '123' }),
        row('llm-endpoint', { configured: 'a-model' }),
        row('genie-dictionary', { configured: 'another-space', intended: 'a-third-space' }),
      ],
      drift: [
        {
          id: 'mismatch-sql-warehouse',
          severity: 'blocking',
          resourceId: 'sql-warehouse',
          headline: '',
          detail: '',
          remedy: '',
        },
        {
          id: 'pending-genie-dictionary',
          severity: 'pending',
          resourceId: 'genie-dictionary',
          headline: '',
          detail: '',
          remedy: '',
        },
      ],
      status: 'blocked',
      appBuildSha: '',
      modelBuildSha: '',
      orchestratorReported: true,
      storeAvailable: true,
      checkedAt: '',
    },
    checks: [
      check('agent-endpoint', 'ok', 'an-endpoint'),
      check('sql-warehouse', 'ok', 'a-different-warehouse'),
      check('genie-data', 'failed', ''),
      check('lakebase-storage', 'unverified', ''),
    ],
  };
}

describe('a node reports what the shared derivation says, and nothing else', () => {
  it('maps the shared detailed status without upgrading unknown evidence to failure', () => {
    const { payload, checks } = fixture();
    const byResource = readingsById(readConnections(payload, checks));

    for (const node of ARCHITECTURE_NODES) {
      if (!node.resourceId) continue;
      const reading = byResource.get(node.resourceId);
      if (!reading) continue;
      // Recomputed here from the primitives the Connections page badges with,
      // so this fails if the diagram ever grows its own interpretation.
      const check = checks.find((candidate) => candidate.id === reading.resource.actualFromCheck);
      const expected = connectionStatus({
        check,
        hasRemoteEnd: hasRemoteEnd(reading.row, check),
      });
      expect(reading.status, node.id).toBe(expected);
      const label =
        expected === 'reachable'
          ? 'Connected'
          : expected === 'blocked'
            ? 'Disconnected'
            : expected === 'refused' || expected === 'unreachable'
              ? 'Unavailable'
              : expected === 'nothing-to-reach'
                ? 'Not configured'
                : 'Not checked';
      expect(nodeReport(node, reading).label, node.id).toBe(label);
    }
  });

  it('shows the value the collapsed row on Connections shows, by the same rule', () => {
    const { payload, checks } = fixture();
    const byResource = readingsById(readConnections(payload, checks));
    for (const row of payload.resources) {
      const reading = byResource.get(row.resource.id);
      if (!reading) continue;
      expect(reading.summary).toEqual(inUseSummary(row));
      const node = ARCHITECTURE_NODES.find((candidate) => candidate.resourceId === row.resource.id);
      if (!node) continue;
      const shown = nodeValue(reading);
      if (inUseSummary(row).value) expect(shown, node.id).toEqual(inUseSummary(row));
      else expect(shown, node.id).toBeNull();
    }
  });

  it('marks drift where the shared derivation marks it, and only there', () => {
    const { payload, checks } = fixture();
    const byResource = readingsById(readConnections(payload, checks));
    for (const row of payload.resources) {
      const expected = driftMarker({
        findingIds: payload.drift.filter((f) => f.resourceId === row.resource.id).map((f) => f.id),
        intended: null,
      });
      const reading = byResource.get(row.resource.id);
      if (!reading) continue;
      expect(reading.marker, row.resource.id).toBe(expected);
    }
    // The case the diagram exists to surface: a warehouse that answered, under
    // an id that is not the configured one. Drifted, and NOT blocked -- it
    // answered.
    const warehouse = byResource.get('sql-warehouse')!;
    expect(warehouse.marker).toBe('drift');
    expect(warehouse.status).toBe('reachable');
    expect(warehouse.disagrees).toBe(true);
  });

  it('says drift in the text equivalent and hides legacy pending intentions', () => {
    const { payload, checks } = fixture();
    const lines = describeArchitecture(readingsById(readConnections(payload, checks)));
    expect(lines.some((line) => /SQL warehouse/.test(line) && /drifted/i.test(line))).toBe(true);
    expect(lines.some((line) => /has not been applied/i.test(line))).toBe(false);
  });
});

describe('the page has no way to derive a status for itself', () => {
  /**
   * The real guard. If the page can call these, a later edit can quietly make
   * it disagree with Connections and every behavioural test above still passes,
   * because they would be testing the module rather than the page.
   */
  it('does not import the status primitives into the page', () => {
    for (const primitive of ['connectionStatus', 'driftMarker', 'inUseSummary', 'connectionCounts']) {
      expect(ARCHITECTURE_PAGE, `${primitive} is not called in the page`).not.toContain(`${primitive}(`);
    }
  });

  it('reads its statuses through connection-model, as the Connections page does', () => {
    expect(ARCHITECTURE_PAGE).toMatch(/from '\.\/connection-model'/);
    expect(CONNECTIONS_PAGE).toMatch(/from '\.\/connection-model'/);
    expect(ARCHITECTURE_PAGE).toMatch(/readConnections/);
  });

  it('owns settled and neutral Architecture connection labels', () => {
    expect(ARCHITECTURE_MODEL).toContain("'Connected'");
    expect(ARCHITECTURE_MODEL).toContain("'Disconnected'");
    expect(ARCHITECTURE_MODEL).toContain("'Not checked'");
    expect(ARCHITECTURE_MODEL).toContain("'Unavailable'");
    expect(ARCHITECTURE_MODEL).not.toMatch(/label:\s*'(Reachable|Blocked|Unreachable|Refused)'/);
  });

  it('gives the Connections page no second derivation to drift from', () => {
    // It called these inline, twice, before the lift. One caller each now, in
    // connection-model.ts.
    expect(CONNECTIONS_PAGE).not.toContain('connectionStatus(');
    expect(CONNECTIONS_PAGE).not.toContain('driftMarker(');
    expect(CONNECTIONS_PAGE).not.toContain('connectionCounts(');
  });
});

describe('every node that names a dependency names a real one', () => {
  it('maps each resource-backed node to an entry in the registry', () => {
    const ids = new Set(CONNECTED_RESOURCES.map((resource) => resource.id));
    for (const node of ARCHITECTURE_NODES) {
      if (!node.resourceId) continue;
      expect(ids.has(node.resourceId), `${node.id} names a real resource`).toBe(true);
    }
  });

  it('names each resource at most once, so one connection is one node', () => {
    const named = ARCHITECTURE_NODES.map((node) => node.resourceId).filter(Boolean);
    expect(named.length).toBe(new Set(named).size);
  });

  /**
   * The nodes the amendment lists by name. A node quietly dropped from the
   * diagram is a dependency the reader stops knowing about.
   */
  it('draws the warehouse, both Genie spaces, the endpoint, Lakebase and the experiment', () => {
    const drawn = new Set(ARCHITECTURE_NODES.map((node) => node.resourceId));
    for (const required of [
      'agent-endpoint',
      'llm-endpoint',
      'genie-data',
      'genie-dictionary',
      'sql-warehouse',
      'catalog',
      'lakebase',
      'experiment-id',
    ]) {
      expect(drawn.has(required), `${required} is on the diagram`).toBe(true);
    }
  });

  it('links every resource-backed node to its row on Connections', () => {
    // The in-app link is the one that must always work, so it is built from the
    // resource id rather than from anything the deployment reported.
    expect(ARCHITECTURE_PAGE).toMatch(/entityHref\(node\.resourceId\)/);
  });

  it('connects only nodes it has drawn', () => {
    const drawn = new Set(ARCHITECTURE_NODES.map((node) => node.id));
    for (const edge of ARCHITECTURE_EDGES) {
      expect(drawn.has(edge.from), `${edge.from} is a node`).toBe(true);
      expect(drawn.has(edge.to), `${edge.to} is a node`).toBe(true);
    }
  });
});

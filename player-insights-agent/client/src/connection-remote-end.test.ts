/**
 * Which rows can honestly be given a reachability verdict, and which cannot.
 *
 * THE DEFECT THIS PINS. `Not checked` used to be decided by `agentKey`, which
 * records who OWNS a value rather than whether anything is on the other end of
 * it. So three orchestrator settings that name no object anywhere -- the answer
 * length limit and both catalog pattern lists -- sat permanently under a heading
 * promising a reachability verdict that no check could ever deliver, and two more
 * did it whenever they were legitimately unset.
 *
 * The registry declares it now, per resource, and these assert both halves: that
 * every entry states its answer, and that the answer produces the badge a reader
 * can act on.
 */
import { describe, expect, it } from 'vitest';
import { hasRemoteEnd, readConnection, type ResourceRow } from './connection-model';
import { CONNECTED_RESOURCES, connectedResource } from '../../shared/deployment-config';
import type { PreflightCheck } from './preflight';

function row(id: string, over: Partial<ResourceRow> = {}): ResourceRow {
  return {
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
  };
}

function check(id: string, status: PreflightCheck['status']): PreflightCheck {
  return {
    id,
    kind: 'dependency',
    name: '',
    label: id,
    status,
    detail: '',
    checked_with: '',
    duration_ms: 0,
    error: '',
    remedy: null,
  };
}

function statusOf(id: string, over: Partial<ResourceRow> = {}, probe?: PreflightCheck) {
  return readConnection({ row: row(id, over), check: probe, findings: [] }).status;
}

/**
 * The settings: values with no remote object, whatever owns them.
 *
 * Written out rather than derived from the flag, so a later edit that flips one
 * has to change this list and say why. The last two are objects that exist and
 * still belong here: nothing in this deployment opens the assets volume. The
 * experiment moved out when its runtime resolver gained a real existence probe.
 */
const SETTINGS = [
  'catalog-allowlist',
  'catalog-denylist',
  'max-output-tokens',
  'lakebase-schema',
  'assets-volume',
  'shared-conversation-rail',
];

describe('the registry says whether a value names anything to reach', () => {
  it('states an answer for every connection, so none of them defaults', () => {
    for (const resource of CONNECTED_RESOURCES) {
      expect(typeof resource.namesRemoteObject, resource.id).toBe('boolean');
    }
  });

  it('marks the settings, and only the settings', () => {
    const local = CONNECTED_RESOURCES.filter((resource) => !resource.namesRemoteObject).map((r) => r.id);
    expect(local.sort()).toEqual([...SETTINGS].sort());
  });

  // The three that were wrong on the live deployment, named individually so a
  // regression says which one came back.
  it.each(['catalog-allowlist', 'catalog-denylist', 'max-output-tokens'])(
    'never promises a reachability verdict for %s',
    (id) => {
      expect(statusOf(id, { configured: 'something' })).toBe('nothing-to-reach');
    }
  );
});

describe('an unset value is not an unchecked one', () => {
  // Unset is the AI Gateway route's correct and default state on every target,
  // and the semantic index's on any release logged without one. A row reading
  // "Not checked" over an empty value promises an answer nobody is coming with.
  it.each(['llm-gateway', 'semantic-index'])('reads unset %s as nothing to reach', (id) => {
    expect(statusOf(id)).toBe('nothing-to-reach');
  });

  it('reads the same rows as not checked once they name something', () => {
    expect(statusOf('llm-gateway', { configured: 'a-route' })).toBe('not-checked');
    expect(statusOf('semantic-index', { configured: 'a.b.c' })).toBe('not-checked');
  });
});

describe('a check that ran outranks all of it', () => {
  it('takes the verdict from the check even where nothing was expected to answer', () => {
    expect(statusOf('experiment-id', { configured: '123' }, check('experiment-id', 'ok'))).toBe('reachable');
    expect(statusOf('max-output-tokens', {}, check('max-output-tokens', 'failed'))).toBe('blocked');
  });

  it('counts a measured value as a remote end even with nothing configured', () => {
    // The Vector Search endpoint's name is held only by the check that asked
    // about it, so its row is empty and its reading still has to be a verdict.
    expect(hasRemoteEnd(row('semantic-index-endpoint', { actual: 'an-endpoint' }))).toBe(true);
  });
});

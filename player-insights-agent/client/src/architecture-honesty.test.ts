import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_EDGES,
  ARCHITECTURE_NODES,
  LOCAL_NOTE,
  SEMANTIC_ENDPOINT_NO_INDEX,
  SEMANTIC_ENDPOINT_UNNAMED,
  SEMANTIC_ENDPOINT_UNREPORTED,
  SEMANTIC_INDEX_ABSENT,
  SEMANTIC_INDEX_UNREPORTED,
  architectureNode,
  describeArchitecture,
  nodeAccessibleName,
  nodeContentAge,
  nodeReport,
  nodeValue,
  semanticEndpointState,
  semanticIndexState,
  staleContent,
} from './architecture';
import {
  CONTENT_AGE_UNREPORTED_LABEL,
  REBUILD_INTERVAL_HOURS,
  STALE_AFTER_HOURS,
  STALE_AFTER_REBUILDS,
} from './semantic-freshness';
import { NODE_FAMILY } from './ArchitecturePage';
import { readConnections, readingsById, type ResourceRow, type SettingsPayload } from './connection-model';
import { CONNECTION_STATUS_LABEL } from './connection-status';
import { ENTITY_PARAM, entityHref } from './data-entities';
import { CONNECTED_RESOURCES, connectedResource } from '../../shared/deployment-config';
import type { PreflightCheck } from './preflight';

/**
 * A diagram states things with more confidence than a table does, so the rules
 * about what this app may claim bind harder here than anywhere else.
 *
 * The reference app this page's structure came from prints "~2 min", "30s",
 * "6s ago", "1,244". Those are its real numbers, read from its own deployment.
 * There is no honest way to carry them across, and a plausible figure on a
 * diagram is worse than a blank one, because nobody checks a number that looks
 * right.
 */

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

const PAGE = source('ArchitecturePage.tsx');
const MODEL = source('architecture.ts');
const LAYOUT = source('architecture-layout.ts');
const FRESHNESS = source('semantic-freshness.ts');
const CSS = readFileSync(fileURLToPath(new URL('./styles/architecture.css', import.meta.url)), 'utf8');

/**
 * Source with its commentary removed.
 *
 * The scans below look for figures that could reach the page. A comment saying
 * which figures this page refuses to print is the opposite of the defect, and a
 * test that fails on it teaches people to delete the explanation.
 */
function code(file: string): string {
  return file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function row(id: string, over: Record<string, unknown> = {}) {
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
  } as SettingsPayload['resources'][number];
}

function payload(rows: SettingsPayload['resources']): SettingsPayload {
  return {
    resources: rows,
    drift: [],
    status: 'unknown',
    appBuildSha: '',
    modelBuildSha: '',
    orchestratorReported: false,
    storeAvailable: false,
    checkedAt: '',
  };
}

describe('nothing on the page is a figure that was not read', () => {
  it('shows no identifier for a connection the deployment has not named', () => {
    const readings = readingsById(readConnections(payload([row('sql-warehouse')]), []));
    expect(nodeValue(readings.get('sql-warehouse'))).toBeNull();
  });

  it('shows no identifier at all before anything has been read', () => {
    for (const node of ARCHITECTURE_NODES) {
      expect(nodeValue(undefined), node.id).toBeNull();
    }
  });

  it('says whether a value was measured or only configured, every time it shows one', () => {
    const configured = readingsById(readConnections(payload([row('sql-warehouse', { configured: 'an-id' })]), []));
    expect(nodeValue(configured.get('sql-warehouse'))).toEqual({ value: 'an-id', measured: false });

    const measured = readingsById(
      readConnections(payload([row('sql-warehouse', { configured: 'an-id', actual: 'an-id', actualObserved: true })]), [])
    );
    expect(nodeValue(measured.get('sql-warehouse'))).toEqual({ value: 'an-id', measured: true });

    // And the distinction survives into the text equivalent, where it is the
    // only thing carrying it.
    const lines = describeArchitecture(configured);
    expect(lines.some((line) => /Nothing has measured what it is actually using/.test(line))).toBe(true);
  });

  it('carries none of the reference app\u2019s numbers, nor invented equivalents', () => {
    for (const file of [PAGE, MODEL, LAYOUT]) {
      // Durations and counts of the kind that page prints beside a node.
      expect(code(file)).not.toMatch(/~\s*\d+\s*(min|sec|s\b)/i);
      expect(code(file)).not.toMatch(/\d+\s*(ms|s) ago/i);
      expect(code(file)).not.toMatch(/\b\d{1,3},\d{3}\b/);
    }
  });

  it('never spells a latency, a row count or a freshness as a fixed string', () => {
    for (const node of ARCHITECTURE_NODES) {
      expect(node.role, node.id).not.toMatch(/\b\d+\s*(ms|seconds?|minutes?|rows?|queries)\b/i);
    }
    for (const edge of ARCHITECTURE_EDGES) {
      expect(edge.meaning, `${edge.from}->${edge.to}`).not.toMatch(/\b\d+\s*(ms|seconds?|minutes?|rows?)\b/i);
    }
  });
});

describe('a check that did not run is not a component that is broken', () => {
  it('reads an unverified check as not checked, never as blocked', () => {
    const unverified = { id: 'warehouse', status: 'unverified', name: '' } as unknown as PreflightCheck;
    const resource = connectedResource('sql-warehouse')!;
    const readings = readingsById(
      readConnections(payload([row('sql-warehouse')]), [{ ...unverified, id: resource.actualFromCheck! }])
    );
    const report = nodeReport(ARCHITECTURE_NODES.find((node) => node.id === 'sql-warehouse')!, readings.get('sql-warehouse'));
    expect(report.tone).toBe('not-checked');
    expect(report.label).not.toMatch(/blocked/i);
    expect(report.note).not.toMatch(/fail|broken|missing/i);
  });

  it('starts every dependency at not checked on a page load that probed nothing', () => {
    // The cheap read is the default, so this is what the diagram says most of
    // the time it is looked at. It must not resolve to a green graph.
    for (const node of ARCHITECTURE_NODES) {
      if (node.presence !== 'connection') continue;
      const report = nodeReport(node, undefined);
      expect(report.tone, node.id).toBe('not-checked');
      expect(report.label, node.id).toBe('Not checked');
    }
  });

  it('keeps not-checked, blocked and nothing-to-reach three different words', () => {
    const words = ['not-checked', 'blocked', 'nothing-to-reach'].map(
      (status) => nodeReport(
          { ...ARCHITECTURE_NODES[2], presence: 'connection' },
          { status, marker: 'none', summary: { value: '', measured: false } } as never
        ).label
    );
    expect(new Set(words).size).toBe(3);
    expect(words).toEqual(['Not checked', 'Blocked', 'Nothing to reach']);
  });

  it('does not colour a node it has not checked', () => {
    // Only the two statuses a probe actually established take a colour. The
    // other four are neutral, which is the treatment the Connections page gives
    // the same statuses -- an unrun check is not a finding, and tinting it would
    // make the page look like it had found four problems on a clean load.
    //
    // Read off the tone-to-family map rather than off the stylesheet, because
    // the per-tone rules the page used to carry are gone: the pills compose the
    // one shared recipe now, and the map is where a node's tone becomes a
    // colour. A tinted family here is the only way a node can be coloured.
    const tinted = Object.entries(NODE_FAMILY)
      .filter(([, family]) => family !== 'neutral-outline' && family !== 'neutral')
      .map(([tone]) => tone);
    expect(new Set(tinted)).toEqual(new Set(['reachable', 'blocked']));
    // And the two that ARE tinted take the families their words mean.
    expect(NODE_FAMILY.reachable).toBe('pos');
    expect(NODE_FAMILY.blocked).toBe('neg');
  });
});

describe('the optional component reports which of its three states it is in', () => {
  /**
   * A reading for the semantic index node, through the real derivation.
   *
   * `configuredFrom` is the whole subject here: the orchestrator writes this
   * setting whether or not it names an index, so a source at all means the served
   * version answered, and no source means no version was asked in a way it could
   * answer. Built through `readConnections` rather than as a literal so it cannot
   * pass against a shape the server does not send.
   */
  function indexReading(over: Partial<ResourceRow>) {
    const payload: SettingsPayload = {
      resources: [
        {
          resource: connectedResource('semantic-index')!,
          configured: '',
          configuredFrom: '',
          actual: '',
          actualObserved: false,
          intended: null,
          intendedAt: '',
          intendedBy: '',
          editable: false,
          changedByLabel: '',
          changedByNote: '',
          ...over,
        },
      ],
      drift: [],
      status: 'ok',
      appBuildSha: '',
      modelBuildSha: '',
      orchestratorReported: true,
      storeAvailable: true,
      checkedAt: '',
    };
    return readingsById(readConnections(payload, [])).get('semantic-index')!;
  }

  const node = ARCHITECTURE_NODES.find((candidate) => candidate.id === 'semantic-index')!;

  it('draws the semantic index whether or not the deployment has one', () => {
    expect(ARCHITECTURE_NODES.some((candidate) => candidate.id === 'semantic-index')).toBe(true);
  });

  it('reads a release with no index as a deployment, not as a gap', () => {
    const report = nodeReport(node, indexReading({ configuredFrom: 'artifact' }));
    expect(report.note).toBe(SEMANTIC_INDEX_ABSENT);
    expect(report.tone).toBe('nothing-to-reach');
    // The distinction this test exists for: not the sentence about being unable
    // to see, which was what every release used to get.
    expect(report.note).not.toMatch(/unknown|cannot see|does not report/i);
  });

  it('separates a version too old to report it from one that reported none', () => {
    const report = nodeReport(node, indexReading({ configuredFrom: '' }));
    expect(report.note).toBe(SEMANTIC_INDEX_UNREPORTED);
    expect(report.tone).toBe('unreadable');
    expect(report.note).toMatch(/does not mean there is no index/);
    expect(report.label).not.toMatch(/reachable|blocked/i);
  });

  it('shows the index it searches, graded like any other connection, when there is one', () => {
    const reading = indexReading({
      configured: 'a_catalog.a_schema.an_index',
      configuredFrom: 'artifact',
    });
    const report = nodeReport(node, reading);
    expect(report.note).not.toBe(SEMANTIC_INDEX_ABSENT);
    expect(report.note).not.toBe(SEMANTIC_INDEX_UNREPORTED);
    expect(nodeValue(reading)?.value).toBe('a_catalog.a_schema.an_index');
  });

  it('does not give the browser or the app a status that means a probe answered', () => {
    for (const id of ['browser', 'app']) {
      const report = nodeReport(ARCHITECTURE_NODES.find((node) => node.id === id)!, undefined);
      expect(report.tone).toBe('local');
      expect(report.note).toBe(LOCAL_NOTE);
      expect(report.label).not.toMatch(/reachable/i);
    }
  });
});

/**
 * The two objects in the semantic lane, and why they are two.
 *
 * Both failures this section is written against happened, days apart, on this
 * deployment. The endpoint ran and billed for five days while nothing searched
 * it; the index went stale on its own schedule while the endpoint under it was
 * perfectly healthy. Drawn as one card, those two are the same picture -- so
 * every state below has to stay a different state, and the endpoint has to be
 * gradeable while the index is fine and the other way round.
 */
describe('the semantic lane is two objects, and one can fail without the other', () => {
  const INDEX = 'semantic-index';
  const ENDPOINT = 'semantic-index-endpoint';

  function check(id: string, status: string, name = ''): PreflightCheck {
    return { id, label: id, status, name, detail: '', error: '', kind: 'dependency' } as unknown as PreflightCheck;
  }

  /**
   * Both readings, through the real derivation.
   *
   * The rows are the two the server sends for these registry entries: the index
   * carries what the orchestrator reported, and the endpoint's row is empty
   * because nothing configures it -- its name is only ever read back from the
   * index. Built through `readConnections` so a state here cannot be one this
   * app would never produce.
   */
  function lane(input: { index?: Partial<ResourceRow>; checks?: PreflightCheck[] }) {
    const payload: SettingsPayload = {
      resources: [row(INDEX, { configuredFrom: '', ...input.index }), row(ENDPOINT, { configuredFrom: '' })],
      drift: [],
      status: 'ok',
      appBuildSha: '',
      modelBuildSha: '',
      orchestratorReported: true,
      storeAvailable: true,
      checkedAt: '',
    };
    const readings = readingsById(readConnections(payload, input.checks ?? []));
    return { index: readings.get(INDEX), endpoint: readings.get(ENDPOINT) };
  }

  function reports(input: { index?: Partial<ResourceRow>; checks?: PreflightCheck[] }) {
    const { index, endpoint } = lane(input);
    return {
      index: nodeReport(architectureNode(INDEX)!, index, index),
      endpoint: nodeReport(architectureNode(ENDPOINT)!, endpoint, index),
      readings: { index, endpoint },
    };
  }

  /** A release with an index, which is the precondition for the endpoint states. */
  const CONFIGURED = { configured: 'a_catalog.a_schema.an_index', configuredFrom: 'artifact' };

  it('draws the endpoint as its own card, in the same lane as the index', () => {
    const endpoint = architectureNode(ENDPOINT);
    expect(endpoint, 'the endpoint is on the drawing').toBeDefined();
    expect(endpoint!.lane).toBe('semantic');
    expect(endpoint!.resourceId).toBe(ENDPOINT);
    expect(architectureNode(INDEX)!.lane).toBe('semantic');
  });

  it('says the index is served by the endpoint, and searched by the finder agent', () => {
    // The two relationships are different and the drawing states both. An edge
    // from the finder to the endpoint would say a search goes there directly;
    // an edge only from the finder to the index would leave the
    // endpoint on the page with nothing joining it to anything.
    const serves = ARCHITECTURE_EDGES.find((edge) => edge.from === ENDPOINT && edge.to === INDEX);
    const searches = ARCHITECTURE_EDGES.find((edge) => edge.from === 'data-source-finder' && edge.to === INDEX);
    expect(serves, 'the endpoint serves the index').toBeDefined();
    expect(searches, 'the finder searches the index').toBeDefined();
    expect(ARCHITECTURE_EDGES.some((edge) => edge.to === ENDPOINT)).toBe(false);
  });

  it('reads a release with no index as a deployment, on both cards, in different words', () => {
    const { index, endpoint } = reports({ index: { configuredFrom: 'artifact' } });
    expect(index.note).toBe(SEMANTIC_INDEX_ABSENT);
    expect(endpoint.note).toBe(SEMANTIC_ENDPOINT_NO_INDEX);
    expect(index.tone).toBe('nothing-to-reach');
    expect(endpoint.tone).toBe('nothing-to-reach');
    // Not a fault on either card, and not a claim that a probe was refused.
    for (const report of [index, endpoint]) {
      expect(report.note).not.toMatch(/unknown|cannot see|does not report|refus/i);
    }
  });

  it('separates a version too old to report the setting from one that reported none', () => {
    const { index, endpoint } = reports({ index: { configuredFrom: '' } });
    expect(index.note).toBe(SEMANTIC_INDEX_UNREPORTED);
    expect(endpoint.note).toBe(SEMANTIC_ENDPOINT_UNREPORTED);
    expect(index.tone).toBe('unreadable');
    expect(endpoint.tone).toBe('unreadable');
    expect(index.note).not.toBe(SEMANTIC_INDEX_ABSENT);
    expect(endpoint.note).not.toBe(SEMANTIC_ENDPOINT_NO_INDEX);
  });

  it('says nobody has looked yet, rather than that there is nothing to look at', () => {
    // The state the page opens in on a deployment that does search an index.
    const { index, endpoint } = reports({ index: CONFIGURED });
    expect(index.label).toBe(CONNECTION_STATUS_LABEL['not-checked']);
    expect(endpoint.label).toBe(CONNECTION_STATUS_LABEL['not-checked']);
    expect(index.tone).toBe('not-checked');
    expect(endpoint.tone).toBe('not-checked');
  });

  it('grades each object on its own check once the checks have run', () => {
    const both = reports({
      index: CONFIGURED,
      checks: [
        check(INDEX, 'ok', 'a_catalog.a_schema.an_index'),
        check(ENDPOINT, 'ok', 'an-endpoint'),
      ],
    });
    expect(both.index.label).toBe(CONNECTION_STATUS_LABEL.reachable);
    expect(both.endpoint.label).toBe(CONNECTION_STATUS_LABEL.reachable);
  });

  /**
   * The reason for the whole card. An endpoint nothing can reach, under an index
   * that answered, has to read differently from an index nothing can reach.
   */
  it('reports a healthy index on an endpoint that did not answer', () => {
    const { index, endpoint } = reports({
      index: CONFIGURED,
      checks: [check(INDEX, 'ok', 'a_catalog.a_schema.an_index'), check(ENDPOINT, 'failed')],
    });
    expect(index.label).toBe(CONNECTION_STATUS_LABEL.reachable);
    expect(endpoint.label).toBe(CONNECTION_STATUS_LABEL.blocked);
    expect(index.tone).toBe('reachable');
    expect(endpoint.tone).toBe('blocked');
  });

  it('does not blame the endpoint for an index that was refused', () => {
    // Nothing names the endpoint but the index, so an index that did not answer
    // leaves the endpoint unasked -- which is not the same as unhealthy, and not
    // the same as nobody having pressed the button.
    const { index, endpoint } = reports({ index: CONFIGURED, checks: [check(INDEX, 'failed')] });
    expect(index.label).toBe(CONNECTION_STATUS_LABEL.blocked);
    expect(endpoint.label).toBe(CONNECTION_STATUS_LABEL['not-checked']);
    expect(endpoint.tone).toBe('not-checked');
    expect(endpoint.note).toBe(SEMANTIC_ENDPOINT_UNNAMED);
  });

  /**
   * Distinct WITHIN a card, which is the claim that matters and is not the same
   * as distinct across both. "Reachable" means the same thing on either card and
   * is deliberately the same word -- the status vocabulary is shared, and giving
   * this lane its own synonyms is how a second vocabulary starts. What may never
   * collapse is two states of ONE object reading alike, because that is the
   * reader mistaking a deployment that has no index for one nobody has asked.
   */
  it('keeps the index\u2019s five states apart, so no two of them read the same', () => {
    const cases = [
      reports({ index: { configuredFrom: 'artifact' } }).index, // no index at all
      reports({ index: { configuredFrom: '' } }).index, // the version did not say
      reports({ index: CONFIGURED }).index, // configured, nobody looked
      reports({ index: CONFIGURED, checks: [check(INDEX, 'ok', 'an_index')] }).index,
      reports({ index: CONFIGURED, checks: [check(INDEX, 'failed')] }).index,
    ];
    expect(new Set(cases.map((report) => `${report.label}|${report.note}`)).size).toBe(cases.length);
  });

  it('keeps the endpoint\u2019s states apart too, including its two kinds of unchecked', () => {
    const online = [check(INDEX, 'ok', 'an_index')];
    const cases = [
      reports({ index: { configuredFrom: 'artifact' } }).endpoint, // nothing to serve
      reports({ index: { configuredFrom: '' } }).endpoint, // the version did not say
      reports({ index: CONFIGURED }).endpoint, // nobody has looked
      reports({ index: CONFIGURED, checks: [check(INDEX, 'failed')] }).endpoint, // unnamed
      reports({ index: CONFIGURED, checks: [...online, check(ENDPOINT, 'ok', 'an-endpoint')] }).endpoint,
      reports({ index: CONFIGURED, checks: [...online, check(ENDPOINT, 'failed')] }).endpoint,
    ];
    expect(new Set(cases.map((report) => `${report.label}|${report.note}`)).size).toBe(cases.length);
  });

  it('shows the endpoint name the workspace reported, since nothing configures it', () => {
    // The one connection whose identifier exists nowhere in configuration: the
    // index reports it, the probe reads it back, and the card shows it as
    // measured rather than as something a deployer typed.
    const { readings } = reports({
      index: CONFIGURED,
      checks: [check(INDEX, 'ok', 'a_catalog.a_schema.an_index'), check(ENDPOINT, 'ok', 'an-endpoint')],
    });
    expect(nodeValue(readings.endpoint)).toEqual({ value: 'an-endpoint', measured: true });
  });

  it('states both cards in the words the diagram is read as', () => {
    const { index, endpoint } = lane({
      index: CONFIGURED,
      checks: [check(INDEX, 'ok', 'a_catalog.a_schema.an_index'), check(ENDPOINT, 'failed')],
    });
    const lines = describeArchitecture(new Map([[INDEX, index!], [ENDPOINT, endpoint!]]));
    expect(lines.some((line) => line.startsWith('Vector Search index:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('Vector Search endpoint:'))).toBe(true);
    // And the two are graded differently in the words, not only in the pills.
    expect(lines.find((line) => line.startsWith('Vector Search index:'))).toContain(
      CONNECTION_STATUS_LABEL.reachable
    );
    expect(lines.find((line) => line.startsWith('Vector Search endpoint:'))).toContain(
      CONNECTION_STATUS_LABEL.blocked
    );
  });
});

/**
 * The reading that would have caught the outage nobody was told about.
 *
 * The rebuild job failed every night from 11 to 15 August. The index answered
 * every probe throughout, so every surface that watched it stayed green while
 * it searched vocabulary written on the 10th -- including a title that is not
 * in the tables any more. Reachability was never the question, and this section
 * is the question nobody was asking.
 *
 * Two rules run through all of it. THE AGE IS READ, NEVER COMPUTED FROM WHAT IS
 * TO HAND: the probe's `content_at` or nothing, because the check time and the
 * page's own clock are both always available and both mean the moment somebody
 * asked. And AN OLD INDEX IS NOT AN UNREACHABLE ONE: the status word must go on
 * meaning what it means everywhere else on the page.
 */
describe('an index that answers is not an index that is current', () => {
  const INDEX = 'semantic-index';
  const HOUR = 3_600_000;
  const NOW = Date.parse('2026-08-15T09:00:00Z');
  const CONFIGURED = { configured: 'a_catalog.a_schema.an_index', configuredFrom: 'artifact' };

  function check(id: string, status: string, over: Partial<PreflightCheck> = {}): PreflightCheck {
    return {
      id,
      label: id,
      status,
      name: '',
      detail: '',
      error: '',
      kind: 'dependency',
      ...over,
    } as unknown as PreflightCheck;
  }

  /** The index's reading, through the real derivation, with a check on it. */
  function indexReading(status: string, over: Partial<PreflightCheck> = {}) {
    const built: SettingsPayload = {
      ...payload([row(INDEX, CONFIGURED)]),
      // The page's own last-check time, set, and set to NOW. Any test below
      // that passes only because the age fell back to this would be reading
      // "checked a moment ago" as "rebuilt a moment ago", which is the bug.
      checkedAt: new Date(NOW).toISOString(),
    };
    return readingsById(readConnections(built, [check(INDEX, status, over)])).get(INDEX);
  }

  function age(status: string, over: Partial<PreflightCheck> = {}, now = NOW) {
    return nodeContentAge(architectureNode(INDEX)!, indexReading(status, over), now);
  }

  it('reports how old the content is, from the time the probe brought back', () => {
    const five = age('ok', { content_at: new Date(NOW - 5 * 24 * HOUR).toISOString() });
    expect(five?.state).toBe('stale');
    expect(five?.hours).toBe(120);
    expect(five?.label).toContain('5 d');
  });

  /**
   * The one that has to fail if anybody ever reaches for a substitute.
   *
   * Every ingredient for a plausible-looking timestamp is in scope at the point
   * this is drawn: the check ran, the page recorded when, and `Date.now()` is a
   * character away. Each of them would render as a fresh index.
   */
  it('says the age is not reported, rather than showing a time it has to hand', () => {
    const none = age('ok');
    expect(none?.state).toBe('unreported');
    expect(none?.label).toBe(CONTENT_AGE_UNREPORTED_LABEL);
    expect(none?.hours).toBeNull();
    // No number of any kind: a fabricated age is a number, and this is the one
    // assertion that holds however the substitution is spelled.
    expect(none?.label).not.toMatch(/\d/);
    expect(none?.note).not.toMatch(/\d/);
    // And it must not read as current, which is the softer version of the same
    // failure -- a card that says "up to date" when nothing said so.
    expect(none?.label).not.toMatch(/fresh|current|up to date|rebuilt/i);
  });

  it('refuses a time that cannot be an age instead of rounding it to now', () => {
    const ahead = age('ok', { content_at: new Date(NOW + 6 * HOUR).toISOString() });
    expect(ahead?.state).toBe('unreported');
    expect(ahead?.hours).toBeNull();
    expect(ahead?.label).not.toMatch(/rebuilt/i);
    const nonsense = age('ok', { content_at: 'the tenth' });
    expect(nonsense?.state).toBe('unreported');
  });

  it('never computes an age from anything but the timestamp it was given', () => {
    // The call site, read out of the module. `content_at` is the only field it
    // is allowed to pass, and there is no second call anywhere to smuggle one.
    const calls = [...code(MODEL).matchAll(/contentAge\(([^)]*)\)/g)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toMatch(/content_at/);
    // And the module that decides the words reads no clock of its own, so it
    // cannot quietly answer with the time of the render.
    expect(code(FRESHNESS)).not.toMatch(/Date\.now\(\)/);
    expect(code(FRESHNESS)).not.toMatch(/checked_?[Aa]t/);
  });

  it('holds the threshold to the rebuild schedule rather than to a round number', () => {
    expect(STALE_AFTER_HOURS).toBe(REBUILD_INTERVAL_HOURS * STALE_AFTER_REBUILDS);
    const withinSchedule = age('ok', { content_at: new Date(NOW - (STALE_AFTER_HOURS - 1) * HOUR).toISOString() });
    const pastIt = age('ok', { content_at: new Date(NOW - STALE_AFTER_HOURS * HOUR).toISOString() });
    expect(withinSchedule?.state).toBe('fresh');
    expect(pastIt?.state).toBe('stale');
    // A single interval is normal and must not fire: the content is at its
    // oldest in the minutes before each rebuild.
    expect(age('ok', { content_at: new Date(NOW - REBUILD_INTERVAL_HOURS * HOUR).toISOString() })?.state).toBe('fresh');
  });

  it('leaves the status word alone, so stale and unreachable stay different faults', () => {
    const reading = indexReading('ok', { content_at: new Date(NOW - 5 * 24 * HOUR).toISOString() });
    const report = nodeReport(architectureNode(INDEX)!, reading, reading);
    expect(report.label).toBe(CONNECTION_STATUS_LABEL.reachable);
    expect(report.tone).toBe('reachable');
    // The fault is on the second pill and in its own words.
    expect(nodeContentAge(architectureNode(INDEX)!, reading, NOW)?.label).toMatch(/stale/i);
    expect(report.note).not.toMatch(/stale/i);
  });

  it('draws no age where no check answered, so one absence is not stated twice', () => {
    expect(age('unverified'), 'nobody has looked').toBeNull();
    expect(age('failed'), 'the object was refused').toBeNull();
    expect(nodeContentAge(architectureNode(INDEX)!, undefined, NOW), 'no reading at all').toBeNull();
  });

  it('gives an age only to the one node that holds content somebody rebuilds', () => {
    // Everything else on the drawing reads through to a table when it is asked,
    // so it has no age to be wrong about. A pill on those would be noise, and
    // noise on a warning is how the warning stops being read.
    const rebuilt = ARCHITECTURE_NODES.filter((node) => node.rebuilt);
    expect(rebuilt.map((node) => node.id)).toEqual([INDEX]);
    const reading = indexReading('ok', { content_at: new Date(NOW - 5 * 24 * HOUR).toISOString() });
    for (const node of ARCHITECTURE_NODES) {
      if (node.id === INDEX) continue;
      expect(nodeContentAge(node, reading, NOW), node.id).toBeNull();
    }
  });

  it('raises stale content to the top of the page, where a reader is not looking for it', () => {
    const stale = new Map([[INDEX, indexReading('ok', { content_at: new Date(NOW - 5 * 24 * HOUR).toISOString() })!]]);
    const found = staleContent(stale, NOW);
    expect(found.map((entry) => entry.node.id)).toEqual([INDEX]);
    expect(found[0].age.note).toContain('5 d');

    // And says nothing at all in the ordinary case, which is most of them. A
    // banner that is always up is a banner nobody reads.
    const healthy = new Map([[INDEX, indexReading('ok', { content_at: new Date(NOW - 6 * HOUR).toISOString() })!]]);
    expect(staleContent(healthy, NOW)).toEqual([]);
    expect(staleContent(new Map([[INDEX, indexReading('ok')!]]), NOW), 'no timestamp is not a fault').toEqual([]);
    expect(staleContent(new Map(), NOW), 'nothing checked').toEqual([]);
  });

  it('puts the age in the words the diagram is read as, not only in the pill', () => {
    const stale = indexReading('ok', { content_at: new Date(NOW - 5 * 24 * HOUR).toISOString() });
    const line = describeArchitecture(new Map([[INDEX, stale!]]), NOW).find((entry) =>
      entry.startsWith('Vector Search index:')
    );
    expect(line).toContain('5 d');
    expect(line).toMatch(/rebuild runs every/);
    expect(nodeAccessibleName(architectureNode(INDEX)!, stale, stale, NOW)).toMatch(/stale/i);

    // Including when there is nothing to report, which a reader who cannot see
    // the pill would otherwise be told nothing about at all.
    const silent = indexReading('ok');
    const quiet = describeArchitecture(new Map([[INDEX, silent!]]), NOW).find((entry) =>
      entry.startsWith('Vector Search index:')
    );
    expect(quiet).toContain('Nothing reported when this index last took content');
  });
});

/**
 * The guard against the two surfaces drifting apart again.
 *
 * The diagram was short a card for months while the app was probing both
 * objects perfectly well, because nothing tied the probe the server emits to a
 * connection the diagram could draw. These assertions are that chain, end to
 * end: the probe id, the registry id and the node's id are one id, so a rename
 * at either end fails here rather than silently dropping a card.
 */
describe('Architecture cannot know less about the semantic lane than Connections does', () => {
  const PROBES = readFileSync(
    fileURLToPath(new URL('../../server/lib/dependency-probes.ts', import.meta.url)),
    'utf8'
  );

  it('draws a node for every semantic object the server probes', () => {
    // The two probe ids, read out of the server's own subjects rather than
    // restated. `semantic-index-endpoint` is emitted only after the index
    // answers and names it, which is why it is easy to forget it exists.
    const probed = [...PROBES.matchAll(/id: '(semantic-index(?:-endpoint)?)'/g)].map((match) => match[1]);
    expect(new Set(probed)).toEqual(new Set(['semantic-index', 'semantic-index-endpoint']));

    const registry = new Set(CONNECTED_RESOURCES.map((resource) => resource.id));
    const drawn = new Set(ARCHITECTURE_NODES.map((node) => node.resourceId));
    for (const id of probed) {
      expect(registry.has(id), `${id} is a connection Connections lists`).toBe(true);
      expect(drawn.has(id), `${id} is a node Architecture draws`).toBe(true);
    }
  });

  it('reads the endpoint through a check rather than treating it as app-applied', () => {
    // `nothing-to-reach` is for a value the app both resolves and applies. This
    // one has a real remote end, so an unprobed endpoint must say nobody looked.
    const endpoint = connectedResource('semantic-index-endpoint')!;
    expect(endpoint.actualFromCheck).toBe('semantic-index-endpoint');
    expect(endpoint.agentKey).toBeNull();
  });

  it('lets neither card invent a grade the shared derivation did not produce', () => {
    // Wherever a probe decided the answer, the word on the card is the word
    // Connections would put on the same row. Only the two states that are NOT
    // probe verdicts -- no index, and a version that did not say -- may carry
    // wording of their own, and both are asserted above.
    const rows = [row('semantic-index', { configured: 'a.b.c', configuredFrom: 'artifact' }), row('semantic-index-endpoint', { configuredFrom: '' })];
    for (const [indexStatus, endpointStatus] of [
      ['ok', 'ok'],
      ['ok', 'failed'],
      ['ok', 'unverified'],
    ] as const) {
      const checks = [
        { id: 'semantic-index', label: '', status: indexStatus, name: 'a.b.c', detail: '', error: '', kind: 'x' },
        { id: 'semantic-index-endpoint', label: '', status: endpointStatus, name: 'an-endpoint', detail: '', error: '', kind: 'x' },
      ] as unknown as PreflightCheck[];
      const readings = readingsById(readConnections(payload(rows), checks));
      for (const id of ['semantic-index', 'semantic-index-endpoint']) {
        const reading = readings.get(id)!;
        expect(nodeReport(architectureNode(id)!, reading, readings.get('semantic-index')).label, id).toBe(
          CONNECTION_STATUS_LABEL[reading.status]
        );
      }
    }
    // And with nothing read at all, both say so rather than falling to a state
    // that means something was established.
    expect(semanticIndexState(undefined)).toBe('not-checked');
    expect(semanticEndpointState(undefined, undefined)).toBe('not-checked');
  });
});

describe('nothing about this deployment is written down in source', () => {
  /**
   * There is a publication pipeline that rewrites these values on the way out
   * and a leak check that blocks on them, so a literal here is a defect even
   * when it renders correctly.
   */
  it('names no workspace, catalog, warehouse, space or endpoint', () => {
    for (const file of [PAGE, MODEL, LAYOUT, CSS]) {
      expect(file).not.toMatch(/https?:\/\/[a-z0-9-]*\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)/i);
      expect(file).not.toMatch(/\bdbc-[0-9a-f-]+/i);
      expect(file).not.toMatch(/adb-\d+\.\d+/);
      // A warehouse or space id is a 16-character hex string.
      expect(file).not.toMatch(/\b[0-9a-f]{16}\b/i);
    }
  });

  it('builds Databricks links from a host the server reported, and drops them when it did not', () => {
    // Guarded on the host, so no host means no anchor rather than a guessed one.
    expect(PAGE).toMatch(/workspaceHost/);
    expect(PAGE).toMatch(/databricksLink/);
    expect(PAGE).not.toMatch(/href=\{`https/);
  });

  it('keeps the in-app link unconditional, since it is the one that must always work', () => {
    // entityHref needs nothing from the deployment -- it is this app's own
    // route and the parameter the Connections page already reads -- so a node
    // is a link even when the server could report no host at all.
    expect(PAGE).toMatch(/entityHref\(/);
    for (const node of ARCHITECTURE_NODES) {
      if (!node.resourceId) continue;
      const href = entityHref(node.resourceId);
      expect(href, node.id).toContain(`${ENTITY_PARAM}=`);
      expect(href, node.id).toContain(node.resourceId);
      // Relative, so it needs no host and cannot be pointed at a workspace.
      expect(href.startsWith('/'), node.id).toBe(true);
    }
  });
});

describe('the diagram is not information only a sighted mouse user can get', () => {
  it('states every node and every edge in words', () => {
    const lines = describeArchitecture(new Map());
    for (const node of ARCHITECTURE_NODES) {
      expect(lines.some((line) => line.startsWith(`${node.label}:`)), node.id).toBe(true);
    }
    for (const edge of ARCHITECTURE_EDGES) {
      expect(lines.some((line) => line.includes(edge.meaning)), `${edge.from}->${edge.to}`).toBe(true);
    }
  });

  it('does not hide the drawing from a screen reader without offering the words', () => {
    // An aria-hidden SVG is fine only because the description above carries the
    // same facts. If the description ever goes, this fails.
    expect(PAGE).toMatch(/aria-hidden/);
    expect(PAGE).toMatch(/describeArchitecture/);
  });

  it('guards the edge animation on prefers-reduced-motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const guard = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(guard).toMatch(/animation: none/);
  });

  it('gives the graph a role and a name rather than leaving it an anonymous box', () => {
    expect(PAGE).toMatch(/role="group"|role="img"|role="list"/);
  });
});

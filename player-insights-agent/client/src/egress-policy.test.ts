/**
 * The browser's copy of what may leave, and the thing it sends when something did.
 *
 * Two properties are worth more than the rest of this file:
 *
 *   1. The closed state is what holds while the answer is out, and what holds
 *      when the answer never comes. A control that opens on a failed fetch is a
 *      control that a broken deployment turns off for you.
 *   2. A report carries no payload. The record exists so that an export leaves a
 *      trace, and a trace containing the export is the leak it was built against.
 *      Asserted on the WIRE here and again on the schema in `egress-store.test.ts`,
 *      because either alone can be true while the other is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultEgressControls, EGRESS_PATHS } from '../../shared/egress-contract';
import {
  adoptEgressControls,
  egressControlsSnapshot,
  egressPathAllowed,
  egressPolicyLoaded,
  loadEgressPolicy,
  onEgressPolicyChange,
  reportEgress,
  resetEgressPolicy,
} from './egress-policy';

/** One request the module made, with its body already back off the wire. */
interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A `fetch` that answers with a body, or refuses.
 *
 * The request body is parsed on capture rather than at each assertion, because
 * what this file is checking is the OBJECT the module put on the wire and a test
 * that reached through `init.body` at every call site would be four lines of
 * casting before every expectation.
 */
function stubFetch(answer: { ok: boolean; body?: unknown } | Error): Sent[] {
  const calls: Sent[] = [];
  const impl = vi.fn((url: string, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    calls.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      ok: answer.ok,
      json: () => Promise.resolve(answer.body),
    } as unknown as Response);
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

beforeEach(() => {
  resetEgressPolicy();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetEgressPolicy();
});

describe('what is in force before the deployment has answered', () => {
  it('is the build defaults, which close every path that carries rows and has a switch', () => {
    expect(egressPolicyLoaded()).toBe(false);
    expect(egressPathAllowed('chart-image')).toBe(false);
  });

  it('closes every controllable path whose default is off, whatever the set becomes', () => {
    // Derived from the registry rather than listed, so a path added with
    // `allowedByDefault: false` is covered here on the commit that adds it.
    for (const path of EGRESS_PATHS) {
      if (path.enforcement === 'uncontrollable' || path.allowedByDefault) continue;
      expect(egressPathAllowed(path.channel), path.channel).toBe(false);
    }
  });

  it('still permits the paths whose default is on', () => {
    // The defaults are a decision and not a blanket. Turning everything off until
    // a fetch lands would flicker every copy button in the app on every load.
    expect(egressPathAllowed('generated-sql')).toBe(true);
    expect(egressPathAllowed('identifier')).toBe(true);
    expect(egressPathAllowed('grant-statement')).toBe(true);
  });

  it('permits what it cannot control, because saying otherwise would be a claim', () => {
    expect(egressPathAllowed('text-selection')).toBe(true);
    expect(egressPathAllowed('screen-capture')).toBe(true);
    expect(egressPathAllowed('answer-prose')).toBe(true);
    // The figure breakdown and the step payload are here rather than above:
    // neither panel has a copy button or a download, so the only ways those
    // values leave are the two lines above this one. Answering false would make
    // every caller behave as though something had been closed.
    expect(egressPathAllowed('result-figures')).toBe(true);
    expect(egressPathAllowed('step-payload')).toBe(true);
  });
});

describe('reading the deployment answer', () => {
  it('takes the stored set and marks itself loaded', async () => {
    stubFetch({
      ok: true,
      body: { controls: { ...defaultEgressControls(), 'chart-image': true }, stored: true, paths: [] },
    });
    await loadEgressPolicy();
    expect(egressPolicyLoaded()).toBe(true);
    expect(egressPathAllowed('chart-image')).toBe(true);
  });

  it('ignores a channel this build has never heard of', async () => {
    stubFetch({
      ok: true,
      body: { controls: { ...defaultEgressControls(), 'invented-path': true }, stored: true },
    });
    await loadEgressPolicy();
    expect(egressControlsSnapshot()).not.toHaveProperty('invented-path');
  });

  it('keeps the defaults and stays unloaded when the route refuses', async () => {
    stubFetch({ ok: false });
    await loadEgressPolicy();
    expect(egressPolicyLoaded()).toBe(false);
    expect(egressPathAllowed('chart-image')).toBe(false);
  });

  it('keeps the defaults when the fetch throws, rather than opening up', async () => {
    // The property that matters. A deployment whose control endpoint is down has
    // not decided that everything may leave.
    stubFetch(new Error('offline'));
    await loadEgressPolicy();
    expect(egressPolicyLoaded()).toBe(false);
    expect(egressPathAllowed('chart-image')).toBe(false);
  });

  it('keeps the defaults when the body is not the shape it claims', async () => {
    stubFetch({ ok: true, body: { controls: null } });
    await loadEgressPolicy();
    expect(egressPolicyLoaded()).toBe(false);
  });

  it('shares one request between callers that ask at the same moment', async () => {
    const calls = stubFetch({ ok: true, body: { controls: defaultEgressControls(), stored: true } });
    await Promise.all([loadEgressPolicy(), loadEgressPolicy(), loadEgressPolicy()]);
    expect(calls).toHaveLength(1);
  });
});

describe('a change reaches what is already on screen', () => {
  it('tells subscribers when the answer lands', async () => {
    const heard = vi.fn();
    const stop = onEgressPolicyChange(heard);
    stubFetch({ ok: true, body: { controls: defaultEgressControls(), stored: true } });
    await loadEgressPolicy();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it('tells them when a panel adopts a set the server just returned', () => {
    const heard = vi.fn();
    const stop = onEgressPolicyChange(heard);
    adoptEgressControls({ ...defaultEgressControls(), 'chart-image': true });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(egressPathAllowed('chart-image')).toBe(true);
    stop();
  });

  it('carries on when one subscriber throws', () => {
    const good = vi.fn();
    const stopBad = onEgressPolicyChange(() => {
      throw new Error('a component unmounted mid-notify');
    });
    const stopGood = onEgressPolicyChange(good);
    expect(() => adoptEgressControls(defaultEgressControls())).not.toThrow();
    expect(good).toHaveBeenCalled();
    stopBad();
    stopGood();
  });

  it('stops telling a subscriber that unsubscribed', () => {
    const heard = vi.fn();
    onEgressPolicyChange(heard)();
    adoptEgressControls(defaultEgressControls());
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('what a report puts on the wire', () => {
  /** The fields a report is allowed to have, and there is no other. */
  const ALLOWED = ['channel', 'surface', 'runId', 'conversationId', 'itemCount'];

  it('sends the channel, the surface and the pointers, and nothing else', () => {
    const calls = stubFetch({ ok: true, body: {} });
    reportEgress({ channel: 'chart-image', surface: 'answer', runId: 'run-1', itemCount: 1 });
    const body = calls[0].body;
    expect(Object.keys(body).sort()).toEqual([...ALLOWED].sort());
    expect(body.channel).toBe('chart-image');
    expect(body.runId).toBe('run-1');
    expect(body.itemCount).toBe(1);
  });

  it('has no field a value could travel in', () => {
    // Belt and braces against the specific mistake: somebody adds `preview` or
    // `sample` to help an administrator see what left, and the record becomes a
    // copy of the data it was watching.
    const calls = stubFetch({ ok: true, body: {} });
    reportEgress({ channel: 'generated-sql', surface: 'run-details' });
    const body = calls[0].body;
    for (const forbidden of [
      'payload',
      'value',
      'content',
      'rows',
      'sql',
      'text',
      'filename',
      'bytes',
      'sample',
      'preview',
      'data',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("names neither the actor nor the outcome, which are the server's to decide", () => {
    // An actor field would make this a way to write rows against somebody else's
    // name into the app's own audit record.
    const calls = stubFetch({ ok: true, body: {} });
    reportEgress({ channel: 'identifier', surface: 'run-header' });
    const body = calls[0].body;
    expect(body).not.toHaveProperty('actor');
    expect(body).not.toHaveProperty('outcome');
  });

  it('sends nulls rather than dropping the pointers it was not given', () => {
    const calls = stubFetch({ ok: true, body: {} });
    reportEgress({ channel: 'identifier', surface: 'connections' });
    const body = calls[0].body;
    expect(body.runId).toBeNull();
    expect(body.conversationId).toBeNull();
    expect(body.itemCount).toBeNull();
  });

  it('does not throw when the record cannot be written', () => {
    // An export must not be blocked, delayed or made to look failed because the
    // note about it did not land.
    stubFetch(new Error('offline'));
    expect(() => reportEgress({ channel: 'chart-image', surface: 'answer' })).not.toThrow();
  });
});

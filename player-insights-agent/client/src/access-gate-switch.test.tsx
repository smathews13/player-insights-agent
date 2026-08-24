/**
 * Whether the access check stands between a reader and the app.
 *
 * It does not, and this is the file that says so: the gate is the only thing
 * mounted above the router, so what it does with its children IS what a reader
 * meets on open. With the switch off the children come through untouched, which
 * is the app in its ordinary state under the reader's own token.
 *
 * The switch is asserted in both positions rather than only in the one we ship,
 * because the whole point of disabling rather than deleting is that turning it
 * back on has to work. What the panel then SAYS is pinned by
 * access-gate-copy.test.ts and access-gate-brevity.test.ts, which read the same
 * component and are unaffected by this.
 *
 * Rendered with react-dom/server, in the pattern the brevity test established,
 * because this repo has no jsdom: effects do not run here, so an enabled gate
 * renders its pre-identity state and a disabled one renders its children.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccessGate } from './AccessGate';
import { forgetIdentityRequest, identityRequest } from './app-state';
import { ACCESS_GATE_ENABLED } from '../../shared/access-gate';

const SOURCE = readFileSync(new URL('./AccessGate.tsx', import.meta.url), 'utf8');
const APP_STATE = readFileSync(new URL('./app-state.ts', import.meta.url), 'utf8');

const APP = <p>the app</p>;

afterEach(() => {
  forgetIdentityRequest();
  vi.unstubAllGlobals();
});

describe('the switch', () => {
  it('is off in what this deployment ships', () => {
    expect(ACCESS_GATE_ENABLED).toBe(false);
  });
});

describe('what a reader meets on open', () => {
  it('is the app itself, with no check in front of it', () => {
    const markup = renderToStaticMarkup(<AccessGate>{APP}</AccessGate>);
    expect(markup).toBe('<p>the app</p>');
    expect(markup).not.toContain('Access check');
  });

  it('does not ask who is signed in, so nothing is recorded about the reader', () => {
    // The read that would have to happen first, guarded. A mode recorded for a
    // reader who was never asked shows up on Monitoring as one who declined.
    // Asserted against the source because an effect does not run in this
    // renderer and this repo has no browser to run it in.
    const effect = SOURCE.slice(SOURCE.indexOf('useEffect(() => {'));
    expect(effect.slice(0, effect.indexOf('fetch('))).toContain('if (!enabled) return;');
  });
});

describe('turning it back on', () => {
  it('keeps the app shell painted while the gate decides whether to cover it', () => {
    // Effects do not run in this renderer, so this is exactly the first frame:
    // the identity is unresolved, but a cold role read no longer means a blank
    // viewport.
    expect(renderToStaticMarkup(<AccessGate enabled>{APP}</AccessGate>)).toBe('<p>the app</p>');
  });

  it('shares the shell identity request instead of issuing its own', async () => {
    const fetchIdentity = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ signedInAs: 'reader@example.com' }),
    });
    vi.stubGlobal('fetch', fetchIdentity);

    const [first, second] = await Promise.all([identityRequest(), identityRequest()]);
    expect(first).toEqual(second);
    expect(fetchIdentity).toHaveBeenCalledTimes(1);
    expect(SOURCE).not.toContain("fetch('/api/identity')");
    expect(SOURCE).toContain('identityRequest()');
    expect(APP_STATE.match(/fetch\('\/api\/identity'\)/g)).toHaveLength(1);
  });

  it('asks again after a failed identity read, instead of replaying that failure', async () => {
    const fetchIdentity = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ signedInAs: 'reader@example.com' }),
      });
    vi.stubGlobal('fetch', fetchIdentity);

    await expect(identityRequest()).rejects.toThrow('Identity unavailable');
    await expect(identityRequest()).resolves.toEqual({ signedInAs: 'reader@example.com' });
    expect(fetchIdentity).toHaveBeenCalledTimes(2);
  });
});

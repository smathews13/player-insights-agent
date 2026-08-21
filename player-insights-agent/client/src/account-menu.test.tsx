import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Identity } from './app-types';
import { AccountMenuPanel } from './AccountMenu';
import { accountSlackHref } from './account-slack-links';
import { FIRST_OPEN_KEY, FIRST_OPEN_OUTCOME_KEY, signOutOfAstrolabe } from './first-open';

const IDENTITY: Identity = {
  signedInAs: 'jordan.lee@example.com',
  executionIdentity: 'app service principal',
  executionMode: 'user-verified',
};

describe('account menu', () => {
  it('opens with the live identity and the fixed menu order', () => {
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} onSignOut={() => {}} />);
    const labels = [
      'jordan.lee',
      'jordan.lee@example.com',
      'Report feedback',
      'Escalate to Super Admin',
      'Back to Databricks Apps',
      'Sign out of',
      'astrolabe',
    ];
    for (const label of labels) expect(markup).toContain(label);
    for (let index = 1; index < labels.length; index += 1) {
      expect(markup.indexOf(labels[index - 1])).toBeLessThan(markup.indexOf(labels[index]));
    }
    expect(markup).toContain('account-menu-astrolabe');
    expect(markup).not.toMatch(/Slack[^<]*astrolabe|astrolabe[^<]*Slack/);
  });

  it('opens Slack DMs addressed to Sam for feedback and Garrett for escalation', () => {
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} onSignOut={() => {}} />);
    expect(accountSlackHref('feedback')).toBe('https://slack.com/app_redirect?team=T02EPKPG3&channel=U04H3555WMB');
    expect(accountSlackHref('escalation')).toBe('https://slack.com/app_redirect?team=T02EPKPG3&channel=U06BV72N4KY');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it('does not send Slack messages through the Astrolabe server', () => {
    const source = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('/api/account/slack-message');
    expect(source).not.toContain('chat.postMessage');
    expect(source).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(source).toContain("event.key !== 'Escape'");
  });

  it('ends only the Astrolabe tab session', () => {
    const removed: string[] = [];
    signOutOfAstrolabe({
      getItem: () => null,
      setItem: () => {},
      removeItem: (key) => removed.push(key),
    });
    expect(removed).toEqual([FIRST_OPEN_OUTCOME_KEY, FIRST_OPEN_KEY]);

    const source = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
    expect(source).toContain('signOutOfAstrolabe()');
    expect(source).toContain('window.location.reload()');
    expect(source).not.toContain('/api/account/logout');
  });

  it('keeps the gear wired to the existing settings modal', () => {
    const layout = readFileSync(new URL('./Layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('aria-label="App settings"');
    expect(layout).toContain('onClick={() => setSettingsOpen(true)}');
    expect(layout).toContain('<SettingsPage');
    expect(layout).toContain('features={features}');
    expect(layout).toContain('role={role}');
  });
});

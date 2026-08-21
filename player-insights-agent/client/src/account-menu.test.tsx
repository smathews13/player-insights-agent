import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Identity } from './app-types';
import { AccountMenuPanel, SlackComposer } from './AccountMenu';
import { FIRST_OPEN_KEY, FIRST_OPEN_OUTCOME_KEY, signOutOfAstrolabe } from './first-open';

const IDENTITY: Identity = {
  signedInAs: 'jordan.lee@example.com',
  executionIdentity: 'app service principal',
  executionMode: 'user-verified',
};

describe('account menu', () => {
  it('opens with the live identity and the fixed menu order', () => {
    const markup = renderToStaticMarkup(
      <AccountMenuPanel identity={IDENTITY} onCompose={() => {}} onSignOut={() => {}} />
    );
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

  it('renders the shared Slack composer for escalation', () => {
    const markup = renderToStaticMarkup(<SlackComposer action="escalation" identity={IDENTITY} onClose={() => {}} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Escalate to Super Admin');
    expect(markup).toContain('Super Admin');
    expect(markup).toContain('Slack');
    expect(markup).toContain('What do you need from the Super Admin?');
    expect(markup).toContain('Sends your name and a link to this page.');
    expect(markup).toContain('Send on Slack');
  });

  it('posts the message, page URL, and live user to the server', () => {
    const source = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
    expect(source).toContain("fetch('/api/account/slack-message'");
    expect(source).toContain('message: text');
    expect(source).toContain('pageUrl: window.location.href');
    expect(source).toContain('user: identity.signedInAs');
    expect(source).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(source).toContain("event.key === 'Escape'");
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
    expect(layout).toContain('<SettingsPage onClose={closeSettings} />');
  });
});

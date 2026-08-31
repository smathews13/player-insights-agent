import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Identity } from './app-types';
import { AccountMenuPanel } from './AccountMenu';
import { accountSlackHref } from './account-slack-links';

const IDENTITY: Identity = {
  signedInAs: 'jordan.lee@example.com',
  executionIdentity: 'app service principal',
  executionMode: 'user-verified',
};

describe('account menu', () => {
  it('opens with the live identity and the fixed menu order', () => {
    const markup = renderToStaticMarkup(
      <AccountMenuPanel identity={IDENTITY} role="super_admin" onSignOut={() => {}} />
    );
    const labels = [
      'jordan.lee',
      'jordan.lee@example.com',
      'Report feedback',
      'Escalate to Super Admin',
      'Back to Databricks Apps',
      'Sign out of Astrolabe',
    ];
    for (const label of labels) expect(markup).toContain(label);
    for (let index = 1; index < labels.length; index += 1) {
      expect(markup.indexOf(labels[index - 1])).toBeLessThan(markup.indexOf(labels[index]));
    }
    expect(markup).toContain('account-menu-signout-label');
    expect(markup).not.toMatch(/Slack[^<]*astrolabe|astrolabe[^<]*Slack/);
  });

  it('opens Slack DMs addressed to Sam for feedback and Garrett for escalation', () => {
    const markup = renderToStaticMarkup(
      <AccountMenuPanel identity={IDENTITY} role="super_admin" onSignOut={() => {}} />
    );
    expect(accountSlackHref('feedback')).toBe('https://slack.com/app_redirect?team=T02EPKPG3&channel=U04H3555WMB');
    expect(accountSlackHref('escalation')).toBe('https://slack.com/app_redirect?team=T02EPKPG3&channel=U06BV72N4KY');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  /**
   * The dropdown used to open on a bare name and an address, so pressing the
   * identity chip replaced the reader's own mark and rank with two lines of text
   * and the panel read as somebody else's account.
   *
   * It is not merely a repetition of the header, which is the part worth recording:
   * responsive.css hides the cluster's informational members below 800px, so at
   * narrow widths this is the only place on the page the rank appears at all.
   */
  it('heads the panel with the reader’s mark, name and rank', () => {
    const markup = renderToStaticMarkup(
      <AccountMenuPanel identity={IDENTITY} role="super_admin" onSignOut={() => {}} />
    );
    expect(markup).toContain('account-menu-who');
    expect(markup).toContain('Super admin');
    expect(markup).toContain('data-role-state="super_admin"');
    // The mark, the name and the rank in that order -- the trigger's own order.
    expect(markup.indexOf('<svg')).toBeLessThan(markup.indexOf('jordan.lee'));
    expect(markup.indexOf('jordan.lee<')).toBeLessThan(markup.indexOf('Super admin'));
    // And the address is no longer selected as `.account-menu-identity span`, which
    // was a descendant match: with a wrapper and a pill in the row above it, that
    // selector painted the rank in 11.5px grey and ellipsised it.
    expect(markup).toContain('account-menu-address');
  });

  it('draws the pill without a second live region', () => {
    // Two `RoleBadge`s on the page would be two `aria-live` regions, so losing the
    // admin role would be announced to a screen reader twice. The announcement
    // belongs to the header's badge; the panel takes the pill alone.
    const source = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<RoleBadgePill state={role} />');
    expect(source).not.toContain('<RoleBadge ');
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} role="admin" onSignOut={() => {}} />);
    expect(markup).not.toContain('aria-live');
  });

  it('does not send Slack messages through the Astrolabe server', () => {
    const source = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('/api/account/slack-message');
    expect(source).not.toContain('chat.postMessage');
    expect(source).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(source).toContain("event.key !== 'Escape'");
  });

  it('uses the coordinated app and native-cookie sign-out path', () => {
    const source = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onClick={onSignOut}');
    expect(source).toContain('setOpen(false)');
    expect(source).toContain('signOutAndEndAppSession()');
    expect(source).not.toContain('window.location.reload()');
    expect(source).not.toMatch(/https?:\/\/[^'"]+\/\.auth\/sign_out/);
  });

  it('keeps sign-out concise without session explanations or disclosure UI', () => {
    const markup = renderToStaticMarkup(
      <AccountMenuPanel identity={IDENTITY} role="super_admin" onSignOut={() => {}} />
    );
    expect(markup).toContain('Sign out of Astrolabe');
    expect(markup).not.toContain('role="menu"');
    expect(markup).not.toContain('role="menuitem"');
    expect(markup).toContain('lucide-log-out');
    expect(markup).not.toContain('App and workspace sessions are separate.');
    expect(markup).not.toContain('What sign-out does');
    expect(markup).not.toContain('may authenticate you again without prompting');
    expect(markup).not.toContain('Federated logout is not supported');
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('<summary');
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

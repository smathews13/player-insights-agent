import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Identity } from './app-types';
import { AccountMenu } from './AccountMenu';
import { nextFeedbackItem } from './account-feedback-menu';
import { AccountFeedbackChoices, AccountMenuPanel } from './AccountMenuPanel';
import { accountEscalationSlackHref } from './account-slack-links';
import { identityFromResponse } from './app-state';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { accountFeedbackTargets } from '../../shared/account-feedback';

const MENU_SOURCE = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
const PANEL_SOURCE = readFileSync(new URL('./AccountMenuPanel.tsx', import.meta.url), 'utf8');
const ACCOUNT_CSS = readFileSync(new URL('./styles/account-menu.css', import.meta.url), 'utf8');

const IDENTITY: Identity = {
  signedInAs: 'jordan.lee@example.com',
  executionMode: 'user-verified',
};

describe('account menu', () => {
  it('uses the official Databricks organization mark in the trigger and panel', () => {
    const identity: Identity = {
      signedInAs: '<your-username>@labs.databricks.com',
      executionMode: 'user-verified',
      organizations: [{ domain: 'labs.databricks.com', name: 'Conflicting config', monogram: 'XX' }],
    };
    const trigger = renderToStaticMarkup(<AccountMenu identity={identity} role="super_admin" />);
    const panel = renderToStaticMarkup(<AccountMenuPanel identity={identity} role="super_admin" onClose={() => {}} />);

    for (const markup of [trigger, panel]) {
      expect(markup).toContain('roster-organization-mark--databricks');
      expect(markup).toContain('roster-databricks-symbol');
      expect(markup).toContain(DATABRICKS_SYMBOL);
      expect(markup).toContain('aria-label="Organization: Databricks"');
      expect(markup).not.toContain('lucide-user-round');
    }
    expect(trigger).toContain('aria-label="Signed in as <your-username>@labs.databricks.com"');
    expect(trigger).toContain('title="<your-username>@labs.databricks.com"');
  });

  it.each([
    ['artist@studio.northwindgames.com', 'Northwind Games', 'R*'],
    ['producer@games.take2.example', 'Acme Interactive', 'T2'],
  ])('uses configured organization identity for %s', (signedInAs, organizationName, monogram) => {
    const identity: Identity = {
      signedInAs,
      executionMode: 'user-verified',
      organizations: [
        { domain: 'northwindgames.com', name: 'Northwind Games', monogram: 'R*' },
        { domain: 'take2.example', name: 'Acme Interactive', monogram: 'T2' },
      ],
    };
    const trigger = renderToStaticMarkup(<AccountMenu identity={identity} role="consumer" />);
    const panel = renderToStaticMarkup(<AccountMenuPanel identity={identity} role="consumer" onClose={() => {}} />);

    expect(trigger).toContain(`aria-label="Organization: ${organizationName}"`);
    expect(trigger).toContain(`>${monogram}</span>`);
    expect(panel).toContain(`aria-label="Organization: ${organizationName}"`);
    expect(panel).toContain(`>${monogram}</span>`);
    expect(panel).not.toContain('lucide-user-round');
  });

  it('uses a company fallback and drops malformed wire mappings safely', () => {
    const identity = identityFromResponse({
      signedInAs: 'reader@unknown.example',
      executionMode: 'user-verified',
      organizations: [{ domain: 'unknown.example', name: 'Unsafe', monogram: 'U', credential: 'secret' }],
    });
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={identity} role="consumer" onClose={() => {}} />);

    expect(identity.organizations).toBeUndefined();
    expect(markup).toContain('aria-label="Organization: unknown.example"');
    expect(markup).toContain('lucide-building-2');
    expect(markup).not.toContain('lucide-user-round');
    expect(markup).not.toContain('Unsafe');
    expect(markup).not.toContain('secret');
  });

  it('opens with the live identity and the fixed menu order', () => {
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} role="super_admin" onClose={() => {}} />);
    const labels = [
      'Super admin',
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

  it('makes feedback a disclosure and leaves the Super Admin escalation unchanged', () => {
    const panel = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} role="super_admin" onClose={() => {}} />);
    const feedback = panel.match(/<button[^>]*class="account-feedback-trigger"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(feedback).toContain('aria-haspopup="menu"');
    expect(feedback).toContain('aria-expanded="false"');
    expect(feedback).toContain('Report feedback');
    expect(feedback).not.toContain('href=');
    expect(accountEscalationSlackHref()).toBe('https://slack.com/app_redirect?team=T02EPKPG3&channel=U06BV72N4KY');
    expect(panel).toContain(`href="${accountEscalationSlackHref().replaceAll('&', '&amp;')}"`);
  });

  it('offers GitHub alone until a deployment supplies a validated Slack target', () => {
    const githubOnly = renderToStaticMarkup(<AccountFeedbackChoices targets={accountFeedbackTargets()} />);
    expect(githubOnly).toContain('GitHub issue');
    expect(githubOnly).toContain('https://github.com/smathews13/astrolabe_public/issues/new');
    expect(githubOnly.match(/target="_blank"/g)).toHaveLength(1);
    expect(githubOnly).toContain('lucide-github');
    expect(githubOnly).not.toContain('lucide-slack');

    const configured = accountFeedbackTargets(
      `https://app.slack.com/client/T${'1'.repeat(8)}/search?q=Feedback%20contact`,
      'Find Feedback contact'
    );
    const markup = renderToStaticMarkup(<AccountFeedbackChoices targets={configured} />);
    expect(markup.indexOf('GitHub issue')).toBeLessThan(markup.indexOf('Find Feedback contact'));
    expect(markup.match(/target="_blank"/g)).toHaveLength(2);
    expect(markup.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(markup).toContain('lucide-github');
    expect(markup).toContain('lucide-slack');
  });

  it('wraps arrow focus through both feedback choices', () => {
    expect(nextFeedbackItem(0, 'ArrowDown')).toBe(1);
    expect(nextFeedbackItem(1, 'ArrowDown')).toBe(0);
    expect(nextFeedbackItem(0, 'ArrowUp')).toBe(1);
    expect(nextFeedbackItem(1, 'Home')).toBe(0);
    expect(nextFeedbackItem(0, 'End')).toBe(1);
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
  it('stacks the reader’s rank, full name, and full address in reading order', () => {
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} role="super_admin" onClose={() => {}} />);
    expect(markup).toContain('Super admin');
    expect(markup).toContain('data-role-state="super_admin"');
    const role = markup.indexOf('Super admin');
    const name = markup.indexOf('jordan.lee</strong>');
    const address = markup.indexOf('jordan.lee@example.com');
    expect(markup.indexOf('<svg')).toBeLessThan(role);
    expect(role).toBeLessThan(name);
    expect(name).toBeLessThan(address);
    expect(markup).not.toContain('account-menu-who');
    expect(markup).toContain('account-menu-name');
    expect(markup).toContain('account-menu-address');
  });

  it('draws the pill without a second live region', () => {
    // Two `RoleBadge`s on the page would be two `aria-live` regions, so losing the
    // admin role would be announced to a screen reader twice. The announcement
    // belongs to the header's badge; the panel takes the pill alone.
    const source = PANEL_SOURCE;
    expect(source).toContain('<RoleBadgePill state={role} />');
    expect(source).not.toContain('<RoleBadge ');
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} role="admin" onClose={() => {}} />);
    expect(markup).not.toContain('aria-live');
  });

  it('does not send Slack messages through the Astrolabe server', () => {
    const source = `${MENU_SOURCE}\n${PANEL_SOURCE}`;
    expect(source).not.toContain('/api/account/slack-message');
    expect(source).not.toContain('chat.postMessage');
    expect(source).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(source).toContain("event.key !== 'Escape'");
    expect(source).toContain("target.closest('[data-account-feedback-menu]')");
    expect(source).toContain('event.defaultPrevented');
    expect(PANEL_SOURCE).toContain("event.key === 'Tab'");
    expect(PANEL_SOURCE).toContain("event.key === 'Escape'");
    expect(PANEL_SOURCE).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']");
    expect(PANEL_SOURCE).toContain('onInteractOutside');
    expect(PANEL_SOURCE).toContain('onMouseEnter={cancelHoverClose}');
    expect(PANEL_SOURCE).toContain('onMouseLeave={scheduleFeedbackClose}');
  });

  it('keeps native trigger semantics and gives hover, keyboard focus, and open distinct states', () => {
    expect(MENU_SOURCE).toContain('type="button"');
    expect(MENU_SOURCE).toContain('aria-expanded={open}');
    expect(MENU_SOURCE).toContain('aria-controls={open ? menuId : undefined}');
    expect(MENU_SOURCE).toContain("event.key !== 'Escape'");
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-trigger\.identity-chip:hover,\s*\.account-menu-trigger\.identity-chip:focus-visible\s*\{[^}]*border-color:\s*var\(--ast-pos-border\)[^}]*background:\s*color-mix\(in srgb,\s*var\(--ast-surface-chrome\) 96%,\s*var\(--ast-pos-text\)\)[^}]*color:\s*var\(--ast-pos-text\)/s
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-trigger\.identity-chip:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ast-pos-text\)/
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-trigger\.identity-chip\[aria-expanded='true'\]\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--ast-surface-chrome\) 90%,\s*var\(--ast-pos-text\)\)[^}]*box-shadow:\s*inset 0 0 0 1px var\(--ast-pos-border\)/
    );
    expect(ACCOUNT_CSS).not.toMatch(/account-menu-trigger[^{]*\{[^}]*(?:--ast-blue|--primary)/s);
  });

  it('keeps the feedback disclosure and portaled choices opaque, distinct, and non-blue', () => {
    expect(ACCOUNT_CSS).toMatch(
      /\.account-feedback-menu\s*\{[^}]*z-index:\s*var\(--ast-layer-menu\)[^}]*background:\s*var\(--ast-surface-menu\)[^}]*backdrop-filter:\s*none/s
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-feedback-trigger:hover,[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--ast-surface-menu\) 96%,\s*var\(--ast-pos-text\)\)/
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-feedback-trigger\[aria-expanded='true'\]\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--ast-surface-menu\) 90%,\s*var\(--ast-pos-text\)\)/
    );
    expect(ACCOUNT_CSS).not.toMatch(/account-feedback-(?:trigger|menu)[^{]*\{[^}]*(?:--ast-blue|--primary)/s);
  });

  it('uses the coordinated app and native-cookie sign-out path', () => {
    const source = `${MENU_SOURCE}\n${PANEL_SOURCE}`;
    expect(source).toContain('onClose();');
    expect(source).toContain('setOpen(false)');
    expect(source).toContain('signOutAndEndAppSession()');
    expect(source).not.toContain('window.location.reload()');
    expect(source).not.toMatch(/https?:\/\/[^'"]+\/\.auth\/sign_out/);
  });

  it('keeps sign-out concise without session explanations or disclosure UI', () => {
    const markup = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} role="super_admin" onClose={() => {}} />);
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
    expect(layout).toMatch(/onClick=\{\(\) => \{[\s\S]*setSettingsOpen\(true\);[\s\S]*refreshExperimental\(\)/);
    expect(layout).toContain('<SettingsPage');
    expect(layout).toContain('features={features}');
    expect(layout).toContain('role={role}');
  });

  it('keeps organization marks compact, responsive and on theme tokens', () => {
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-trigger > \.roster-organization-mark \{[^}]*width:\s*14px[^}]*height:\s*14px/s
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-identity > \.roster-organization-mark \{[^}]*width:\s*28px[^}]*height:\s*28px/s
    );
    expect(ACCOUNT_CSS).toContain('width: min(336px, calc(100vw - 24px))');
    expect(ACCOUNT_CSS).toMatch(/\.account-menu-name\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s);
    expect(ACCOUNT_CSS).toMatch(/\.account-menu-address\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s);
    expect(ACCOUNT_CSS).not.toMatch(
      /\.account-menu-(?:name|address)\s*\{[^}]*(?:text-overflow|white-space:\s*nowrap)/s
    );
    expect(ACCOUNT_CSS).toContain('background: var(--card)');
    expect(ACCOUNT_CSS).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('adapts focus to forced colors and removes motion when requested', () => {
    expect(ACCOUNT_CSS).toMatch(
      /@media \(forced-colors:\s*active\)[\s\S]*account-menu-trigger[^}]*border-color:\s*Highlight[^}]*color:\s*Highlight/
    );
    expect(ACCOUNT_CSS).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.account-menu-trigger,[^{]*\{[^}]*transition:\s*none/
    );
    expect(ACCOUNT_CSS).toMatch(
      /@media \(forced-colors:\s*active\)[\s\S]*\.account-feedback-trigger:is\([^}]*outline:\s*2px solid Highlight/
    );
    expect(ACCOUNT_CSS).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.account-feedback-menu > a\s*\{[^}]*transition:\s*none/
    );
  });
});

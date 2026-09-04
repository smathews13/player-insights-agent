import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Identity } from './app-types';
import { AccountMenu } from './AccountMenu';
import { nextFeedbackItem } from './account-feedback-menu';
import { AccountEscalationChoice, AccountFeedbackChoices, AccountMenuPanel } from './AccountMenuPanel';
import { identityFromResponse } from './app-state';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { accountFeedbackTargets } from '../../shared/account-feedback';
import { organizationForEmail, parseOrganizationMappings } from '../../shared/organization-mapping';

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
      signedInAs: 'employee@example.com',
      organization: organizationForEmail('employee@example.com'),
      executionMode: 'user-verified',
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
    expect(trigger).toContain('aria-label="Signed in as employee@example.com"');
    expect(trigger).toContain('title="employee@example.com"');
    expect(trigger).toContain('<strong class="identity-chip-name">employee</strong>');
  });

  it('uses one canonical Identity record for the short trigger, full panel, and deployment organization', () => {
    const [organization] = parseOrganizationMappings(
      JSON.stringify([{ domain: 'studio.example', name: 'Example Studio', monogram: 'ES' }])
    ).filter((candidate) => candidate.domain === 'studio.example');
    const identity = identityFromResponse({
      signedInAs: 'jordan.lee',
      canonicalEmail: 'jordan.lee@studio.example',
      displayName: 'jordan.lee',
      identityRevision: 'roster-revision-1',
      organization,
      organizations: organization ? [organization] : [],
      executionMode: 'user-verified',
    });
    const trigger = renderToStaticMarkup(<AccountMenu identity={identity} role="super_admin" />);
    const panel = renderToStaticMarkup(<AccountMenuPanel identity={identity} role="super_admin" onClose={() => {}} />);

    for (const markup of [trigger, panel]) {
      expect(markup).toContain('aria-label="Organization: Example Studio"');
      expect(markup).toContain('>ES</span>');
    }
    expect(trigger).toContain('<strong class="identity-chip-name">jordan.lee</strong>');
    expect(trigger).not.toContain('identity-chip-name">jordan.lee@studio.example');
    expect(trigger).toContain('title="jordan.lee@studio.example"');
    expect(panel).toContain('<span class="account-menu-address">jordan.lee@studio.example</span>');
    expect(identity.identityRevision).toBe('roster-revision-1');
  });

  it('keeps an unresolved local part on the neutral organization fallback', () => {
    const identity = identityFromResponse({
      signedInAs: 'shared.user',
      canonicalEmail: null,
      displayName: 'shared.user',
      executionMode: 'user-verified',
    });
    const trigger = renderToStaticMarkup(<AccountMenu identity={identity} role="consumer" />);
    const panel = renderToStaticMarkup(<AccountMenuPanel identity={identity} role="consumer" onClose={() => {}} />);
    for (const markup of [trigger, panel]) {
      expect(markup).toContain('aria-label="Organization: External"');
      expect(markup).toContain('lucide-building-2');
      expect(markup).not.toContain(DATABRICKS_SYMBOL);
    }
  });

  it('uses deployment-provided organization monograms without compiling customer artwork', () => {
    const [organization] = parseOrganizationMappings(
      JSON.stringify([{ domain: 'partner.example', name: 'Example Partner', monogram: 'EP' }])
    ).filter((candidate) => candidate.domain === 'partner.example');
    const identity: Identity = {
      signedInAs: 'reader@partner.example',
      organization,
      organizations: organization ? [organization] : [],
      executionMode: 'user-verified',
    };
    const trigger = renderToStaticMarkup(<AccountMenu identity={identity} role="consumer" />);
    const panel = renderToStaticMarkup(<AccountMenuPanel identity={identity} role="consumer" onClose={() => {}} />);

    expect(trigger).toContain('aria-label="Organization: Example Partner"');
    expect(trigger).toContain('>EP</span>');
    expect(panel).toContain('aria-label="Organization: Example Partner"');
    expect(panel).toContain('>EP</span>');
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
      'Back to Databricks Apps',
      'Sign out of Astrolabe',
    ];
    for (const label of labels) expect(markup).toContain(label);
    for (let index = 1; index < labels.length; index += 1) {
      expect(markup.indexOf(labels[index - 1])).toBeLessThan(markup.indexOf(labels[index]));
    }
    expect(markup).toContain('account-menu-signout-label');
    expect(markup).not.toContain('Escalate to Super Admin');
    expect(markup).not.toMatch(/Slack[^<]*astrolabe|astrolabe[^<]*Slack/);
  });

  it('keeps feedback a disclosure and renders escalation only from its distinct target', () => {
    const panel = renderToStaticMarkup(<AccountMenuPanel identity={IDENTITY} role="super_admin" onClose={() => {}} />);
    const feedback =
      panel.match(/<button[^>]*class="account-feedback-trigger[^"]*"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(feedback).toContain('aria-haspopup="menu"');
    expect(feedback).toContain('aria-expanded="false"');
    expect(feedback).toContain('Report feedback');
    expect(feedback).not.toContain('href=');
    expect(panel).not.toContain('Escalate to Super Admin');

    const search = `https://app.slack.com/client/T${'2'.repeat(8)}/search?q=Customer%20Admin`;
    const targets = accountFeedbackTargets(undefined, undefined, search, 'Find Customer Admin in Slack');
    const escalation = renderToStaticMarkup(<AccountEscalationChoice target={targets.escalation} />);
    expect(escalation).toContain('Escalate to Super Admin');
    expect(escalation).toContain('aria-label="Find Customer Admin in Slack"');
    expect(escalation).toContain('title="Find Customer Admin in Slack"');
    expect(escalation).toContain(`href="${search}"`);
    expect(escalation).not.toContain('GitHub issue');
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
      'Find Maintainer in Slack'
    );
    const markup = renderToStaticMarkup(<AccountFeedbackChoices targets={configured} />);
    expect(markup.indexOf('GitHub issue')).toBeLessThan(markup.indexOf('Find Maintainer in Slack'));
    expect(markup.match(/target="_blank"/g)).toHaveLength(2);
    expect(markup.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(markup).toContain('lucide-github');
    expect(markup).toContain('lucide-slack');
    expect(markup).not.toContain('Escalate to Super Admin');
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
    expect(MENU_SOURCE).toContain('<Popover');
    expect(PANEL_SOURCE).toContain('<PopoverContent');
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
    expect(MENU_SOURCE).toContain('aria-controls={menuId}');
    expect(MENU_SOURCE).toContain('onOpenChange={setOpen}');
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-trigger\.identity-chip:hover,\s*\.account-menu-trigger\.identity-chip:focus-visible\s*\{[^}]*border-color:\s*var\(--ast-pos-border\)[^}]*background:\s*color-mix\(in srgb,\s*var\(--background\) 94%,\s*var\(--ast-pos-text\)\)[^}]*color:\s*var\(--ast-pos-text\)/s
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-trigger\.identity-chip:focus-visible\s*\{[^}]*outline:\s*none[^}]*box-shadow:\s*0 0 0 2px/
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-menu-trigger\.identity-chip\[aria-expanded='true'\]\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--background\) 88%,\s*var\(--ast-pos-text\)\)[^}]*box-shadow:\s*inset 0 0 0 1px var\(--ast-pos-border\)/
    );
    expect(ACCOUNT_CSS).not.toMatch(/account-menu-trigger[^{]*\{[^}]*(?:--ast-blue|--primary)/s);
  });

  it('keeps the feedback disclosure and portaled choices opaque, distinct, and non-blue', () => {
    expect(ACCOUNT_CSS).toMatch(
      /\.account-feedback-menu\s*\{[^}]*z-index:\s*var\(--ast-layer-menu\)[^}]*background:\s*var\(--background\)[^}]*backdrop-filter:\s*none/s
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-feedback-trigger:hover,[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--background\) 94%,\s*var\(--ast-pos-text\)\)/
    );
    expect(ACCOUNT_CSS).toMatch(
      /\.account-feedback-trigger\[aria-expanded='true'\]\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--background\) 88%,\s*var\(--ast-pos-text\)\)/
    );
    expect(ACCOUNT_CSS).not.toMatch(/account-feedback-(?:trigger|menu)[^{]*\{[^}]*(?:--ast-blue|--primary)/s);
  });

  it('uses the shared non-modal portal without changing body scroll width', () => {
    expect(PANEL_SOURCE).toContain('<PopoverContent');
    expect(MENU_SOURCE).not.toContain('document.body');
    expect(MENU_SOURCE).not.toMatch(/<Popover[^>]*modal=/);
    expect(ACCOUNT_CSS).toMatch(/\.account-menu-portal[^}]*scrollbar-gutter:\s*stable/s);
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

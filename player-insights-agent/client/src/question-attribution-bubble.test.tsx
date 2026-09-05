import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { QuestionAttributionBubble } from './QuestionAttributionBubble';

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const CSS = source('styles/question-attribution.css');
const ASK_CSS = source('styles/ask.css');
const DARK_CSS = source('styles/dark-mode.css');
const APPEARANCE_CSS = source('styles/appearance-preferences.css');
const ANSWER_BODY_CSS = source('styles/answer-body.css');
const MONITORING_CSS = source('styles/monitoring.css');
const RUNS_CSS = source('styles/runs.css');
const SHIPPED_CSS = [CSS, ASK_CSS, DARK_CSS, APPEARANCE_CSS, ANSWER_BODY_CSS, MONITORING_CSS, RUNS_CSS].join('\n');

function rule(selector: string, stylesheet = CSS): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return stylesheet.slice(start, stylesheet.indexOf('}', start));
}

describe('the shared question attribution bubble', () => {
  it('renders the question and attribution inside one outer surface', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <QuestionAttributionBubble
          question="How did Hoops 26 sell through on each platform last week?"
          asker="<your-username>@example.test"
          canOpenUser
          questionAs="h3"
          questionId="question-title"
        />
      </MemoryRouter>
    );

    expect(markup).toContain('id="question-title"');
    expect((markup.match(/question-attribution-surface/g) ?? []).length).toBe(1);
    expect(markup).toContain('class="question-attribution-message"');
    expect(markup).toContain('class="question-attribution-meta"');
    expect(markup).toContain('identity-chip-name"><your-username>');
    expect(markup).toContain('data-organization-id="domain:example.test"');
    expect(markup).toContain('data-organization-mark="raw"');
    expect(markup.indexOf('data-organization-mark="raw"')).toBeLessThan(markup.indexOf('identity-chip-name'));
    expect(markup).not.toContain('lucide-user-round');
    expect(markup).not.toContain('Asked by');
    expect(markup).toContain('href="/monitoring?who=<your-username>%40example.test"');
    expect((markup.match(/<a /g) ?? []).length).toBe(1);
    expect(markup.indexOf('How did Hoops')).toBeLessThan(markup.indexOf('identity-chip-name'));
    expect(markup.indexOf('question-attribution-surface')).toBeLessThan(markup.indexOf('How did Hoops'));
    expect(markup.indexOf('identity-chip-name')).toBeLessThan(markup.lastIndexOf('</div>'));
  });

  it('draws one rounded outer border, one integrated tail, and no connector boxes', () => {
    const group = rule('.question-attribution-bubble');
    const surface = rule('.question-attribution-surface');
    const tail = rule('.question-attribution-surface::after');
    const hostPseudo = rule('.question-attribution-bubble::before,\n.question-attribution-bubble::after');
    const message = rule('.question-attribution-message');
    const meta = rule('.question-attribution-meta');
    const identity = rule('.question-attribution-bubble .question-attribution-user.identity-chip');

    expect(group).toContain('overflow: visible');
    expect(group).toContain('border: 0');
    expect(group).toContain('border-radius: 0');
    expect(group).toContain('background: transparent');
    expect(group).toContain('box-shadow: none');
    expect(group).not.toMatch(/\bgap\s*:/);
    expect(hostPseudo).toContain('display: none');
    expect(hostPseudo).toContain('content: none');
    expect(hostPseudo).toContain('background: none');
    expect(hostPseudo).toContain('border: 0');
    expect(surface).toContain('border: 1px solid var(--ast-border-input)');
    expect(surface).toContain(
      'border-radius: calc(var(--radius-md) * 2) calc(var(--radius-md) * 2) var(--radius-sm) calc(var(--radius-md) * 2)'
    );
    expect(surface).toContain('background: var(--ast-pane)');
    expect(surface).toContain('overflow: visible');
    expect(tail).toContain("content: ''");
    expect(tail).toContain('right: 22px');
    expect(tail).toContain('bottom: -5px');
    expect(tail).toContain('border-right: 1px solid var(--ast-border-input)');
    expect(tail).toContain('border-bottom: 1px solid var(--ast-border-input)');
    expect(tail).toContain('background: inherit');
    expect(tail).toContain('pointer-events: none');
    expect(message).toContain('border: 0');
    expect(message).toContain('border-radius: 0');
    expect(message).toContain('background: transparent');
    expect(message).toContain('box-shadow: none');
    expect(meta).toContain('border-left: 1px solid var(--ast-border-input)');
    expect(meta).toContain('background: transparent');
    expect(meta).toContain('box-shadow: none');
    expect(identity).toContain('border: 0');
    expect(identity).toContain('border-radius: 0');
    expect(identity).toContain('background: transparent');
    expect((CSS.match(/content:\s*''/g) ?? []).length).toBe(1);
    expect(CSS).not.toMatch(/question-attribution-(?:message|meta|user)[^,{]*(?::before|::after)/);
    expect(CSS).not.toMatch(/clip-path|margin-(?:left|top):\s*7px/);
  });

  it('cannot regain the legacy rectangular Ask backing through the later cascade', () => {
    const home = source('HomePage.tsx');

    expect(home).not.toContain('questionClassName="user-bubble"');
    expect(SHIPPED_CSS).not.toContain('.user-bubble');
    expect(ASK_CSS).toContain('.user-message .question-attribution-message');
    const ordinaryDarkQuestionRules = [...DARK_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selectors]) => selectors.includes('.question-attribution-message') && !selectors.includes('::selection')
    );
    expect(ordinaryDarkQuestionRules).toEqual([]);
    expect(APPEARANCE_CSS).not.toMatch(/question-attribution-(?:bubble|message|meta|surface)/);
    expect(ANSWER_BODY_CSS).not.toContain('.user-bubble');
  });

  it('wraps long questions and keeps a one-surface second row when narrow', () => {
    expect(rule('.question-attribution-message')).toContain('overflow-wrap: anywhere');
    expect(CSS).toContain('@media (max-width: 480px)');
    expect(CSS).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.question-attribution-surface\s*\{[^}]*width:\s*100%[^}]*flex-direction:\s*column/
    );
    expect(CSS).toMatch(
      /\.question-attribution-bubble \.question-attribution-message\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/
    );
    expect(CSS).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.question-attribution-meta\s*\{[^}]*width:\s*100%[^}]*border-top:\s*1px solid var\(--ast-border-input\)[^}]*border-left:\s*0/
    );
  });

  it('isolates the user click and changes only linked text and icon states', () => {
    expect(CSS).toContain('.question-attribution-meta > .user-drilldown-link:is(:hover, :focus-visible)');
    expect(CSS).not.toContain('.question-attribution-bubble:hover');
    expect(rule('.question-attribution-meta > .user-drilldown-link .identity-chip-name')).toContain(
      'text-decoration-color: transparent'
    );
    expect(source('UserDrilldownLink.tsx')).toContain('event.stopPropagation()');
    expect(source('OrganizationUserBadge.tsx')).toContain('organization ${resolved.name}');
  });

  it('uses shared occlusion, density, dark-theme, and high-contrast contracts', () => {
    expect(rule('.question-attribution-surface')).toContain('background: var(--ast-pane)');
    expect(rule('.question-attribution-message')).toContain('padding: var(--density-row-padding-block) 14px');
    expect(rule('.question-attribution-bubble .question-attribution-user.identity-chip')).toContain(
      'padding: var(--density-row-padding-block) 12px'
    );
    expect(CSS).toContain("html[data-theme='dark'] .question-attribution-surface");
    expect(CSS).toContain('@media (forced-colors: active)');
    expect(CSS).toContain('border-color: CanvasText');
    expect(CSS).toContain('background: Canvas');
    expect(CSS).not.toMatch(/border-color:\s*var\(--(?:ast|db)-(?:blue|info)/);
  });

  it('anchors answer-view spacing below chrome without moving other hosts', () => {
    const activeAsk = rule(".ask-layout[data-transcript='active'] .conversation-main", ASK_CSS);
    const askTrack = rule('.conversation-main', ASK_CSS);
    const askBubbleHost = rule('.user-message', ASK_CSS);
    const monitoringHost = rule('.monitoring-question-attribution', MONITORING_CSS);
    const runHost = rule('.run-question-attribution', RUNS_CSS);

    expect(activeAsk).toContain('padding-top: var(--density-page-gap)');
    expect(activeAsk).toContain('padding-bottom: 0');
    expect(activeAsk).not.toMatch(/^\s*(?:position|transform|margin-top|margin-block-start|top)\s*:/m);
    expect(askTrack).toContain('var(--conversation-inset)');
    expect(askTrack).not.toMatch(/margin-(?:top|block-start):\s*-/);
    expect(askBubbleHost).toContain('margin-bottom: 22px');
    expect(askBubbleHost).not.toMatch(/^\s*(?:position|transform|top)\s*:/m);
    expect(monitoringHost).not.toMatch(/^\s*(?:position|transform|margin-top|margin-block-start|top)\s*:/m);
    expect(runHost).not.toMatch(/^\s*(?:position|transform|margin-top|margin-block-start|top)\s*:/m);
  });

  it('is the question-and-asker host for Ask, Monitoring, and Run Explorer', () => {
    const home = source('HomePage.tsx');
    const monitoring = source('MonitoringPage.tsx');
    const runs = source('RunHeader.tsx');

    expect(home).toMatch(/message\.role === 'user'[\s\S]{0,260}<QuestionAttributionBubble/);
    expect(monitoring).toMatch(/<QuestionAttributionBubble[\s\S]{0,260}questionId="monitoring-question-title"/);
    expect(runs).toMatch(/run \? \([\s\S]{0,220}<QuestionAttributionBubble/);
    expect(monitoring).not.toContain('headerExtra={<UserIdentityChip');
    expect(runs).not.toMatch(/run-detail-ident[\s\S]{0,900}<UserDrilldownLink/);
  });
});

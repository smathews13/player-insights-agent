import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { QuestionAttributionBubble } from './QuestionAttributionBubble';

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const CSS = source('styles/question-attribution.css');

function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('}', start));
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
    expect(markup).toContain('Asked by');
    expect(markup).toContain('href="/monitoring?who=<your-username>%40example.test"');
    expect((markup.match(/<a /g) ?? []).length).toBe(1);
    expect(markup.indexOf('How did Hoops')).toBeLessThan(markup.indexOf('Asked by'));
    expect(markup.indexOf('question-attribution-surface')).toBeLessThan(markup.indexOf('How did Hoops'));
    expect(markup.indexOf('Asked by')).toBeLessThan(markup.lastIndexOf('</div>'));
  });

  it('draws exactly one outer border with one internal divider and no connector', () => {
    const group = rule('.question-attribution-bubble');
    const surface = rule('.question-attribution-surface');
    const message = rule('.question-attribution-message');
    const meta = rule('.question-attribution-meta');
    const identity = rule('.question-attribution-bubble .question-attribution-user.identity-chip');

    expect(group).not.toMatch(/\bborder(?:-radius)?\s*:/);
    expect(group).not.toMatch(/\bgap\s*:/);
    expect(surface).toContain('border: 1px solid var(--ast-border-input)');
    expect(surface).toContain('border-radius: var(--radius-md)');
    expect(surface).toContain('background: var(--ast-pane)');
    expect(message).toContain('border: 0');
    expect(message).toContain('border-radius: 0');
    expect(message).toContain('background: transparent');
    expect(meta).toContain('border-left: 1px solid var(--ast-border-input)');
    expect(identity).toContain('border: 0');
    expect(identity).toContain('border-radius: 0');
    expect(identity).toContain('background: transparent');
    expect(CSS).not.toMatch(/question-attribution[^,{]*(?::before|::after)/);
    expect(CSS).not.toMatch(/rotate\(|clip-path|margin-(?:left|top):\s*7px/);
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
    expect(source('UserDrilldownLink.tsx')).toContain('aria-label={`Open user overview for ${identityName(email)}`}');
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

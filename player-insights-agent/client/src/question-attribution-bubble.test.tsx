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
  it('reads the question before one isolated user link', () => {
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
    expect(markup).toContain('class="question-attribution-message"');
    expect(markup).toContain('Asked by');
    expect(markup).toContain('href="/monitoring?who=<your-username>%40example.test"');
    expect((markup.match(/<a /g) ?? []).length).toBe(1);
    expect(markup.indexOf('How did Hoops')).toBeLessThan(markup.indexOf('Asked by'));
  });

  it('bridges the two borders with a decorative tail and no floating flex gap', () => {
    const group = rule('.question-attribution-bubble');
    const message = rule('.question-attribution-message');
    const tail = rule('.question-attribution-message::after');
    const attachment = rule(
      '.question-attribution-bubble > .user-drilldown-link,\n.question-attribution-bubble > .question-attribution-user'
    );

    expect(group).toContain('align-items: flex-end');
    expect(group).not.toMatch(/\bgap\s*:/);
    expect(message).toContain('border: 1px solid var(--ast-border-input)');
    expect(message).toContain('border-radius: var(--radius-md) var(--radius-md) 0 var(--radius-md)');
    expect(tail).toContain("content: ''");
    expect(tail).toContain('right: -7px');
    expect(tail).toContain('border-right: 1px solid var(--ast-border-input)');
    expect(tail).toContain('pointer-events: none');
    expect(attachment).toContain('margin-left: 7px');
  });

  it('wraps long questions and moves attribution to an attached second row when narrow', () => {
    expect(rule('.question-attribution-message')).toContain('overflow-wrap: anywhere');
    expect(CSS).toContain('@media (max-width: 480px)');
    expect(CSS).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.question-attribution-bubble\s*\{[^}]*flex-direction:\s*column/
    );
    expect(CSS).toMatch(
      /\.question-attribution-bubble \.question-attribution-message\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/
    );
    expect(CSS).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.question-attribution-message::after\s*\{[^}]*bottom:\s*-7px/
    );
    expect(CSS).not.toMatch(/question-attribution-(?:bubble|message)[^{]*\{[^}]*overflow:\s*(?:hidden|clip)/);
  });

  it('keeps hover on the username and preserves high-contrast geometry', () => {
    expect(CSS).toContain('.question-attribution-bubble > .user-drilldown-link:hover');
    expect(CSS).not.toContain('.question-attribution-bubble:hover');
    expect(source('UserDrilldownLink.tsx')).toContain('event.stopPropagation()');
    expect(CSS).toContain('@media (forced-colors: active)');
    expect(CSS).toContain('border-color: CanvasText');
    expect(CSS).toContain('background: Canvas');
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

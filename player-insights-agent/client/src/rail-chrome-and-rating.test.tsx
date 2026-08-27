/**
 * Four reports from the live build, and the one thing they have in common.
 *
 * The release badge that does not match the two controls beside it, the question
 * that sits directly over the answer's right edge, the settings pane you can
 * read the page through, and a thumbs-down that records nothing. Each is a claim
 * about what a reader is looking at, and each was previously "fixed" in a way
 * that could not have moved a pixel -- a `padding-left` on a right-aligned row,
 * a rating written only if the reader also typed a sentence.
 *
 * So the assertions here are about mechanism rather than intent: that the
 * property changed is one that can produce the effect asked for, that the rule
 * written can win the cascade position it has to win, and that the click that is
 * supposed to record a rating is the click that calls the write. No browser was
 * launched, so what this cannot see is the paint itself; everything below is the
 * stylesheet as the cascade assembles it, and the markup as the page emits it.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AnswerCard } from './AnswerCard';
import { DeploymentTimeChip } from './DeploymentTimeChip';
import { RunStatusPill } from './RunStatusPill';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { runStatusFor } from './run-status';
import { DOWN_RATING, EMPTY_FEEDBACK, UP_RATING } from './stored-feedback';
import { partial, partialNames } from './styles/stylesheet';
import type { Answer, FeedbackEntry } from './app-types';

const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const ROUTES = readFileSync(new URL('../../server/routes/insights-routes.ts', import.meta.url), 'utf8');

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const SHELL = strip(partial('shell.css'));
const ACCOUNT = strip(partial('account-menu.css'));
const ASK = strip(partial('ask.css'));
const RAIL = partial('rail.css');
const SETTINGS = strip(partial('settings.css'));
const DARK = strip(partial('dark-mode.css'));

/** One rule's body, by exact selector, from a comment-stripped partial. */
function rule(css: string, selector: string): string {
  const match = css.match(
    new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
  );
  expect(match, `${selector} exists`).not.toBeNull();
  return match?.[1] ?? '';
}

/** Everything inside one at-rule, braces balanced, so nested rules come with it. */
function atRule(css: string, prelude: string): string {
  const start = css.indexOf(prelude);
  expect(start, `${prelude} exists`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  throw new Error(`${prelude} is unclosed`);
}

function answer(): Answer {
  return normalizeAnswer({
    id: 'msg-1',
    mode: 'live',
    takeaway: 'Active players rose 4%.',
    narrative: 'Active players rose 4% over the period.',
    figures: [],
    sources: [],
    caveats: [],
    sql: 'SELECT 1',
    trace: { id: 'tr-1', totalMs: 10, toolCalls: 1, stages: [] },
  } as WireAnswer) as Answer;
}

function cardMarkup(feedback: FeedbackEntry): string {
  return renderToStaticMarkup(
    <AnswerCard
      answer={answer()}
      feedback={feedback}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback
    />
  );
}

/** The card's footer as a reader reads it, tags removed. */
const cardText = (feedback: FeedbackEntry) =>
  cardMarkup(feedback)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('the release badge and the two controls beside it', () => {
  /**
   * The three compact chips on the header rail are the release stamp, the
   * account badge and the gear, and the stamp was reported as "styled
   * differently from its neighbours". The surface half already agreed -- same
   * height, hairline, radius, fill and ink, pinned in
   * deployment-time-chip.test.tsx -- so what was left is the two properties
   * that were not compared to anything: a 12px glyph against the badge's 14px,
   * with 6px of gap against its 8px, and no response to the pointer at all.
   */
  it('draws its glyph and gap at the account badge’s size, not one grade smaller', () => {
    const chip = rule(SHELL, '.deployment-time-chip');
    const badge = rule(ACCOUNT, '.account-menu-trigger');

    expect(badge).toMatch(/gap:\s*8px/);
    expect(chip).toMatch(/gap:\s*8px/);
    // Stated in the rule as well as in the markup's utility class, so the size
    // cannot quietly change to a third value with the class still in place.
    expect(rule(SHELL, '.deployment-time-chip > svg')).toMatch(/width:\s*14px/);
    expect(rule(ACCOUNT, '.account-menu-trigger > svg')).toMatch(/width:\s*14px/);
    const markup = renderToStaticMarkup(<DeploymentTimeChip deployedAt="2026-08-20T16:51:23.456Z" />);
    expect(markup).toContain('size-3.5');
    expect(markup).not.toMatch(/class="[^"]*size-3"/);
  });

  it('answers the pointer with the same fill its neighbours do', () => {
    // The inert chip on a rail of three was most of the reported difference: two
    // of them lift under the pointer and one did nothing.
    expect(ACCOUNT).toMatch(/\.account-menu-trigger:hover \{\s*background: var\(--muted\)/);
    expect(SHELL).toMatch(
      /\.deployment-time-chip:hover,\s*\.deployment-time-chip:focus-visible \{\s*background: var\(--muted\)/
    );
  });

  it('keeps its own class rather than borrowing the badge’s', () => {
    // Wearing `account-menu-trigger` was tried and backed out. account-menu.css
    // is imported after shell.css, so its `font: inherit`, its 250px cap and its
    // `> span` ellipsis would all have won -- and that last one matches the
    // tooltip, which is a span, and would have clipped the release fact.
    const markup = renderToStaticMarkup(<DeploymentTimeChip deployedAt="2026-08-20T16:51:23.456Z" />);
    expect(markup).not.toContain('account-menu-trigger');
    expect(partialNames().indexOf('shell.css')).toBeLessThan(partialNames().indexOf('account-menu.css'));
  });
});

describe('a conversation with a run in flight', () => {
  it('wears the harness’s own live badge in the rail row', () => {
    // The same component the inspector column draws, so the rail cannot end up
    // with a second live chip written in its own hand.
    const row = HOME.slice(HOME.indexOf('<span className="conversation-item-head">'));
    expect(row.slice(0, row.indexOf('</span>'))).toContain('<RunStatusPill status={runStatus} />');
    expect(HOME).toContain('Boolean(readLiveAsk(conversation.id)?.inFlight)');
  });

  it('breathes with the one animation the app has for this, not a second one', () => {
    const live = renderToStaticMarkup(
      <RunStatusPill
        status={runStatusFor({
          loading: true,
          liveSteps: 3,
          runStopped: false,
          awaitingApproval: false,
          asked: true,
          answered: false,
          readiness: 'ready',
        })}
      />
    );

    expect(live).toContain('is-alive');
    expect(live).toContain('run-status-dot');
    expect(live).toContain('Live · step 03');
    // One keyframes block, seated once, and the finished pill does not wear it:
    // a completed run whose dot went on moving would be claiming the harness was
    // still working.
    expect(RAIL.match(/@keyframes run-status-breath/g)).toHaveLength(1);
    expect(RAIL).toMatch(/\.run-status\.is-alive \.run-status-dot \{\s*animation: run-status-breath/);
    const done = renderToStaticMarkup(
      <RunStatusPill
        status={runStatusFor({
          loading: false,
          liveSteps: 3,
          runStopped: false,
          awaitingApproval: false,
          asked: true,
          answered: true,
          readiness: 'ready',
        })}
      />
    );
    expect(done).not.toContain('is-alive');
  });

  it('holds the dot still for a reader who asked for less motion', () => {
    const guard = atRule(RAIL, '@media (prefers-reduced-motion: reduce)');
    expect(guard).toContain('.run-status.is-alive .run-status-dot');
    expect(guard).toMatch(/animation:\s*none/);
  });
});

describe('the question staggered right of the answer', () => {
  it('insets the question row from the answer’s left edge, without shrinking the answer', () => {
    // `margin-right` on the answer pinched the card and left both turns sharing
    // a left edge: the bubble is `flex-end`, so taking width off the card moved
    // nothing the reader could see. `margin-left` on the row is the property
    // that can produce the offset.
    expect(ASK).toMatch(/\.conversation-main \{\s*--question-stagger: clamp\(72px, 14%, 180px\);\s*\}/);
    expect(rule(ASK, '.user-message')).toMatch(/margin-left:\s*var\(--question-stagger\)/);
    expect(ASK).not.toMatch(/\.conversation-main \.answer-card \{[^}]*margin-right:\s*var\(--question-stagger\)/);
  });

  it('does not move the bubble out of the measure to do it', () => {
    // A `translateX` on the row was the previous attempt. The page is the
    // scroller and `.trace-inspector` is a later sibling painting an opaque sky,
    // so a bubble pushed past the measure goes behind the harness rather than
    // into the gap -- and just above 1180px the middle track is far narrower
    // than the measure, so there is no gap there to move into at all.
    const row = rule(ASK, '.user-message');
    expect(row).not.toContain('transform');
    expect(row).not.toContain('margin-right');
    expect(row).not.toContain('padding-right');
    // The row still ends at the measure's right edge. The offset is the left
    // inset, so a long prompt cannot begin where the answer begins.
    expect(row).toMatch(/justify-content:\s*flex-end/);
  });

  it('gives the lane back where there is no harness column to lean toward', () => {
    // In the app's one breakpoint set rather than behind a `min-width` of this
    // partial's own: a second set of widths is the defect breakpoints.test.ts
    // exists to catch, and it is how the nav once collapsed 100px after the
    // column it shares a header with.
    const band = atRule(partial('responsive.css'), '@media (max-width: 1180px)');

    expect(band).toMatch(/\.conversation-main \{\s*--question-stagger: 0px;/);
    expect(band).toContain('.trace-inspector');
    expect(ASK).not.toMatch(/@media\s*\((?:max|min)-width/);
  });

  it('is scoped to Ask, not to every card that shares the recipe', () => {
    // The same card is drawn in Run Explorer and in the Monitoring drawer, and
    // neither has a question above it.
    expect(ASK).not.toMatch(/(?:^|[};])\s*\.answer-card \{[^}]*margin-right/);
  });
});

describe('the settings pane, frosted like the account menu', () => {
  const FROST = "html[data-theme='dark'] .settings-overlay .settings-page.settings-modal";

  it('is the account menu’s surface rather than three per cent white', () => {
    const frost = rule(SETTINGS, FROST);

    // The dropdown is the surface being mimicked, so this reads its token rather
    // than a hand-mixed navy that would drift from it.
    expect(rule(DARK, "html[data-theme='dark'] .account-menu")).toContain('--ast-surface-solid');
    expect(frost).toContain('var(--ast-surface-solid)');
    expect(frost).toMatch(/backdrop-filter:\s*blur\(18px\)/);
    expect(frost).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.03\)/);
  });

  it('stays glass rather than becoming a slab', () => {
    // Asked for explicitly: less see-through, not opaque. A `color-mix` toward
    // transparent keeps the sky readable as depth behind the pane; the token on
    // its own would be a solid.
    const frost = rule(SETTINGS, FROST);
    expect(frost).toMatch(/color-mix\(in srgb, var\(--ast-surface-solid\) 92%, transparent\)/);
    expect(frost).toMatch(/backdrop-filter/);
  });

  it('gives none of that glass to a reader who asked for less transparency', () => {
    // dark-mode.css makes this modal solid under the preference, and the rule
    // above now outranks that one. Undoing an accessibility preference for the
    // sake of a look is the one way this change could have done harm.
    const guard = atRule(SETTINGS, '@media (prefers-reduced-transparency: reduce)');

    expect(guard).toContain(FROST);
    expect(guard).toMatch(/background:\s*var\(--ast-surface-solid\)/);
    expect(guard).toMatch(/backdrop-filter:\s*none/);
    expect(atRule(DARK, '@media (prefers-reduced-transparency: reduce)')).toContain(
      "html[data-theme='dark'] .settings-page.settings-modal"
    );
  });

  it('carries the extra class it needs to win the position it cannot win', () => {
    // dark-mode.css is imported after settings.css and states the rail frost at
    // `html[data-theme='dark'] .settings-page.settings-modal`, so an equal-weight
    // rule here would lose on order alone. The overlay is the modal's own
    // wrapper, which is one class and no `!important`.
    expect(partialNames().indexOf('settings.css')).toBeLessThan(partialNames().indexOf('dark-mode.css'));
    expect(SETTINGS).toContain('.settings-overlay .settings-page.settings-modal');
    expect(SETTINGS).not.toContain('!important');
  });
});

describe('a thumb is the rating, on both sides', () => {
  it('writes the negative rating on the click of the icon', () => {
    // The whole of the report: this used to be `onClick={() =>
    // onFeedbackChange({ open: true })}`, so the icon opened a text field and
    // recorded nothing, and a reader who typed nothing had rated nothing.
    const down = CARD.slice(CARD.indexOf('aria-label="Thumbs down"'));
    const handler = down.slice(0, down.indexOf('<ThumbsDown'));

    expect(handler).toContain('void saveFeedback(DOWN_RATING, { keepCommentOpen: true })');
    expect(handler).toContain('onFeedbackChange({ open: true })');
    // The box is what stays open behind the write, not the condition of it.
    expect(handler).not.toMatch(/onClick=\{\(\) => onFeedbackChange\(\{ open: true \}\)\}/);
  });

  it('keeps the positive one on the same footing', () => {
    const up = CARD.slice(CARD.indexOf('aria-label="Thumbs up"'));
    expect(up.slice(0, up.indexOf('<ThumbsUp'))).toContain('void saveFeedback(UP_RATING)');
    // Both values live with the function that decides which thumb they light, so
    // a rating cannot be stored that lights neither control.
    expect(UP_RATING).toBe(5);
    expect(DOWN_RATING).toBe(2);
  });

  it('shows the reader that the negative rating landed', () => {
    // The state the page reaches after that click: rated 2, saved, box still
    // open for the optional sentence.
    const state: FeedbackEntry = { ...EMPTY_FEEDBACK, saved: true, usefulness: DOWN_RATING, open: true };
    const markup = cardMarkup(state);

    expect(markup).toMatch(
      /aria-label="Thumbs down"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Thumbs down"/
    );
    expect(markup).toContain('feedback-chosen');
    expect(cardText(state)).toContain('Feedback saved');
    // Optional, and still there: the reader can say why against a rating that is
    // already recorded.
    expect(markup).toContain('What could be better?');
  });

  it('does not leave an older confirmation standing over a rating in flight', () => {
    // Exactly what the screenshot showed: "Feedback saved" beside an unlit
    // thumbs-down, left over from the press before it, saying the click had been
    // recorded when it had not.
    expect(HOME).toContain('patch({ saving: true, saved: false, error: null })');
    expect(cardText({ ...EMPTY_FEEDBACK, saving: true })).not.toContain('Feedback saved');
  });

  it('keeps the comment box open only for the click that opened it', () => {
    const save = HOME.slice(
      HOME.indexOf('async function saveFeedback'),
      HOME.indexOf('async function uploadAttachments')
    );

    expect(save).toContain('open: options.keepCommentOpen === true');
    // A blank box is not a comment. `''` would be stored and then rendered as an
    // empty one wherever comments are read back.
    expect(save).toContain('comment: entry.comment.trim() || undefined');
  });

  it('is accepted by the route with no comment attached', () => {
    // The server half of "the comment is optional": the body schema asks for the
    // rating and nothing else, and a missing comment is written as NULL rather
    // than refused.
    const body = ROUTES.slice(ROUTES.indexOf('const FeedbackBody'));
    const schema = body.slice(0, body.indexOf('});'));

    expect(schema).toMatch(/usefulness: z\.number\(\)\.int\(\)\.min\(1\)\.max\(5\)\.optional\(\)/);
    expect(schema).toMatch(/comment: z\.string\(\)\.max\(2000\)\.optional\(\)/);
    expect(ROUTES).toContain('feedback.comment ?? null');
  });
});

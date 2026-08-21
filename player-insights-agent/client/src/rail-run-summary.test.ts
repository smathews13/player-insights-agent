import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { railDuration, railRunSummaries, railStatusTone } from './rail-run-summary';
import { RATING_SCALE, ratingOutOf } from './benchmark-summary';
import { partial } from './styles/stylesheet';
import type { Run } from './app-types';

/**
 * The conversation rail's row, which is now the Run Explorer's recorded-runs card.
 *
 * Two halves, and they fail for different reasons. The collapse from a list of
 * runs to one summary per conversation is arithmetic and is tested as such. The
 * card itself is a stylesheet and a piece of markup: asserted by reading them,
 * because the complaint that produced this pass was about what the rail looked
 * like, and no rendered tree in a jsdom without layout can answer that either.
 * What CAN be pinned is that the parts are present, that the row asks for the run
 * card's own treatment rather than a third one, and that nothing is drawn for a
 * conversation with no run.
 */

const RAIL_CSS = partial('rail.css');
const RUNS_CSS = partial('runs.css');
const HOME_PAGE = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');

function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** One rule's body, by exact selector. */
function body(selector: string, css: string = RAIL_CSS) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(css).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

/** A declaration's value in pixels. */
function px(rule: string, property: string) {
  const match = rule.match(new RegExp(`${property}:\\s*(-?[\\d.]+)px`));
  return match ? Number.parseFloat(match[1]) : undefined;
}

function run(over: Partial<Run> & { id: string }): Run {
  return {
    kind: 'conversation',
    conversation_id: 'conv-1',
    prompt: 'Which titles are churning?',
    stakeholder: 'someone@example.com',
    status: 'complete',
    duration_ms: 4200,
    rating: null,
    created_at: '2026-08-14T10:00:00.000Z',
    ...over,
  };
}

describe('a rail row reports the conversation’s latest turn, or reports nothing', () => {
  it('keeps the newest turn of each conversation, by its timestamp rather than by its place in the list', () => {
    // The endpoint sorts newest-first and taking the first match would be right
    // today. It is compared instead, because "the latest turn" is the claim the
    // pill makes, and the day that ORDER BY changes the rail would go quietly
    // wrong rather than loudly.
    const summaries = railRunSummaries([
      run({ id: 'old', conversation_id: 'conv-1', status: 'failed', created_at: '2026-08-01T09:00:00.000Z' }),
      run({ id: 'new', conversation_id: 'conv-1', status: 'complete', created_at: '2026-08-14T09:00:00.000Z' }),
      run({ id: 'other', conversation_id: 'conv-2', status: 'partial', created_at: '2026-08-10T09:00:00.000Z' }),
    ]);
    expect(summaries.get('conv-1')?.status).toBe('complete');
    expect(summaries.get('conv-2')?.status).toBe('partial');
  });

  it('says nothing at all about a conversation it holds no run for', () => {
    // The normal state for a conversation nobody has asked anything yet, and for
    // somebody else's conversation on a shared rail: the runs query is scoped to
    // the caller, so their turns were never sent to this browser. Both have to
    // arrive as an absent entry rather than as a neutral "complete", which would
    // be this client claiming something it was never told.
    const summaries = railRunSummaries([run({ id: 'a', conversation_id: 'conv-1' })]);
    expect(summaries.has('conv-9')).toBe(false);
    // And a benchmark run is not a turn in anybody's conversation.
    expect(railRunSummaries([run({ id: 'b', kind: 'benchmark', conversation_id: null })]).size).toBe(0);
  });

  it('carries a duration and a rating only where the store recorded one', () => {
    const summaries = railRunSummaries([
      run({ id: 'a', conversation_id: 'conv-1', duration_ms: null, rating: null }),
      run({ id: 'b', conversation_id: 'conv-2', duration_ms: 12_340, rating: 4 }),
    ]);
    expect(summaries.get('conv-1')).toMatchObject({ durationMs: null, rating: null });
    expect(summaries.get('conv-2')).toMatchObject({ durationMs: 12_340, rating: 4 });
    // An unrecorded wall time is absent, not zero: a turn stored before the trace
    // carried `totalMs` did not take no time.
    expect(railDuration(null)).toBeNull();
    expect(railDuration(12_340)).toBe('12.3s');
    expect(railDuration(4200)).toBe('4.2s');
  });

  it('gives an unrecognised status the neutral tone and prints the word anyway', () => {
    expect(railStatusTone('complete')).toBe('ast-pill--pos');
    expect(railStatusTone('failed')).toBe('ast-pill--neg');
    expect(railStatusTone('partial')).toBe('ast-pill--warn');
    expect(railStatusTone('marinating')).toBe('ast-pill--neutral-outline');
    expect(railStatusTone(null)).toBe('ast-pill--neutral-outline');
    // A run whose status column is null still HAS a status, and it is unknown --
    // which is a different statement from having no run, and the row makes it.
    expect(railRunSummaries([run({ id: 'a', status: null })]).get('conv-1')?.status).toBe('unknown');
  });

  it('reports a turn that stopped early only where the server said so', () => {
    // The same rule the Explorer's row applies, and for the same reason: an
    // older server does not report the fact at all, and "not reported" is not
    // "ran to the end". A mark that is silently always absent reads as a
    // positive claim that nothing was cut short.
    const summaries = railRunSummaries([
      run({ id: 'a', conversation_id: 'conv-1', truncated: true }),
      run({ id: 'b', conversation_id: 'conv-2', truncated: false }),
      run({ id: 'c', conversation_id: 'conv-3' }),
      run({ id: 'd', conversation_id: 'conv-4', truncated: null }),
    ]);
    expect(summaries.get('conv-1')?.truncated).toBe(true);
    for (const id of ['conv-2', 'conv-3', 'conv-4']) expect(summaries.get(id)?.truncated).toBe(false);
  });

  it('never lets a malformed timestamp displace a turn that has a real one', () => {
    const summaries = railRunSummaries([
      run({ id: 'real', status: 'complete', created_at: '2026-08-14T09:00:00.000Z' }),
      run({ id: 'broken', status: 'failed', created_at: 'not a date' }),
    ]);
    expect(summaries.get('conv-1')?.status).toBe('complete');
  });
});

describe('the row is the run card, not a third style', () => {
  it('takes the run card’s selection language, and has dropped the rail’s left rule', () => {
    const row = body('.conversation-row');
    const card = body('.run-item', RUNS_CSS);
    // A border in every state, so picking a row cannot move the row below it --
    // the property the run card was written for and the rail did not have.
    expect(row).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(body('.conversation-row:hover')).toMatch(/border-color:\s*var\(--primary\)/);
    expect(body('.conversation-row.active')).toMatch(/border-color:\s*var\(--primary\)/);
    expect(row).toMatch(/background:\s*var\(--ast-white\)/);
    expect(body('.conversation-row.active')).toMatch(/background:\s*var\(--ast-white\)/);
    expect(body('.conversation-row.active')).not.toMatch(/transparent|rgba|selected-tint|ast-navy/);
    // The 3px marker is gone from every state, including the delete confirmation,
    // and its absence is what gave the title back three of its pixels.
    expect(row).not.toMatch(/border-left/);
    expect(body('.conversation-row.confirming')).not.toMatch(/border-left/);
  });

  it('pads the card once, so the title is not inset twice', () => {
    // The old row padded itself AND the button inside it, and the button also sat
    // beside a permanently reserved 26px column for a control that is invisible
    // until hover. The card pads itself and the button pads nothing.
    expect(px(body('.conversation-row'), 'padding')).toBe(10);
    expect(body('.conversation-item')).toMatch(/padding:\s*0(px)?\s*;/);
  });

  it('holds the delete corner on the head line only, and puts the control in it', () => {
    // The one line that pays for the control. Reserving it on the card would have
    // cost the title the same 22px the old layout did; not reserving it at all
    // puts a destructive button on top of the date the moment anybody hovers.
    const control = body('.conversation-delete');
    expect(control).toMatch(/position:\s*absolute/);
    const reserved = px(body('.conversation-item-head'), 'padding-right') ?? 0;
    const width = px(control, 'width') ?? 0;
    const right = px(control, 'right') ?? 0;
    expect(width).toBeGreaterThan(0);
    expect(reserved).toBeGreaterThanOrEqual(width + right - 10);
    // Still revealed by hover and focus rather than drawn on every row, and never
    // removed from the tab order.
    expect(RAIL_CSS).toMatch(/\.conversation-row:hover \.conversation-delete/);
  });

  it('seats the app’s one status recipe rather than restating it', () => {
    // §2 allows the app ONE status chip: 1px border, tint, 4px radius, 11px/500,
    // never colour alone. The rail used to keep its own copy of that rule against
    // the retired db- washes, which is how one screen ends up a shade off the rest
    // the day somebody restyles the other.
    expect(HOME_PAGE).toContain('ast-pill conversation-status');
    expect(HOME_PAGE).toContain("summary.truncated === true ? 'ast-pill--warn' : summary.tone");
    const recipe = body('.ast-pill', partial('astrolabe-tokens.css'));
    expect(recipe).toMatch(/border-radius:\s*var\(--ast-radius-control\)/);
    expect(recipe).toMatch(/font-size:\s*var\(--ast-fs-11\)/);
    // And the retired recipe is gone rather than left defined and unseated. A rule
    // nothing draws is the next reader's example of how this rail does a pill.
    expect(withoutComments(RAIL_CSS)).not.toMatch(/\.conversation-pill/);
    expect(HOME_PAGE).not.toMatch(/conversation-pill/);
  });

  it('keeps only the three properties a 264px column adds to that recipe', () => {
    // The store's own word, capitalised rather than relabelled, so a status this
    // client has not been taught still reads as itself. The other two are the
    // narrow rail's, and the test below is the one that explains them.
    const seat = body('.conversation-status');
    expect(seat).toMatch(/text-transform:\s*capitalize/);
    expect(seat).toMatch(/flex:\s*none/);
    expect(seat).toMatch(/white-space:\s*nowrap/);
    // Nothing else: a colour, a radius or a size here would be the restatement
    // coming back one declaration at a time.
    expect(seat).not.toMatch(/color|background|border|font-size|padding/);
  });

  it('takes a family per tone, with the neutral one outlined for the selected row', () => {
    expect(railStatusTone('complete')).toBe('ast-pill--pos');
    // The selected row stays an opaque light card over the navy rail. Its status
    // stays outlined so the border, rather than a second fill, carries selection.
    expect(body('.conversation-row.active')).toMatch(/background:\s*var\(--ast-white\)/);
    expect(railStatusTone('marinating')).toBe('ast-pill--neutral-outline');
    const outline = body('.ast-pill--neutral-outline', partial('astrolabe-tokens.css'));
    expect(outline).not.toMatch(/background/);
    expect(outline).toMatch(/border-color/);
  });

  it('collapses a truncated turn to the one Partial status pill', () => {
    expect(HOME_PAGE).toMatch(/summary\.truncated === true \? 'partial' : summary\.status/);
    expect(HOME_PAGE).not.toContain('Truncated');
  });

  it('lets the head line wrap, because two pills and a date do not fit the narrow rail', () => {
    // THE GEOMETRY THE SECOND PILL COSTS, and it is arithmetic rather than
    // caution. Inside the 220px rail below 1180px the head line has about 152px:
    // 220 less the rail's own 24 of padding, the card's border and its 20, then
    // the 22 held for the delete control. A status pill and "Truncated" and a
    // relative date come to about 187px at this size. Nothing in that line is
    // allowed to give -- a pill is `flex: none` so it cannot be squeezed and
    // `nowrap` so it cannot break, both deliberately, because a status word split
    // across two lines is not a status -- so the overflow has nowhere to go and
    // the date lands under the delete control. That is the clipping this rail has
    // had "fixed" twice by moving something two pixels.
    //
    // Asserted as the implication rather than as a measured string width: the
    // three facts below cannot all hold without a wrap, and each of them is a
    // decision somebody made on purpose.
    const pill = body('.conversation-status');
    expect(pill, 'a pill cannot be squeezed').toMatch(/flex:\s*none/);
    expect(pill, 'a pill cannot be broken').toMatch(/white-space:\s*nowrap/);
    expect(body('.conversation-item-head')).toMatch(/flex-wrap:\s*wrap/);
    // And the date still goes to the right of whichever line it ends up on, which
    // is what `margin-left: auto` is doing there rather than `space-between`.
    expect(body('.conversation-item-head .conversation-age')).toMatch(/margin-left:\s*auto/);
  });

  it('draws the sheet copy at the width the column is hidden at', () => {
    // The sheet is the rail below 800px, and responsive.css hides
    // `.conversation-rail` there. One class in a media query beats nothing at all,
    // so a copy that declares no display of its own opens as an empty panel with
    // a title on it. This is the whole of that fix, and it is the kind of rule a
    // tidy-up removes as redundant.
    expect(body('.conversation-rail.is-sheet')).toMatch(/display:\s*flex/);
    expect(partial('responsive.css')).toMatch(/@media \(max-width: 800px\)/);
  });

  it('reserves the scrollbar a strip rather than letting it sit on the rows', () => {
    const rail = body('.conversation-rail');
    expect(rail).toMatch(/scrollbar-gutter:\s*stable/);
    expect(rail).toMatch(/scrollbar-width:\s*thin/);
    // The reserve is paid for out of this edge's padding, so the rows are no
    // narrower than they were: 8px of padding plus the thin bar is the 16px of
    // clearance the other three sides have.
    expect(withoutComments(rail)).toMatch(/padding:\s*16px 8px 16px 16px/);
  });
});

describe('a star says what it is out of', () => {
  it('prints the scale the write path constrains a rating to', () => {
    // "★ 5" was reported as unreadable, and it was: five stars, five out of ten
    // and five ratings all print that way. The denominator is not a choice made
    // here -- the feedback column is constrained to 1-5 and storedRating treats
    // anything outside that as absent.
    expect(RATING_SCALE).toBe(5);
    expect(ratingOutOf(5)).toBe('5/5');
    expect(ratingOutOf(4)).toBe('4/5');
  });

  it('is the same sentence on all three surfaces that print one', () => {
    // The rail row, the Explorer's card, and the Benchmark Lab's table. A bare
    // `rating.value` beside a star on any of them is the defect coming back.
    //
    // The expression may be wrapped in one element. The Benchmark Lab's rating
    // repeats down a table column, so the FIGURE is `.ast-num` while the star
    // beside it is a glyph and must not be; that puts a `<span>` between the two.
    // What is being asserted is what gets printed, not what it is wrapped in.
    for (const file of ['HomePage.tsx', 'RunExplorer.tsx', 'BenchmarkLab.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
      const stars = [...source.matchAll(/<Star[^>]*\/>\s*(?:<span[^>]*>\s*)?\{([^}]+)\}/g)].map((match) =>
        match[1].trim()
      );
      expect(stars.length, `${file} draws no star`).toBeGreaterThan(0);
      for (const printed of stars) expect(printed).toMatch(/ratingOutOf\(/);
    }
  });

  it('draws no star at all for a turn nobody rated', () => {
    // An empty star is a rating of zero, which is a claim nobody made.
    expect(HOME_PAGE).toMatch(/summary\?\.rating !== null && summary\?\.rating !== undefined/);
  });
});

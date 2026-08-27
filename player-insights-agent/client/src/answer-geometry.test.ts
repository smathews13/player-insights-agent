import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';

/**
 * The transcript's three cards, at the measurements the design gives them.
 *
 * Asserted against the source and the stylesheet, for the reason
 * message-selection.test.ts and palette.test.ts are: every claim here is a
 * painted pixel and this repo has no browser. What that buys is real but
 * narrow -- it proves the rules exist, that they say what the handoff says,
 * and that a later edit which quietly reverts one will fail. It cannot prove
 * the result looks right, and nothing in this file should be read as saying
 * anyone has seen it.
 *
 * The claims worth pinning are the ones that were wrong for a reason rather
 * than by a pixel: a value printed on the fill it has to be read against, a
 * delta coloured green because its text did not begin with a hyphen, a
 * provenance chip in the colour of a button.
 */
const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
/**
 * The card's copy with its comments removed, for the assertions about what the
 * card may not SAY. The comments explain at length what a sentence used to claim
 * and why it stopped, so a check for a forbidden phrase run over the whole file
 * fails on the explanation of the fix.
 */
const PROSE = CARD.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
const PLAN = readFileSync(new URL('./PlanCard.tsx', import.meta.url), 'utf8');
const CHARTS = readFileSync(new URL('./AnswerCharts.tsx', import.meta.url), 'utf8');
const ANSWER_CSS = partial('answer.css');
const ASK_CSS = partial('ask.css');
const MONITORING_CSS = partial('monitoring.css');
const BODY_CSS = partial('answer-body.css');
const STYLESHEET = stylesheet();

/**
 * The body of the rule whose selector list starts a line with `selector`.
 *
 * The same helper answer-markdown.test.ts uses, and it has the same limit: it
 * finds the FIRST such rule. Where a selector is declared in two partials the
 * caller has to say which file it means, which is why the two are read
 * separately above as well as concatenated.
 */
function ruleFor(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector}`);
  expect(at, `${selector} is declared`).toBeGreaterThan(-1);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

describe('the answer and plan cards sit on the design’s scale, not the library’s', () => {
  it('takes the one card radius and no shadow', () => {
    // 8px is the card radius and 4px the control radius; there is no third, and
    // AppKit's 12px was one. The shadow went with the page gradient -- a card
    // that floats over a flat white page reads as a dialog.
    for (const selector of ['.answer-card {', '.plan-card {']) {
      expect(ruleFor(ANSWER_CSS, selector)).toContain('border-radius: var(--ast-radius-card)');
      expect(ruleFor(ANSWER_CSS, selector)).toContain('box-shadow: none');
    }
  });

  it('cancels AppKit card padding so Live sits on the top edge', () => {
    // Header padding 8px was already set; AppKit Card's py-6 still dropped the
    // row a gutter. Zero the card itself. Ask and Monitoring restate it.
    const card = ruleFor(ANSWER_CSS, '.answer-card {');
    expect(card).toMatch(/padding:\s*0/);
    expect(card).not.toMatch(/padding-top:\s*(1[2-9]|2[0-9])px/);
    expect(ruleFor(ASK_CSS, '.conversation-main .answer-card {')).toMatch(/padding:\s*0/);
    expect(ruleFor(MONITORING_CSS, '.monitoring-question-modal .answer-card {')).toMatch(
      /padding:\s*0/
    );
  });

  it('closes the gap between sections to the answer-card specification’s 14px', () => {
    // The difference between a card holding ten sections and a card holding ten
    // pages. AppKit's own value is 24px, and the answer card has ten of them.
    expect(ruleFor(ANSWER_CSS, '.answer-card,')).toContain('gap: 14px');
  });

  it('draws the answer mark at the compact 18px seating', () => {
    // The light seating is navy on the daylight card and is remapped to white by
    // dark-mode.css. Asking for the dark seating here would make the mark white in
    // both themes and erase it from the light card.
    expect(CARD).toContain('<AstrolabeMark size={18} ink="light" />');
    const mark = ruleFor(ANSWER_CSS, '.answer-card-mark {');
    expect(mark).toContain('width: 18px');
    expect(mark).toContain('height: 18px');
    expect(CARD).not.toContain('className="agent-avatar"');
  });

  it('sizes the takeaway as a card heading and not as a hero', () => {
    // 16.5px/700. It was a clamp to 28px on a page whose own h2 is 22px, so the
    // one sentence in the card out-shouted the page it was on.
    const rule = ruleFor(ANSWER_CSS, '.answer-takeaway {');
    expect(rule).toContain('font-size: calc(var(--ast-fs-16) + 0.5px)');
    expect(rule).toContain('font-weight: 700');
    expect(rule).toContain('line-height: 1.35');
  });

  it('uses the answer specification’s compact 1.5 reading rhythm', () => {
    const rule = ruleFor(BODY_CSS, '.answer-card .answer-prose,');
    expect(rule).toContain('line-height: 1.5');
    expect(rule).not.toContain('var(--ast-lh-body)');
  });

  it('sets Source and the following paragraphs on the same 14px body rung', () => {
    // 12.5px prose and an 11px Source line were the same reading block drawn
    // two sizes too small for the unused measure. One type step to 14px; the
    // takeaway and the figure rail stay on the rungs already pinned above.
    expect(ruleFor(ANSWER_CSS, '.answer-prose {')).toContain('font-size: var(--ast-fs-14)');
    expect(ruleFor(BODY_CSS, '.source-list {')).toContain('font-size: var(--ast-fs-14)');
    expect(ruleFor(ANSWER_CSS, '.answer-takeaway {')).toContain(
      'font-size: calc(var(--ast-fs-16) + 0.5px)'
    );
    expect(ruleFor(BODY_CSS, '.answer-stat-value {')).toContain('font-size: var(--ast-fs-16)');
  });
});

describe('the provenance chip has three tones and none is the action colour', () => {
  it('states a live answer as a compact neutral surface pill', () => {
    const rule = ruleFor(ANSWER_CSS, ".provenance-chip[data-tone='live'] {");
    expect(rule).toContain('background: var(--ast-neutral-fill)');
    expect(rule).toContain('color: var(--ast-text)');
    expect(rule).not.toContain('--ast-blue');
    // AppKit's default Badge is `bg-primary`. The slot selector has to win
    // that utility, or "Live agent response" stays a neon slab.
    expect(ANSWER_CSS).toContain("[data-slot='badge'].provenance-chip[data-tone='live']");
  });

  it('separates a half-stored answer from a wholly stored one', () => {
    // THE THIRD TONE, AND THE REASON FOR IT. Both used to be `destructive`,
    // because the chip was coloured from AppKit's `variant` and that has no rung
    // between fine and failure. So an answer whose narrative is live and whose
    // figures are stored wore the same chip as one where nothing ran at all --
    // and a reader has to do different things about those. The first is an
    // answer to their question with numbers that are not theirs; the second is
    // not an answer to their question.
    //
    // Warning tinted for mixed, because it qualifies the answer under it and a
    // solid mass above a heading reads as a refusal. Negative SOLID for stored,
    // which is the one filled chip in the app and is the design reference's own
    // drawing at 11ar: #A04A62 is 5.93:1 with white on it, so the label is still
    // type at 11px.
    const mixed = ruleFor(ANSWER_CSS, ".provenance-chip[data-tone='mixed'] {");
    expect(mixed).toContain('background: var(--ast-warn-fill)');
    expect(mixed).toContain('border: 1px solid var(--ast-warn-border)');
    expect(mixed).toContain('color: var(--ast-warn-text)');

    const stored = ruleFor(ANSWER_CSS, ".provenance-chip[data-tone='stored'] {");
    expect(stored).toContain('background: var(--ast-neg-text)');
    expect(stored).toContain('color: var(--ast-white)');
    expect(stored, 'the two are not the same chip').not.toContain('var(--ast-warn-fill)');
  });

  it('paints a failure chip as muted dark red, not a light or pink fill', () => {
    const rule = ruleFor(ANSWER_CSS, ".provenance-chip[data-tone='failed'] {");
    expect(rule).toContain('color-mix(in oklab, var(--ast-navy) 72%, var(--ast-neg-text))');
    expect(rule).toContain('color: var(--ast-ice)');
    expect(rule).not.toMatch(/background:\s*var\(--ast-neg-text\)/);
    expect(rule).not.toMatch(/#e8a9b8|#faf3f5|--ast-neg-fill|--ast-neg-on-dark/i);
    expect(ANSWER_CSS).toContain("[data-slot='badge'].provenance-chip[data-tone='failed']");
  });

  it('is never blue, because a blue pill above a heading reads as a control', () => {
    for (const tone of ['live', 'mixed', 'stored']) {
      const rule = ruleFor(ANSWER_CSS, `.provenance-chip[data-tone='${tone}'] {`);
      expect(rule, `the ${tone} chip`).not.toMatch(/--db-blue|--ast-blue|--primary|#2272b4/i);
    }
  });

  it('leaves which chip appears to the module that reads what the server stated', () => {
    // The most serious defect this card can ship is a chip that is wrong about
    // where a figure came from, so the tone is derived from the decision rather
    // than chosen beside it: one call drives the label, the variant and the
    // attribute the stylesheet keys on. A literal label here would be a second
    // opinion about provenance living in the presentation layer.
    expect(CARD).toContain('const badge = answerBadge(answer);');
    expect(CARD).toContain('<Badge variant={badge.variant} className="provenance-chip" data-tone={badge.tone}>');
    expect(CARD).toContain('{badge.label}');
  });
});

describe('the compact stat rail preserves every figure', () => {
  it('replaces the old bar panel with stat rail cards', () => {
    expect(CARD).toContain('className="answer-stat-rail"');
    expect(CARD).toContain('className="answer-stat-value ast-num"');
    expect(CARD).not.toContain('Result breakdown');
    expect(CARD).not.toContain('<i style={{ width:');
  });

  it('keeps the figures in the agent’s order, uncapped', () => {
    // The same rule the caveats have and for the same reason: the agent chose
    // which figures to return and in what order, and a sort or a slice here
    // would be this surface editing the result.
    // Two figures can share a label, and a key that was the label alone dropped
    // the second. The content signature stays stable when figures move; exact
    // duplicates receive an occurrence suffix rather than an array-position key.
    expect(CARD).toContain('const figureOccurrences = new Map<string, number>();');
    expect(CARD).toContain('const keyedFigures = answer.figures.map((figure) => {');
    expect(CARD).toContain('{keyedFigures.map(({ figure, key }) => (');
    expect(CARD).toContain('<div className="answer-stat" key={key}>');
    expect(CARD).not.toContain('key={`${position}-');
    expect(CARD).not.toMatch(/answer\.figures\.(slice|sort|filter)\(/);
  });
});

describe('stat comparisons remain neutral and recoverable', () => {
  it('keeps comparison text neutral and verbatim in the stat context', () => {
    // The `title` is the same string again and not a second reading of it: the rail
    // clips this line to one row, and a comparison naming a window and a baseline
    // ellipsised away the thing the figure is being compared against.
    expect(CARD).toMatch(
      /<span className="answer-stat-context" title=\{figure\.comparison\}>\s*\{figure\.comparison\}\s*<\/span>/
    );
    expect(CARD).not.toMatch(/comparison\.(replace|slice|substring)\(/);
  });

  it('leaves the sign in the text, so the direction is never colour alone', () => {
    expect(CARD).toContain('{figure.comparison}');
    expect(CARD).not.toMatch(/comparison\.(replace|slice|substring)\(/);
  });
});

describe('the caveats change how loudly they are said and nothing else', () => {
  it('keeps Keep in mind and Run process in the card’s stacking flow', () => {
    expect(ruleFor(BODY_CSS, '.keep-in-mind {')).toContain('position: static');
    expect(ruleFor(BODY_CSS, '.keep-in-mind {')).toContain('margin: 0');
    expect(ruleFor(BODY_CSS, '.run-process {')).toContain('position: static');
    expect(ruleFor(BODY_CSS, '.run-process {')).toContain('margin: 0');
    const content = ruleFor(BODY_CSS, '.answer-card-content {');
    expect(content).toContain('display: grid');
    expect(content).toContain('grid-auto-rows: auto');
    expect(content).toContain('overflow: visible');
    expect(content).toContain('align-content: start');
  });

  it('draws Keep in mind as its own compact surface box', () => {
    // Amber is the evaluation colour and these are the qualifications on the
    // figures above them. What changed is where it is spent: this was a
    // free-standing alert under the sources, and an alert is a box, so on the
    // neutral wash it read as one more panel in a column of panels and was
    // missed for months. It is now the closing zone of the Sources module,
    // separated from the rows by a hairline in the same hue rather than by a
    // gap, so the qualification arrives attached to the tables it qualifies.
    //
    // The hue moved with the palette. DuBois amber #FFAB00 was a signal colour
    // that could not be read as type at 11px; astrolabe's warning family is
    // #8A6A38 on #F9F6EF behind #E0D3B8, which is muted on purpose and is what
    // the design reference draws at 8ar. Same meaning, same seating, a family
    // whose text rung is legible.
    const rule = ruleFor(BODY_CSS, '.keep-in-mind {');
    expect(rule).toContain('background: var(--ast-ice)');
    expect(rule).toContain('border-radius: 6px');
    expect(rule).toContain('border: 0');
  });

  it('labels the block with a heading rather than a warning glyph', () => {
    // The alert brought an icon with it, in the deep rung, which was the only
    // amber glyph the card allowed. Read beside an amber wash it made the block
    // look like an error the reader had caused rather than a note about the
    // figures, so the label is now a heading and the wash is the whole alarm.
    expect(ruleFor(BODY_CSS, '.keep-in-mind-heading {')).toContain('font-weight: 700');
    expect(ruleFor(BODY_CSS, '.keep-in-mind-heading {')).toContain('letter-spacing: var(--ast-tracking-eyebrow)');
    expect(BODY_CSS).not.toContain('caveat-alert');
    // The deep rung survives on the one control in the block, which needs to be
    // legible as a control without recruiting the action blue into an amber
    // panel for the sake of showing two more lines of the same list.
    expect(ruleFor(BODY_CSS, '.keep-in-mind-toggle {')).toContain('var(--ast-blue)');
  });

  it('gives a scope tag, a linked table and a named column the same mono tag', () => {
    // Three ways of naming a thing inside one bullet -- the tag in front of the
    // sentence, a table the app can link, a column it can only mark -- and a
    // reader has no reason to care which is which. They are one visual object
    // in the amber tint, and only the link keeps the underline that says it can
    // be followed.
    const rule = ruleFor(BODY_CSS, '.keep-in-mind .caveat-scope,');
    expect(rule).toContain('font-family: var(--font-mono)');
    // The warning family's mono fill, which is an rgba of its deep rung rather
    // than a hex: a tag inside a tinted panel has to sit ON the wash, and an
    // opaque second tint at these two values reads as a rendering fault.
    expect(rule).toContain('background: var(--ast-warn-mono-fill)');
    expect(BODY_CSS).toContain('.keep-in-mind a[data-entity] {');
  });

  // Count, order, wording and the absence of a cap are caveat-list.test.ts's,
  // which asserts them against this same file. Nothing is restated here.
});

describe('the run process is one panel rather than a bar and a box', () => {
  it('carries its edge on the container', () => {
    // At the control rung rather than the hairline: the answer card is a
    // high-alpha white over the sky, and #EBEBEB on that is an edge nobody can
    // see. Same step .ast-pill--neutral-outline makes for the same reason.
    const rule = ruleFor(BODY_CSS, '.run-process {');
    expect(rule).toContain('border: 1px solid var(--ast-border-input)');
    expect(rule).toContain('border-radius: var(--ast-radius-card)');
  });

  it('rules the head instead of washing it', () => {
    // THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, and the decision it
    // pinned no longer has two options to choose between. It read "washes the head
    // instead of drawing a second edge under it", because a wash and a rule together
    // are two separations doing one job. Every grey band on the sky has since gone:
    // the card is a translucent white sheet and a #F7F7F7 band on it is the exact
    // thing that made the sheet read as grey. With no wash to pick, the hairline is
    // the only thing left that can say the head is a heading and not the first line
    // of the body -- and this head, unlike the Sources module's, had no rule of its
    // own to fall back on, so one is added rather than merely uncovered.
    const rule = ruleFor(BODY_CSS, '.run-process-head {');
    expect(rule).toContain('background: transparent');
    expect(rule).toContain('border-bottom: 1px solid var(--ast-hairline)');
  });

  it('pushes the control to the end of the head row', () => {
    // The trigger renders as a Button, whose own data-slot replaces the
    // trigger's, so the rule reaches it as an element rather than by slot.
    expect(ruleFor(BODY_CSS, '.run-process-head > button {')).toContain('margin-left: auto');
  });

  it('leaves what is drawn inside it to the timeline', () => {
    // The boundary with the trace screen: this file owns the disclosure and its
    // head bar, TraceTimeline owns the roll-up and the Gantt.
    expect(CARD).toContain('<CollapsibleContent className="run-process-body">');
    expect(CARD).toMatch(/<TraceTimeline trace={processTrace}/);
    expect(BODY_CSS).not.toContain('.trace-kpi');
    expect(BODY_CSS).not.toContain('.gantt');
  });
});

describe('the plan card says which state it is in, in the colour that state means', () => {
  it('waits in the warning family and resolves to the positive one', () => {
    // ASSERTED ON THE MARKUP NOW, BECAUSE THE STYLESHEET NO LONGER DECIDES IT.
    // The chip used to declare its own radius, padding, size, weight and then a
    // wash and a deep-rung label per state -- one of twenty-one independently
    // written chip recipes in this app, which disagreed with each other on every
    // axis. It takes `.ast-pill` and one family class, so the colours are the
    // same two the trace, the Connections rows and the Sources module use, and
    // there is nothing left in `answer.css` to read them out of.
    //
    // The hues moved with the palette rather than the meaning: DuBois amber
    // #FFAB00 could not be read as type at 11px, and astrolabe's #8A6A38 on
    // #F9F6EF is the muted family drawn for exactly this.
    expect(PLAN).toContain(
      "`ast-pill plan-state ast-pill--${state === 'approved' ? 'pos' : state === 'review' ? 'warn' : 'neutral'}`"
    );
    expect(ANSWER_CSS, 'no second recipe survives in the stylesheet').not.toMatch(
      /\.plan-state\[data-state='(review|approved)'\]\s*\{/
    );
  });

  it('drives the tint from the same flag as the label', () => {
    // One value for all three statements -- chip label, chip tint, and the
    // sentence at the foot -- so the card cannot say "Approved" over copy that
    // says nothing ran. The third state is a plan settled without being
    // approved: revised away, or left behind by the next question.
    expect(PLAN).toContain("const state = approved ? 'approved' : resolved ? 'superseded' : 'review';");
    expect(PLAN).toContain('data-state={state}');
    expect(PLAN).toContain("{state === 'approved' ? 'Approved' : state === 'review' ? 'Review needed' : 'Not run'}");
  });

  it('keeps the sentence that says no query has run yet', () => {
    // Load-bearing copy. The card is a consent gate, and this is the line that
    // tells the reader what approving it will do.
    expect(PLAN).toContain('No analytical query runs until you approve this plan.');
    expect(PLAN).toContain('You approved this plan. The analysis below was produced by running these steps.');
    // And the third: claiming an approval the reader never gave is the same
    // defect in the other direction.
    expect(PLAN).toContain('None of these steps ran. The turn below replaced this plan.');
  });

  it('reassures in green, which is the reachable-or-saved colour', () => {
    // The positive family, which is the same three values the state chip above it
    // and the Sources rows take. It was DuBois' green wash, so the reassurance and
    // the chip two lines from it were two different greens.
    const rule = ruleFor(ANSWER_CSS, "[data-slot='alert'].plan-reassurance {");
    expect(rule).toContain('background: var(--ast-pos-fill)');
    expect(rule).toContain('border-color: var(--ast-pos-border)');
  });

  it('numbers the steps in the pressed-segment fill at 22px, in the face that can line them up', () => {
    // Same pair Rendered | Raw uses. `--ast-blue` remaps to ice on the night
    // sky, which as a filled 22px circle is the neon chip the reader asked to
    // darken. The shared token stays action-blue in daylight and the hover
    // rung in dark.
    const rule = ruleFor(ANSWER_CSS, '.plan-step > span {');
    expect(rule).toContain('width: 22px');
    expect(rule).toContain('background: var(--ast-seg-pressed)');
    expect(rule).toContain('color: var(--ast-seg-pressed-ink)');
    expect(rule).not.toContain('--ast-blue');
    // MONO ON THE MARKUP, AND NO `tabular-nums` LEFT IN THE RULE. The reason
    // given for the property was that a ten-step plan should not have a wider
    // circle at 10 than at 9, and the circle is 22px either way, so that was
    // never the risk. The digits inside it were, and DM Sans cannot line those
    // up: it declares no `tnum` feature, so the property switched on nothing.
    expect(rule).not.toContain('tabular-nums');
    expect(PLAN).toContain('<span className="ast-num">');
  });

  it('right-aligns the decision, with the query-starting action last', () => {
    expect(ruleFor(ANSWER_CSS, '.plan-actions {')).toContain('justify-content: flex-end');
    expect(PLAN.indexOf('Revise request')).toBeLessThan(PLAN.indexOf('Approve and run'));
  });

  it('presses in blue and never in the evaluation colour', () => {
    // palette.test.ts enforces this across the app; asserted here because this
    // card is the one place amber and a primary button are inches apart.
    expect(ruleFor(ANSWER_CSS, '.plan-actions {')).not.toMatch(/amber/i);
  });
});

describe('the chart panel is a panel on this card, not a second page', () => {
  it('takes the hairline, the 8px radius and 16px of padding', () => {
    const rule = ruleFor(BODY_CSS, '.chart-card {');
    expect(rule).toContain('border-radius: var(--ast-radius-card)');
    expect(rule).toContain('padding-block: 16px');
    expect(ruleFor(BODY_CSS, ".chart-card > [data-slot='card-header'],")).toContain('padding-inline: 16px');
  });

  it('titles itself as a sub-block, under the takeaway rather than beside it', () => {
    const rule = ruleFor(BODY_CSS, ".chart-card > [data-slot='card-header'] [data-slot='card-title'] {");
    expect(rule).toContain('font-size: var(--ast-fs-14)');
    expect(rule).toContain('font-weight: 700');
  });

  it('heads itself with one eyebrow, and no line working the plot for the reader', () => {
    // "Hover for values, drag to zoom, double-click to reset" sat under the
    // title as the card's description. It was a manual for three affordances
    // Plotly discloses itself: the tooltip follows the pointer, and the mode
    // bar appears on hover carrying zoom, pan and Reset axes as labelled
    // buttons with their own titles.
    //
    // Pinned as the shape rather than the sentence. The head may hold the title
    // and nothing else, so a REWORDED hint fails here too, whatever element it
    // comes back as. The chart-kind badge that used to sit opposite the title is
    // gone with it: it named the shape a reader can see, and the panel is now
    // half a card wide.
    const prose = CHARTS.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
    const head = prose.match(/<figcaption[\s\S]*?<\/figcaption>/)?.[0] ?? '';
    expect(head).toContain('answer-chart-eyebrow');
    expect(head).not.toContain('<Badge');
    expect(prose).not.toContain('<CardHeader>');
    expect(prose).not.toContain('<Badge');
    // Scoped past the head: the boundary's failure notice is a paragraph, and it
    // is the one piece of prose in this file that says something the reader
    // cannot see for themselves.
    // It now points at where the figures went rather than reassuring the reader
    // about the rest of the card. A panel that will not draw took the evidence with
    // it, and the card unfolds the Markdown rows when this fires, so the sentence
    // says where to look. "The rest of this answer is unaffected" was true and
    // useless: the reader wanted the numbers, not the paragraph above them.
    expect(prose).toContain('Its figures are in the rows below.');
    // No instruction anywhere in the panel, under any wording.
    expect(prose).not.toMatch(/\b(hover|drag|zoom|click|scroll|pinch|tap)\b/i);
    // The other side: the rule that sized that description. It styled nothing
    // else, and left behind it is a slot that makes the next hint look intended.
    expect(BODY_CSS).not.toContain(".chart-card > [data-slot='card-header'] [data-slot='card-description']");
  });

  it('keeps all three interactions the removed line described', () => {
    // Deleting the caption must not delete the behaviour it narrated. These are
    // the affordances a reader still has, and the mode bar is what discloses
    // them now, so the buttons that reset and zoom may not be stripped from it.
    const plot = readFileSync(new URL('./plotly-config.ts', import.meta.url), 'utf8');
    expect(plot).toContain("doubleClick: 'reset'");
    expect(plot).toContain("displayModeBar: 'hover'");
    expect(plot).not.toMatch(/resetScale2d|zoom2d|pan2d/);
  });

  it('holds the plot and the skeleton at the same one number', () => {
    // One constant for both, so the transcript does not jump when the chunk
    // lands. Two literals would drift the moment either was tuned -- and one was
    // tuned: 320 came down to 260 when the panel lost its card header and gained
    // a sibling beside it.
    expect(CHARTS).toContain('const CHART_HEIGHT = 260;');
    expect(CHARTS).toContain('<Skeleton style={{ height: CHART_HEIGHT }}');
    expect(CHARTS).toContain('height={CHART_HEIGHT}');
    // Both numbers counted in the code alone: the comment above the constant says
    // what the old height was and why it came down, which is prose about a literal
    // rather than a second literal.
    const code = CHARTS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.match(/\b260\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/\b320\b/);
  });

  it('fetches Plotly only when an answer carries a chart', () => {
    expect(CHARTS).toContain("lazy(() => import('./PlotlyFigure'))");
    expect(CHARTS).toContain('<Suspense fallback=');
  });

  it('loses one chart rather than the answer around it', () => {
    expect(CHARTS).toContain('static getDerivedStateFromError()');
    expect(CHARTS).toContain('<ChartBoundary onFailure={onFailure}>');
    // Inside the map, so the boundary is per panel: one boundary around the
    // list would take every chart down with the first one that threw.
    expect(CHARTS.indexOf('<ChartBoundary')).toBeLessThan(CHARTS.indexOf('function AnswerCharts'));
  });

  it('reserves the mono face for what a reader compares character by character', () => {
    // SQL and identifiers, which is what it is for. The rule used to be stated
    // the other way round -- the source name was set in DM Sans and the point
    // was that the freshness line under it must not be mono. Both halves have
    // moved: the name is an identifier a reader checks against the one in the
    // prose above, so it takes the mono face, and there is no freshness line
    // left to get wrong because the freshness is in the row's tooltip.
    expect(ruleFor(BODY_CSS, '.code-panel pre {')).toContain('var(--font-mono');
    // The shared source-name recipe also reaches derivation rows; pin the
    // recipe rather than the one seating that opts into it.
    expect(ruleFor(BODY_CSS, '.source-name-pill {')).toContain('var(--font-mono)');
    // And the other half: the label beside a derivation value is a word that is
    // the same under every answer, not something to be compared, so mono on it
    // would make prose read as data. This replaces the same claim about the
    // retired Sources card header's fact count.
    expect(ruleFor(BODY_CSS, '.derivation-label {')).not.toContain('font-family');
  });

  it('adds no series colour of its own, and neither does the component that mounts it', () => {
    // The panel and the mount are both colourless. The spec's colours are the
    // agent's and are resolved against the current theme in plotly-config.ts,
    // over a COPY -- a colour written HERE would be a second palette arguing
    // with the one the figure declared, on a surface that cannot see the theme.
    const plot = readFileSync(new URL('./PlotlyFigure.tsx', import.meta.url), 'utf8');
    for (const source of [CHARTS, plot]) {
      expect(source).not.toMatch(/marker|colorway|--chart-|#[0-9a-f]{6}/i);
    }
  });

  it('leaves the figure’s label arrangement to the agent, theming and all', () => {
    // Where the legend sits, how much room the tick labels get, which slice
    // labels are drawn and at what angle are one arrangement in the agent's
    // `new_plot`, applied to every chart it can produce. Written a second time
    // at this end it would only cover the shapes whoever wrote it had in mind,
    // and the agent writes the specs, so the next question is a shape nobody had
    // in mind.
    //
    // THE THEME PASS IS INCLUDED IN THAT, which is why it is scanned here. It
    // may repaint a label and may not move one: the four keys below are the ones
    // that decide where a label lands, and none of them is a colour.
    const plot = readFileSync(new URL('./PlotlyFigure.tsx', import.meta.url), 'utf8');
    const theme = readFileSync(new URL('./plotly-config.ts', import.meta.url), 'utf8');
    for (const source of [CHARTS, plot]) {
      expect(source).not.toMatch(/legend|automargin|tickangle|textposition|\bmargin\b/i);
    }
    expect(theme).not.toMatch(/automargin|tickangle|textposition|\bmargin\b/i);
  });
});

describe('the advanced panel is a row and a code block, on the shared recipes', () => {
  it('states the toggle row’s two lines in the stylesheet rather than on the markup', () => {
    // BOTH LINES USED TO CARRY UTILITY CLASSES THE STYLESHEET OUTRANKED. The
    // label had `font-medium text-sm` and the caption `text-xs
    // text-muted-foreground`, against `.advanced-row > div > p:first-child` and
    // `:last-child`, which are two-class selectors. So the markup named a 14px
    // 500 label the row has never drawn -- and the 500 it named was not even
    // wrong, only unenforced, which is the version of this that survives a
    // palette pass unnoticed. The weight is declared where the size is now.
    const label = ruleFor(BODY_CSS, '.advanced-row > div > p:first-child {');
    expect(label).toContain('font-size: var(--ast-fs-13)');
    expect(label).toContain('font-weight: 500');
    const caption = ruleFor(BODY_CSS, '.advanced-row > div > p:last-child {');
    expect(caption).toContain('font-size: var(--ast-fs-12)');
    expect(caption).toContain('color: var(--ast-text-secondary)');
    expect(CARD).toContain('<p>Advanced trace details</p>');
    expect(CARD).toContain('<p>Generated SQL and raw input and output of every stage</p>');
  });

  it('chips the SQL panel’s read-only note on the one pill recipe, outlined', () => {
    // Outlined and not tinted: the chip sits on the code panel's header, which is
    // the card's translucent sheet, and a neutral tint on a tinted surface reads as
    // a rendering fault rather than as a chip. That is the case
    // `--ast-pill--neutral-outline` exists for. The header used to carry
    // `--ast-fill-band` and the reasoning was the same then -- a tint on a tint.
    expect(CARD).toContain('className="ast-pill ast-pill--neutral-outline"');
  });

  it('says a failed rating in the negative family, not in AppKit’s destructive', () => {
    // The one sentence in the feedback row that reports a failure. It was
    // `text-destructive text-xs` on the markup, which is a second red beside the
    // three the rest of the card draws.
    expect(CARD).toContain('<span className="feedback-error">{feedback.error}</span>');
    const rule = ruleFor(BODY_CSS, '.feedback-error {');
    expect(rule).toContain('color: var(--ast-neg-text)');
    expect(CARD).not.toContain('text-destructive');
  });

  it('tints the chosen thumb from the one blue rather than a copy of it', () => {
    // The tint was a hand-written `rgba(34, 114, 180, 0.06)` behind a token
    // named for the state instead of the colour, so the palette could move and
    // this selected control would keep the old blue at 6%.
    const rule = ruleFor(BODY_CSS, '.feedback > button.feedback-chosen {');
    expect(rule).toContain('color-mix(in srgb, var(--ast-blue) 6%, transparent)');
    expect(rule).not.toMatch(/rgba\(|--db-/);
  });
});

describe('an entity in the prose is a link that says where it goes', () => {
  it('is blue at 500 with a pinned 1px dotted rule', () => {
    // The dotted underline is what separates "this names a table you can go and
    // inspect" from ordinary emphasis. `decoration-1` states the thickness the
    // browser would otherwise scale with the font size.
    const links = readFileSync(new URL('./DataEntityLinks.tsx', import.meta.url), 'utf8');
    expect(links).toContain('text-primary font-medium underline decoration-dotted decoration-1 underline-offset-2');
  });

  it('says so on hover as well, since a dotted rule is easy to miss', () => {
    const links = readFileSync(new URL('./DataEntityLinks.tsx', import.meta.url), 'utf8');
    expect(links).toContain('hover:decoration-solid');
  });

  it('keeps a solid rule for a link the agent wrote, which is a different offer', () => {
    expect(ruleFor(ANSWER_CSS, '.answer-link {')).toContain('text-decoration: underline');
    expect(ruleFor(ANSWER_CSS, '.answer-link {')).not.toContain('dotted');
  });
});

describe('the closing note and the feedback row', () => {
  it('separates the feedback with a hairline rather than a component', () => {
    // It was a <Separator />, which is a 24px-margined element in a card whose
    // sections are 16px apart.
    const rule = ruleFor(BODY_CSS, '.feedback {');
    expect(rule).toContain('border-top: 1px solid var(--ast-hairline)');
    expect(CARD).not.toContain('<Separator />');
  });

  it('sizes the icon buttons at the design’s 30px', () => {
    expect(ruleFor(BODY_CSS, '.feedback > button {')).toContain('width: 30px');
  });

  it('keeps the disclosure that names who read the data', () => {
    // Load-bearing copy, and the sentence a reader needs in order to know whose
    // grants the figures were computed under.
    expect(CARD).toContain('astrolabe analysis. Verify material decisions against cited sources.');
  });

  it('takes the identity half of that disclosure from the run, not from a constant', () => {
    // The card used to end "Data access executed by the Player Insights service
    // principal", which this deployment has not done since the reader's token
    // started being forwarded to the endpoint. A constant cannot be right about
    // an arrangement a release can change, so the sentence is derived from the
    // claim the run reported and the assertion is that no literal survives.
    expect(CARD).toContain('dataAccessDisclosure(answer.executionIdentity)');
    expect(PROSE).not.toMatch(/service principal/i);
    expect(PROSE).not.toMatch(/Data access executed by/i);
  });

  it('ends the note after the caveat when the run recorded no identity', () => {
    // The footer used to close "The identity this data was read as is
    // unconfirmed." on every run whose identity was not recorded. It is gone
    // rather than reworded: a doubt printed under an answer is a claim about
    // that answer, and it was being made on runs nobody had found anything
    // wrong with. `dataAccessDisclosure` returns null there and the card
    // renders the sentence conditionally, so nothing hedged can come back
    // through this line.
    expect(CARD).toContain('dataAccess ?');
    expect(PROSE).not.toMatch(/unconfirmed/i);
  });

  it('sets the note at 12px in the secondary grey', () => {
    expect(ruleFor(BODY_CSS, '.ai-note {')).toContain('font-size: var(--ast-fs-12)');
    expect(ruleFor(BODY_CSS, '.ai-note {')).toContain('color: var(--ast-text-secondary)');
  });
});

describe('the card holds text it did not write', () => {
  it('lets every agent-supplied string break wherever it has to', () => {
    // A table name is one word and longer than the column it lands in. The list
    // is long because AppKit's slots are reached by attribute and the Markdown
    // renderer's output is reached through its wrapper.
    const rule = ruleFor(BODY_CSS, '.answer-card p,');
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).toContain('min-width: 0');
    for (const selector of ['.answer-prose', '.keep-in-mind', '.dag-node']) {
      expect(BODY_CSS, `${selector} is in the wrapping list`).toContain(`\n${selector},`);
    }
  });

  it('wraps the fallback sentence in one child, because the alert slot is a grid', () => {
    // AppKit lays that slot out as a grid and puts every direct child on a row
    // of its own, which is what shipped "Nothing stored yet.Lakebase is
    // connected" on another screen. The headline and the sentence that finishes
    // it are one paragraph.
    // alert-layout.test.ts removed the app's `display: block` pin on that slot
    // and recorded the call-site wrapping as follow-up work. This is that work,
    // at the last call site still exposed to it.
    // Bounded by the alert's own closing tag rather than by the first `<AnswerProse`
    // after it: the evidence tables are now built into a variable above the return,
    // so that landmark moved above this alert and the slice came back empty.
    const alert = CARD.slice(CARD.indexOf('<Alert variant="destructive">'));
    const description = alert.slice(alert.indexOf('<AlertDescription>'), alert.indexOf('</Alert>'));
    expect(description.indexOf('<p>')).toBeLessThan(description.indexOf('fallbackNotice.headline'));
    expect(description).toMatch(/<\/p>\s*<\/AlertDescription>/);
  });

  it('omits a freshness it was not given rather than printing the separator', () => {
    // In SourcesModule.tsx since the Run Explorer and the answer card were found
    // disagreeing about this row's punctuation and stopped each drawing their
    // own. The freshness has moved from the row's text into its tooltip, but the
    // branch is the same one and the defect it guards against is the same: a
    // source that arrived without a freshness must not be labelled with a
    // dangling separator. What the row reads is rendered and read back in
    // sources-module-render.test.tsx; this pins the branch where it is written.
    const module = readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8');
    expect(module).toContain('row.freshness ? `${row.name} · ${row.freshness}` : row.name');
  });

  it('keeps sources as one bullet list rather than a nested card', () => {
    // The old bordered card had a head, ruled source rows and a derivation strip.
    // Provenance now reads as one bullet per table, using the same middot Keep in
    // mind uses; caveats keep their own compact surface immediately after it.
    const rule = ruleFor(BODY_CSS, '.sources-module {');
    expect(rule).toContain('min-width: 0');
    expect(readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8')).toContain(
      'className="answer-list source-list"'
    );
    expect(ruleFor(BODY_CSS, '.source-list {')).toContain('font-size: var(--ast-fs-14)');
  });

  it('places each recorded role after its source name', () => {
    // The retired source rows carried a separate role chip. In the list, the
    // role follows its source in parentheses and the source-name colour carries
    // the same family distinction without introducing another chip recipe.
    const module = readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8');
    // `title` carries what the role MEANS for the numbers -- "Its data is not in the
    // numbers shown" -- which had a line of its own on the retired Sources card and
    // no seating at all once provenance became one compact line.
    expect(module).toContain('<span className="source-list-role" title={row.note}>');
    expect(module).toContain('({row.chip})');
    expect(ruleFor(BODY_CSS, '.source-list-name,')).toContain('font-family: var(--font-mono)');
    expect(ruleFor(BODY_CSS, '.source-list-name,')).toContain('color: var(--ast-pos-text)');
  });
});

describe('the copy the reader asked us to drop stays dropped', () => {
  it('has none of the section titles that were removed', () => {
    const sources = `${CARD}${PLAN}${CHARTS}`;
    for (const phrase of ['Where the time went', 'How it worked', 'A friendly view', 'Interactive result']) {
      expect(sources, `${phrase} is gone`).not.toContain(phrase);
    }
  });

  it('does not argue for the design in the reader’s own card', () => {
    // Prose that explains why the app was built the way it was belongs in a
    // comment, and these three files carry a great deal of it there on purpose.
    // What must not appear is the same reasoning addressed to the reader, so the
    // comments are stripped and what is left is what reaches the screen.
    const copy = `${CARD}${PLAN}${CHARTS}`.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const phrase of ['we chose', 'we built', 'we decided', 'by design', 'for performance reasons']) {
      expect(copy.toLowerCase(), `"${phrase}" is not said to the reader`).not.toContain(phrase);
    }
  });

  it('describes the advanced panel by what it holds', () => {
    // It promised the payloads were sanitized, which is a claim about a
    // pipeline this card cannot see; what it can say is which things the switch
    // reveals. Two of them now rather than three: "all declared sources" named a
    // tab that was the source list a second time -- same names, same links, same
    // governance line -- and the caption is the one place a stale promise would
    // survive the tab being deleted.
    expect(CARD).toContain('Generated SQL and raw input and output of every stage');
    expect(CARD).not.toContain('sanitized');
    const caption = CARD.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
    expect(caption).not.toContain('all declared sources');
  });
});

describe('the two cards do not reach past the token block', () => {
  it('writes no colour of its own', () => {
    // palette.test.ts makes this claim for the whole stylesheet. It is made
    // again for these two partials because they are the files a designer is
    // most likely to paste a hex into, and white is the one literal allowed:
    // it is what sits on the ink chip and the blue numeral.
    //
    // Comments are stripped first, and deliberately: the contrast arithmetic
    // these rules were chosen by is recorded beside them in hex, and a check
    // that could not tell a note from a declaration would push those notes out
    // of the file to stay green.
    for (const [name, source] of [
      ['answer.css', ANSWER_CSS],
      ['answer-body.css', BODY_CSS],
    ] as const) {
      const declarations = source.replace(/\/\*[\s\S]*?\*\//g, '');
      const hexes = [...new Set(declarations.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])]
        .map((hex) => hex.toLowerCase())
        .filter((hex) => hex !== '#ffffff');
      expect(hexes, `${name} names colours by token`).toEqual([]);
    }
  });

  it('spends no token that is not the astrolabe palette’s', () => {
    // An ALLOWLIST, not a list of the older spellings. The two this caught were
    // `--text-h-card` and `--text-h-sub`, which no sweep for `--db-` would have
    // named: they are the previous heading scale, they resolve to 18px and 14px,
    // and the card therefore looked correct while sizing itself off a block the
    // astrolabe tokens do not own. A denylist only ever finds the tokens whoever
    // wrote it had already thought of.
    //
    // `--font-mono` is the one exception, and it is not a palette value: it is
    // the family `.ast-num` sets numerals in, and the tokens block is where it
    // is meant to be read from.
    for (const [name, source] of [
      ['answer.css', ANSWER_CSS],
      ['answer-body.css', BODY_CSS],
    ] as const) {
      const tokens = [...new Set(source.match(/var\(--[a-z0-9-]+/g) ?? [])].map((ref) => ref.replace('var(', ''));
      const foreign = tokens.filter((token) => !token.startsWith('--ast-') && token !== '--font-mono');
      expect(foreign, `${name} draws from the astrolabe tokens`).toEqual([]);
    }
  });

  it('is still part of the stylesheet the other tests read', () => {
    // partial() reads a file directly; stylesheet() parses index.css for the
    // import order. A partial dropped from that list would leave every claim
    // above passing and none of the rules loaded.
    expect(STYLESHEET).toContain('.provenance-chip {');
    expect(STYLESHEET).toContain('.answer-stat-rail {');
  });
});

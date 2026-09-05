import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ATTACH_LABEL, ATTACHING_LABEL, attachControlState } from './attach-control';
import { partial } from './styles/stylesheet';

/**
 * The composer's paperclip, which worked and said nothing about working.
 *
 * The decision is asserted as a function because the app's tests run without a
 * DOM, and the states are asserted against composer.css for the reason
 * answer-geometry.test.ts and palette.test.ts do the same: they are painted
 * pixels in a repo with no browser, so what this buys is that the rules exist
 * and that a later restyle which quietly drops one fails here. It cannot prove
 * any of them look right, and nothing below should be read as saying anyone has
 * seen them.
 *
 * The state that matters most is the one in the middle. A file being read,
 * uploaded and parsed is seconds of work on a PDF, and for the whole of it this
 * control was indistinguishable from a control at rest -- so pressing it again
 * was the reasonable response, and pressing it again starts a second
 * `uploadAttachments` over the same `<input>` element, whose `value` the first
 * one clears on its way out.
 */

const HOME_PAGE = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const COMPOSER = partial('composer.css');
const TOKENS = partial('tokens.css');

/** Comments stripped, so a state discussed in prose is not read as one declared. */
function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** One rule's body, by exact selector. */
function body(selector: string, css: string = COMPOSER) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(css).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

function state(overrides: Partial<Parameters<typeof attachControlState>[0]> = {}) {
  return attachControlState({ attaching: false, asking: false, conversationLoading: false, ...overrides });
}

describe('the attach control refuses input while it is working', () => {
  it('answers at rest', () => {
    expect(state()).toEqual({ disabled: false, pending: false, label: ATTACH_LABEL });
  });

  it('is disabled and pending while a file is in flight', () => {
    // Both halves, and the disabled half is the one that fixes a defect rather
    // than a look: it is what stops a second press starting a second upload over
    // the shared file input.
    expect(state({ attaching: true })).toEqual({ disabled: true, pending: true, label: ATTACHING_LABEL });
  });

  it('says it is working, in the present tense', () => {
    // "Attached" would be a claim about an outcome this control does not know.
    // The chip row under the composer reports what happened to each file.
    expect(ATTACHING_LABEL).toBe('Attaching…');
    expect(state({ attaching: true }).label).not.toBe(ATTACH_LABEL);
  });

  it('is disabled but not pending while a question runs or the conversation loads', () => {
    // The distinction is the whole reason `pending` exists separately. A control
    // waiting for a conversation to load is unavailable, not busy, and painting
    // the working tint on it would report work that nobody asked for.
    for (const reason of ['asking', 'conversationLoading'] as const) {
      const result = state({ [reason]: true });
      expect(result.disabled, `disabled while ${reason}`).toBe(true);
      expect(result.pending, `not pending while ${reason}`).toBe(false);
      expect(result.label).toBe(ATTACH_LABEL);
    }
  });

  it('stays pending when a run and an upload overlap', () => {
    // Precedence, asserted rather than left to the order of an `&&` chain: an
    // upload in flight is the more specific fact and is the one worth saying.
    expect(state({ attaching: true, asking: true, conversationLoading: true }).pending).toBe(true);
    expect(state({ attaching: true, asking: true }).label).toBe(ATTACHING_LABEL);
  });
});

describe('the composer wires the control to that one decision', () => {
  it('drives the label, the glyph, the disabled attribute and aria-busy from it', () => {
    // Four expressions of one state. They were not previously four expressions of
    // anything -- there was no state -- and the failure this guards against is
    // one of them being computed separately later and drifting from the rest.
    expect(HOME_PAGE).toContain("import { ATTACH_LABEL, attachControlState } from './attach-control';");
    expect(HOME_PAGE).toMatch(/const attachControl = attachControlState\(\{\s*attaching,\s*asking: loading,/);
    expect(HOME_PAGE).toContain('aria-busy={attachControl.pending}');
    expect(HOME_PAGE).toContain('disabled={attachControl.disabled}');
    expect(HOME_PAGE).toMatch(
      /<PiaBusyButtonContent\s+busy=\{attachControl\.pending\}\s+label=\{ATTACH_LABEL\}\s+busyLabel=\{attachControl\.label\}\s+tone="light"\s+icon=\{<Paperclip \/>\}/
    );
  });

  it('raises the flag for the whole batch and lowers it in a finally', () => {
    // Per-file, the flag would come down between two files of a multi-file
    // selection and let a second press in halfway through. And without the
    // `finally` an unexpected throw leaves the control disabled until the page is
    // reloaded, which is a worse outcome than the missing feedback this fixed.
    const upload = HOME_PAGE.slice(
      HOME_PAGE.indexOf('async function uploadAttachments'),
      HOME_PAGE.indexOf('async function removeAttachment')
    );
    expect(upload).toContain('setAttaching(true);');
    expect(upload).toMatch(/\} finally \{[\s\S]*setAttaching\(false\);/);
    // Once each: a second lowering somewhere in the loop is exactly the defect
    // the batch-wide flag exists to prevent.
    expect(upload.match(/setAttaching\(/g)).toHaveLength(2);
  });

  it('does not spend the chip row’s parsing statuses on this', () => {
    // `parsing` is derived from the chips and is true at almost the same times,
    // which is what makes it tempting. It is not the same fact: a chip turns
    // `error` the instant its own file is rejected, so a rejected first file in a
    // batch of three would re-enable the control while two were still uploading.
    expect(HOME_PAGE).not.toContain('disabled={parsing');
    expect(HOME_PAGE).not.toMatch(/attachControlState\(\{[^}]*attaching: parsing/);
  });
});

describe('the four states the control is painted in', () => {
  it('tints on hover, because the variant’s own hover is invisible here', () => {
    // AppKit's `ghost` is `hover:bg-accent` and --accent is `var(--db-wash)`, which
    // was the strip's own fill: the variant painted the strip's colour onto the
    // strip, so hover was invisible. The strip is transparent now -- the grey band
    // went with every other band on the sky -- so the wash would in fact show. The
    // explicit hover tint stays anyway, because a control's hover state should not
    // depend on the fill of whatever it happens to be sitting on, which is the
    // mistake that produced the original report.
    expect(TOKENS).toMatch(/--accent:\s*var\(--db-wash\)/);
    expect(body('.composer-actions')).toMatch(/background:\s*transparent/);
    expect(body('.composer-attach:hover')).toMatch(/background:\s*var\(--db-hover-tint\)/);
  });

  it('presses to a heavier weight of the same blue', () => {
    // There was no `:active` rule in any button variant, so press and release
    // both painted the hover wash and a click was indistinguishable from a
    // hesitation over the label.
    expect(body('.composer-attach:active')).toMatch(/background:\s*var\(--db-press-tint\)/);
  });

  it('mixes the press tint from --db-blue-600, above the hover weight', () => {
    // The same arithmetic palette.test.ts pins for the other two weights. A press
    // that is lighter than a hover reports the wrong one of the two, and a tint
    // typed out by hand stops following the blue the moment the blue moves.
    const channels = (token: string) => {
      const found = TOKENS.match(new RegExp(`${token}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`));
      expect(found, `${token} is declared as an rgba of the blue`).not.toBeNull();
      return found!.slice(1).map(Number);
    };
    expect(channels('--db-press-tint').slice(0, 3)).toEqual(channels('--db-hover-tint').slice(0, 3));
    expect(channels('--db-press-tint')[3]).toBeGreaterThan(channels('--db-hover-tint')[3]);
  });

  it('draws the app’s one focus ring rather than the variant’s faint one', () => {
    // The variant sets `outline-none` and its own `focus-visible:ring-ring/50`,
    // both Tailwind utilities, so which of them draws the ring on this control
    // was being settled by layer order between a dependency and the app. Stated
    // here, at the same 2px solid blue and 2px offset base.css asks for
    // everywhere.
    const rule = body('.composer-attach:focus-visible');
    expect(rule).toMatch(/outline:\s*2px solid var\(--db-blue-600\)/);
    expect(rule).toMatch(/outline-offset:\s*2px/);
  });

  it('reads as busy rather than as unavailable while it works', () => {
    // AppKit dims a disabled control to 50%, which on the one state where the
    // control is doing something says "unavailable" for the seconds when what is
    // true is "busy". Keyed on `aria-busy`, so the painted state and the spoken
    // one are the same attribute read twice rather than two facts that can drift.
    const rule = body(".composer-attach[aria-busy='true']:disabled");
    expect(rule).toMatch(/opacity:\s*1/);
    expect(rule).toMatch(/background:\s*var\(--db-selected-tint\)/);
  });

  it('changes no size between any of them', () => {
    // The strip is a flex row: a border or a padding change on hover would widen
    // this control's box and shove the caveat line and the submit button along.
    // The same rule the rail's filter chips are held to.
    for (const selector of [
      '.composer-attach:hover',
      '.composer-attach:active',
      '.composer-attach:focus-visible',
      ".composer-attach[aria-busy='true']:disabled",
    ]) {
      expect(body(selector), `${selector} paints only colour`).not.toMatch(
        /padding|border-width|font-size|line-height|height|border:\s/
      );
    }
  });

  it('keeps the working colour out of it, even though that is what it means', () => {
    // Orange is "happening right now" everywhere else in the app, and it is
    // reserved for filled masses -- this is a wash behind a label. palette.test.ts
    // refuses an accent on anything pressable as well, and is right to: the reader
    // needs to know this is a button before they need to know it is busy. The
    // spinning glyph and the label carry the "right now" instead.
    const rules = withoutComments(COMPOSER).match(/\.composer-attach[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(4);
    for (const rule of rules) expect(rule, 'no accent on the attach control').not.toMatch(/orange|amber/i);
  });
});

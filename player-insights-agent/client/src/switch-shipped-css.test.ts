import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Benchmark Lab switch, read off the BUILT BUNDLE THAT IS ACTUALLY SERVED.
 *
 * Sam reported the same defect six times -- the switch "looks awful when
 * selected" -- against six separate fixes, every one of which was correct in
 * `settings.css` and green under a test that read `settings.css`. The source was
 * never the thing that was wrong. The build was.
 *
 * `settings.css` writes the checked offset twice, once as `transform: none` and
 * once as `translate: 16px 0`, because AppKit's thumb carries
 * `data-[state=checked]:translate-x-[calc(100%-2px)]` and Tailwind v4 compiles
 * that to the `translate` property. `transform` and `translate` are separate
 * properties that the browser applies in sequence, so an override written in one
 * does not replace an offset written in the other -- it is added to it. Naming
 * both is what stops the two accumulating.
 *
 * The bundler's CSS minifier then merged the pair into the single equivalent
 * declaration `transform: translate(16px)` and dropped the `translate` one. Read
 * as one rule in isolation that rewrite is sound. Read against the cascade it is
 * the original bug: the deleted property is the property AppKit writes, so the
 * shipped stylesheet moved the knob 12px with AppKit's rule and a further 16px
 * with ours. The track offers 16px of travel. A 14px white knob pushed 28px
 * leaves the 34px pill entirely and, being white on a white card, stops being
 * drawn -- so the selected switch was a bare blue smear with no knob on it.
 *
 * THIS FILE READS THE COMMITTED BUILD, NOT THE SOURCE, and that is the whole
 * point of it. `build/deploy/client/dist` is the tree `app-release.sh` uploads;
 * it is what the reader's browser parses. Six source-level tests could not see
 * this and a seventh would not either.
 *
 * It fails against every build made before the fix, including the one on disk
 * when it was written.
 */

const distAssets = path.resolve(__dirname, '../../build/deploy/client/dist/assets');

/** Every route stylesheet the committed deployment can load. */
function shippedCss(): string {
  const sheets = readdirSync(distAssets)
    .filter((name) => name.endsWith('.css'))
    .sort();
  expect(sheets.length, `expected at least one stylesheet in ${distAssets}`).toBeGreaterThan(0);
  return sheets.map((name) => readFileSync(path.join(distAssets, name), 'utf8')).join('\n');
}

const CSS = shippedCss();

/**
 * Every rule in the shipped sheet whose selector mentions the switch thumb, in
 * source order, with `@media` and `@supports` wrappers left alone: nothing in
 * either state is conditional, so a rule inside one would itself be the defect.
 */
function thumbRules(): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];

  for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector.includes('switch-thumb') && !selector.includes('translate-x')) continue;
    rules.push({ selector, body: match[2] });
  }

  return rules;
}

/** One declaration's value from a rule body, or '' when the rule does not set it. */
function declaration(body: string, property: string): string {
  const found = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`));
  return found ? found[1].trim() : '';
}

/**
 * How many classes and attribute selectors a selector carries, which is the only
 * term that separates these particular rules: none of them uses an id, and the
 * cascade decides between AppKit's `[data-state=checked]` pair and our
 * `.settings-page`-scoped triple on that count alone.
 */
function weight(selector: string): number {
  const escaped = selector.replace(/\\./g, '');
  return (escaped.match(/\.[A-Za-z_-]/g) ?? []).length + (escaped.match(/\[/g) ?? []).length;
}

/**
 * The declaration a browser would settle on for one property in one state:
 * highest weight wins, and source order breaks a tie, exactly as the cascade
 * does. Resolving in plain source order instead is wrong and reads as a much
 * worse bug than there is -- AppKit's rule would win a property our rule
 * overrides -- so the two states are folded properly here.
 */
function winning(state: 'checked' | 'unchecked', property: string): string {
  const other = state === 'checked' ? 'unchecked' : 'checked';
  let best = '';
  let bestWeight = -1;

  for (const { selector, body } of thumbRules()) {
    // A rule written for the other state cannot apply in this one.
    if (selector.includes(`=${other}`)) continue;

    const declared = declaration(body, property);
    if (declared && weight(selector) >= bestWeight) {
      best = declared;
      bestWeight = weight(selector);
    }
  }

  return best;
}

/**
 * The horizontal distance the shipped sheet moves the knob in one state, in px,
 * summed over BOTH properties the way a browser sums them.
 *
 * The thumb is 14px, so AppKit's `calc(100% - 2px)` resolves to 12px. Anything
 * that resolves to a percentage is resolved against that width here rather than
 * being skipped, because skipping it is exactly how 12px went unnoticed.
 */
function offsetPx(state: 'checked' | 'unchecked'): number {
  const THUMB_PX = 14;

  const variable = resolve(winning(state, '--tw-translate-x'), THUMB_PX);

  const declaredTranslate = winning(state, 'translate');
  const translate = declaredTranslate.includes('--tw-translate-x') ? variable : resolve(declaredTranslate, THUMB_PX);

  return translate + resolve(winning(state, 'transform'), THUMB_PX);
}

/** A length, a percentage of the thumb, `none`, or a `calc()` of the first two. */
function resolve(value: string, basisPx: number): number {
  if (value === 'none') return 0;

  const inner = value.match(/(?:translate|translateX)\(([^)]*)\)/);
  const first = (inner ? inner[1] : value).split(/[\s,]+/)[0] ?? '';

  const calc = value.match(/calc\(\s*([\d.]+)%\s*-\s*([\d.]+)px\s*\)/);
  if (calc) return (Number(calc[1]) / 100) * basisPx - Number(calc[2]);

  if (first.endsWith('%')) return (Number(first.slice(0, -1)) / 100) * basisPx;
  return Number.parseFloat(first) || 0;
}

describe('the switch the deployed app actually paints', () => {
  it('leaves the knob at the start of the track when it is off', () => {
    expect(offsetPx('unchecked')).toBe(0);
  });

  it('moves the knob exactly the travel the track has when it is on', () => {
    // 34px track, less 1px of border and 1px of padding at each end, less the
    // 14px knob: 16px, and no other number puts the knob inside the pill.
    expect(
      offsetPx('checked'),
      'the shipped stylesheet moves the checked knob by a distance the track does not have. ' +
        'At more than 16px the knob leaves the pill and, being white on a white card, is not ' +
        'drawn at all -- which is the "looks awful when selected" report. Check that the ' +
        'minifier has not merged `translate` into `transform`: see settings.css.'
    ).toBe(16);
  });

  it('disarms the upstream offset at the variable, which is the part the minifier cannot merge', () => {
    // `transform` and `translate` are interchangeable enough for a minifier to
    // rewrite one into the other; `--tw-translate-x` has no equivalent, so it is
    // the only declaration here guaranteed to survive the build intact.
    const ours = thumbRules().filter(({ selector }) => selector.includes('settings-page'));

    expect(ours.length, 'the app no longer styles the switch thumb at all in the shipped sheet').toBeGreaterThan(0);
    for (const { selector, body } of ours) {
      expect(declaration(body, '--tw-translate-x'), `${selector} lets AppKit's own offset through`).toBe('0px');
    }
  });

  it('keeps the track at the size it was drawn at', () => {
    const track = CSS.match(/\.settings-page \[data-slot=switch\]\{([^}]*)\}/);

    expect(track, 'the shipped sheet does not size the switch track').not.toBeNull();
    expect(declaration(track![1], 'width')).toBe('34px');
    expect(declaration(track![1], 'height')).toBe('18px');
    expect(declaration(track![1], 'padding')).toBe('1px');
  });
});

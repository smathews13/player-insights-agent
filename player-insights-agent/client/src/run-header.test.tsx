import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunHeader } from './RunHeader';
import { astPill, runHeadline, shortRunId, statusFamily, statusTone } from './run-header';
import { RATING_SCALE } from './benchmark-summary';
import { partial } from './styles/stylesheet';
import type { Run } from './app-types';

/**
 * The header above a run's tabs, which is the first thing read about a run and
 * was the last thing on this page still written as a sentence.
 *
 * It printed `{full id} · {person} · {status}` in one mono line: 36 characters of
 * a value nobody reads end to end, followed by the two facts they came for, in a
 * line that truncated with an ellipsis at the width the page happened to be. So
 * the status -- the single word that says whether to trust anything below it --
 * was the part most likely to be cut off.
 *
 * What is asserted here is what the header PRINTS. The figures come from the run
 * and the trace, and the tests that matter most are the ones about a run that
 * measured nothing: an app that fills those in with zeroes is an app that reports
 * a free, instant run rather than an unmeasured one.
 *
 * What is NOT verified here, and cannot be without a browser: whether the line
 * fits at a given width, and whether the clipboard actually receives the id.
 */
const SOURCE = readFileSync(new URL('./RunHeader.tsx', import.meta.url), 'utf8');
const COPY_CONTROL = readFileSync(new URL('./copy-id.ts', import.meta.url), 'utf8');
const RUNS_CSS = partial('runs.css');
const OPS_CSS = partial('ops.css');

/** The declarations of one rule, so a claim can be made about one block. */
function rule(selector: string): string {
  const start = RUNS_CSS.indexOf(`\n${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return RUNS_CSS.slice(start, RUNS_CSS.indexOf('}', start));
}

function opsRule(selector: string): string {
  const start = OPS_CSS.indexOf(`\n${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return OPS_CSS.slice(start, OPS_CSS.indexOf('}', start));
}

const FULL_ID = 'cafebabecafebabecafebabecafebabe';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: FULL_ID,
    prompt: 'Which titles lost the most players last month?',
    stakeholder: 'someone@example.com',
    status: 'complete',
    duration_ms: 73200,
    rating: 5,
    created_at: '2026-02-01T10:00:00Z',
    ...overrides,
  };
}

function header(props: Partial<Parameters<typeof RunHeader>[0]> = {}): string {
  return renderToStaticMarkup(
    <RunHeader run={run()} toolCalls={12} reference={false} groundedness={null} {...props} />
  );
}

describe('the run header names the run without spelling it out', () => {
  it('shows the prefix a trace is identified by, and never the whole id', () => {
    // The prefix is what MLflow, the store and a ticket all use to refer to one
    // trace. The rest is 24 more characters that push the person and the status
    // off the line, and the reader was never going to read them: an id is
    // compared, not read.
    const markup = header();
    expect(markup).toContain('cafebabecafe');
    expect(markup).not.toContain(FULL_ID);
    expect(shortRunId(FULL_ID)).toBe('cafebabecafe');
  });

  it('leaves a short id alone rather than padding it to a fixed width', () => {
    expect(shortRunId('run-7')).toBe('run-7');
  });

  it('puts the whole id on the clipboard, which is the only form it is wanted in', () => {
    // The rendered tree is the assertion for what is SHOWN; this is the one claim
    // about the id that a rendered tree cannot make, because there is no
    // clipboard here to read back. The chip hands the WHOLE id to the shared
    // copy control -- which awaits the write and falls back to the selection
    // copy when the frame refuses the async clipboard, the failure that made
    // every copy icon in this header look inert.
    expect(SOURCE).toContain('value={run.id}');
    expect(COPY_CONTROL).toContain('await navigator.clipboard.writeText(value)');
    expect(COPY_CONTROL).toContain("document.execCommand('copy')");
    // Not in a title either. A title holding the full id would render it -- as a
    // tooltip and into the accessibility tree -- which is the one thing the chip
    // exists to avoid.
    expect(SOURCE).not.toMatch(/title=\{[^}]*run\.id/);
    expect(header()).toContain('aria-label="Copy the full run id"');
  });

  it('uses the shared identity chip instead of plain text or initials', () => {
    const markup = header();
    expect(markup).toContain('identity-chip identity-chip--compact run-detail-user');
    expect(markup).toContain('lucide-user-round');
    expect(markup).toContain('identity-chip-name">someone');
    expect(markup).not.toContain('>SO<');
  });

  it('links the whole identity chip to that person’s Monitoring activity', () => {
    const markup = header({ run: run({ stakeholder: 'alex rivera+qa@example.com' }) });

    expect(markup).toContain('class="run-detail-user-link"');
    expect(markup).toContain('href="/monitoring?who=alex%20rivera%2Bqa%40example.com"');
    expect(markup).toMatch(/<a class="run-detail-user-link"[^>]*><span class="identity-chip/);
  });

  it('keeps an unrecorded identity plain instead of linking to an empty filter', () => {
    const markup = header({ run: run({ stakeholder: '' }) });

    expect(markup).toContain('identity-chip identity-chip--compact run-detail-user');
    expect(markup).not.toContain('run-detail-user-link');
    expect(markup).not.toContain('/monitoring?who=');
  });

  it('keeps the store’s own word for the status, and tones it', () => {
    // The tone is the only thing this app adds. A status nobody here recognises
    // still reads as itself rather than being renamed to one of the four we know.
    expect(header()).toContain('complete');
    expect(statusTone('complete')).toBe('tone-ok');
    expect(statusTone('succeeded')).toBe('tone-ok');
    expect(statusTone('failed')).toBe('tone-bad');
    expect(statusTone('partial')).toBe('tone-degraded');
    expect(statusTone('queued')).toBe('tone-neutral');
    expect(statusTone(null)).toBe('tone-neutral');
    expect(rule('.run-pill.tone-ok')).toContain('var(--db-green-wash)');
  });

  it('ticks only the status that earns a tick', () => {
    // A check beside the word "failed" is the decoration contradicting the value
    // next to it, and a glyph on a status this app does not recognise is a claim
    // about how the run went that nobody made.
    expect(header()).toContain('lucide-check');
    expect(header({ run: run({ status: 'failed' }) })).not.toContain('lucide-check');
    expect(header({ run: run({ status: 'queued' }) })).not.toContain('lucide-check');
  });
});

describe('the run header sums the run up in one line', () => {
  it('keeps wall time at the edge and puts calls and rating in the identity badges', () => {
    const markup = header();
    expect(markup).toContain('run-detail-meta ast-num">73.2s');
    expect(markup).toContain('Tools · <span class="ast-num">12</span>');
    expect(markup).toContain('aria-label="Rated helpful"');
    expect(markup).toContain('lucide-thumbs-up');
  });

  it('takes the rating’s scale from the one place that knows it', () => {
    // Not a `/5` written into this line. The top of the scale is the feedback
    // column's constraint, and a surface asserting it on its own is a surface
    // that still says 5 after the column changes.
    expect(runHeadline({ rating: 4 })).toBe(`rated 4/${RATING_SCALE}`);
  });

  it('counts one call as one call', () => {
    expect(runHeadline({ durationMs: 1000, toolCalls: 1 })).toBe('1.0s · 1 tool call · Not rated yet');
  });

  it('says a run is unrated rather than showing an empty scale', () => {
    // Nobody rating a run is the normal state -- the agent never rates itself --
    // so the header says so. An absent line reads as an oversight instead.
    expect(header({ run: run({ rating: null }) })).toContain('Not rated');
    expect(runHeadline({ rating: null })).toBe('Not rated yet');
  });

  it('omits a measurement nobody took, rather than printing it as zero', () => {
    // The rule this app is built on, and the reason this line is assembled from
    // parts rather than formatted from a template: a run whose duration was never
    // recorded did not take 0.0s, and a trace with no counter did not make no
    // calls. Either zero is a fabricated figure sitting where a real one goes.
    const markup = header({ run: run({ duration_ms: null, rating: null }), toolCalls: null });
    expect(markup).not.toContain('0.0s');
    expect(markup).not.toContain('0 tool calls');
    expect(markup).toContain('Not rated');
    expect(runHeadline({ durationMs: null, toolCalls: null, rating: null })).toBe('Not rated yet');
    expect(runHeadline({ durationMs: 400 })).toBe('0.4s · Not rated yet');
    expect(runHeadline({ toolCalls: 0 })).toBe('0 tool calls · Not rated yet');
  });

  it('reads the call count from the trace rather than from the row', () => {
    // The row carries no call count; the agent's own counter is on the trace. The
    // Overview tile beside this line reads the same number, so a header that
    // derived its own would be the second opinion this page keeps deleting.
    expect(header({ toolCalls: 3 })).toContain('Tools · <span class="ast-num">3</span>');
  });
});

describe('the run header is four objects, not one sentence', () => {
  it('draws the id, the person and the status as separate things', () => {
    const markup = header();
    expect(markup).toContain('class="run-detail-ident"');
    expect(markup).toContain('class="run-id-chip"');
    expect(markup).toContain('identity-chip identity-chip--compact run-detail-user');
    // The line they used to be: id, middot, person, middot, status, as one string.
    expect(markup).not.toMatch(/cafebabecafe[^<]*·[^<]*·/);
  });

  it('pins the figures to the far end, and sets them as figures', () => {
    expect(rule('.run-detail-figures')).toContain('align-items: flex-end');
    /*
     * The face arrives as `.ast-num` on the element rather than as a `font-family`
     * in this rule, and that is the point rather than a detail: §3's rule is about
     * where a number sits -- a column, a cell, a stat value, a right-aligned meta
     * slot -- so it is worth being one class that can be checked in one place.
     *
     * What this rule used to carry was `font-variant-numeric: tabular-nums` beside
     * DM Sans's own family, and that half did nothing at all: DM Sans declares no
     * `tnum` feature, so the declaration read as done and the figures stayed
     * proportional. It must not come back.
     */
    expect(header()).toMatch(/class="run-detail-meta ast-num"/);
    expect(rule('.run-detail-meta')).not.toContain('font-variant-numeric');
  });

  it('outlines the id chip rather than filling it', () => {
    // A filled chip reads as a status; this is a control that holds a value.
    expect(rule('.run-id-chip')).toContain('border: 1px solid var(--db-line-strong)');
    expect(rule('.run-id-short')).toContain('font-family: var(--font-mono)');
  });

  it('wraps the identity row rather than truncating the status off the end', () => {
    // The old line ended in an ellipsis at whatever width the page was, and the
    // part it cut was the status -- the one word that says whether to trust the
    // panels below it.
    expect(rule('.run-detail-ident')).toContain('flex-wrap: wrap');
  });

  it('shows hover and keyboard focus without overriding the identity ink', () => {
    expect(opsRule('.run-detail-user-link')).toContain('color: inherit');
    expect(opsRule('.run-detail-user-link:focus-visible')).toContain('outline: 2px solid var(--ast-blue)');
    expect(opsRule('.run-detail-user-link')).not.toMatch(/color:\s*var\(--ast-blue\)/);
  });

  it('says nothing about a run when no run is selected', () => {
    const markup = header({ run: null });
    expect(markup).toContain('Select a run');
    expect(markup).not.toContain('run-detail-ident');
    expect(markup).not.toContain('Not rated yet');
  });

  it('qualifies the trace under the figures, when there is anything to qualify', () => {
    // Both badges are claims about the trace rather than about the run, and
    // neither is drawn on a run they do not apply to: a fixed 94% groundedness
    // used to sit here on every run, including ones nobody had scored.
    expect(header()).not.toContain('Groundedness');
    expect(header()).not.toContain('Reference trace');
    const qualified = header({ reference: true, groundedness: 0.94 });
    expect(qualified).toContain('Reference trace');
    // The word and the figure, with the figure set as one: a score is a number in a
    // slot, so it takes the mono face the rest of this header's figures take.
    expect(qualified).toContain('Groundedness');
    expect(qualified).toMatch(/<span class="ast-num">94%<\/span>/);
  });

  it('draws every pill on the one recipe, and never colour alone', () => {
    /*
     * §2: one pill recipe, five families, and the chip has to say what it means in
     * words. A rule cannot see whether its element has text in it, so this is where
     * that half is held -- and it is held on the words rather than on the classes,
     * because a pill whose meaning is only its hue passes any check written about
     * its class list.
     */
    const complete = header({ run: run({ truncated: true }) });
    expect(complete).toMatch(/run-status-pill ast-pill ast-pill--pos/);
    expect(complete).toContain('complete');
    expect(complete).not.toContain('partial');
    expect(complete).not.toContain('Truncated');
    expect(header({ run: run({ status: 'failed' }) })).toMatch(/ast-pill--neg/);
    // The DuBois pill is gone from this surface. It is still defined, because the
    // conversation rail's own pill is written against it, but nothing here draws it.
    expect(complete).not.toMatch(/class="[^"]*\brun-pill\b/);
    expect(complete).not.toContain('tone-ok');
  });

  it('ticks the family that earns a tick, and nothing else', () => {
    // A run that failed does not get a check beside the word "failed".
    expect(statusFamily('complete')).toBe('pos');
    expect(statusFamily('answered')).toBe('pos');
    expect(statusFamily('failed')).toBe('neg');
    expect(statusFamily('refused')).toBe('neg');
    expect(statusFamily('partial')).toBe('warn');
    expect(statusFamily('queued')).toBe('neutral');
    expect(statusFamily(null)).toBe('neutral');
    // One decision behind both the class and the glyph, so they cannot disagree.
    expect(astPill('complete')).toBe('ast-pill ast-pill--pos');
    expect(astPill('truncated')).toBe('ast-pill ast-pill--warn');
  });
});

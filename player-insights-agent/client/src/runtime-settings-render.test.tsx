import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'RuntimeSettingsPanel.tsx'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'SettingsPage.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles', 'settings.css'), 'utf8');
const answerStyles = fs.readFileSync(path.join(__dirname, 'styles', 'answer.css'), 'utf8');

/**
 * The file with its commentary taken out.
 *
 * Needed by exactly one assertion below: the note this modal used to draw is
 * quoted verbatim in the comment that records its removal, so a test asserting
 * the sentence is absent from the source finds it in the explanation of why it is
 * absent. The quote is worth keeping -- it is the only record of what the line
 * said -- so the assertion reads the markup instead.
 */
const markupOf = (file: string): string =>
  file
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('runtime and appearance modal sections', () => {
  it('mounts both sections behind one modal settings form', () => {
    // Handed `onSaveState` as well, so the footer can say what Save did.
    expect(page).toContain('<RuntimeSettingsPanel section={active} onSaveState={setSaveState} />');
    expect(source).toContain("section: 'runtime' | 'appearance'");
    expect(source).toContain("export const RUNTIME_SETTINGS_FORM_ID = 'settings-runtime-form'");
  });

  it('writes through the admin route and preserves real errors and load retry', () => {
    expect(source).toContain("fetch('/api/admin/runtime-settings'");
    expect(source).toContain("runtimeSettingsFromResponse(response, 'loaded')");
    expect(source).toContain("runtimeSettingsFromResponse(response, 'saved')");
    expect(source).toContain("failure?.operation === 'load'");
    expect(source).toContain('failure.message');
  });

  it('draws the requested loop, answer and timezone controls without caption filler', () => {
    for (const label of [
      'Max DSF steps',
      'Max tool calls',
      'Run budget (s)',
      'Takeaway',
      'Narrative',
      'Figures',
      'Charts',
      'Analyst caveats',
      'Timezone (IANA name)',
    ]) {
      expect(source).toContain(label);
    }
    expect(source).not.toContain('Guidance goes to the agent with every ask.');
    expect(source).not.toContain('Limits how many reasoning passes');
    expect(source).not.toContain('Changes how relative dates');
    expect(source).toContain('Reasoning steps in one Ask.');
    expect(source).toContain('placeholder="America/New_York"');
    expect(source).toContain('Example: 42 teams increased weekly usage.');
  });

  it('maps the three Loop structure labels to Architecture’s semantic accents', () => {
    expect(source).toContain("runtime-loop-label runtime-loop-label--agent ast-pill");
    expect(source).toContain("runtime-loop-label runtime-loop-label--tool ast-pill");
    expect(source).toContain("runtime-loop-label runtime-loop-label--budget ast-pill");
    expect(source).toContain('labelClassName={extra.labelClassName}');
    expect(styles).toMatch(/\.runtime-loop-label \{[^}]*justify-self:\s*start/);
    expect(styles).toMatch(/\.runtime-loop-label--agent \{[^}]*--ast-primary-control-border/);
    expect(styles).toMatch(/\.runtime-loop-label--tool \{[^}]*--db-teal-600/);
    expect(styles).toMatch(/\.runtime-loop-label--budget \{[^}]*--ast-blue/);
    expect(source).not.toMatch(/guidance\([^)]*runtime-loop-label/s);
  });

  it('does not repeat the Runtime select field labels inside their triggers', () => {
    expect(source.match(/showLabel=\{false\}/g) ?? []).toHaveLength(2);
    expect(source).toContain("label: 'Recommended order'");
    expect(source).toContain("label: 'Auto'");
    expect(source).toContain("label: 'Bar + line'");
  });

  it('gives the Architecture answer-contract links a stable destination', () => {
    expect(source).toContain('id="answer-contract-settings"');
  });

  it('keeps all answer values wired while toggled sections hide their controls', () => {
    for (const field of [
      'takeawayGuidance',
      'narrativeGuidance',
      'narrativeMaxCharacters',
      'figuresOrder',
      'chartsTypes',
      'maxFigures',
      'maxCharts',
      'maxCaveats',
    ]) {
      expect(source).toContain(field);
    }
    expect(source).toContain('checked && children');
  });

  it('renders the six live entity samples from the same settings saved to the server', () => {
    for (const kind of ['catalog', 'schema', 'table', 'column', 'quote', 'tag']) {
      expect(source).toContain(`${kind}:`);
    }
    expect(source).toContain('appearance-grid');
    expect(source).toContain('appearance-sample');
    expect(source).toContain('entityStyles');
    expect(source).toContain('colorScheme');
    expect(source).toContain('aria-label="Dark"');
    expect(source).toContain('previewColorScheme(on)');
    expect(source).toContain('appearance-sample-plaque');
    expect(source).toContain('fontBodyColor');
    expect(source).toContain('fontMutedColor');
    expect(source).toContain('fontFamily');
    expect(source).toContain('fontSize');
    expect(source).toContain('previewRuntimeTypography(settings)');
    expect(source).toContain('appearance-type-preview');
  });

  it('pairs Body text and Secondary hex fields with a native colour picker', () => {
    expect(source).toContain('type="color"');
    expect(source).toContain('appearance-color-picker');
    expect(source).toContain("isHexColor(hex) ? hex : '#000000'");
    expect(source).toContain('`${aria} picker`');
    expect(styles).toContain('.appearance-color-picker');
    expect(styles).toContain("input:not([type='color'])");
  });

  it('pairs every entity text and highlight hex field with the same native picker', () => {
    const entityColors = source.slice(source.indexOf('aria-label="Answer entity colors"'));
    expect(entityColors).toContain('type="color"');
    expect(entityColors).toContain('aria-label={`${kind} ${property} picker`}');
    expect(entityColors).toContain("isHexColor(hex) ? hex : '#000000'");
    expect(entityColors).not.toContain('appearance-color-swatch" aria-hidden="true"');
  });

  it('previews theme changes and applies a save immediately', () => {
    expect(source).not.toContain('Theme, type, and chip colours. They apply across Ask, Run Explorer, and Monitoring.');
    expect(source).not.toContain('Limits how many reasoning passes');
    expect(source).toContain('2026-07-22 – 2026-08-03');
    expect(source).toContain('Northwind, Contoso');
    expect(source).toContain('adoptRuntimeEntityStyles(savedSettings.current)');
    expect(source).toContain('adoptRuntimeEntityStyles(saved)');
    expect(styles).toMatch(/\.appearance-sample-plaque\s*\{[^}]*background:\s*var\(--background\)/);
    expect(answerStyles).toMatch(/\.answer-badge--date\s*\{[^}]*--ast-entity-quote-fg[^}]*--ast-entity-quote-bg/);
    expect(answerStyles).toMatch(/\.answer-badge--tag\s*\{[^}]*--ast-entity-tag-fg[^}]*--ast-entity-tag-bg/);
  });

  it('keeps one footer Save, in the shell rather than in the pane', () => {
    /*
     * The two attributes, not their adjacency. This wanted them on consecutive
     * lines and so broke when the button gained a styling attribute between them,
     * reporting a formatting change as a missing Save button. What matters is that
     * the shell's footer button submits, and submits the open pane's own form.
     */
    const save = /<Button\b[^>]*\btype="submit"[^>]*>/s.exec(page)?.[0] ?? '';
    expect(save).toContain('type="submit"');
    expect(save).toContain('form={form}');
    expect(source).not.toContain('Save runtime settings');
  });

  it('carries no safeguards note, on any pane or in any state', () => {
    // The Runtime pane used to draw a locked line in the footer: "Dictionary-first
    // field binding and never-invent-figures are mandatory safeguards, not
    // switches." Removed at Sam's request, and asserted three ways because there
    // are three ways for it to come back -- the sentence, the element that held it,
    // and the rule that painted it.
    const markup = markupOf(page);
    expect(markup).not.toContain('mandatory safeguards');
    expect(markup).not.toContain('settings-footer-note');
    expect(styles).not.toContain('.settings-footer-note');
    // The footer had two children and `space-between` held them apart. With one
    // child left, `space-between` puts Cancel and Save against the modal's LEFT
    // edge, so the removal of the note and this declaration are one change.
    expect(styles).toMatch(/\.settings-modal-footer \{[^}]*justify-content:\s*flex-end/);
  });

  it('presses Save and closes the modal once the save has landed', () => {
    // The press and the close are the whole of the confirmation now that the line
    // beside the button is gone. AppKit paints `:active` the same as `:hover`, so
    // the press is driven by an attribute that outlasts the mouse-up -- it has to
    // still be on screen while the save is in flight.
    expect(page).toContain("data-pressed={pressed ? 'true' : undefined}");
    expect(page).toContain('onClick={() => setPressed(true)}');
    expect(styles).toMatch(/\[data-pressed='true'\] \{[^}]*background:\s*var\(--db-blue-800\)/);
    // ON `saved` AND NOT ON THE CLICK. The refusal is drawn in the footer, so
    // closing on the click would take the message off screen as it was written and
    // a refused save would look exactly like a successful one.
    expect(page).toContain('if (!saveLanded(saveState)) return;');
    expect(page).toMatch(/setTimeout\(\(\) => close\(\), SAVE_PRESS_MS\)/);
  });
});

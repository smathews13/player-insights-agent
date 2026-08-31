import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuntimeGuidanceField, RuntimeSettingsPanel } from './RuntimeSettingsPanel';

const source = fs.readFileSync(path.join(__dirname, 'RuntimeSettingsPanel.tsx'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'SettingsPage.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles', 'settings.css'), 'utf8');
const responsiveStyles = fs.readFileSync(path.join(__dirname, 'styles', 'responsive-settings.css'), 'utf8');
const appearanceStyles = fs.readFileSync(path.join(__dirname, 'styles', 'appearance-preferences.css'), 'utf8');
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
    expect(page).toContain('<RuntimeSettingsPanel');
    expect(page).toContain('section={active}');
    expect(page).toContain('onSaveState={setSaveState}');
    expect(page).toContain('onDirtyChange={handlePaneDirty}');
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
    ]) {
      expect(source).toContain(label);
    }
    expect(source).toContain('<RuntimeTimezoneField');
    expect(source).toContain('value={settings.behavior.timezone}');
    expect(source).not.toContain('Guidance goes to the agent with every ask.');
    expect(source).not.toContain('Limits how many reasoning passes');
    expect(source).not.toContain('Changes how relative dates');
    expect(source).toContain('Reasoning steps in one Ask.');
    expect(source).not.toContain('placeholder="America/New_York"');
    expect(source).toContain('Example: 42 teams increased weekly usage.');
  });

  it('renders saved numeric values without example helpers or placeholder values', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="runtime" />);
    expect(source).toContain('value={draft ?? String(value)}');
    expect(source).not.toContain('runtime-control-example');
    expect(source).not.toContain('Example: {placeholder}');
    expect(styles).not.toContain('.runtime-control-example');
    for (const label of [
      'Max DSF steps',
      'Max tool calls',
      'Run budget (s)',
      'Narrative cap',
      'Max figures',
      'Max charts',
      'Max caveats',
    ]) {
      const input = new RegExp(`<input[^>]*aria-label="${label.replace(/[()]/g, '\\$&')}"[^>]*>`).exec(markup)?.[0];
      expect(input, `${label} renders`).toBeDefined();
      expect(input).toMatch(/\bvalue="\d+"/);
      expect(input).not.toContain('placeholder=');
    }
  });

  it('renders Narrative cap as a compact peer field without a competing heading or explanation', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="runtime" />);
    expect(markup).not.toContain('Character cap');
    expect(markup).not.toContain('0 means uncapped');
    expect(source).not.toContain('Character cap');
    expect(source).not.toContain('0 means uncapped');
    expect(markup).toMatch(
      /class="runtime-field runtime-answer-field runtime-answer-cap"[^>]*>[\s\S]*?runtime-field-label">Cap<\/span>[\s\S]*?aria-label="Narrative cap"/
    );
    expect(markup).toMatch(
      /class="runtime-field runtime-answer-field runtime-answer-guidance"[^>]*>[\s\S]*?runtime-field-label">Guidance<\/span>/
    );
  });

  it('aligns Takeaway Guidance, Narrative Guidance and Cap with one field rhythm', () => {
    expect(source.match(/<RuntimeGuidanceField/g) ?? []).toHaveLength(2);
    expect(source).toContain('className="runtime-answer-field runtime-answer-cap"');
    expect(styles).toMatch(
      /\.runtime-answer-body--narrative \{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+90px[^}]*align-items:\s*start/s
    );
    expect(styles).toMatch(
      /\.runtime-answer-guidance \.runtime-guidance,\s*\.runtime-answer-cap input \{[^}]*width:\s*100%[^}]*height:\s*34px[^}]*min-height:\s*34px[^}]*border-color:\s*var\(--border\)[^}]*border-radius:\s*var\(--radius-sm\)[^}]*background:\s*var\(--background\)/s
    );
  });

  it('keeps example copy as placeholder text while rendering saved guidance as the value', () => {
    const placeholder = 'Example: a concise finding.';
    const empty = renderToStaticMarkup(<RuntimeGuidanceField value="" update={() => {}} placeholder={placeholder} />);
    const saved = renderToStaticMarkup(
      <RuntimeGuidanceField value="Use the saved customer tone." update={() => {}} placeholder={placeholder} />
    );

    expect(empty).toContain(`placeholder="${placeholder}"`);
    expect(empty.replace(`placeholder="${placeholder}"`, '')).not.toContain(placeholder);
    expect(saved).toContain('>Use the saved customer tone.</textarea>');
    expect(saved.replace(`placeholder="${placeholder}"`, '')).not.toContain(placeholder);
    expect(source).not.toContain('Example: {placeholder}');
    expect(source).not.toContain('runtime-control-example');
  });

  it('stacks the compact cap below Guidance on narrow screens without widening it', () => {
    expect(responsiveStyles).toMatch(
      /@media \(max-width:\s*800px\) \{[\s\S]*?\.runtime-answer-body--narrative \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*\}[\s\S]*?\.runtime-answer-body--narrative \.runtime-answer-cap \{[^}]*width:\s*90px[^}]*justify-self:\s*start[^}]*\}/
    );
  });

  it('maps the three Loop structure labels to Architecture’s semantic accents', () => {
    expect(source).toContain('runtime-loop-label runtime-loop-label--agent ast-pill');
    expect(source).toContain('runtime-loop-label runtime-loop-label--tool ast-pill');
    expect(source).toContain('runtime-loop-label runtime-loop-label--budget ast-pill');
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
    expect(source).toContain('aria-label="Dark mode"');
    expect(source).not.toContain('previewColorScheme(on)');
    expect(source).toContain('appearance-sample-plaque');
    expect(source).toContain('fontBodyColor');
    expect(source).toContain('fontMutedColor');
    expect(source).toContain('fontFamily');
    expect(source).toContain('fontSize');
    expect(source).not.toContain('previewRuntimeTypography(settings)');
    expect(source).toContain('appearance-display-preview');
  });

  it('keeps interface controls and text colors together in Display', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="appearance" />);
    const display = markup.slice(
      markup.indexOf('appearance-display-section'),
      markup.indexOf('appearance-typography-section')
    );

    expect(markup).not.toContain('appearance-theme-section');
    expect(markup).not.toMatch(/<h4[^>]*>Theme<\/h4>/);
    expect(markup).not.toContain('appearance-interface-section');
    expect(markup).not.toMatch(/<h4[^>]*>Interface<\/h4>/);
    expect(display).toContain('<h4 class="runtime-section-label">Display</h4>');
    expect(display).toContain('appearance-display-rows');
    expect(display).toContain('appearance-display-choices');
    expect(display).toContain('>Dark mode</span>');
    expect(display).toContain('aria-label="Dark mode"');
    expect(display).toContain('>Background graphics</span>');
    expect(display).toContain('>Animations</span>');
    expect(display).toContain('>Density</span>');
    expect(display).toContain('>Body text</span>');
    expect(display).toContain('>Secondary</span>');
    const labels = ['Dark mode', 'Background graphics', 'Animations', 'Density', 'Body text', 'Secondary'];
    for (let index = 1; index < labels.length; index += 1) {
      expect(display.indexOf(labels[index - 1])).toBeLessThan(display.indexOf(labels[index]));
    }
    expect(display).not.toContain('>Font</span>');
    expect(display).not.toContain('>Size</span>');
  });

  it('keeps typography controls and preview in their own section', () => {
    const markup = renderToStaticMarkup(<RuntimeSettingsPanel section="appearance" />);
    const display = markup.slice(
      markup.indexOf('appearance-display-section'),
      markup.indexOf('appearance-typography-section')
    );
    const typography = markup.slice(
      markup.indexOf('appearance-typography-section'),
      markup.indexOf('appearance-palette-section')
    );

    expect(display).toContain('aria-label="Body text color picker"');
    expect(display).toContain('aria-label="Body text color"');
    expect(display).toContain('aria-label="Secondary text color picker"');
    expect(display).toContain('aria-label="Secondary text color"');
    expect(typography).toContain('aria-label="Font: DM Sans"');
    expect(typography).toContain('role="radiogroup"');
    expect(typography).toContain('aria-label="Font size L"');
    expect(typography).toContain('appearance-display-preview');
    expect(source).toContain('data-color-scheme={settings.colorScheme}');
    expect(source).toContain("'--appearance-preview-body': settings.fontBodyColor");
    expect(source).toContain("'--appearance-preview-font': FONT_FAMILY_STACKS[settings.fontFamily]");
  });

  it('lays out merged choices across supported responsive breakpoints', () => {
    expect(appearanceStyles).toMatch(
      /\.appearance-display-choices\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(responsiveStyles).toMatch(
      /@media \(max-width:\s*480px\)\s*\{[\s\S]*?\.appearance-display-choices\s*\{[^}]*minmax\(0,\s*1fr\)/
    );
    expect(styles).toContain(".appearance-display-preview[data-color-scheme='dark']");
    expect(styles).toContain(".appearance-display-preview[data-color-scheme='light']");
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

  it('stages appearance edits and applies them only after a save succeeds', () => {
    expect(source).not.toContain('Theme, type, and chip colours. They apply across Ask, Run Explorer, and Monitoring.');
    expect(source).not.toContain('Limits how many reasoning passes');
    expect(source).toContain('2026-07-22 – 2026-08-03');
    expect(source).toContain('Northwind, Contoso');
    expect(source).toContain('adoptRuntimeEntityStyles(saved)');
    expect(source).not.toContain('previewColorScheme(on)');
    expect(source).not.toContain('previewRuntimeTypography(settings)');
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
    expect(styles).toMatch(/\.settings-modal-footer \{[^}]*justify-content:\s*space-between/);
  });

  it('presses Save and keeps the modal open after the save lands', () => {
    expect(page).toContain("data-pressed={pressed ? 'true' : undefined}");
    expect(page).toContain('onClick={() => setPressed(true)}');
    expect(styles).toMatch(/\[data-pressed='true'\] \{[^}]*background:\s*var\(--db-blue-800\)/);
    expect(page).not.toContain('saveLanded(saveState)');
    expect(page).not.toMatch(/setTimeout\(\(\) => close\(\), SAVE_PRESS_MS\)/);
    expect(page).toContain('unsavedChangesLabel(dirtyCount)');
  });
});

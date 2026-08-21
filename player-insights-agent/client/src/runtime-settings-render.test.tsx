import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'RuntimeSettingsPanel.tsx'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'SettingsPage.tsx'), 'utf8');

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
    expect(source).toContain('Guidance goes to the agent with every ask.');
    expect(source).not.toContain('Limits how many reasoning passes');
    expect(source).not.toContain('Changes how relative dates');
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
  });

  it('keeps one footer Save and the mandatory safeguards note in the modal shell', () => {
    expect(page).toContain('type="submit" form={form}');
    expect(page).toContain('Dictionary-first field binding and never-invent-figures are mandatory safeguards, not switches.');
    expect(source).not.toContain('Save runtime settings');
  });
});

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StateSwitch } from './StateSwitch';

describe('explicit binary control state', () => {
  it('renders the domain state beside the accessible switch', () => {
    const on = renderToStaticMarkup(
      <StateSwitch checked onLabel="Shown" offLabel="Hidden" aria-label="Show details" onCheckedChange={() => {}} />
    );
    const off = renderToStaticMarkup(
      <StateSwitch
        checked={false}
        onLabel="Allowed"
        offLabel="Blocked"
        aria-label="Allow export"
        onCheckedChange={() => {}}
      />
    );

    expect(on).toContain('Shown');
    expect(on).toContain('aria-label="Show details"');
    expect(off).toContain('Blocked');
    expect(off).toContain('aria-label="Allow export"');
  });

  it('leaves bare switches only in table rows that already render a separate state cell', () => {
    const directSwitchFiles = ['BenchmarkSettingsPanel.tsx', 'SettingsPage.tsx'];
    for (const name of directSwitchFiles) {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8');
      expect(source).toContain('ExperimentalStatus');
      expect(source).toContain('<Switch');
    }

    for (const name of ['AnswerCard.tsx', 'EgressPanel.tsx', 'RunDetails.tsx', 'RuntimeSettingsPanel.tsx']) {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8');
      expect(source).toContain('<StateSwitch');
      expect(source).not.toContain('<Switch');
    }
  });
});

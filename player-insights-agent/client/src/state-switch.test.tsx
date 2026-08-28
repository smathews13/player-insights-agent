import { readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StateSwitch } from './StateSwitch';

function productionTsxFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) return productionTsxFiles(child);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [child] : [];
  });
}

describe('explicit binary control state', () => {
  it('renders only On and Off beside switches while preserving action names', () => {
    const on = renderToStaticMarkup(<StateSwitch checked aria-label="Show details" onCheckedChange={() => {}} />);
    const off = renderToStaticMarkup(
      <StateSwitch checked={false} aria-label="Allow export" onCheckedChange={() => {}} />
    );

    expect(on).toContain('>On</span>');
    expect(on).not.toContain('>Off</span>');
    expect(on).toContain('aria-label="Show details"');
    expect(off).toContain('>Off</span>');
    expect(off).not.toContain('>On</span>');
    expect(off).toContain('aria-label="Allow export"');
  });

  it('does not let production binary-status callers supply presentation aliases', () => {
    const offenders = productionTsxFiles(new URL('.', import.meta.url))
      .filter((file) => /\b(?:onLabel|offLabel)=/.test(readFileSync(file, 'utf8')))
      .map((file) => file.pathname.split('/').at(-1));

    expect(offenders).toEqual([]);
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

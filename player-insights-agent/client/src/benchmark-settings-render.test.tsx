import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MULTI_TURN_JUDGES } from '../../shared/eval-dataset';
import { BenchmarkSettingsPanel } from './BenchmarkSettingsPanel';

const SETTINGS_STYLES = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE_STYLES = readFileSync(new URL('./styles/responsive.css', import.meta.url), 'utf8');
const JUDGE_CONTROLS = [
  { label: 'Always-on traces', aria: 'Always-on traces' },
  { label: 'Groundedness', aria: 'Groundedness judge' },
  { label: 'Relevance', aria: 'Relevance judge' },
  { label: 'Guidelines', aria: 'Guidelines judge' },
  ...MULTI_TURN_JUDGES.map((judge) => ({ label: judge.label, aria: judge.label })),
];

describe('Settings → Experimental benchmarking cluster', () => {
  it('shows the controls but disables them while Benchmarking is off', () => {
    const markup = renderToStaticMarkup(<BenchmarkSettingsPanel enabled={false} />);
    expect(markup).toContain('MLflow experiment');
    expect(markup).toContain('Always-on traces');
    expect(markup).toContain('Judge model');
    expect(markup).toContain('Groundedness');
    expect(markup).toContain('Guidelines');
    expect(markup).toContain('Conversation completeness');
    expect(markup).toContain('Custom judges');
    expect(markup).toContain('Custom judge prompt');
    expect(markup).toContain('Add this custom judge');
    expect(markup).not.toContain('bench-guidelines-help');
    expect(markup).not.toContain('Baseline vs candidate');
    expect(markup).not.toContain('Compare side A');
    expect(markup).not.toContain('Compare side B');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Turn Benchmarking on above to edit these');
    expect(markup).not.toContain('Eval set');
    expect(markup).not.toContain('Compare two versions');
  });

  it('keeps the same controls guarded until saved settings load', () => {
    const markup = renderToStaticMarkup(<BenchmarkSettingsPanel enabled={true} />);
    expect(markup).toContain('MLflow experiment');
    expect(markup).toContain('<fieldset class="benchmark-settings-cluster" disabled=""');
    expect(markup).toContain('Reading benchmarking settings.');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Add this custom judge<\/button>/);
    expect(markup).not.toContain('build a dataset, score a Genie space');
  });

  it('keeps every judge status immediately beside its specifically-labelled switch', () => {
    const markup = renderToStaticMarkup(<BenchmarkSettingsPanel enabled={true} />);
    const rows = markup.match(/<tr(?: [^>]*)?>[\s\S]*?<\/tr>/g) ?? [];

    for (const judge of JUDGE_CONTROLS) {
      const row = rows.find((candidate) => candidate.includes(`>${judge.label}</`));
      expect(row, judge.label).toBeDefined();
      expect(row?.match(/<td(?: [^>]*)?>/g) ?? [], judge.label).toHaveLength(2);
      expect(row, judge.label).toContain('class="state-switch"');
      expect(row, judge.label).toContain(`aria-label="${judge.aria}"`);
      expect(row?.indexOf('class="ast-pill'), judge.label).toBeLessThan(row?.indexOf('data-slot="switch"') ?? -1);
      expect(row, judge.label).toMatch(/>(?:On|Off)<\/span>/);
    }
  });

  it('uses two-column judge tables with one right-aligned Control header', () => {
    const markup = renderToStaticMarkup(<BenchmarkSettingsPanel enabled={true} />);
    const tables = markup.match(/<table class="exp-feature-table judge-settings-table">[\s\S]*?<\/table>/g) ?? [];

    expect(tables).toHaveLength(2);
    for (const table of tables) {
      const heading = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? '';
      expect(heading.match(/<th(?: [^>]*)?>/g) ?? []).toHaveLength(2);
      expect(heading).toContain('class="exp-feature-control">Control</th>');
      expect(heading).not.toContain('>Status</th>');
      expect(table).not.toContain('exp-feature-status-column');
      expect(table).not.toContain('exp-feature-status');
      expect(table).toContain('judge-settings-control-column');
    }
    expect(markup.match(/>Multi-turn judges<\/th>/g) ?? []).toHaveLength(1);
    expect(SETTINGS_STYLES).toMatch(/\.judge-settings-control-column \{[^}]*width:\s*104px/);
  });

  it('stacks narrow judge rows while keeping the compact control right-aligned', () => {
    expect(RESPONSIVE_STYLES).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.judge-settings-table tbody,[\s\S]*display:\s*block/
    );
    expect(RESPONSIVE_STYLES).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.judge-settings-table \.exp-feature-control \{[^}]*margin-top:\s*7px[^}]*text-align:\s*right/
    );
  });
});

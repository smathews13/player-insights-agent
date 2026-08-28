import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BenchmarkSettingsPanel } from './BenchmarkSettingsPanel';

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

  it('uses one Multi-turn judges table heading with aligned status and control columns', () => {
    const markup = renderToStaticMarkup(<BenchmarkSettingsPanel enabled={true} />);
    expect(markup.match(/>Multi-turn judges<\/th>/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain('>Multi-turn judges</p>');
    const multiTurnTable = markup.slice(markup.indexOf('>Multi-turn judges</th>'));
    expect(multiTurnTable).toContain('>Status</th>');
    expect(multiTurnTable).toContain('>Control</th>');
    expect(multiTurnTable).not.toContain('>Setting</th>');
  });
});

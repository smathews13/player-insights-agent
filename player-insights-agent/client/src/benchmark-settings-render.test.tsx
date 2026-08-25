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
    expect(markup).toContain('Baseline vs candidate');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Turn Benchmarking on above to edit these');
    expect(markup).not.toContain('Eval set');
    expect(markup).not.toContain('Compare two versions');
  });

  it('enables the same controls once Benchmarking is on', () => {
    const markup = renderToStaticMarkup(<BenchmarkSettingsPanel enabled={true} />);
    expect(markup).toContain('MLflow experiment');
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('build a dataset, score a Genie space');
  });
});

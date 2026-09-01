/**
 * Whether Benchmarking, its scorers and its judge are on screen, and what a
 * deployment with no saved row gets.
 *
 * THE DEFAULT IS THE SUBJECT OF THE FIRST BLOCK, not an incidental starting
 * value for the rest. Sam asked for this surface back as something HE turns on;
 * a customer who never wanted Benchmarking must not meet it after an upgrade. So
 * "off unless somebody said yes" is asserted at the schema and rendered route,
 * the two places a default could be
 * flipped, only one of which a reader of the component would think to check.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { BenchmarkingVisibility } from './BenchmarkingVisibility';
import { ExperimentalSettingsSchema } from '../../shared/experimental-settings';
import { NO_EXPERIMENTS, showsBenchmarkLab, type ExperimentalFeatures } from './experimental-features';

function renderBenchmarking(features: ExperimentalFeatures): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/benchmarks']}>
      <Routes>
        <Route element={<Outlet context={{ features, setFeature: () => {} }} />}>
          <Route
            path="/benchmarks"
            element={
              <BenchmarkingVisibility>
                <div>Scorers · Judge</div>
              </BenchmarkingVisibility>
            }
          />
          <Route path="/" element={<div>Ask</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('the default an unconfigured deployment gets', () => {
  it('is off in the set every unasked browser starts from', () => {
    expect(NO_EXPERIMENTS.benchmarkLab).toBe(false);
    expect(showsBenchmarkLab(NO_EXPERIMENTS)).toBe(false);
  });

  it('is off when the durable document has no Benchmarking field', () => {
    expect(ExperimentalSettingsSchema.parse({}).benchmarkLab).toBe(false);
  });

  it('reaches the route as hidden, which is the state a customer meets', () => {
    expect(renderBenchmarking({ ...NO_EXPERIMENTS })).not.toContain('Scorers · Judge');
  });
});

describe('Benchmarking scorer and judge chrome', () => {
  it('is hidden by default', () => {
    expect(renderBenchmarking({ ...NO_EXPERIMENTS })).not.toContain('Scorers · Judge');
  });

  it('renders when the operator setting is on', () => {
    expect(renderBenchmarking({ ...NO_EXPERIMENTS, benchmarkLab: true })).toContain('Scorers · Judge');
  });

  it('is hidden again when the setting is off', () => {
    const enabled = renderBenchmarking({ ...NO_EXPERIMENTS, benchmarkLab: true });
    const disabled = renderBenchmarking({ ...NO_EXPERIMENTS, benchmarkLab: false });
    expect(enabled).toContain('Scorers · Judge');
    expect(disabled).not.toContain('Scorers · Judge');
  });
});

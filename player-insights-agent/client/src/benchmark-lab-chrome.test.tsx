import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BenchmarkLab } from './BenchmarkLab';
import { BenchmarkLabChrome, cellsFromPocContract, labContractCells } from './BenchmarkLabChrome';
import { STAGE_04_CAPTIONS } from '../../shared/benchmark-lab-v3';
import { partial } from './styles/stylesheet';

function readable(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

const CHROME = readFileSync(new URL('./BenchmarkLabChrome.tsx', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('./BenchmarkLab.tsx', import.meta.url), 'utf8');
const DARK = partial('dark-benchmark.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('Benchmark Lab v3 chrome, rendered', () => {
  const markup = renderToStaticMarkup(
    <BenchmarkLabChrome
      contract={labContractCells({ scorerActive: 3 })}
      judges={['groundedness', 'relevance', 'guidelines']}
    />
  );
  const prose = readable(markup);

  it('opens as Benchmark Lab with the in-tab jump', () => {
    expect(markup).toContain('>Benchmark Lab<');
    expect(markup).toContain('href="#lab-evaluation-set"');
    expect(prose).toContain('Dataset, diagnostics, comparison, and traces below');
    expect(prose).not.toContain('guided evaluation workspace');
    expect(prose).not.toContain('judges and scorers picked in Settings');
  });

  it('keeps the POC contract strip always visible with the six spec cells', () => {
    for (const eyebrow of ['Goal', 'Dataset', 'Baseline / candidate', 'Pass gates', 'Scorer set', 'Target']) {
      expect(markup).toContain(`>${eyebrow}<`);
    }
    expect(prose).toContain('Genie accuracy + agent judges');
    expect(prose).not.toContain('two lanes, one dataset');
    expect(prose).not.toContain('same cases, same scorers');
    expect(prose).toContain('3 active');
    expect(prose).not.toContain('run_057');
    expect(prose).not.toContain('v3');
  });

  it('numbers the four pipeline stages 01 to 04', () => {
    expect(prose).toContain('01');
    expect(prose).toContain('Curate the evaluation set');
    expect(prose).toContain('02');
    expect(prose).toContain('Genie accuracy');
    expect(prose).toContain('03');
    expect(prose).toContain('Agent judges');
    expect(prose).toContain('04');
    expect(prose).toContain('Apply the candidate');
  });

  it('names every region below the spine with the spec section titles', () => {
    expect(markup).toContain('id="lab-evaluation-set"');
    expect(markup).toContain('id="lab-genie-accuracy"');
    expect(markup).toContain('id="lab-run-comparison"');
    expect(markup).toContain('id="lab-failure"');
    expect(markup).toContain('id="lab-held-out"');
    expect(prose).toContain('Evaluation set');
    expect(prose).toContain('Genie accuracy diagnostics');
    expect(prose).toContain('Run comparison');
    expect(prose).toContain('Failure investigation');
    expect(prose).toContain('Held-out evaluation');
  });

  it('draws the three comparison lanes and no composite score', () => {
    expect(prose).toContain('Genie lane');
    expect(prose).toContain('Agent lane');
    expect(prose).toContain('Trace lane');
    expect(prose).not.toContain('No composite score');
    expect(prose).not.toContain('composite score:');
  });

  it('keeps empty regions honest, with spec column headers and no invented scores', () => {
    expect(prose).toContain('Question or conversation');
    expect(prose).toContain('No cases yet');
    expect(prose).toContain('Not recorded');
    expect(prose).toContain('PII redaction on');
    expect(prose).toContain('role-gated');
    expect(prose).not.toContain('85%');
    expect(prose).not.toContain('case_012');
  });

  it('maps a workspace contract view onto the six strip cells without inventing scores', () => {
    const cells = cellsFromPocContract({
      goal: 'genie · agent',
      dataset: 'working copy · 0 cases · 0 held out',
      baseline: '-',
      candidate: '-',
      passGates: 'No numeric thresholds set. Regressions are always shown.',
      scorerSet: 'ss-1 · 0 active · 0 not applicable',
      target: 'Prompt Registry · not set',
      snapshotHref: '#lab-snapshot',
      snapshotDetail: '',
      heldOutLocked: false,
    });
    expect(cells).toHaveLength(6);
    expect(cells[2]?.value).toBe('- / -');
    expect(cells.map((cell) => cell.value).join(' ')).not.toContain('85%');
  });

  it('gives primary actions the names the spec uses', () => {
    expect(prose).toContain('Import from Ask and Monitoring traces');
    expect(prose).toContain('Run complete suite');
    expect(prose).toContain('Run baseline');
    expect(prose).toContain('Run candidate');
    expect(prose).toContain('Score one Ask session');
    expect(prose).toContain('Apply candidate');
    expect(prose).toContain('View rollback path');
    expect(prose).toContain('Export evidence pack');
    expect(prose).toContain('Add to dataset as edge case');
    expect(prose).toContain('Cancel');
    expect(prose).toContain('Retry failed cases');
    expect(prose).not.toContain('Connections unchanged');
    expect(prose).not.toContain('Prompt Registry moves the production alias');
    expect(markup).toContain('href="#lab-snapshot"');
    expect(prose).not.toContain('Rollback');
    expect(markup).toContain('This control runs once the Lab workspace is connected.');
    expect(prose).not.toContain('This control runs once the Lab workspace is connected.');
    expect(prose).not.toContain('No configuration snapshot is saved');
    expect(prose).not.toContain('No run id yet');
    expect(prose).not.toContain('n of m + gate');
    expect(prose).not.toContain('Per-case pass');
    expect(prose).toContain('Matching policy reference');
  });
});

describe('the page seats that chrome', () => {
  it('renders the Lab heading from the page module', () => {
    const markup = renderToStaticMarkup(<BenchmarkLab />);
    expect(markup).toContain('>Benchmark Lab<');
    expect(markup).toContain('bench-surface');
    expect(markup).toContain('id="lab-pipeline"');
  });

  it('fills every chrome slot once and keeps Run baseline idle on an empty lab', () => {
    const markup = renderToStaticMarkup(<BenchmarkLab />);
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const id of [
      'lab-pipeline',
      'lab-evaluation-set',
      'lab-genie-accuracy',
      'lab-run-comparison',
      'lab-failure',
      'lab-held-out',
    ]) {
      expect(counts.get(id)).toBe(1);
    }
    expect(markup).toContain('Import from Ask and Monitoring traces');
    expect(markup).toContain('Run complete suite');
    expect(markup).toContain('Run baseline');
    expect(markup).toContain('Apply candidate');
    expect(markup).not.toContain('Run in progress');
    expect(markup).not.toContain('Recorded runs');
    expect(markup).not.toContain('Per-case results');
    expect(markup.match(/>Benchmark Lab</g)).toHaveLength(1);
    expect(readable(markup)).not.toContain('This control runs once the Lab workspace is connected.');
    expect(markup).toContain('Roll back next Ask');
  });

  it('leaves dataset and Genie bodies as slots, not a second flywheel stack', () => {
    expect(PAGE).not.toContain('EvalFlywheel');
    expect(PAGE).toContain('BenchmarkLabChrome');
    expect(PAGE).toContain('useEvaluationLab');
    expect(PAGE).toContain('suiteIsLive');
    expect(PAGE).not.toContain('metrics?.counts');
  });
});

describe('copy and glass rules that hold across the six surfaces', () => {
  it('writes no em dash in the chrome module', () => {
    expect(CHROME).not.toMatch(/—/);
  });

  it('imports the v3 contract without rendering Apply lecture', () => {
    expect(CHROME).toContain("from '../../shared/benchmark-lab-v3'");
    expect(CHROME).not.toContain('STAGE_04_CAPTIONS');
    expect(CHROME).not.toContain('Connections unchanged');
    expect(STAGE_04_CAPTIONS.prompt_registry).toContain('production');
    expect(STAGE_04_CAPTIONS.genie_space).toContain('does not write space instructions');
    expect(STAGE_04_CAPTIONS.rag_config).toBe('Not configured for this target.');
  });

  it('frosts Lab surfaces at 4% white and solids them under reduced transparency', () => {
    const reducedAt = DARK.indexOf('@media (prefers-reduced-transparency: reduce)');
    const normal = DARK.slice(0, reducedAt);
    const reduced = DARK.slice(reducedAt);
    expect(normal).toMatch(
      /html\[data-theme='dark'\] \.bench-surface\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0\.04\)[^}]*backdrop-filter:\s*blur\(2px\)/
    );
    expect(reduced).toContain("html[data-theme='dark'] .bench-surface");
  });
});

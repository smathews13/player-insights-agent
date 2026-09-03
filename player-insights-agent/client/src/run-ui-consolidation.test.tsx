import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ToolCallsLabel } from './ToolCallsLabel';

const HERE = new URL('.', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, HERE), 'utf8');
const rule = (css: string, selector: string) =>
  css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

const RUNS = read('styles/runs.css');
const SHELL = read('styles/shell.css');
const DARK = read('styles/dark-mode.css');
const TRACE = read('styles/trace.css');
const CONSTELLATION = read('styles/constellation.css');
const RESPONSIVE = read('styles/responsive-runs.css');
const DENSITY = read('styles/density-runs.css');

describe('consolidated Run and Ask interaction styling', () => {
  it('uses text and a reserved underline, never a square wash, for both tab systems', () => {
    for (const body of [
      rule(SHELL, '.app-nav-tab:hover'),
      rule(SHELL, '.app-nav-tab:focus-visible'),
      rule(
        RUNS,
        ".run-detail [data-slot='tabs-trigger'][data-state='inactive']:hover:not(:disabled):not([data-disabled])"
      ),
      rule(RUNS, ".run-detail [data-slot='tabs-trigger']:focus-visible"),
    ]) {
      expect(body).toMatch(/border-bottom-color:/);
      expect(body).toMatch(/color:/);
      expect(body).toMatch(/background:\s*transparent/);
      expect(body).not.toMatch(/padding|margin|width|height|background:\s*var\(--db-hover-tint\)/);
    }
    expect(DARK).not.toMatch(/app-nav-tab:hover[\s\S]*?background:/);
    expect(DENSITY).not.toMatch(/tabs-trigger[^}]*background/);
  });

  it('gives every map node a non-shifting pointer and keyboard preview with stronger selection', () => {
    for (const selector of ['.trace-dag.map .dag-node:hover', '.trace-dag.compact .dag-node:hover']) {
      const body = rule(TRACE, selector);
      expect(body).toContain('border-color: var(--ast-blue)');
      expect(body).toContain('background: var(--db-blue-faint)');
      expect(body).not.toMatch(/padding|margin|width|height|transform/);
    }
    for (const selector of ['.trace-dag.map .dag-node:focus-visible', '.trace-dag.compact .dag-node:focus-visible']) {
      expect(rule(TRACE, selector)).toMatch(/outline: 2px solid var\(--db-blue-600\)/);
    }
    expect(rule(TRACE, '.trace-dag.map .dag-node.open')).toMatch(/border: 2px solid var\(--primary\)/);
    expect(rule(CONSTELLATION, '.ast-star-select')).toContain('cursor: pointer');
    expect(rule(CONSTELLATION, '.ast-star-select.selected')).toContain('drop-shadow(0 0 8px');
    expect(rule(CONSTELLATION, '.step-rail-pick:is(:hover, :focus-visible)')).toContain(
      'border-color: var(--ast-blue)'
    );
    expect(TRACE).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dag-node\s*\{[^}]*transition: none/);
  });

  it('keeps the responsive and density contracts from introducing a third scroll owner', () => {
    expect(RUNS.match(/overflow-y:\s*auto/g)).toHaveLength(2);
    expect(RESPONSIVE).toMatch(/\.run-list\s*\{[^}]*overflow: visible/s);
    expect(RESPONSIVE).toMatch(/\.run-detail\s*\{[^}]*overflow: visible/s);
    expect(DENSITY).not.toMatch(/overflow-y:\s*(?:auto|scroll)|height:\s*\d+(?:px|vh|dvh)/);
  });
});

describe('shared generic tool-call label', () => {
  it('uses one decorative wrench without adding duplicate spoken text', () => {
    const markup = renderToStaticMarkup(<ToolCallsLabel>Agent tool calls</ToolCallsLabel>);
    expect(markup).toContain('lucide-wrench');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('>Agent tool calls<');
    expect(markup).not.toContain('aria-label');
  });

  it('is reused by Run Explorer, Answer process, Monitoring and Ask metrics', () => {
    expect(read('RunOverviewKpis.tsx')).toContain('<ToolCallsLabel>Agent tool calls</ToolCallsLabel>');
    expect(read('RunExplorer.tsx')).toContain('<ToolCallsLabel>Tools</ToolCallsLabel>');
    expect(read('RunHeader.tsx')).toContain('<ToolCallsLabel>Tools</ToolCallsLabel>');
    expect(read('MonitoringPage.tsx').match(/<ToolCallsLabel>Tools<\/ToolCallsLabel>/g)).toHaveLength(3);
    expect(read('HomePage.tsx')).toContain('<ToolCallsLabel>Tool calls</ToolCallsLabel>');
  });
});

describe('public trace evidence and pre-stage copy', () => {
  it('keeps internal reconciliation diagnostics out of every rendered token surface', () => {
    for (const source of [read('RunDetails.tsx'), read('TraceTimeline.tsx')]) {
      expect(source).not.toContain('Attributed coverage');
      expect(source).not.toContain('Unattributed difference');
    }
  });

  it('uses the same exact planning phrase before stage one and keeps elapsed separate', () => {
    const labels = read('working-animation.ts');
    expect(labels.match(/'Planning out your answer'/g)).toHaveLength(2);
    expect(read('WorkingInlineRow.tsx')).toContain('ast-flick-row-count');
    expect(read('HomePage.tsx')).toMatch(
      /<strong>\{WORKING_LABEL\}<\/strong>[\s\S]*?<strong className="ast-num">\{elapsed\}<\/strong>/
    );
    expect(read('HomePage.tsx')).toContain('aria-label="Planning out your answer"');
    expect(read('HomePage.tsx')).toMatch(/railStages\.length > 0[\s\S]*?<AgentPathConstellation/);
  });
});

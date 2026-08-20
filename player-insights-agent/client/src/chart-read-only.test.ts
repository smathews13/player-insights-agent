import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { PlotEdit } from 'plotly.js-cartesian-dist-min';

/**
 * A chart in an answer is a record, not a form.
 *
 * A proof-of-concept lead clicked an x-axis label and typed over it. The cause was
 * `showAxisRangeEntryBoxes`, which Plotly defaults to `true` and reads straight off
 * the context without consulting `editable`: one click on an axis end handle swaps the
 * tick text for a live text box. Nothing in the app had asked for that, which is the
 * point -- it arrived as a default, and a default nobody stated is a default nobody
 * reviews.
 *
 * This file asserts the config object PlotlyFigure hands to Plotly rather than the SVG
 * it produces. A rendered element missing an attribute would pass again the moment
 * somebody built the config a different way; the object is the thing that decides.
 */

// Plotly is 1.4 MB of browser code and this suite runs in node. The component is
// imported for its config, so the library it draws with is stubbed away.
vi.mock('plotly.js-cartesian-dist-min', () => ({
  default: { react: vi.fn(), purge: vi.fn() },
  react: vi.fn(),
  purge: vi.fn(),
}));

const { FIGURE_CONFIG } = await import('./plotly-config');
const SOURCE = readFileSync(new URL('./PlotlyFigure.tsx', import.meta.url), 'utf8');
const CONFIG_SOURCE = readFileSync(new URL('./plotly-config.ts', import.meta.url), 'utf8');

/**
 * Every piece of a figure Plotly can be told to accept typing on, from its own
 * `config.edits` schema. Enumerated here rather than trusted to `editable` alone so
 * that switching one of them on individually -- which is exactly how this would come
 * back, one flag at a time for one chart -- fails.
 */
const EVERY_EDIT: PlotEdit[] = [
  'annotationPosition',
  'annotationTail',
  'annotationText',
  'axisTitleText',
  'colorbarPosition',
  'colorbarTitleText',
  'legendPosition',
  'legendText',
  'shapePosition',
  'titleText',
];

describe('nothing a reader sees in a chart accepts a keystroke', () => {
  it('states editing off rather than inheriting it from a library default', () => {
    // Plotly's own default is already `false`. Asserting the stated value is what
    // makes the next reader's question answerable and what makes a change to it show
    // up in a diff instead of in a customer's screenshot.
    expect(FIGURE_CONFIG.editable).toBe(false);
  });

  it('closes the axis range entry box, which editing being off did not cover', () => {
    // The actual defect. Separate assertion from `editable` because it is a separate
    // gate in Plotly: `_context.showAxisRangeEntryBoxes` is read on its own, so a
    // config that only says `editable: false` still hands out the text box.
    expect(FIGURE_CONFIG.showAxisRangeEntryBoxes).toBe(false);
  });

  it('leaves no single edit switched on beside the master', () => {
    // `edits` may be absent -- each flag defaults to `editable` -- but if it is ever
    // written out, none of its members may be true.
    const edits = FIGURE_CONFIG.edits ?? {};
    for (const edit of EVERY_EDIT) {
      expect(edits[edit] ?? false).toBe(false);
    }
  });

  it('offers no mode bar route to an editor elsewhere', () => {
    expect(FIGURE_CONFIG.showEditInChartStudio).toBe(false);
    expect(FIGURE_CONFIG.showSendToCloud).toBe(false);
  });

  it('hands Plotly this object and nothing spread over it', () => {
    // The gap the object assertions leave: a config assembled at the call site would
    // satisfy every test above and still ship an editable chart. Both draw calls must
    // pass the reviewed object by name.
    const calls = SOURCE.match(/Plotly\.react\([^;]*?\);/gs) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain(', FIGURE_CONFIG)');
      expect(call).not.toMatch(/\.\.\.\s*FIGURE_CONFIG/);
    }
    // And one config object in the file, so there is one place to read and one to
    // change. A second literal is how two charts come to disagree.
    expect(CONFIG_SOURCE.match(/: PlotConfig\b/g)).toHaveLength(1);
  });

  it('is the only figure component, so this config covers every chart drawn', () => {
    // Answers, Ops, Monitoring and Benchmark Lab. Ops draws its traffic and cost
    // charts from divs and Monitoring and Benchmark Lab draw none, so Plotly reaches
    // the screen through this module alone. If a second surface ever imports it, this
    // fails and that surface needs the same treatment.
    const importers = ['AnswerCharts.tsx', 'AnswerCard.tsx', 'OpsPage.tsx', 'MonitoringPage.tsx',
      'BenchmarkLab.tsx', 'ArchitecturePage.tsx', 'RunExplorer.tsx', 'HomePage.tsx', 'App.tsx',
    ].map((name) => [name, readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')] as const);

    for (const [name, source] of importers) {
      expect(source, `${name} draws with Plotly directly`).not.toMatch(/from 'plotly/);
    }
    // The one that mounts it does so through PlotlyFigure, which is where the config is.
    const charts = importers.find(([name]) => name === 'AnswerCharts.tsx')![1];
    expect(charts).toContain("import('./PlotlyFigure')");
  });
});

describe('the reading interactions the design asks for are untouched', () => {
  it('keeps the tooltip, drag to zoom and double-click to reset', () => {
    // The trade that mattered while closing the write path: none of these share a
    // gate with editing, so nothing had to be given up. `staticPlot` would have taken
    // all three at once and is the wrong fix.
    expect(FIGURE_CONFIG.doubleClick).toBe('reset');
    expect(FIGURE_CONFIG.displayModeBar).toBe('hover');
    expect(FIGURE_CONFIG).not.toHaveProperty('staticPlot');
    expect(SOURCE).not.toContain('staticPlot');
  });

  it('leaves the axis drag handles alone, which is what the entry box shared a click with', () => {
    // `showAxisRangeEntryBoxes` fires on a single click on an axis handle; the drag
    // behaviour on that same handle is `showAxisDragHandles` and is a different flag.
    // Closing the first must not close the second.
    expect(FIGURE_CONFIG.showAxisDragHandles ?? true).toBe(true);
  });

  it('strips no button a reader inspects the figure with', () => {
    // `toImage` left this list when the egress work gated the chart image download.
    // It was never a reading control: every other button here changes what is on
    // screen, and that one writes a file. Its own coverage is in
    // `egress-chart-gate.test.ts`, which asserts both states of the switch.
    const removed = FIGURE_CONFIG.modeBarButtonsToRemove ?? [];
    for (const button of ['zoom2d', 'pan2d', 'resetScale2d', 'zoomIn2d', 'zoomOut2d',
      'hoverClosestCartesian', 'hoverCompareCartesian']) {
      expect(removed).not.toContain(button);
    }
  });
});

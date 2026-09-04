import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isVisibleInContainer, revealStepDetail, returnToSelectedStep, type StepActivation } from './agent-map-scroll';

const TRACE = readFileSync(new URL('./TraceDag.tsx', import.meta.url), 'utf8');
const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const RUNS_CSS = readFileSync(new URL('./styles/runs.css', import.meta.url), 'utf8');
const TRACE_CSS = readFileSync(new URL('./styles/trace.css', import.meta.url), 'utf8');
const TIMELINE_CSS = readFileSync(new URL('./styles/timeline.css', import.meta.url), 'utf8');
const RESPONSIVE_CSS = readFileSync(new URL('./styles/responsive-runs.css', import.meta.url), 'utf8');
const DENSITY_CSS = readFileSync(new URL('./styles/density-runs.css', import.meta.url), 'utf8');
const ANSWER_BODY_CSS = readFileSync(new URL('./styles/answer-body.css', import.meta.url), 'utf8');
const BASE_CSS = readFileSync(new URL('./styles/base.css', import.meta.url), 'utf8');

type MockElement = HTMLElement & {
  focus: ReturnType<typeof vi.fn>;
  scrollIntoView: ReturnType<typeof vi.fn>;
  scrollTo: ReturnType<typeof vi.fn>;
};

function rect(top: number, bottom: number, left = 0, right = 900): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function element({
  top,
  bottom,
  scrollTop = 0,
  scrollHeight = bottom - top,
  clientHeight = bottom - top,
}: {
  top: number;
  bottom: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}): MockElement {
  const target = {
    scrollTop,
    scrollHeight,
    clientHeight,
    focus: vi.fn(),
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => rect(top, bottom),
  } as unknown as MockElement;
  target.scrollTo = vi.fn((options: ScrollToOptions) => {
    target.scrollTop = options.top ?? target.scrollTop;
  });
  return target;
}

function activation(stepId: string, kind: StepActivation['kind'] = 'pointer', sequence = 1): StepActivation {
  return { stepId, kind, sequence };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('selected Agent map details stay inside their workspace scroll owner', () => {
  it('scrolls the right workspace for a detail below the fold and never the page', () => {
    const windowScroll = vi.fn();
    const documentScroll = vi.fn();
    vi.stubGlobal('window', { scroll: windowScroll, scrollTo: windowScroll });
    vi.stubGlobal('document', { scrollingElement: { scrollTo: documentScroll } });
    const container = element({ top: 100, bottom: 500, scrollHeight: 1800, clientHeight: 400 });
    const heading = element({ top: 720, bottom: 760 });

    const result = revealStepDetail({
      activation: activation('step-14'),
      selectedStepId: 'step-14',
      container,
      heading,
      reducedMotion: false,
    });

    expect(result).toEqual({ focused: false, scrolled: true, top: 260 });
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 260, behavior: 'smooth' });
    expect(heading.scrollIntoView).not.toHaveBeenCalled();
    expect(windowScroll).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();
  });

  it('handles details above the viewport and bounds the internal destination', () => {
    const container = element({
      top: 100,
      bottom: 500,
      scrollTop: 480,
      scrollHeight: 1600,
      clientHeight: 400,
    });
    const heading = element({ top: -80, bottom: -40 });

    const result = revealStepDetail({
      activation: activation('step-10'),
      selectedStepId: 'step-10',
      container,
      heading,
      reducedMotion: false,
    });

    expect(result.top).toBe(300);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 300, behavior: 'smooth' });
  });

  it('does nothing when the selected header is already visible', () => {
    const container = element({
      top: 100,
      bottom: 500,
      scrollTop: 240,
      scrollHeight: 1600,
      clientHeight: 400,
    });
    const heading = element({ top: 160, bottom: 205 });

    expect(isVisibleInContainer(heading.getBoundingClientRect(), container.getBoundingClientRect())).toBe(true);
    expect(
      revealStepDetail({
        activation: activation('step-19'),
        selectedStepId: 'step-19',
        container,
        heading,
        reducedMotion: false,
      })
    ).toEqual({ focused: false, scrolled: false, top: 240 });
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it('uses abrupt internal movement when reduced motion is requested', () => {
    const container = element({ top: 0, bottom: 320, scrollHeight: 2200, clientHeight: 320 });
    const heading = element({ top: 900, bottom: 940 });

    revealStepDetail({
      activation: activation('step-18'),
      selectedStepId: 'step-18',
      container,
      heading,
      reducedMotion: true,
    });

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 620, behavior: 'auto' });
  });

  it('aligns an expanded timeline detail taller than the workspace at its top', () => {
    const container = element({ top: 100, bottom: 500, scrollTop: 240, scrollHeight: 2400, clientHeight: 400 });
    const detail = element({ top: 620, bottom: 1320 });

    const result = revealStepDetail({
      activation: activation('step-7'),
      selectedStepId: 'step-7',
      container,
      heading: detail,
      reducedMotion: false,
    });

    expect(result.top).toBe(760);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 760, behavior: 'smooth' });
  });

  it('moves focus only for keyboard activation and always prevents native scrolling', () => {
    const container = element({ top: 0, bottom: 400, scrollHeight: 1200, clientHeight: 400 });
    const keyboardHeading = element({ top: 500, bottom: 540 });
    const pointerHeading = element({ top: 500, bottom: 540 });

    revealStepDetail({
      activation: activation('step-12', 'keyboard'),
      selectedStepId: 'step-12',
      container,
      heading: keyboardHeading,
      reducedMotion: false,
    });
    revealStepDetail({
      activation: activation('step-13', 'pointer', 2),
      selectedStepId: 'step-13',
      container,
      heading: pointerHeading,
      reducedMotion: false,
    });

    expect(keyboardHeading.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(pointerHeading.focus).not.toHaveBeenCalled();
  });

  it('ignores a stale effect after rapid selection', () => {
    const container = element({ top: 0, bottom: 400, scrollHeight: 1800, clientHeight: 400 });
    const heading = element({ top: 900, bottom: 940 });

    const stale = revealStepDetail({
      activation: activation('step-14', 'keyboard', 4),
      selectedStepId: 'step-19',
      container,
      heading,
      reducedMotion: false,
    });

    expect(stale).toEqual({ focused: false, scrolled: false, top: 0 });
    expect(container.scrollTo).not.toHaveBeenCalled();
    expect(heading.focus).not.toHaveBeenCalled();
  });

  it('returns to the map top while restoring focus to the selected node', () => {
    const container = element({
      top: 80,
      bottom: 380,
      scrollTop: 900,
      scrollHeight: 2600,
      clientHeight: 300,
    });
    const topNode = element({ top: -420, bottom: -360 });
    const bottomNode = element({ top: 620, bottom: 680 });
    const map = element({ top: -820, bottom: 700 });

    const top = returnToSelectedStep({ container, node: topNode, map, reducedMotion: false });
    expect(top.top).toBe(0);
    expect(topNode.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(topNode.scrollIntoView).not.toHaveBeenCalled();

    const bottom = returnToSelectedStep({ container, node: bottomNode, reducedMotion: true });
    expect(bottom.top).toBe(300);
    expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 300, behavior: 'auto' });
  });

  it('keeps long SQL and table details bounded at the internal maximum', () => {
    const container = element({
      top: 60,
      bottom: 460,
      scrollTop: 3300,
      scrollHeight: 4000,
      clientHeight: 400,
    });
    const heading = element({ top: 1200, bottom: 1240 });

    const result = revealStepDetail({
      activation: activation('step-17'),
      selectedStepId: 'step-17',
      container,
      heading,
      reducedMotion: false,
    });

    expect(result.top).toBe(3600);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 3600, behavior: 'smooth' });
  });
});

describe('Run Explorer has two desktop scroll owners', () => {
  it('links every toggle to one stable panel with pressed and expanded state', () => {
    expect(TRACE).toContain('aria-controls={panelId}');
    expect(TRACE).toContain('aria-pressed={isOpen}');
    expect(TRACE).toContain('aria-expanded={isOpen}');
    expect(TRACE).toContain('Showing details for Step ${openIndex + 1}');
    expect(TRACE).toContain('Back to agent map');
  });

  it('never delegates selected-step movement to scrollIntoView or page scrolling', () => {
    expect(TRACE).not.toMatch(/scrollIntoView|window\.scroll|document\.scroll/);
    expect(TRACE).toContain('returnToSelectedStep({ container, node, map');
    expect(TRACE).toContain('revealStepDetail({');
  });

  it('uses one right workspace for every tab and selected map detail', () => {
    expect(EXPLORER.match(/className="run-detail-content/g)).toHaveLength(4);
    expect(EXPLORER).not.toContain('run-detail-scroll');
    expect(EXPLORER).toContain('ref={workspaceScrollRef}');
    expect(EXPLORER).toContain('scrollContainerRef={workspaceScrollRef}');
    expect(EXPLORER).toMatch(/<TraceTimeline[\s\S]*scrollContainerRef=\{workspaceScrollRef\}/);
    expect(EXPLORER).toContain('<Tabs value={activeTab} onValueChange={setActiveTab}');
    expect(EXPLORER).toContain("workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })");
    expect(EXPLORER).not.toMatch(/scrollIntoView|window\.scroll|document\.scroll/);
  });

  it('makes only the recent-runs rail and complete right workspace vertically scrollable', () => {
    const root = RUNS_CSS.match(/\.run-explorer \{([^}]*)\}/)?.[1] ?? '';
    const layout = RUNS_CSS.match(/\.explorer-layout \{([^}]*)\}/)?.[1] ?? '';
    const sharedPanes = RUNS_CSS.match(/\.run-list,\s*\.run-detail \{([^}]*)\}/)?.[1] ?? '';
    expect(root).toMatch(
      /--run-explorer-pane-block-size:\s*clamp\(\s*640px,\s*calc\(100dvh - var\(--app-header-h\) \+ 240px - env\(safe-area-inset-bottom, 0px\)\),\s*1240px\s*\)/
    );
    expect(root).toMatch(/height: auto/);
    expect(root).toMatch(/grid-template-rows: auto auto/);
    expect(root).toMatch(/overflow: visible/);
    expect(layout).toMatch(/align-items: stretch/);
    expect(layout).not.toMatch(/(?:height|max-height):\s*100%/);
    for (const property of ['height', 'min-height', 'max-height']) {
      expect(sharedPanes, `${property} shares the pane token`).toMatch(
        new RegExp(`${property}: var\\(--run-explorer-pane-block-size\\)`)
      );
    }
    expect(sharedPanes).toMatch(/overscroll-behavior: contain/);
    expect(sharedPanes).toMatch(/scrollbar-gutter: stable/);
    for (const selector of ['run-list', 'run-detail']) {
      const matches = [...RUNS_CSS.matchAll(new RegExp(`^\\.${selector} \\{([^}]*)\\}`, 'gm'))];
      const body = matches.at(-1)?.[1] ?? '';
      expect(body, selector).toMatch(/overflow-y: auto/);
      expect(body, selector).not.toMatch(/(?:height|min-height|max-height):/);
    }
    expect(RUNS_CSS.match(/overflow-y:\s*auto/g)).toHaveLength(2);
    for (const selector of ['run-detail-tabs', 'run-detail-tab-panel', 'run-detail-content']) {
      const body = RUNS_CSS.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, selector).not.toMatch(/overflow-y:\s*(auto|scroll)/);
      expect(body, selector).not.toMatch(/max-height|height:\s*100%/);
    }
    for (const selector of ['run-process-body', 'answer-card-content']) {
      const body = ANSWER_BODY_CSS.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, selector).not.toMatch(/overflow-y:\s*(auto|scroll)|max-height/);
    }
    expect(BASE_CSS).toMatch(/\*\s*\{[^}]*scrollbar-width: thin[^}]*scrollbar-color: transparent transparent/s);
    expect(RUNS_CSS).toMatch(
      /@media \(forced-colors: active\)[\s\S]*?\.run-list,\s*\.run-detail \{[^}]*scrollbar-color: CanvasText Canvas/
    );
  });

  it('returns to normal document flow when the rail and workspace stack', () => {
    expect(RESPONSIVE_CSS).toContain('@media (max-width: 960px)');
    expect(RESPONSIVE_CSS).toMatch(/\.run-explorer \{[^}]*height: auto[^}]*overflow: visible/s);
    expect(RESPONSIVE_CSS).toMatch(/\.explorer-layout \{[^}]*height: auto[^}]*max-height: none[^}]*overflow: visible/s);
    expect(RESPONSIVE_CSS).toMatch(/\.run-list \{[^}]*height: auto[^}]*overflow: visible/s);
    expect(RESPONSIVE_CSS).toMatch(/\.run-detail \{[^}]*height: auto[^}]*max-height: none[^}]*overflow: visible/s);
    expect(DENSITY_CSS).toContain("html[data-density='compact'] .run-explorer");
    expect(DENSITY_CSS).not.toMatch(/overflow-y:\s*(auto|scroll)|height:\s*\d+(?:px|vh|dvh)/);
  });

  it('keeps the page top unchanged while steps 10 through 19 are selected', () => {
    const pageScroll = vi.fn();
    vi.stubGlobal('window', { scroll: pageScroll, scrollTo: pageScroll });
    const container = element({ top: 100, bottom: 500, scrollHeight: 5000, clientHeight: 400 });
    const leftRail = element({ top: 100, bottom: 500, scrollTop: 333, scrollHeight: 1800, clientHeight: 400 });

    for (let step = 10; step <= 19; step += 1) {
      const heading = element({ top: 520 + step * 12, bottom: 560 + step * 12 });
      revealStepDetail({
        activation: activation(`step-${step}`, 'pointer', step),
        selectedStepId: `step-${step}`,
        container,
        heading,
        reducedMotion: false,
      });
    }

    expect(container.scrollTo).toHaveBeenCalledTimes(10);
    expect(leftRail.scrollTop).toBe(333);
    expect(leftRail.scrollTo).not.toHaveBeenCalled();
    expect(pageScroll).not.toHaveBeenCalled();
    expect(container.getBoundingClientRect().top).toBe(100);
  });

  it('keeps empty, loading, unavailable, and selected content inside the same tall right surface', () => {
    const rightSurface = EXPLORER.indexOf('className="run-detail ast-surface-primary"');
    expect(rightSurface).toBeGreaterThan(-1);
    for (const state of [
      "detailMode === 'loading'",
      "detailMode === 'empty'",
      "detailMode === 'invalid'",
      "detailMode === 'ready'",
    ]) {
      expect(EXPLORER.indexOf(state)).toBeGreaterThan(rightSurface);
    }
    expect(EXPLORER.indexOf('className="run-list ast-surface-primary"')).toBeLessThan(rightSurface);
  });

  it('lets a large map grow to its complete grid bounds without an internal viewport', () => {
    expect(TRACE).toContain('displayedStages.map((item, index)');
    expect(TRACE).not.toMatch(/displayedStages\.(?:slice|splice)/);
    const map = TRACE_CSS.match(/\.trace-dag\.map \{([^}]*)\}/)?.[1] ?? '';
    expect(map).toMatch(/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
    expect(map).toMatch(/overflow-y: visible/);
    expect(map).not.toMatch(/height|max-height|overflow-y:\s*(auto|scroll)/);
  });

  it('expands timeline, result, token and raw payload regions instead of nesting scrollbars', () => {
    for (const [css, selector] of [
      [TIMELINE_CSS, 'trace-gantt-scroll'],
      [TIMELINE_CSS, 'trace-detail pre'],
      [RUNS_CSS, 'stage-raw-io-stage .trace-payload pre'],
      [RUNS_CSS, 'token-invocations'],
      [RUNS_CSS, 'trace-summary > pre'],
      [TRACE_CSS, 'trace-dag.map .dag-raw .dag-block'],
      [TRACE_CSS, 'trace-dag.map .dag-result-table'],
    ] as const) {
      const escaped = selector.replaceAll('.', '\\.').replaceAll('>', '\\>');
      const body = css.match(new RegExp(`\\.${escaped} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, selector).not.toMatch(/max-height|overflow(?:-x|-y)?:\s*(auto|scroll)/);
    }
    expect(RUNS_CSS).toMatch(/\.run-explorer \.answer-code-block,[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/);
    expect(RUNS_CSS).toMatch(/\.run-explorer \.answer-table-wrap \{[^}]*overflow: visible/s);
  });
});

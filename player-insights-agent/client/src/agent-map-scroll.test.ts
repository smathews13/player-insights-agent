import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isVisibleInContainer, revealStepDetail, returnToSelectedStep, type StepActivation } from './agent-map-scroll';

const TRACE = readFileSync(new URL('./TraceDag.tsx', import.meta.url), 'utf8');
const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const RUNS_CSS = readFileSync(new URL('./styles/runs.css', import.meta.url), 'utf8');
const RESPONSIVE_CSS = readFileSync(new URL('./styles/responsive-runs.css', import.meta.url), 'utf8');

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

describe('selected Agent map details stay inside their scroll owner', () => {
  it('scrolls the internal container for a detail below the fold and never the page', () => {
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

  it('returns to top and bottom map nodes through the same narrow container', () => {
    const container = element({
      top: 80,
      bottom: 380,
      scrollTop: 900,
      scrollHeight: 2600,
      clientHeight: 300,
    });
    const topNode = element({ top: -420, bottom: -360 });
    const bottomNode = element({ top: 620, bottom: 680 });

    const top = returnToSelectedStep({ container, node: topNode, reducedMotion: false });
    expect(top.top).toBe(400);
    expect(topNode.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(topNode.scrollIntoView).not.toHaveBeenCalled();

    const bottom = returnToSelectedStep({ container, node: bottomNode, reducedMotion: true });
    expect(bottom.top).toBe(700);
    expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 700, behavior: 'auto' });
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

describe('Run Explorer owns one anchored viewport', () => {
  it('links every toggle to one stable panel with pressed and expanded state', () => {
    expect(TRACE).toContain('aria-controls={panelId}');
    expect(TRACE).toContain('aria-pressed={isOpen}');
    expect(TRACE).toContain('aria-expanded={isOpen}');
    expect(TRACE).toContain('Showing details for Step ${openIndex + 1}');
    expect(TRACE).toContain('Back to agent map');
  });

  it('never delegates selected-step movement to scrollIntoView or page scrolling', () => {
    expect(TRACE).not.toMatch(/scrollIntoView|window\.scroll|document\.scroll/);
    expect(TRACE).toContain('returnToSelectedStep({ container, node');
    expect(TRACE).toContain('revealStepDetail({');
  });

  it('gives map, timeline, overview, and details separate bounded tab bodies', () => {
    expect(EXPLORER.match(/className="run-detail-scroll/g)).toHaveLength(4);
    expect(EXPLORER).toContain('scrollContainerRef={mapScrollRef}');
    expect(EXPLORER).toContain('<Tabs value={activeTab} onValueChange={setActiveTab}');
    expect(EXPLORER).toContain("scroll.current?.scrollTo({ top: 0, behavior: 'auto' })");
    expect(EXPLORER).not.toMatch(/scrollIntoView|window\.scroll|document\.scroll/);
  });

  it('anchors the detail column and reserves its scrollbar without changing width', () => {
    expect(RUNS_CSS).toMatch(/\.run-detail \{[^}]*position: sticky[^}]*height: calc\(100dvh/);
    expect(RUNS_CSS).toMatch(/\.run-detail \{[^}]*overflow: hidden/);
    expect(RUNS_CSS).toMatch(/\.run-detail-scroll \{[^}]*overflow-y: auto/);
    expect(RUNS_CSS).toMatch(/\.run-detail-scroll \{[^}]*scrollbar-gutter: stable/);
    expect(RUNS_CSS).toMatch(/\.run-detail-scroll \{[^}]*overflow-anchor: none/);
  });

  it('keeps the same internal owner in the narrow layout', () => {
    expect(RESPONSIVE_CSS).toMatch(/\.run-detail \{[^}]*position: relative[^}]*height: min\(/);
    expect(RESPONSIVE_CSS).not.toMatch(/overflow:\s*(visible|auto)/);
  });

  it('keeps the page top unchanged while steps 10 through 19 are selected', () => {
    const pageScroll = vi.fn();
    vi.stubGlobal('window', { scroll: pageScroll, scrollTo: pageScroll });
    const container = element({ top: 100, bottom: 500, scrollHeight: 5000, clientHeight: 400 });

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
    expect(pageScroll).not.toHaveBeenCalled();
    expect(container.getBoundingClientRect().top).toBe(100);
  });
});

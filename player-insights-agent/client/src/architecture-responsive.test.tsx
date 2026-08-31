import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ArchitectureCanvas } from './ArchitecturePage';
import { CANVAS_MAX_WIDTH, MIN_CANVAS_PANEL, canvasScale } from './architecture-layout';
import { observeArchitectureScale } from './architecture-responsive';

const CSS = readFileSync(fileURLToPath(new URL('./styles/architecture.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);
const PAGE_SOURCE = readFileSync(fileURLToPath(new URL('./ArchitecturePage.tsx', import.meta.url)), 'utf8');
const RESPONSIVE_SOURCE = readFileSync(fileURLToPath(new URL('./architecture-responsive.ts', import.meta.url)), 'utf8');

function rule(selector: string, source = CSS): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function containerBlock(): string {
  const start = CSS.indexOf('@container architecture');
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start);
}

function firstPaintMode(width: number): 'canvas' | 'text' {
  const threshold = Number(/@container architecture \(min-width:\s*([0-9.]+)px\)/.exec(CSS)?.[1] ?? Number.NaN);
  expect(threshold).toBe(MIN_CANVAS_PANEL);
  return width >= threshold ? 'canvas' : 'text';
}

describe('Architecture responsive startup', () => {
  it('selects the safe first-paint tree at phone, tablet, and wide container widths', () => {
    expect(firstPaintMode(320)).toBe('text');
    expect(firstPaintMode(800)).toBe('text');
    expect(firstPaintMode(CANVAS_MAX_WIDTH)).toBe('canvas');
  });

  it('starts with the canvas hidden and only reveals it at the geometry fit floor', () => {
    expect(rule('.arch-responsive')).toMatch(/container-name:\s*architecture/);
    expect(rule('.arch-responsive')).toMatch(/container-type:\s*inline-size/);
    expect(rule('.arch-canvas-scroll')).toMatch(/display:\s*none/);

    const wide = containerBlock();
    expect(rule('.arch-canvas-scroll', wide)).toMatch(/display:\s*block/);
    expect(rule('.arch-equivalent', wide)).toMatch(/display:\s*none/);
    expect(PAGE_SOURCE).not.toContain('data-fits');
    expect(PAGE_SOURCE).not.toContain('canvasFits(');
  });

  it('keeps exactly one visual and assistive tree live in each CSS state', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ArchitectureCanvas byResource={new Map()} now={0} payload={null} />
      </MemoryRouter>
    );
    const wide = containerBlock();

    expect(markup.match(/data-testid="architecture-canvas"/g)).toHaveLength(1);
    expect(markup.match(/data-testid="architecture-equivalent"/g)).toHaveLength(1);
    expect(rule('.arch-canvas-scroll')).toMatch(/display:\s*none/);
    expect(rule('.arch-equivalent')).not.toMatch(/display:\s*none/);
    expect(rule('.arch-canvas-scroll', wide)).toMatch(/display:\s*block/);
    expect(rule('.arch-equivalent', wide)).toMatch(/display:\s*none/);
  });

  it('publishes initial scale synchronously, reconciles observer updates, and disconnects', () => {
    let callback: ResizeObserverCallback = () => undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();

    class Observer {
      constructor(next: ResizeObserverCallback) {
        callback = next;
      }

      observe = observe;
      disconnect = disconnect;
      unobserve() {}
    }

    const scales: number[] = [];
    const element = { clientWidth: 800 } as HTMLElement;
    const cleanup = observeArchitectureScale(
      element,
      (scale) => scales.push(scale),
      Observer as unknown as typeof ResizeObserver
    );

    expect(scales).toEqual([canvasScale(800)]);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(element);

    callback([{ contentRect: { width: 1100 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(scales).toEqual([canvasScale(800), canvasScale(1100)]);

    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('uses a pre-paint layout effect without making server and client initial markup differ', () => {
    expect(PAGE_SOURCE).toContain("typeof document === 'undefined' ? useEffect : useLayoutEffect");
    expect(PAGE_SOURCE).toContain('const [scale, setScale] = useState(1)');
    expect(RESPONSIVE_SOURCE).toContain('publish(element.clientWidth)');
    expect(PAGE_SOURCE).not.toMatch(/useState\(\(\) =>[\s\S]{0,200}(window|matchMedia|clientWidth)/);
  });
});

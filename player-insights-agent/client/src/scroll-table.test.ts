import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScrollTable } from './ui';

type MarkedElement = ReactElement<{ ref: (table: HTMLTableElement | null) => void }>;

/*
 * Rendered to static markup and the ref called by hand: this repo has no jsdom,
 * and a ref never runs during a static render. Whether a keyboard user can then
 * scroll the box needs a human at a narrow window.
 */
describe('ScrollTable', () => {
  it("renders inside AppKit's sideways-scrolling container", () => {
    const html = renderToStaticMarkup(ScrollTable({ label: 'Cases', className: 'bench-sheet' }));
    expect(html).toMatch(/^<div data-slot="table-container" class="[^"]*overflow-x-auto[^"]*"><table/);
    expect(html).toContain('bench-sheet');
  });

  it('makes that container a named, focusable region', () => {
    const attributes: Record<string, string> = {};
    const box = { tabIndex: -1, setAttribute: (name: string, value: string) => (attributes[name] = value) };
    const table = { parentElement: box } as unknown as HTMLTableElement;

    (ScrollTable({ label: 'Evaluation cases' }) as MarkedElement).props.ref(table);

    expect(box.tabIndex).toBe(0);
    expect(attributes).toEqual({ role: 'region', 'aria-label': 'Evaluation cases' });
  });

  it('ignores the unmount call', () => {
    expect(() => (ScrollTable({ label: 'Cases' }) as MarkedElement).props.ref(null)).not.toThrow();
  });
});

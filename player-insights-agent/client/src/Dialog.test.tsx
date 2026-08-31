import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog';
import { dialogKeyIntent, dialogTabTarget } from './dialog-state';

const SOURCE = readFileSync(new URL('./Dialog.tsx', import.meta.url), 'utf8');

function renderDialog(): string {
  return renderToStaticMarkup(
    <Dialog
      overlayClassName="overlay"
      contentClassName="content"
      labelledBy="dialog-title"
      describedBy="dialog-description"
      onDismiss={() => {}}
    >
      <h2 id="dialog-title">Shared dialog</h2>
      <p id="dialog-description">Dialog description</p>
      <button type="button">First action</button>
      <button type="button">Last action</button>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('renders the modal contract and labelled description', () => {
    const html = renderDialog();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="dialog-title"');
    expect(html).toContain('aria-describedby="dialog-description"');
    expect(html).toContain('tabindex="-1"');
  });

  it('supports semantic side panels and explicit busy state', () => {
    const html = renderToStaticMarkup(
      <Dialog overlayClassName="overlay" contentClassName="drawer" contentAs="aside" labelledBy="drawer-title" ariaBusy>
        <h2 id="drawer-title">Person activity</h2>
      </Dialog>
    );
    expect(html).toContain('<aside');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-busy="true"');
  });

  it('turns fake keyboard events into containment and dismissal intent', () => {
    expect(dialogKeyIntent({ key: 'Escape', shiftKey: false })).toBe('escape');
    expect(dialogKeyIntent({ key: 'Tab', shiftKey: false })).toBe('forward');
    expect(dialogKeyIntent({ key: 'Tab', shiftKey: true })).toBe('backward');
    expect(dialogKeyIntent({ key: 'ArrowDown', shiftKey: false })).toBeNull();

    const controls = ['first', 'last'];
    expect(dialogTabTarget(controls, null, 'forward')).toBe('first');
    expect(dialogTabTarget(controls, 'last', 'forward')).toBe('first');
    expect(dialogTabTarget(controls, 'first', 'backward')).toBe('last');
  });

  it('contains focus, hides the background, restores focus, and nests scroll locks', () => {
    expect(SOURCE).toContain('target.focus()');
    expect(SOURCE).toContain("sibling.setAttribute('aria-hidden', 'true')");
    expect(SOURCE).toContain('sibling.inert = true');
    expect(SOURCE).toContain("document.body.style.overflow = 'hidden'");
    expect(SOURCE).toContain('scrollLocks += 1');
    expect(SOURCE).toContain('if (scrollLocks === 0) document.body.style.overflow = savedBodyOverflow');
    expect(SOURCE).toContain('restoreTo instanceof HTMLElement && restoreTo.isConnected');
    expect(SOURCE).toContain('restoreTo.focus()');
  });

  it('keeps Escape and backdrop behavior under caller policy', () => {
    expect(SOURCE).toContain("onDismiss?.('escape')");
    expect(SOURCE).toContain("onDismiss?.('backdrop')");
    expect(SOURCE).toContain('event.target !== event.currentTarget');
    expect(SOURCE).toContain('event.stopPropagation()');
  });
});

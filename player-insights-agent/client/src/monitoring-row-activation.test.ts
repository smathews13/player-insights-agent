import { describe, expect, it, vi } from 'vitest';

import {
  MONITORING_ROW_INTERACTIVE_SELECTOR,
  activateMonitoringRow,
  isMonitoringRowInteractiveDescendant,
  monitoringQuestionRowHandlers,
  type MonitoringRowActivationEvent,
} from './monitoring-row-activation';

function passiveTarget() {
  return Object.assign(new EventTarget(), {
    closest: () => null,
  });
}

function interactiveTarget(interactive: EventTarget) {
  return Object.assign(new EventTarget(), {
    closest: (selector: string) => {
      expect(selector).toBe(MONITORING_ROW_INTERACTIVE_SELECTOR);
      return interactive;
    },
  });
}

function event(
  currentTarget: EventTarget,
  target: EventTarget,
  overrides: Partial<MonitoringRowActivationEvent> = {}
): MonitoringRowActivationEvent {
  return { currentTarget, target, ...overrides };
}

describe('Monitoring row activation', () => {
  it.each(['question', 'when', 'outcome', 'duration', 'tokens', 'tools', 'feedback'])(
    'opens once from the non-interactive %s cell',
    () => {
      const row = new EventTarget();
      const onOpen = vi.fn();
      const question = { id: 'current-question' };
      const handlers = monitoringQuestionRowHandlers(question, onOpen);

      handlers.onClick(event(row, passiveTarget()));

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledWith(question);
    }
  );

  it.each(['Enter', ' '])('opens from the %s key on the row', (key) => {
    const row = new EventTarget();
    const preventDefault = vi.fn();
    const onOpen = vi.fn();

    const activated = activateMonitoringRow(event(row, row, { key, preventDefault }), onOpen);

    expect(activated).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(key === ' ' ? 1 : 0);
  });

  it.each(['Escape', 'ArrowDown', 'Tab', 'a'])('ignores the %s key', (key) => {
    const row = new EventTarget();
    const onOpen = vi.fn();

    expect(activateMonitoringRow(event(row, row, { key }), onOpen)).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each(['a', 'button', 'input', 'select', '[data-no-row-activation]'])(
    'keeps a nested %s action out of row activation',
    (selector) => {
      expect(MONITORING_ROW_INTERACTIVE_SELECTOR).toContain(selector);
      const row = new EventTarget();
      const control = new EventTarget();
      const target = interactiveTarget(control);
      const onOpen = vi.fn();

      expect(isMonitoringRowInteractiveDescendant(target, row)).toBe(true);
      expect(activateMonitoringRow(event(row, target), onOpen)).toBe(false);
      expect(activateMonitoringRow(event(row, target, { key: 'Enter' }), onOpen)).toBe(false);
      expect(onOpen).not.toHaveBeenCalled();
    }
  );

  it('uses the question object from the refreshed row instead of a stale id lookup', () => {
    const row = new EventTarget();
    const onOpen = vi.fn();
    const stale = { id: 'page-1-question', question: 'Old page' };
    const refreshed = { id: 'page-2-question', question: 'Current page' };

    monitoringQuestionRowHandlers(stale, onOpen);
    const currentHandlers = monitoringQuestionRowHandlers(refreshed, onOpen);
    currentHandlers.onClick(event(row, passiveTarget()));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(refreshed);
  });
});

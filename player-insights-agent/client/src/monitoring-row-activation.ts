/**
 * Interactive descendants keep their own action when a Monitoring row is
 * clickable. The explicit data attribute covers custom controls whose native
 * element or ARIA role would not otherwise identify them.
 */
export const MONITORING_ROW_INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '[data-no-row-activation]',
].join(', ');

type ClosestEventTarget = EventTarget & {
  closest?: (selector: string) => EventTarget | null;
};

export interface MonitoringRowActivationEvent {
  currentTarget: EventTarget;
  target: EventTarget | null;
  key?: string;
  preventDefault?: () => void;
}

export function isMonitoringRowInteractiveDescendant(target: EventTarget | null, currentTarget: EventTarget): boolean {
  if (!target || target === currentTarget) return false;
  const closest = (target as ClosestEventTarget).closest;
  if (typeof closest !== 'function') return false;
  const interactive = closest.call(target, MONITORING_ROW_INTERACTIVE_SELECTOR);
  return interactive !== null && interactive !== currentTarget;
}

export function activateMonitoringRow(event: MonitoringRowActivationEvent, activate: () => void): boolean {
  if (event.key !== undefined && event.key !== 'Enter' && event.key !== ' ') return false;
  if (isMonitoringRowInteractiveDescendant(event.target, event.currentTarget)) return false;
  if (event.key === ' ') event.preventDefault?.();
  activate();
  return true;
}

export function monitoringQuestionRowHandlers<T>(question: T, onOpen: (question: T) => void) {
  const activate = (event: MonitoringRowActivationEvent) => activateMonitoringRow(event, () => onOpen(question));
  return { onClick: activate, onKeyDown: activate };
}

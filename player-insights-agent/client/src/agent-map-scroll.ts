/**
 * Scroll ownership for Run Explorer's Agent map.
 *
 * The page chrome is not a scroll target. A selected step and its detail header
 * both live in one explicit, bounded container; these helpers reveal either by
 * changing that container's scrollTop and nothing outside it.
 */

export type StepActivationKind = 'pointer' | 'keyboard';

export interface StepActivation {
  stepId: string;
  kind: StepActivationKind;
  sequence: number;
}

export interface RevealResult {
  focused: boolean;
  scrolled: boolean;
  top: number;
}

type VerticalRect = Pick<DOMRect, 'top' | 'bottom'>;

function boundedScrollTop(container: HTMLElement, delta: number): number {
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.min(maximum, Math.max(0, container.scrollTop + delta));
}

/** Whether the whole target header is currently visible inside its owner. */
export function isVisibleInContainer(target: VerticalRect, container: VerticalRect): boolean {
  return target.top >= container.top && target.bottom <= container.bottom;
}

/**
 * Reveal a selected detail header without invoking scrollIntoView.
 *
 * `selectedStepId` rejects a stale effect after rapid selection. Keyboard
 * activation moves focus to the heading with preventScroll, leaving this helper
 * as the only owner of movement.
 */
export function revealStepDetail({
  activation,
  selectedStepId,
  container,
  heading,
  reducedMotion,
}: {
  activation: StepActivation;
  selectedStepId: string;
  container: HTMLElement;
  heading: HTMLElement;
  reducedMotion: boolean;
}): RevealResult {
  if (activation.stepId !== selectedStepId) {
    return { focused: false, scrolled: false, top: container.scrollTop };
  }

  let focused = false;
  if (activation.kind === 'keyboard') {
    heading.focus({ preventScroll: true });
    focused = true;
  }

  const containerRect = container.getBoundingClientRect();
  const headingRect = heading.getBoundingClientRect();
  if (isVisibleInContainer(headingRect, containerRect)) {
    return { focused, scrolled: false, top: container.scrollTop };
  }

  const targetIsTaller = headingRect.bottom - headingRect.top > containerRect.bottom - containerRect.top;
  const delta =
    headingRect.top < containerRect.top || targetIsTaller
      ? headingRect.top - containerRect.top
      : headingRect.bottom - containerRect.bottom;
  const top = boundedScrollTop(container, delta);
  if (top === container.scrollTop) return { focused, scrolled: false, top };

  container.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
  return { focused, scrolled: true, top };
}

/**
 * Return from the detail panel to the map top and its selected card.
 *
 * Focus is restored without native scrolling. When the map root is supplied,
 * its top is aligned in the same bounded workspace; compact callers may omit it
 * and reveal only the selected card.
 */
export function returnToSelectedStep({
  container,
  node,
  map,
  reducedMotion,
}: {
  container: HTMLElement;
  node: HTMLElement;
  map?: HTMLElement;
  reducedMotion: boolean;
}): RevealResult {
  node.focus({ preventScroll: true });
  const containerRect = container.getBoundingClientRect();
  const targetRect = (map ?? node).getBoundingClientRect();
  if (!map && isVisibleInContainer(targetRect, containerRect)) {
    return { focused: true, scrolled: false, top: container.scrollTop };
  }

  const delta = map
    ? targetRect.top - containerRect.top
    : targetRect.top < containerRect.top
      ? targetRect.top - containerRect.top
      : targetRect.bottom - containerRect.bottom;
  const top = boundedScrollTop(container, delta);
  if (top === container.scrollTop) return { focused: true, scrolled: false, top };

  container.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
  return { focused: true, scrolled: true, top };
}

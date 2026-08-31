/**
 * Keeps the Ask transcript clear of its fixed composer.
 *
 * The composer grows when attachments, notices, or the narrow run summary are
 * present. Its clearance therefore belongs to the rendered element, not to a
 * design-time height guess.
 */

export const COMPOSER_CLEARANCE_BUFFER_PX = 16;

type ComposerRect = Pick<DOMRect, 'bottom' | 'height'>;

export type ComposerClearanceEnvironment = {
  viewportHeight: () => number;
  listenViewport: (listener: () => void) => () => void;
  observeElement?: (element: Element, listener: () => void) => () => void;
};

export function composerClearance(rect: ComposerRect, viewportHeight: number): number {
  const bottomInset = Math.max(0, viewportHeight - rect.bottom);
  return Math.ceil(Math.max(0, rect.height) + bottomInset + COMPOSER_CLEARANCE_BUFFER_PX);
}

export function measureComposerClearance(scope: HTMLElement, composer: HTMLElement, viewportHeight: number): number {
  const clearance = composerClearance(composer.getBoundingClientRect(), viewportHeight);
  scope.style.setProperty('--composer-reserve', `${clearance}px`);
  return clearance;
}

function browserEnvironment(): ComposerClearanceEnvironment {
  const listenViewport = (listener: () => void) => {
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  };

  if (typeof ResizeObserver === 'function') {
    return {
      viewportHeight: () => window.innerHeight,
      listenViewport,
      observeElement: (element, listener) => {
        const observer = new ResizeObserver(listener);
        observer.observe(element);
        return () => observer.disconnect();
      },
    };
  }

  /*
   * Older embedded browsers have no ResizeObserver. Attachment chips still
   * change the composer's height without resizing the viewport, so a subtree
   * observer is the useful fallback; the viewport listener below covers
   * orientation and safe-area changes. If neither observer exists, the initial
   * measurement plus that listener still clears the ordinary composer.
   */
  if (typeof MutationObserver === 'function') {
    return {
      viewportHeight: () => window.innerHeight,
      listenViewport,
      observeElement: (element, listener) => {
        const observer = new MutationObserver(listener);
        observer.observe(element, { attributes: true, characterData: true, childList: true, subtree: true });
        return () => observer.disconnect();
      },
    };
  }

  return {
    viewportHeight: () => window.innerHeight,
    listenViewport,
  };
}

export function observeComposerClearance(
  scope: HTMLElement,
  composer: HTMLElement,
  environment: ComposerClearanceEnvironment = browserEnvironment()
): () => void {
  const measure = () => measureComposerClearance(scope, composer, environment.viewportHeight());
  measure();
  const stopObserving = environment.observeElement?.(composer, measure);
  const stopListening = environment.listenViewport(measure);

  return () => {
    stopObserving?.();
    stopListening();
    scope.style.removeProperty('--composer-reserve');
  };
}

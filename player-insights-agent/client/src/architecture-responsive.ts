import { canvasScale } from './architecture-layout';

/**
 * Publish the scale implied by the panel now, then keep it current.
 *
 * Visibility is intentionally absent: the container query owns whether the
 * drawing or its text equivalent paints, while JavaScript owns only the zoom
 * value the fixed geometry needs.
 */
export function observeArchitectureScale(
  element: HTMLElement,
  onScale: (scale: number) => void,
  Observer: typeof ResizeObserver | undefined = typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver
): () => void {
  let lastScale = Number.NaN;
  const publish = (width: number) => {
    const nextScale = canvasScale(width);
    if (nextScale === lastScale) return;
    lastScale = nextScale;
    onScale(nextScale);
  };

  publish(element.clientWidth);
  if (!Observer) return () => undefined;

  const observer = new Observer((entries) => {
    publish(entries[0]?.contentRect.width ?? element.clientWidth);
  });
  observer.observe(element);
  return () => observer.disconnect();
}

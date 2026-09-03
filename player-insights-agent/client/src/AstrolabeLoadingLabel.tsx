import { ConceptFlicker } from './ConceptFlicker';

/**
 * The canonical compact Astrolabe loader: one stable concept slot and one label.
 *
 * The component never keys or remounts the mark when its label changes. Motion
 * preferences are handled by the shared Astrolabe animation rules, which freeze
 * the slot on the recognizable rest mark.
 */
export function AstrolabeLoadingLabel({
  label,
  className,
  announce = true,
  as: Element = 'div',
}: {
  label: string;
  className?: string;
  announce?: boolean;
  /** Use inline phrasing content when the loader sits inside a button. */
  as?: 'div' | 'span';
}) {
  return (
    <Element
      className={`ast-flick-row ${className ?? ''}`.trim()}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-busy="true"
    >
      <ConceptFlicker seat="inline" />
      <span className="ast-flick-row-say">{label}</span>
    </Element>
  );
}

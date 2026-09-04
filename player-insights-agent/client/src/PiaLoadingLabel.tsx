import { PiaFlicker } from './PiaFlicker';
import type { PiaLoaderSeat } from './pia-loader';

/** A compact PIA loader paired with one stable status label. */
export function PiaLoadingLabel({
  label,
  className,
  announce = true,
  as: Element = 'div',
  seat = 'inline',
}: {
  label: string;
  className?: string;
  announce?: boolean;
  /** Use inline phrasing content when the loader sits inside a button. */
  as?: 'div' | 'span';
  seat?: PiaLoaderSeat;
}) {
  return (
    <Element
      className={`pia-flick-row ${className ?? ''}`.trim()}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-busy="true"
    >
      <PiaFlicker seat={seat} />
      <span className="pia-flick-row-say">{label}</span>
    </Element>
  );
}

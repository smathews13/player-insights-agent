import { PiaLoader } from './PiaLoader';
import type { PiaMarkTone } from './PiaMark';
import type { PiaLoaderSeat, PiaLoaderVariant } from './pia-loader';

const SEAT_VARIANT: Readonly<Record<PiaLoaderSeat, PiaLoaderVariant>> = {
  splash: 'panel',
  compact: 'compact',
  inline: 'inline',
  button: 'button',
  strip: 'compact',
  status: 'chip',
};

/** A compact PIA loader paired with one stable status label. */
export function PiaLoadingLabel({
  label,
  className,
  announce = true,
  as: Element = 'div',
  seat = 'inline',
  tone = seat === 'button' || seat === 'status' ? 'dark' : 'light',
}: {
  label: string;
  className?: string;
  announce?: boolean;
  /** Use inline phrasing content when the loader sits inside a button. */
  as?: 'div' | 'span';
  seat?: PiaLoaderSeat;
  tone?: PiaMarkTone;
}) {
  return (
    <PiaLoader
      as={Element}
      variant={SEAT_VARIANT[seat]}
      tone={tone}
      label={label}
      announce={announce}
      className={className}
    />
  );
}

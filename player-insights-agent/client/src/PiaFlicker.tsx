/**
 * The PIA loading mark in legacy seats: full choreography for splash,
 * face-buttons-only motion for local seats, and the 16px control cluster.
 *
 * New panel and inline hosts should prefer `PiaLoader`; these named seats keep
 * established layout geometry while using the same PIA loader drawing.
 */
import { PiaLoaderMark } from './PiaLoader';
import type { PiaMarkTone } from './PiaMark';
import { PIA_LOADER_SIZES, type PiaLoaderSeat, type PiaLoaderVariant } from './pia-loader';

const SEAT = {
  splash: { variant: 'panel', tone: 'light' },
  compact: { variant: 'compact', tone: 'light' },
  inline: { variant: 'inline', tone: 'light' },
  button: { variant: 'button', tone: 'dark' },
  strip: { variant: 'compact', tone: 'dark' },
  status: { variant: 'chip', tone: 'dark' },
} as const satisfies Readonly<Record<PiaLoaderSeat, { variant: PiaLoaderVariant; tone: PiaMarkTone }>>;

export function PiaFlicker({
  seat,
  tone: toneOverride,
  className,
}: {
  seat: PiaLoaderSeat;
  tone?: PiaMarkTone;
  className?: string;
}) {
  const { variant, tone } = SEAT[seat];
  const size = PIA_LOADER_SIZES[variant];
  return (
    <span
      className={`pia-flick-slot pia-flick-slot--${seat} ${className ?? ''}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <PiaLoaderMark variant={variant} tone={toneOverride ?? tone} />
    </span>
  );
}

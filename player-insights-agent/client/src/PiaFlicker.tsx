/**
 * The PIA D-pad/face-button cycle in every compact legacy seating.
 *
 * New panel and inline hosts should prefer `PiaLoader`; these named seats keep
 * established layout geometry while using the same PIA loader drawing.
 */
import { PiaLoaderMark } from './PiaLoader';
import type { PiaMarkTone } from './PiaMark';
import type { PiaLoaderSeat } from './pia-loader';

const SEAT = {
  splash: { size: 112, tone: 'light', detailed: true },
  inline: { size: 20, tone: 'light', detailed: false },
  button: { size: 14, tone: 'mono', detailed: false },
  strip: { size: 18, tone: 'dark', detailed: false },
  status: { size: 11, tone: 'dark', detailed: false },
} as const satisfies Readonly<Record<PiaLoaderSeat, { size: number; tone: PiaMarkTone; detailed: boolean }>>;

export function PiaFlicker({ seat, className }: { seat: PiaLoaderSeat; className?: string }) {
  const { size, tone, detailed } = SEAT[seat];
  return (
    <span
      className={`pia-flick-slot pia-flick-slot--${seat} ${className ?? ''}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <PiaLoaderMark size={size} tone={tone} detailed={detailed} />
    </span>
  );
}

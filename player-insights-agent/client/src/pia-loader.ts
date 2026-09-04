export const PIA_LOADER_CYCLE_SECONDS = 6.4;
export const PIA_LOADER_HALF_SECONDS = PIA_LOADER_CYCLE_SECONDS / 2;
export const PIA_LOADER_STEP_SECONDS = PIA_LOADER_HALF_SECONDS / 4;

export const PIA_LOADER_SIZES = {
  panel: 112,
  compact: 32,
  inline: 20,
  button: 16,
  chip: 16,
} as const;

export type PiaLoaderVariant = keyof typeof PIA_LOADER_SIZES;
export type PiaLoaderSeat = 'splash' | 'compact' | 'inline' | 'button' | 'strip' | 'status';
export type PiaLoaderGlyph = 'up' | 'right' | 'down' | 'left';

export const PIA_LOADER_GLYPH_ORDER: readonly PiaLoaderGlyph[] = ['up', 'right', 'down', 'left'];

export function piaLoaderGlyphDelay(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= PIA_LOADER_GLYPH_ORDER.length) {
    throw new RangeError(`PIA loader glyph index must be 0-${PIA_LOADER_GLYPH_ORDER.length - 1}`);
  }
  return Math.round((-PIA_LOADER_HALF_SECONDS + index * PIA_LOADER_STEP_SECONDS) * 100) / 100;
}

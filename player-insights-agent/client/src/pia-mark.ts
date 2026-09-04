/**
 * Canonical Player Insights Agent mark geometry and lockup measurements.
 *
 * The six SVG assets in assets/logo are generated from these same coordinates.
 * A D-pad is engraved at 24px and above; smaller seats always use the simplified
 * cut because the four button glyphs do not survive below that size.
 */

export type PiaMarkKind = 'dpad' | 'cluster';
export type PiaMarkTone = 'light' | 'dark' | 'mono' | 'print';
export type PiaMarkPaint = 'ink' | 'accent' | 'engraving';
export type PiaMarkRole = 'arm' | 'glyph' | 'guide' | 'center';

type ShapeBase = {
  fill?: PiaMarkPaint;
  stroke?: PiaMarkPaint;
  strokeWidth?: number;
  opacity?: number;
  role: PiaMarkRole;
};

export type PiaMarkElement =
  | (ShapeBase & { kind: 'circle'; cx: number; cy: number; r: number })
  | (ShapeBase & { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number })
  | (ShapeBase & {
      kind: 'path';
      d: string;
      dash?: string;
      linecap?: 'round';
      linejoin?: 'round';
    });

export const PIA_MARK_VIEWBOX = 64;
export const PIA_SIMPLIFIED_CUTOFF = 24;

export const PIA_DPAD_ARMS: readonly PiaMarkElement[] = [
  { kind: 'rect', x: 25, y: 6, width: 14, height: 52, rx: 7, fill: 'ink', role: 'arm' },
  { kind: 'rect', x: 6, y: 25, width: 52, height: 14, rx: 7, fill: 'ink', role: 'arm' },
];

export const PIA_DPAD_GLYPHS: readonly PiaMarkElement[] = [
  {
    kind: 'path',
    d: 'M32 12.5 L35.5 18.5 H28.5 Z',
    stroke: 'engraving',
    strokeWidth: 2,
    linecap: 'round',
    linejoin: 'round',
    role: 'glyph',
  },
  {
    kind: 'circle',
    cx: 47.5,
    cy: 32,
    r: 3.2,
    stroke: 'engraving',
    strokeWidth: 2,
    role: 'glyph',
  },
  {
    kind: 'path',
    d: 'M29.5 45.5 L34.5 50.5 M34.5 45.5 L29.5 50.5',
    stroke: 'engraving',
    strokeWidth: 2,
    linecap: 'round',
    linejoin: 'round',
    role: 'glyph',
  },
  {
    kind: 'rect',
    x: 13.5,
    y: 29,
    width: 6,
    height: 6,
    rx: 1,
    stroke: 'engraving',
    strokeWidth: 2,
    role: 'glyph',
  },
];

export const PIA_DPAD_CENTER: PiaMarkElement = {
  kind: 'circle',
  cx: 32,
  cy: 32,
  r: 3.4,
  fill: 'accent',
  role: 'center',
};

export const PIA_DPAD_ENGRAVED: readonly PiaMarkElement[] = [...PIA_DPAD_ARMS, ...PIA_DPAD_GLYPHS, PIA_DPAD_CENTER];

export const PIA_DPAD_SIMPLIFIED: readonly PiaMarkElement[] = [...PIA_DPAD_ARMS, PIA_DPAD_CENTER];

export const PIA_CLUSTER_BODY: readonly PiaMarkElement[] = [
  {
    kind: 'path',
    d: 'M32 18 L46 32 L32 46 L18 32 Z',
    stroke: 'accent',
    strokeWidth: 1,
    dash: '2 4',
    role: 'guide',
    opacity: 0.6,
  },
  {
    kind: 'path',
    d: 'M32 6.5 L38.5 17.5 H25.5 Z',
    stroke: 'ink',
    strokeWidth: 2.6,
    linecap: 'round',
    linejoin: 'round',
    role: 'glyph',
  },
  {
    kind: 'circle',
    cx: 52,
    cy: 32,
    r: 6,
    stroke: 'ink',
    strokeWidth: 2.6,
    role: 'glyph',
  },
  {
    kind: 'path',
    d: 'M27 46.5 L37 56.5 M37 46.5 L27 56.5',
    stroke: 'accent',
    strokeWidth: 2.6,
    linecap: 'round',
    linejoin: 'round',
    role: 'glyph',
  },
  {
    kind: 'rect',
    x: 6.5,
    y: 26,
    width: 12,
    height: 12,
    rx: 1.5,
    stroke: 'ink',
    strokeWidth: 2.6,
    role: 'glyph',
  },
];

export const PIA_CLUSTER: readonly PiaMarkElement[] = [...PIA_CLUSTER_BODY, PIA_DPAD_CENTER];

export type PiaDpadCut = 'engraved' | 'simplified';

export function piaDpadCut(size: number): PiaDpadCut {
  return size < PIA_SIMPLIFIED_CUTOFF ? 'simplified' : 'engraved';
}

export function piaMarkElements(size: number, kind: PiaMarkKind = 'dpad'): readonly PiaMarkElement[] {
  if (kind === 'cluster') return PIA_CLUSTER;
  return piaDpadCut(size) === 'simplified' ? PIA_DPAD_SIMPLIFIED : PIA_DPAD_ENGRAVED;
}

export const PIA_NAME = 'Player Insights Agent';
export const PIA_ACRONYM = 'PIA';

export const PIA_LOCKUP_SEATS = {
  header: { mark: 15, type: 12.5, gap: 7 },
  hero: { mark: 48, type: 24, gap: 12 },
  compact: { mark: 40, type: 38, gap: 5 },
} as const;

export type PiaLockupSeat = keyof typeof PIA_LOCKUP_SEATS;
export type PiaLockupName = 'full' | 'acronym' | 'responsive';

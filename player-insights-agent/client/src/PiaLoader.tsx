import type { CSSProperties, ReactNode } from 'react';

import { PiaDrawing, PiaShape, type PiaMarkTone } from './PiaMark';
import { PIA_CLUSTER_BODY, PIA_DPAD_ARMS, PIA_DPAD_CENTER, PIA_DPAD_GLYPHS, PIA_MARK_VIEWBOX } from './pia-mark';
import { PIA_LOADER_SIZES, piaLoaderGlyphDelay, type PiaLoaderVariant } from './pia-loader';

const GLYPH_ORIGINS = ['32px 12px', '52px 32px', '32px 51.5px', '12.5px 32px'] as const;
const DPAD_TIPS = [
  { kind: 'rect', x: 27.5, y: 8.5, width: 9, height: 14, rx: 4.5, fill: 'accent', role: 'glyph' },
  { kind: 'rect', x: 41.5, y: 27.5, width: 14, height: 9, rx: 4.5, fill: 'accent', role: 'glyph' },
  { kind: 'rect', x: 27.5, y: 41.5, width: 9, height: 14, rx: 4.5, fill: 'accent', role: 'glyph' },
  { kind: 'rect', x: 8.5, y: 27.5, width: 14, height: 9, rx: 4.5, fill: 'accent', role: 'glyph' },
] as const;

function animationDelay(index: number): CSSProperties {
  return { animationDelay: `${piaLoaderGlyphDelay(index)}s` };
}

function SwapMark({ detailed }: { detailed: boolean }) {
  const clusterGlyphs = PIA_CLUSTER_BODY.filter((element) => element.role === 'glyph');
  const diamond = PIA_CLUSTER_BODY.find((element) => element.role === 'guide');
  return (
    <>
      <g className="pia-loader__phase pia-loader__phase--dpad">
        <PiaDrawing elements={PIA_DPAD_ARMS} />
        {detailed ? (
          <>
            <g className="pia-loader__tip-pills">
              {DPAD_TIPS.map((tip, index) => (
                <PiaShape
                  element={tip}
                  className="pia-loader__highlight"
                  key={`dpad-tip-${tip.x}-${tip.y}`}
                  style={animationDelay(index)}
                />
              ))}
            </g>
            <g className="pia-loader__engravings">
              <PiaDrawing elements={PIA_DPAD_GLYPHS} />
            </g>
            {PIA_DPAD_GLYPHS.map((glyph, index) => (
              <PiaShape
                element={glyph}
                paintOverride="accent"
                className="pia-loader__highlight"
                key={`dpad-highlight-${JSON.stringify(glyph)}`}
                style={animationDelay(index)}
              />
            ))}
          </>
        ) : null}
      </g>
      <g className="pia-loader__phase pia-loader__phase--cluster">
        {detailed && diamond ? <PiaShape element={diamond} className="pia-loader__diamond" /> : null}
        {clusterGlyphs.map((glyph, index) => (
          <g
            className={detailed ? 'pia-loader__button' : undefined}
            style={
              detailed
                ? {
                    ...animationDelay(index),
                    transformOrigin: GLYPH_ORIGINS[index],
                  }
                : undefined
            }
            key={`cluster-${JSON.stringify(glyph)}`}
          >
            <PiaShape element={glyph} />
          </g>
        ))}
      </g>
      <PiaShape element={PIA_DPAD_CENTER} className="pia-loader__center" />
    </>
  );
}

function ButtonMark({ size }: { size: number }) {
  return (
    <g
      className="pia-loader__button-cluster"
      fill="none"
      strokeWidth={size <= 12 ? 2 : 1.6}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <g className="pia-loader__button" style={{ ...animationDelay(0), transformOrigin: '10px 3.6px' }}>
        <path d="M10 1.2 L12.4 5.5 H7.6 Z" stroke="var(--pia-mark-ink)" />
      </g>
      <g className="pia-loader__button" style={{ ...animationDelay(1), transformOrigin: '16.4px 10px' }}>
        <circle cx="16.4" cy="10" r="2.3" stroke="var(--pia-mark-ink)" />
      </g>
      <g className="pia-loader__button" style={{ ...animationDelay(2), transformOrigin: '10px 16.4px' }}>
        <path d="M8.2 14.6 L11.8 18.2 M11.8 14.6 L8.2 18.2" stroke="var(--pia-mark-accent)" />
      </g>
      <g className="pia-loader__button" style={{ ...animationDelay(3), transformOrigin: '3.6px 10px' }}>
        <rect x="1.6" y="8" width="4" height="4" rx="0.8" stroke="var(--pia-mark-ink)" />
      </g>
    </g>
  );
}

export function PiaLoaderMark({
  variant = 'inline',
  size,
  tone = 'light',
  className,
}: {
  variant?: PiaLoaderVariant;
  size?: number;
  tone?: PiaMarkTone;
  className?: string;
}) {
  const resolvedSize = size ?? PIA_LOADER_SIZES[variant];
  const swaps = variant === 'panel' || variant === 'compact' || variant === 'inline';
  const detailed = variant === 'panel';
  const button = variant === 'button' || variant === 'chip';
  return (
    <svg
      className={`pia-loader-mark pia-loader-mark--${variant} pia-mark pia-mark--${tone} pia-anim ${className ?? ''}`.trim()}
      width={resolvedSize}
      height={resolvedSize}
      viewBox={button ? '0 0 20 20' : `0 0 ${PIA_MARK_VIEWBOX} ${PIA_MARK_VIEWBOX}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {swaps ? <SwapMark detailed={detailed} /> : <ButtonMark size={resolvedSize} />}
    </svg>
  );
}

export function PiaLoader({
  variant = 'panel',
  tone = 'light',
  label = 'Querying player data...',
  announce = true,
  className,
  as: Element = 'div',
}: {
  variant?: PiaLoaderVariant;
  tone?: PiaMarkTone;
  label?: string | null;
  announce?: boolean;
  className?: string;
  as?: 'div' | 'span';
}) {
  return (
    <Element
      className={`pia-loader pia-loader--${variant} ${className ?? ''}`.trim()}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-busy="true"
    >
      <PiaLoaderMark variant={variant} tone={tone} />
      {label ? <span className="pia-loader__label">{label}</span> : null}
    </Element>
  );
}

/**
 * A button label whose idle and busy layers occupy the same grid cell.
 * Both layers participate in sizing, so adding the loader cannot move adjacent
 * controls. The single screen-reader label keeps the accessible name stable.
 */
export function PiaBusyButtonContent({
  busy,
  label,
  busyLabel = label,
  tone = 'dark',
  icon,
}: {
  busy: boolean;
  label: string;
  busyLabel?: string;
  tone?: PiaMarkTone;
  icon?: ReactNode;
}) {
  return (
    <>
      <span className="pia-button-state" data-busy={busy ? 'true' : 'false'} aria-hidden="true">
        <span className="pia-button-state__idle">
          {icon}
          <span>{label}</span>
        </span>
        <span className="pia-button-state__busy">
          <PiaLoaderMark variant="button" tone={tone} />
          <span>{busyLabel}</span>
        </span>
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}

export type { PiaLoaderVariant };

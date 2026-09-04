import type { CSSProperties } from 'react';

import { PiaDrawing, PiaShape, type PiaMarkTone } from './PiaMark';
import { PIA_CLUSTER_BODY, PIA_DPAD_ARMS, PIA_DPAD_CENTER, PIA_DPAD_GLYPHS, PIA_MARK_VIEWBOX } from './pia-mark';
import { PIA_LOADER_SIZES, piaLoaderGlyphDelay, type PiaLoaderVariant } from './pia-loader';

const GLYPH_ORIGINS = ['32px 12px', '52px 32px', '32px 51.5px', '12.5px 32px'] as const;

function animationDelay(index: number): CSSProperties {
  return { animationDelay: `${piaLoaderGlyphDelay(index)}s` };
}

export function PiaLoaderMark({
  size = PIA_LOADER_SIZES.inline,
  tone = 'light',
  detailed = false,
  className,
}: {
  size?: number;
  tone?: PiaMarkTone;
  detailed?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`pia-loader-mark ${detailed ? 'pia-loader-mark--detailed' : 'pia-loader-mark--inline'} pia-mark pia-mark--${tone} pia-anim ${className ?? ''}`.trim()}
      width={size}
      height={size}
      viewBox={`0 0 ${PIA_MARK_VIEWBOX} ${PIA_MARK_VIEWBOX}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className="pia-loader__phase pia-loader__phase--dpad">
        <PiaDrawing elements={PIA_DPAD_ARMS} />
        {detailed ? (
          <>
            <PiaDrawing elements={PIA_DPAD_GLYPHS} />
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
        {PIA_CLUSTER_BODY.map((glyph, index) => {
          const isButton = glyph.role === 'glyph';
          const buttonIndex = PIA_CLUSTER_BODY.slice(0, index).filter((element) => element.role === 'glyph').length;
          return (
            <g
              className={detailed && isButton ? 'pia-loader__button' : undefined}
              style={
                detailed && isButton
                  ? {
                      ...animationDelay(buttonIndex),
                      transformOrigin: GLYPH_ORIGINS[buttonIndex],
                    }
                  : undefined
              }
              key={`cluster-${JSON.stringify(glyph)}`}
            >
              <PiaShape element={glyph} className={glyph.role === 'guide' ? 'pia-loader__diamond' : undefined} />
            </g>
          );
        })}
      </g>
      <PiaShape element={PIA_DPAD_CENTER} className="pia-loader__center" />
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
      <PiaLoaderMark size={PIA_LOADER_SIZES[variant]} tone={tone} detailed={variant === 'panel'} />
      {label ? <span className="pia-loader__label">{label}</span> : null}
    </Element>
  );
}

export type { PiaLoaderVariant };

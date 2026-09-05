import type { CSSProperties } from 'react';

import {
  PIA_LOCKUP_SEATS,
  PIA_MARK_VIEWBOX,
  PIA_NAME,
  PIA_DPAD_ENGRAVED,
  piaDpadCut,
  piaMarkElements,
  type PiaLockupName,
  type PiaLockupSeat,
  type PiaMarkElement,
  type PiaMarkPaint,
  type PiaMarkTone,
} from './pia-mark';

function paint(value: PiaMarkPaint | undefined): string | undefined {
  if (!value) return undefined;
  return `var(--pia-mark-${value})`;
}

export function PiaShape({
  element,
  className,
  paintOverride,
  style,
}: {
  element: PiaMarkElement;
  className?: string;
  paintOverride?: PiaMarkPaint;
  style?: CSSProperties;
}) {
  const fill = paint(element.fill ? (paintOverride ?? element.fill) : undefined) ?? 'none';
  const stroke = paint(element.stroke ? (paintOverride ?? element.stroke) : undefined);
  const common = {
    className,
    fill,
    stroke,
    strokeWidth: element.strokeWidth,
    opacity: element.opacity,
    style,
    'data-pia-role': element.role,
  };

  if (element.kind === 'circle') {
    return <circle {...common} cx={element.cx} cy={element.cy} r={element.r} />;
  }
  if (element.kind === 'rect') {
    return (
      <rect {...common} x={element.x} y={element.y} width={element.width} height={element.height} rx={element.rx} />
    );
  }
  return (
    <path
      {...common}
      d={element.d}
      strokeDasharray={element.dash}
      strokeLinecap={element.linecap}
      strokeLinejoin={element.linejoin}
    />
  );
}

export function PiaDrawing({
  elements,
  shapeClassName,
}: {
  elements: readonly PiaMarkElement[];
  shapeClassName?: (element: PiaMarkElement, index: number) => string | undefined;
}) {
  return elements.map((element, index) => (
    <PiaShape element={element} className={shapeClassName?.(element, index)} key={JSON.stringify(element)} />
  ));
}

export function PiaMark({
  size,
  kind = 'dpad',
  tone = 'light',
  className,
  label,
  style,
}: {
  size: number;
  kind?: 'dpad' | 'cluster';
  tone?: PiaMarkTone;
  className?: string;
  label?: string;
  style?: CSSProperties;
}) {
  const cut = kind === 'dpad' ? piaDpadCut(size) : undefined;
  return (
    <svg
      className={`pia-mark pia-mark--${tone} pia-mark--${kind} ${className ?? ''}`.trim()}
      width={size}
      height={size}
      viewBox={`0 0 ${PIA_MARK_VIEWBOX} ${PIA_MARK_VIEWBOX}`}
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={style}
      data-pia-cut={cut}
    >
      <PiaDrawing elements={piaMarkElements(size, kind)} />
    </svg>
  );
}

/**
 * The canonical static Player Insights Agent identity.
 *
 * Unlike the responsive brand mark, an avatar always keeps all four engraved
 * controller glyphs and the ice center, even in compact identity seats. Loading
 * remains the separate animated PiaLoader primitive.
 */
export function PiaAvatar({
  size,
  tone = 'light',
  className,
  label,
  style,
}: {
  size: number;
  tone?: PiaMarkTone;
  className?: string;
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`pia-mark pia-avatar pia-mark--${tone} pia-mark--dpad ${className ?? ''}`.trim()}
      width={size}
      height={size}
      viewBox={`0 0 ${PIA_MARK_VIEWBOX} ${PIA_MARK_VIEWBOX}`}
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={style}
      data-pia-cut="engraved"
      data-pia-static="true"
    >
      <PiaDrawing elements={PIA_DPAD_ENGRAVED} />
    </svg>
  );
}

function wordmarkTone(tone: PiaMarkTone): string {
  return `pia-type--${tone}`;
}

export function PiaWordmark({ tone = 'light', className }: { tone?: PiaMarkTone; className?: string }) {
  return (
    <span className={`pia-wordmark ${wordmarkTone(tone)} ${className ?? ''}`.trim()}>
      Player Insights <span className="pia-accent">Agent</span>
    </span>
  );
}

export function PiaAcronym({ tone = 'light', className }: { tone?: PiaMarkTone; className?: string }) {
  return (
    <span className={`pia-acronym ${wordmarkTone(tone)} ${className ?? ''}`.trim()} aria-label={PIA_NAME}>
      PI<span className="pia-accent">A</span>
    </span>
  );
}

export function PiaTrackedCaption({
  tone = 'light',
  children = PIA_NAME,
  className,
}: {
  tone?: PiaMarkTone;
  children?: string;
  className?: string;
}) {
  return <span className={`pia-caption ${wordmarkTone(tone)} ${className ?? ''}`.trim()}>{children}</span>;
}

function LockupName({ name, tone }: { name: PiaLockupName; tone: PiaMarkTone }) {
  if (name === 'full') return <PiaWordmark tone={tone} />;
  if (name === 'acronym') return <PiaAcronym tone={tone} />;
  return (
    <>
      <PiaWordmark tone={tone} className="pia-lockup__full" />
      <PiaAcronym tone={tone} className="pia-lockup__acronym" />
    </>
  );
}

export function PiaLockup({
  seat = 'header',
  name = seat === 'compact' ? 'acronym' : 'full',
  tone = 'light',
  className,
  id,
  as: Tag = 'span',
}: {
  seat?: PiaLockupSeat;
  name?: PiaLockupName;
  tone?: PiaMarkTone;
  className?: string;
  id?: string;
  as?: 'span' | 'div' | 'h1';
}) {
  const measurements = PIA_LOCKUP_SEATS[seat];
  const style = {
    '--pia-lockup-gap': `${measurements.gap}px`,
    '--pia-lockup-type': `${measurements.type}px`,
  } as CSSProperties;

  return (
    <Tag
      id={id}
      className={`pia-lockup pia-lockup--${seat} pia-lockup--${name} ${className ?? ''}`.trim()}
      style={style}
    >
      <PiaAvatar size={measurements.mark} tone={tone} />
      <LockupName name={name} tone={tone} />
    </Tag>
  );
}

export function PiaEmptyStateMark({
  size = 64,
  tone = 'light',
  className,
  label,
}: {
  size?: number;
  tone?: PiaMarkTone;
  className?: string;
  label?: string;
}) {
  return (
    <PiaMark
      size={size}
      kind="cluster"
      tone={tone}
      className={`pia-empty-mark ${className ?? ''}`.trim()}
      label={label}
    />
  );
}

export type { PiaLockupName, PiaLockupSeat, PiaMarkTone };

/**
 * The mark on screen, and the lockup it leads.
 *
 * The geometry is `astrolabe-mark.ts` and none of it is here: this file turns a
 * list of elements into SVG and decides nothing about the drawing. Two inks are
 * named rather than written -- `ink` and `accent` -- and astrolabe-mark.css
 * resolves them per surface, so the same component is navy-on-white in the top
 * bar, white-on-navy in a dark band, and all-white on the blue button without a
 * second copy of the mark existing anywhere.
 *
 * THE MARK IS ALSO THE AGENT. The orange robot is retired: an agent-decision
 * chip carries the small cut on Ice, and the working loaders flicker through the
 * four concepts rather than lighting up a figure. Where the mark stands for the
 * agent rather than for the app it is still this drawing, because "the thing
 * that answers" and "the thing you opened" are one thing and were only ever
 * drawn as two.
 */
import type { CSSProperties } from 'react';
import {
  LOCKUP_SIZES,
  MARK_VIEWBOX,
  WORDMARK,
  markElements,
  type LockupSeat,
  type MarkConcept,
  type MarkElement,
  type MarkPaint,
} from './astrolabe-mark';

/**
 * Which pair of inks the surface hands the mark.
 *
 * `mono` is not a shade, it is the case where the accent has nowhere to go: on
 * the blue primary button both halves are white, because #6FAEDD on #2272B4 is
 * 1.6:1 and the accent dots simply vanish.
 */
export type MarkInk = 'light' | 'dark' | 'mono';

/** Named in the markup, resolved in the stylesheet. There is no hex in this file. */
function paint(which: MarkPaint | undefined): string | undefined {
  if (!which) return undefined;
  return which === 'ink' ? 'var(--ast-mark-ink)' : 'var(--ast-mark-accent)';
}

function Element({ element, at }: { element: MarkElement; at: number }) {
  if (element.kind === 'group') {
    return (
      <g
        key={at}
        stroke={paint(element.stroke)}
        strokeWidth={element.strokeWidth}
        opacity={element.opacity}
        fill="none"
      >
        {element.children.map((child, index) => (
          <Element element={child} at={index} key={JSON.stringify(child)} />
        ))}
      </g>
    );
  }
  if (element.kind === 'rect') {
    return (
      <rect
        key={at}
        x={element.x}
        y={element.y}
        width={element.width}
        height={element.height}
        rx={element.rx}
        fill={paint(element.fill)}
      />
    );
  }
  if (element.kind === 'path') {
    return (
      <path
        key={at}
        d={element.d}
        fill={paint(element.fill) ?? 'none'}
        stroke={paint(element.stroke)}
        strokeWidth={element.strokeWidth}
        strokeLinecap={element.round ? 'round' : undefined}
        opacity={element.opacity}
      />
    );
  }
  return (
    <circle
      key={at}
      cx={element.cx}
      cy={element.cy}
      r={element.r}
      fill={paint(element.fill) ?? 'none'}
      stroke={paint(element.stroke)}
      strokeWidth={element.strokeWidth}
      strokeDasharray={element.dash}
      opacity={element.opacity}
    />
  );
}

/**
 * The mark at one size.
 *
 * `size` decides the drawing as well as the box: below 32px the graduation ring
 * is dropped and the rim thickens, because the ring at that size renders as a
 * smudge rather than as graduations. That is a property of the mark and not of
 * the caller, so no seating gets to ask for the wrong one.
 *
 * DECORATIVE BY DEFAULT AND THAT IS THE COMMON CASE: in a lockup the wordmark
 * beside it names the app, and a mark announced a second time is noise. A
 * seating where the mark is the ONLY thing identifying what it labels passes a
 * `label`, which is the only way this draws a `<title>`.
 */
export function AstrolabeMark({
  size,
  concept = 'dpad',
  ink = 'light',
  className,
  label,
  style,
  rest,
}: {
  size: number;
  concept?: MarkConcept;
  ink?: MarkInk;
  className?: string;
  label?: string;
  /** The seating's animation timing. A duration is a property of a seating. */
  style?: CSSProperties;
  /**
   * The one mark of a flicker slot that a frozen slot shows. See the
   * reduced-motion guard at the foot of astrolabe-animation.css: CSS cannot
   * choose between four stacked drawings, so the markup says which.
   */
  rest?: boolean;
}) {
  const elements = markElements(size, concept);
  return (
    <svg
      className={`ast-mark ast-mark--${ink} ${className ?? ''}`.trim()}
      width={size}
      height={size}
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={style}
      data-ast-rest={rest ? '' : undefined}
    >
      {elements.map((element, index) => (
        <Element element={element} at={index} key={JSON.stringify(element)} />
      ))}
    </svg>
  );
}

/**
 * Mark plus the wordmark, which is the app's name and renders lowercase.
 *
 * §1: "Lockup: mark + lowercase 'astrolabe', DM Sans 700, -0.01em. Top bar: 22px
 * + 15px. Dark bands: 26px + 17px." The seating is named rather than measured by
 * the caller, and the two pairs are in astrolabe-mark.ts.
 *
 * The wordmark is TYPE, in the app's own face. It is not artwork and there is no
 * file of it, which is what makes the lockup survive a font change and what
 * keeps a logotype out of a repository that publishes publicly.
 */
export function AstrolabeLockup({
  seat = 'bar',
  ink = 'light',
  className,
  id,
  as: Tag = 'span',
}: {
  seat?: LockupSeat;
  ink?: MarkInk;
  className?: string;
  /** For the surfaces where the lockup is what an `aria-labelledby` points at. */
  id?: string;
  /** `h1` where the lockup IS the page's name, a span everywhere else. */
  as?: 'span' | 'div' | 'h1';
}) {
  const { mark, wordmark } = LOCKUP_SIZES[seat];
  return (
    <Tag id={id} className={`ast-lockup ast-lockup--${seat} ${className ?? ''}`.trim()}>
      <AstrolabeMark size={mark} ink={ink} />
      <span className="ast-wordmark" style={{ fontSize: `${wordmark}px` }}>
        {WORDMARK}
      </span>
    </Tag>
  );
}

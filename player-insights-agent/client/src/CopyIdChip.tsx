/**
 * One copy control, used by every chip in the run header that carries an id.
 *
 * The header had two of them written twice over -- the conversation chip and
 * the run-id chip -- and both had the same two defects: the clipboard write was
 * fired and abandoned, so a refusal was silent, and neither said anything when
 * it worked. WHAT IS SHOWN IS NEVER WHAT IS COPIED here (a six-character prefix
 * against a full identifier), which is precisely the case where a reader who is
 * given no confirmation cannot tell a working button from a dead one. They
 * clicked again, and reported it broken.
 *
 * The chip confirms in place: the copy glyph becomes a tick for a moment, and
 * only after the write is known to have landed. A failure leaves the glyph
 * alone rather than lying.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from './copy-id';

export function CopyIdChip({
  value,
  label,
  className,
  title,
  onCopied,
  children,
}: {
  /** The WHOLE id. What the chip renders is `children`. */
  value: string;
  label: string;
  className: string;
  title?: string;
  /** Reported only on a copy that actually happened. */
  onCopied?: () => void;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={className}
      data-copied={copied ? 'true' : undefined}
      title={title}
      aria-label={label}
      aria-live="polite"
      onClick={(event) => {
        // The chips sit inside rows and cards that take clicks of their own;
        // a copy must not also select, navigate or submit.
        event.preventDefault();
        event.stopPropagation();
        void copyToClipboard(value).then((ok) => {
          if (!ok) return;
          onCopied?.();
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {children}
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span className="sr-only">{copied ? 'Copied' : label}</span>
    </button>
  );
}

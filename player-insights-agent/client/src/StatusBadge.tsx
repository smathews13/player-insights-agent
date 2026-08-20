/**
 * The identifier that IS its own status, and the button that hands over the
 * whole of it.
 *
 * The deployment surfaces stopped drawing a value and a chip beside it saying
 * whether the value answered. On a page of eighteen rows that was two columns to
 * read per row and the same word repeated eighteen times down one of them. The
 * value itself carries the verdict instead: the identifier, set in mono inside a
 * green, red or amber wash. One thing to look at, and the colour is a second
 * reading of something the group header above it has already said in words.
 *
 * WHAT IS ON SCREEN AND WHAT IS ON THE CLIPBOARD ARE DIFFERENT ON PURPOSE. A
 * warehouse id, a commit and a client id are all long enough to wreck a row and
 * all useless truncated. So the badge shows what a reader recognises the thing
 * by and the copy button carries the whole value, with the full string in
 * `title` for anybody who only wants to read it.
 */
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { reportEgress } from './egress-policy';

import { astValueBadge } from './astrolabe-pill';
import { BADGE_FAMILY } from './status-badge-state';

/**
 * Which treatment a value takes.
 *
 * `plain` is not a fourth colour: it is the absence of a claim, for a value
 * nothing has checked. A page that tinted those too would be spending colour on
 * every row and teaching a reader that none of it means anything.
 */
export type StatusTone = 'reachable' | 'blocked' | 'drifted' | 'plain';

/**
 * A verdict about a dependency, in the palette's own families.
 *
 * `drifted` is amber and never red, and that is the one entry here worth
 * arguing about: a connection that drifted ANSWERED. Painting it red sends
 * somebody after a GRANT for something a redeploy fixes, and red on this page is
 * reserved for a check that ran and failed.
 *
 * `plain` maps to no chip at all rather than to a sixth family. It is the
 * absence of a claim, for a value nothing checked, and a grey chip there would
 * be a claim: it would put a verdict-shaped element on every row and teach a
 * reader that the shape means nothing.
 */
export function StatusBadge({
  value,
  tone,
  title,
  testId,
}: {
  value: string;
  tone: StatusTone;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      className={astValueBadge(BADGE_FAMILY[tone], 'status-badge')}
      // Kept alongside the family class, because the two answer different
      // questions: the family is how it renders, `data-tone` is what it means.
      // The stylesheet's truncation rules and several tests hang off the latter.
      data-tone={tone}
      data-testid={testId}
      title={title ?? value}
    >
      {value}
    </span>
  );
}

/**
 * An unset value, said rather than left blank.
 *
 * A gap beside a label reads as a bug the reader should report; "not set" is a
 * fact about the deployment. It is deliberately not `0` and not an em dash.
 */
export const NOT_SET = 'not set';

/**
 * The copy affordance: 22px square, icon only, the FULL value.
 *
 * Confirms in place rather than through a toast. The value it copies is never
 * the value on screen, so a reader who is not told it worked has no way to find
 * out short of pasting it somewhere.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={label}
      data-copied={copied ? 'true' : undefined}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        // Every value this button carries is an identifier: a client id, a
        // principal, a commit, a warehouse. None of them is a row and none is a
        // person, which is why that path is permitted by default. Recorded here
        // rather than at the four call sites, so Connections and the identity
        // panel are covered without either being edited.
        reportEgress({ channel: 'identifier', itemCount: 1 });
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Copy className="size-3" aria-hidden="true" />
      <span className="sr-only">{copied ? 'Copied' : label}</span>
    </button>
  );
}

/**
 * "Keep in mind": the caveats under an answer, ranked, tagged, with a fold.
 *
 * A compact box after the one-line provenance sentence. IT MUST KEEP RENDERING:
 * an answer with caveats and no sources still draws this section, because a
 * limitation does not stop mattering when a run cited no table.
 *
 * Its own module because two surfaces draw it -- the answer in Ask PIA and the
 * Final answer tab in the Run Explorer -- and they have to agree. They did not:
 * the Run Explorer showed a past answer's takeaway, prose and source and none of
 * its caveats at all, so the same answer disclosed less the second time anyone
 * read it.
 *
 * The ranking, the deduplication and where the fold falls are all in
 * caveat-priority.ts, which is testable without a renderer. The scope tag and
 * the figures are caveat-emphasis.ts's, for the same reason. What is decided
 * here is only how the parts are drawn.
 *
 * THE FOLD IS DELIBERATE. Three qualifications stay visible and the remainder
 * sit behind "show more". D11 in `bundle/DECISIONS.md` records the fold; the
 * control does not count the hidden bullets.
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from './ui';
import { EntityText } from './DataEntityLinks';
import { mentionedIdentifiers } from './data-entities';
import { caveatScope, emphasiseFigures } from './caveat-emphasis';
import { rankCaveats } from './caveat-priority';
import { caveatSurface } from './caveat-surface';
import { normalizeReaderAnswer } from '../../shared/answer-content-policy';

/**
 * One bullet, rendered whole.
 *
 * The text reaches the document untouched: `emphasiseFigures` cuts it into runs
 * that concatenate back to the caveat exactly, and each non-figure run goes to
 * `EntityText` as it arrived. A renderer that split a caveat on sentence
 * boundaries to win a shorter bullet, or trimmed one to its first clause, would
 * be deciding what a disclosure says from the surface furthest from the
 * reasoning that wrote it.
 *
 * `columns` is computed over the WHOLE caveat rather than per run, so an
 * identifier is recognised from the sentence it appears in rather than from the
 * fragment left either side of a number.
 */
function CaveatBullet({ caveat, sources }: { caveat: string; sources: readonly { name: string }[] }) {
  const scope = caveatScope(caveat, sources);
  const columns = mentionedIdentifiers([caveat]);
  return (
    <li data-surface={caveatSurface(caveat)}>
      {/* The table this caveat is about, in front of the sentence rather than
          buried in it. Only where the caveat names exactly one of the answer's
          own tables; a run-level warning carries no tag. */}
      {scope && <span className="caveat-scope">{scope}</span>}
      {emphasiseFigures(caveat).map((run) =>
        run.figure ? (
          <b key={run.start}>{run.text}</b>
        ) : (
          <EntityText key={run.start} text={run.text} sources={sources} columns={columns} />
        )
      )}
    </li>
  );
}

/**
 * The section, or nothing when the answer had nothing to disclose.
 *
 * Returning nothing matters more here than it looks. An empty amber footer
 * would make "no caveats" and "the caveats were lost" identical on screen,
 * which is the ambiguity that made an earlier report of this panel impossible
 * to settle from a screenshot.
 */
export function KeepInMind({
  caveats,
  sources,
  sql = '',
  limit = 3,
}: {
  caveats: readonly string[];
  /** The tables this answer cited, which is what may be tagged inside a caveat. */
  sources: readonly { name: string }[];
  /** Generated statement, used only to keep validation copy evidence-aware. */
  sql?: string;
  /**
   * How many are shown before the fold. Three is the answer-card specification
   * and both surfaces use it; the parameter exists so a test can state a smaller one
   * without having to write six caveats to reach the interesting case.
   */
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const displayed = normalizeReaderAnswer({ caveats, sources, sql });
  const { top, rest } = rankCaveats(displayed.caveats ?? [], limit);
  if (top.length === 0) return null;

  return (
    <div className="keep-in-mind">
      {/* No colon and no warning glyph. The heading is a label on the list, and
          the amber wash under it is already the whole of the alarm. */}
      <p className="keep-in-mind-heading">Keep in mind</p>
      {/* One list, not two. The hidden bullets are appended to the same `ul`
          when they are shown, so the rules between rows and the indent stay
          continuous and the fold does not read as a second unrelated panel
          opening underneath the first. */}
      <ul className="answer-list keep-in-mind-list">
        {top.map((caveat) => (
          <CaveatBullet caveat={caveat} sources={sources} key={caveat} />
        ))}
        {showAll && rest.map((caveat) => <CaveatBullet caveat={caveat} sources={sources} key={caveat} />)}
      </ul>
      {rest.length > 0 && (
        <Button className="keep-in-mind-toggle" onClick={() => setShowAll((open) => !open)} size="sm" variant="ghost">
          {showAll ? 'show fewer' : 'show more'}
          <ChevronDown className={showAll ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </Button>
      )}
    </div>
  );
}

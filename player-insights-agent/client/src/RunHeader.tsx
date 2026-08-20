/**
 * What sits above the tabs of a run: which run this is, whose it was, how it
 * ended, and what it cost.
 *
 * It was a title with one mono sentence under it -- the full 36-character id,
 * the person and the status joined by middots -- so the four things a reader
 * comes here to check were one string they had to read left to right to find any
 * of them. Every part is its own object now: the id is a chip that copies, the
 * person is a name, the status is the same pill the run list draws, and the run's
 * own figures are pinned to the other end of the line.
 *
 * THE WHOLE ID NEVER RENDERS. It is 36 characters of a value nobody reads -- they
 * compare it, against MLflow or against a ticket -- and at that length it either
 * pushed the person and the status off the line or wrapped the header onto a
 * second row. The chip shows the prefix every other tool in this stack identifies
 * a trace by, and the copy button puts the whole thing on the clipboard, which is
 * the only form in which it was ever wanted.
 *
 * Its own component, and that is a decision about testing rather than about size:
 * RunExplorer fetches its runs, so mounting the page in a test gets a header with
 * nothing selected. Here the run is a prop, and what the header prints for a run
 * with no duration, no call count and no rating can be asserted against a
 * rendered tree.
 */
import { Badge } from './ui';
import { Check, Copy } from 'lucide-react';
import { ratingLabel } from './benchmark-summary';
import { astPill, runHeadline, shortRunId, statusFamily } from './run-header';
import { runLabel } from './run-label';
import { reportEgress } from './egress-policy';
import type { Run } from './app-types';
import { UserIdentityChip } from './UserIdentityChip';

export function RunHeader({
  run,
  title,
  toolCalls,
  reference,
  groundedness,
}: {
  run: Run | null;
  title?: string;
  /** The agent's own call counter, from the trace rather than from the row. */
  toolCalls: number | null;
  reference: boolean;
  groundedness: number | null;
}) {
  const rating = ratingLabel(run?.rating);
  const family = statusFamily(run?.status);
  return (<div className="run-detail-head">
      <div className="min-w-0">
        <h3 className="run-detail-title">{run ? (title ?? runLabel(run)) : 'Select a run'}</h3>
        {/* Only when there is a run to describe. With nothing selected this row
            used to carry "Pick a run from the list to inspect its trace." -- the
            same sentence the empty state below it prints, under a heading that
            already says "Select a run", so one instruction was given three times
            in one column. */}
        {run && (<div className="run-detail-ident">
            <button
              type="button"
              className="run-id-chip"
              onClick={() => {
                void navigator.clipboard?.writeText(run.id);
                // The run is named, because this is the one copy affordance
                // where the thing copied IS the pointer the record would use.
                reportEgress({ channel: 'identifier', runId: run.id, itemCount: 1 });
              }}
              /* The label rather than a title, because a title holding the full
                 id would render it -- as a tooltip, and into the accessibility
                 tree -- which is the one thing this chip exists to avoid. */
              aria-label="Copy the full run id"
            >
              <span className="run-id-short">{shortRunId(run.id)}</span>
              <Copy aria-hidden="true" />
            </button>
            <UserIdentityChip identity={run.stakeholder} compact className="run-detail-user" />
            <Badge variant="outline" className={`run-status-pill ${astPill(run.status)}`}>
              {/* The tick only on the family that earns it. A run that failed does
                  not get a check beside the word "failed", and a status this app
                  does not recognise gets no glyph asserting how it went. */}
              {family === 'pos' && <Check aria-hidden="true" />}
              {run.status ?? 'unknown'}
            </Badge>
            {/* And beside it, not instead of it, exactly as the row in the list
                draws it. The header was the one place a reader could open a run
                the list had marked as cut short and find nothing here saying so
                -- so the fact was true of the row and untrue of the page the row
                opened. `=== true` because an older server does not report it at
                all, and "not reported" is not "ran to the end". */}
            {run.truncated === true && (<Badge variant="outline" className={`run-status-pill ${astPill('truncated')}`}>
                Truncated
              </Badge>
            )}
          </div>
        )}
      </div>
      <div className="run-detail-figures">
        {/* `ast-num` because these are figures in a right-aligned meta slot, which
            is §3's own description of where DM Mono is binding. The rule it
            replaces asked DM Sans for tabular numerals, which that font declares
            no feature for: the declaration read as done and did nothing. */}
        {run && <p className="run-detail-meta ast-num">{runHeadline({
          durationMs: run.duration_ms,
          toolCalls,
          rating: rating.rated ? rating.value : null,
        })}</p>}
        {(reference || groundedness !== null) && (<div className="run-detail-flags">
            {reference && (<Badge variant="outline" className="ast-pill ast-pill--neutral-outline">
                Reference trace
              </Badge>
            )}
            {/* Only benchmark runs measure groundedness. A fixed 94% used to sit
                here on every run, including ones nobody had scored. The score is a
                real proportion of a measured thing, which is what separates it
                from the elapsed figures §5 bars from ever being a percentage. */}
            {groundedness !== null && (<Badge variant="outline" className="ast-pill ast-pill--info">
                Groundedness <span className="ast-num">{Math.round(groundedness * 100)}%</span>
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

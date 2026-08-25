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
import { useState } from 'react';
import { Badge } from './ui';
import { Check, Pencil } from 'lucide-react';
import { ratingLabel } from './benchmark-summary';
import { astPill, shortRunId, statusFamily } from './run-header';
import { runLabel } from './run-label';
import { reportEgress } from './egress-policy';
import type { Run } from './app-types';
import { UserIdentityChip } from './UserIdentityChip';
import { abbreviatedConversationId } from './display-id';
import { CopyIdChip } from './CopyIdChip';
import { RunHeaderLabelEditor } from './RunHeaderLabelEditor';
import {
  persistRunLabels,
  railOutcomeValue,
  railRatingValue,
  type ConversationRunChoice,
  type RailOutcome,
  type RailRating,
  type RunLabelOverride,
} from './run-header-labels';

export function RunHeader({
  run,
  conversationId,
  conversationRun,
  conversationRuns = [],
  toolCalls,
  reference,
  groundedness,
  canEdit = false,
  editing: editingProp,
  onSelectRun,
  onLabelsSaved,
}: {
  run: Run | null;
  conversationId?: string;
  conversationRun?: number;
  conversationRuns?: ConversationRunChoice[];
  /** The agent's own call counter, from the trace rather than from the row. */
  toolCalls: number | null;
  reference: boolean;
  groundedness: number | null;
  /** Administrators only. Consumers never see the pencil. */
  canEdit?: boolean;
  /** Tests open the editor without a click. Live use is the pencil. */
  editing?: boolean;
  onSelectRun?: (runId: string) => void;
  onLabelsSaved?: (overlay: RunLabelOverride) => void;
}) {
  const [editingState, setEditing] = useState(false);
  const editing = editingProp ?? editingState;
  const rating = ratingLabel(run?.rating);
  const displayedStatus = run?.status;
  const family = statusFamily(displayedStatus);

  const saveOverlay = (overlay: RunLabelOverride) => {
    if (!run) return;
    void persistRunLabels(run.id, overlay)
      .then((saved) => onLabelsSaved?.(saved))
      .catch(() => undefined);
  };
  return (
    <div className="run-detail-head">
      <div className="min-w-0">
        <h3 className="run-detail-title">{run ? runLabel(run) : 'Select a run'}</h3>
        {/* Only when there is a run to describe. With nothing selected this row
            used to carry "Pick a run from the list to inspect its trace." -- the
            same sentence the empty state below it prints, under a heading that
            already says "Select a run", so one instruction was given three times
            in one column. */}
        {run && (
          <div className="run-detail-ident">
            {conversationId && (
              /* The id alone. "Conversation" was a word of chrome in front of a
                 value that already reads as one -- `conv-7` says what it is --
                 and it took a third of the chip to repeat the column. */
              <CopyIdChip
                className={`run-context-badge conversation-context-badge ${astPill(displayedStatus)}`}
                value={conversationId}
                title={conversationId}
                label={`Copy full conversation id ${conversationId}`}
              >
                <span className="ast-num">{abbreviatedConversationId(conversationId)}</span>
              </CopyIdChip>
            )}
            {conversationRun !== undefined && (
              <span className="run-context-badge" title={`Run ${conversationRun} in this conversation`}>
                Run <span className="ast-num">{conversationRun}</span>
              </span>
            )}
            {/* The label rather than a title, because a title holding the full
                id would render it -- as a tooltip, and into the accessibility
                tree -- which is the one thing this chip exists to avoid. */}
            <CopyIdChip
              className="run-id-chip"
              value={run.id}
              label="Copy the full run id"
              // The run is named, because this is the one copy affordance where
              // the thing copied IS the pointer the record would use. Reported
              // on the copy that landed, not on the click that attempted one.
              onCopied={() => reportEgress({ channel: 'identifier', runId: run.id, itemCount: 1 })}
            >
              <span className="run-id-short">{shortRunId(run.id)}</span>
            </CopyIdChip>
            {run.stakeholder?.trim() ? (
              <a
                className="run-detail-user-link"
                href={`/monitoring?who=${encodeURIComponent(run.stakeholder)}`}
                aria-label={`Open ${run.stakeholder}'s activity overview`}
              >
                <UserIdentityChip identity={run.stakeholder} compact className="run-detail-user" />
              </a>
            ) : (
              /* An unrecorded identity is still a fact about the run, but it has
                  no Monitoring population to open. Plain text avoids a focusable
                  control whose destination cannot contain what it names. */
              <UserIdentityChip identity={run.stakeholder} compact className="run-detail-user" />
            )}
            <Badge variant="outline" className={`run-status-pill ${astPill(displayedStatus)}`}>
              {/* The tick only on the family that earns it. A run that failed does
                  not get a check beside the word "failed", and a status this app
                  does not recognise gets no glyph asserting how it went. */}
              {family === 'pos' && <Check aria-hidden="true" />}
              {displayedStatus ?? 'unknown'}
            </Badge>
            {typeof toolCalls === 'number' && Number.isFinite(toolCalls) && (
              <Badge variant="outline" className="ast-pill ast-pill--neutral-outline">
                Tools · <span className="ast-num">{toolCalls.toLocaleString()}</span>
              </Badge>
            )}
            <Badge variant="outline" className="ast-pill ast-pill--neutral-outline">
              {rating.rated ? 'Rated' : 'Not rated'}
            </Badge>
            {canEdit && (
              <button
                type="button"
                className="run-header-edit"
                aria-label="Edit run labels"
                aria-expanded={editing}
                onClick={() => setEditing((open) => !open)}
              >
                <Pencil aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {run && canEdit && editing && (
          <RunHeaderLabelEditor
            run={run}
            conversationId={conversationId}
            conversationRuns={conversationRuns}
            toolCalls={toolCalls}
            outcome={railOutcomeValue(displayedStatus)}
            rating={railRatingValue(run.rating)}
            onOutcome={(value: RailOutcome) => saveOverlay({ status: value })}
            onRating={(value: RailRating) => saveOverlay({ rating: value })}
            onSelectRun={onSelectRun}
          />
        )}
      </div>
      <div className="run-detail-figures">
        {/* `ast-num` because these are figures in a right-aligned meta slot, which
            is §3's own description of where DM Mono is binding. The rule it
            replaces asked DM Sans for tabular numerals, which that font declares
            no feature for: the declaration read as done and did nothing. */}
        {run && typeof run.duration_ms === 'number' && Number.isFinite(run.duration_ms) && (
          <p className="run-detail-meta ast-num">{(run.duration_ms / 1000).toFixed(1)}s</p>
        )}
        {(reference || groundedness !== null) && (
          <div className="run-detail-flags">
            {reference && (
              <Badge variant="outline" className="ast-pill ast-pill--neutral-outline">
                Reference trace
              </Badge>
            )}
            {/* Only benchmark runs measure groundedness. A fixed 94% used to sit
                here on every run, including ones nobody had scored. The score is a
                real proportion of a measured thing, which is what separates it
                from the elapsed figures §5 bars from ever being a percentage. */}
            {groundedness !== null && (
              <Badge variant="outline" className="ast-pill ast-pill--info">
                Groundedness <span className="ast-num">{Math.round(groundedness * 100)}%</span>
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

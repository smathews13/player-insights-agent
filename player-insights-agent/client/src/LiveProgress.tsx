/**
 * The run as it happens, in the card that used to hold two empty skeletons.
 *
 * - Nothing is drawn that the run did not report. There is no placeholder row
 *   for a step in flight, because the endpoint has not said which step that is
 *   and a plausible guess beside real rows makes a reader doubt the real ones.
 * - Every step reported is drawn. The rail this replaces subsampled to four
 *   evenly spread stages once a run passed four steps, so a twenty-one step run
 *   showed four of them and silently dropped seventeen: the opposite of what
 *   a live view is for.
 * - The list grows inside Ask's center scroll pane. It never creates a second
 *   vertical viewport inside the live answer card.
 */
import type { CSSProperties } from 'react';
import { Badge } from './ui';

import type { TraceStage } from './answer-shape';
import { PiaMark } from './PiaMark';
import { productForTool } from './brand-icons';
import { BrandIcon } from './BrandIcon';
import { buildLiveRun, type LiveStep } from './live-progress';
import { railTiming, stepNumber } from './agent-map';
import { astPill } from './run-header';
import { formatMs, toolNameFromId } from './trace-timeline';
import { EntityText, TableEntityList } from './InlineEntityText';
import { InlineSqlCode } from './SqlPresentation';

/**
 * One reported step.
 *
 * `newest` marks the frontier of the run rather than a step in flight: every row
 * here has finished, because the endpoint reports a step only once it has, and
 * the panel is on screen only while a question is outstanding. So the last row is
 * where the agent is working, which is what the working colour is for, and the
 * design's mark for it is a 3px left edge on the warm surface. Not a 1px accent
 * border, which is what this row wanted to be and is the one form orange may not
 * take.
 *
 * The indent is a custom property rather than a computed `padding-left`, so the
 * row's own base padding stays in the stylesheet with the rest of its geometry
 * and there is only one place to change it.
 */
function StepKindMark({ step }: { step: LiveStep }) {
  const product = productForTool(toolNameFromId(step.id));
  if (product) {
    return <BrandIcon product={product} size={14} labelled />;
  }
  return <PiaMark size={13} />;
}

function StepRow({
  step,
  number,
  newest,
  elapsedMs,
}: {
  step: LiveStep;
  number: number;
  newest: boolean;
  elapsedMs: number | null;
}) {
  return (
    <li
      className={`live-step ${step.status}${newest ? ' newest' : ''}`}
      style={step.depth ? ({ '--live-depth': step.depth } as CSSProperties) : undefined}
    >
      {/* Kind mark, then the step number, on one row: SQL / Genie / Mosaic /
          the agent's own mark for an LLM turn, then 03. The type chip in the
          header is still the word; this is the same glyph the constellation
          draws on that step. */}
      <span className="live-step-index">
        <span className="live-step-kind" aria-hidden="true">
          <StepKindMark step={step} />
        </span>
        <span className="live-step-icon step-rail-num ast-num" aria-hidden="true">
          {stepNumber(number)}
        </span>
      </span>
      <div className="live-step-body">
        <p className="live-step-head">
          <strong>
            <EntityText text={step.name} sources={step.tables.map((name) => ({ name }))} tools={step.tools} />
          </strong>
          <span className="live-step-type">{step.type}</span>
          {/* A step the endpoint has announced and not reported has no duration,
              and `durationMs` is 0 for that reason -- printing it would put
              "0ms" beside a step that has been running for twenty seconds. The
              same figure the rail counts up is shown instead, from the same
              clock, and the offset into the run is left off: it is the one thing
              here that is not yet a measurement. */}
          <span className="live-step-timing">
            {step.status === 'running' ? (
              railTiming({ duration: step.durationMs, status: step.status }, elapsedMs)
            ) : (
              <>
                {formatMs(step.durationMs)}
                {step.startMs !== null && <> · +{formatMs(step.startMs)} into the run</>}
              </>
            )}
          </span>
          {step.status !== 'complete' && (
            <Badge variant="outline" className={astPill(step.status)}>
              {step.status}
            </Badge>
          )}
        </p>
        {step.detail && (
          <p className="live-step-detail">
            {step.sql && step.detailLead ? (
              <>
                <span className="stage-summary-prefix">{step.detailLead}:</span> <InlineSqlCode sql={step.sql} />
              </>
            ) : (
              <EntityText text={step.detail} sources={step.tables.map((name) => ({ name }))} tools={step.tools} />
            )}
          </p>
        )}
        {step.result && (
          <p className="live-step-result">
            <span>returned</span>{' '}
            <EntityText text={step.result} sources={step.tables.map((name) => ({ name }))} tools={step.tools} />
          </p>
        )}
        {step.tableListing && step.status !== 'running' && (
          <div className="live-step-tables">
            <TableEntityList tables={step.tables} />
          </div>
        )}
      </div>
    </li>
  );
}

export function LiveProgress({
  stages,
  openedAt,
  question,
  elapsedMs = null,
}: {
  stages: TraceStage[];
  /** When the route opened the stream, or null while the request is in flight. */
  openedAt: number | null;
  /**
   * Both accepted and neither read, and they are optional because a caller that
   * has stopped keeping either clock should not have to invent a value to pass.
   * They fed the line under the list that counted the pause since the newest
   * step and explained why the list runs behind the run, which is gone: see
   * `buildLiveRun` for why. They are still declared because Ask PIA holds the
   * two pieces of state and still passes them, and a prop dropped from here
   * before that call site is updated is a build failure rather than a tidy-up.
   */
  lastStageAt?: number | null;
  now?: number;
  question: string;
  /**
   * How long the step in progress has been going, or null when none is.
   *
   * Passed in from the caller's one clock rather than measured here, and null the
   * instant the run ends. Both this panel and the rail read the same number, so
   * the two cannot disagree about how long the reader has been waiting.
   */
  elapsedMs?: number | null;
}) {
  const run = buildLiveRun({ openedAt, stages, question });

  return (
    <div className="live-progress">
      {run.steps.length > 0 && (
        <ol className="live-steps">
          {run.steps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              number={index + 1}
              newest={index === run.steps.length - 1}
              elapsedMs={elapsedMs}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

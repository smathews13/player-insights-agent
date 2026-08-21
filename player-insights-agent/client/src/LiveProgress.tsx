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
 * - The list follows the newest step, since drawing all of them into a bounded
 *   box otherwise leaves the reader watching a stationary window while the run
 *   arrives below the fold. It stops following the moment they scroll up.
 */
import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { Badge } from './ui';
import { FileSearch, Wrench } from 'lucide-react';
import { AstrolabeMark } from './AstrolabeMark';

import type { TraceStage } from './answer-shape';
import { buildLiveRun, nextFollowState, type LiveStep } from './live-progress';
import { railTiming } from './agent-map';
import { formatMs } from './trace-timeline';

function StepIcon({ step }: { step: LiveStep }) {
  // The mark IS the agent, so an agent/llm step carries the same small cut the
  // rail's own agent steps do in TraceDag (`RailMark`), out of the same file at
  // the same 13px. The orange robot is retired, not restyled. Tool steps keep
  // their lucide glyphs.
  if (step.type === 'llm' || step.type === 'agent') return <AstrolabeMark size={13} />;
  if (step.type === 'sql' || step.type === 'plot') return <Wrench />;
  return <FileSearch />;
}

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
function StepRow({ step, newest, elapsedMs }: { step: LiveStep; newest: boolean; elapsedMs: number | null }
) {
  return (<li
      className={`live-step ${step.status}${newest ? ' newest' : ''}`}
      style={step.depth ? ({ '--live-depth': step.depth } as CSSProperties) : undefined}
    >
      <span className="live-step-icon" aria-hidden="true">
        <StepIcon step={step} />
      </span>
      <div className="live-step-body">
        <p className="live-step-head">
          <strong>{step.name}</strong>
          <span className="live-step-type">{step.type}</span>
          {/* A step the endpoint has announced and not reported has no duration,
              and `durationMs` is 0 for that reason -- printing it would put
              "0ms" beside a step that has been running for twenty seconds. The
              same figure the rail counts up is shown instead, from the same
              clock, and the offset into the run is left off: it is the one thing
              here that is not yet a measurement. */}
          <span className="live-step-timing">
            {step.status === 'running' ? (railTiming({ duration: step.durationMs, status: step.status }, elapsedMs)
            ) : (<>
                {formatMs(step.durationMs)}
                {step.startMs !== null && <> · +{formatMs(step.startMs)} into the run</>}
              </>
            )}
          </span>
          {step.status !== 'complete' && <Badge variant="outline">{step.status}</Badge>}
        </p>
        {step.detail && <p className="live-step-detail">{step.detail}</p>}
        {step.result && (<p className="live-step-result">
            <span>returned</span> {step.result}
          </p>
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

  const list = useRef<HTMLOListElement | null>(null);
  /**
   * Whether the reader is still parked on the newest step.
   *
   * Sampled as they scroll rather than measured when a step lands: by then the
   * container has already grown by the new row, so the gap to the bottom
   * reports a reader who never moved as one who scrolled up.
   */
  const following = useRef(true);
  const previousTop = useRef(0);

  const onScroll = useCallback(() => {
    const view = list.current;
    if (!view) return;
    following.current = nextFollowState({ view, previousTop: previousTop.current, following: following.current });
    previousTop.current = view.scrollTop;
  }, []);

  // Keyed on the step count, not on `run`: the elapsed counter above re-renders
  // this several times a second, and following on that would drag the container
  // out from under anyone reading it rather than once per step, when there is
  // something new to see.
  useEffect(() => {
    const view = list.current;
    if (!view || !following.current) return;
    const abrupt = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    view.scrollTo({ top: view.scrollHeight, behavior: abrupt ? 'auto' : 'smooth' });
  }, [run.steps.length]);

  return (<div className="live-progress">
      {run.steps.length > 0 && (<ol className="live-steps" ref={list} onScroll={onScroll}>
          {run.steps.map((step, index) => (<StepRow
              key={step.id}
              step={step}
              newest={index === run.steps.length - 1}
              elapsedMs={elapsedMs}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

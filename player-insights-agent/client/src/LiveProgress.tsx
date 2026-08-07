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
 */
import { Badge } from './ui';
import { Bot, FileSearch, Wrench } from 'lucide-react';

import type { TraceStage } from './answer-shape';
import { buildLiveRun, type LiveStep } from './live-progress';
import { formatMs } from './trace-timeline';

function StepIcon({ step }: { step: LiveStep }) {
  if (step.type === 'llm' || step.type === 'agent') return <Bot />;
  if (step.type === 'sql' || step.type === 'plot') return <Wrench />;
  return <FileSearch />;
}

/**
 * One reported step.
 */
function StepRow({ step }: { step: LiveStep }) {
  return (<li className={`live-step ${step.status}`} style={step.depth ? { marginLeft: `${step.depth * 14}px` } : undefined}>
      <span className="live-step-icon" aria-hidden="true">
        <StepIcon step={step} />
      </span>
      <div className="live-step-body">
        <p className="live-step-head">
          <strong>{step.name}</strong>
          <span className="live-step-type">{step.type}</span>
          <span className="live-step-timing">
            {formatMs(step.durationMs)}
            {step.startMs !== null && <> · started +{formatMs(step.startMs)} into the run</>}
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
  lastStageAt,
  now,
  question,
}: {
  stages: TraceStage[];
  /** When the route opened the stream, or null while the request is in flight. */
  openedAt: number | null;
  /** When the newest stage arrived in the browser, or null before any has. */
  lastStageAt: number | null;
  now: number;
  question: string;
}) {
  const run = buildLiveRun({ openedAt, lastStageAt, now, stages, question });

  return (<div className="live-progress">
      <p className="live-progress-detail">{run.detail}</p>

      {run.steps.length > 0 && (<ol className="live-steps">
          {run.steps.map((step) => (<StepRow key={step.id} step={step} />
          ))}
        </ol>
      )}

      {/* Both lines are measurements, and both disappear when they stop being
          measurable. Nothing here fills a quiet moment with an invented step. */}
      {run.quietMs !== null && run.quietMs > 2_000 && (<p className="live-progress-note">
          Nothing new for {formatMs(run.quietMs)}. The agent reports a step when it finishes it, and steps here have
          taken as long as twenty seconds.
        </p>
      )}
      {run.lag && (<p className="live-progress-note">
          The newest step above ended {formatMs(run.lag.reportedToMs)} into a run that has been open{' '}
          {formatMs(run.lag.openMs)}, so the agent is further along than this list. The endpoint delivers each step
          once the following one is produced.
        </p>
      )}
    </div>
  );
}

import { useId } from 'react';
import type { RuntimeSettings } from '../../shared/runtime-settings';

/**
 * A compact, read-only map of the three loop controls.
 *
 * The tool limit is deliberately labelled "total": the agent admits calls from
 * every reasoning step against one shared counter, while the time budget wraps
 * the whole run and preserves enough of that time to write the answer.
 */
export function RuntimeLoopDiagram({ loop }: { loop: RuntimeSettings['loop'] }) {
  const markerId = useId();
  const titleId = useId();
  const descriptionId = useId();

  return (
    <svg
      className="runtime-loop-diagram"
      viewBox="0 0 380 106"
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={titleId}>Runtime loop limits</title>
      <desc id={descriptionId}>
        An Ask repeats up to {loop.maxSteps} reasoning steps. Those steps may make up to {loop.maxToolCalls} tool calls
        total across the run, then produce an Answer. The {loop.maxRunSeconds} second overall run budget stops gathering
        early enough to write the answer.
      </desc>
      <defs>
        <marker
          id={markerId}
          className="runtime-loop-diagram__arrowhead"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          viewBox="0 0 6 6"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" />
        </marker>
      </defs>

      <rect className="runtime-loop-diagram__budget-frame" x="1" y="1" width="378" height="104" rx="8" />
      <text className="runtime-loop-diagram__budget-label" x="12" y="15">
        {loop.maxRunSeconds}s overall run budget
      </text>

      <path
        className="runtime-loop-diagram__edge"
        d="M 58 53 H 78"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />
      <path
        className="runtime-loop-diagram__edge runtime-loop-diagram__edge--loop"
        d="M 181 45 C 192 36, 200 36, 211 45"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />
      <path
        className="runtime-loop-diagram__edge runtime-loop-diagram__edge--loop"
        d="M 211 62 C 200 71, 192 71, 181 62"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />
      <path
        className="runtime-loop-diagram__edge"
        d="M 299 53 H 320"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />

      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--ask">
        <rect x="10" y="34" width="48" height="38" rx="5" />
        <text x="34" y="57" textAnchor="middle">
          Ask
        </text>
      </g>
      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--agent">
        <rect x="79" y="29" width="102" height="48" rx="5" />
        <path className="runtime-loop-diagram__node-accent" d="M 82 33 V 73" />
        <text x="130" y="49" textAnchor="middle">
          Reasoning step
        </text>
        <text className="runtime-loop-diagram__node-value" x="130" y="66" textAnchor="middle">
          up to {loop.maxSteps}
        </text>
      </g>
      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--tool">
        <rect x="211" y="29" width="88" height="48" rx="5" />
        <path className="runtime-loop-diagram__node-accent" d="M 214 33 V 73" />
        <text x="255" y="49" textAnchor="middle">
          Tool calls
        </text>
        <text className="runtime-loop-diagram__node-value" x="255" y="66" textAnchor="middle">
          up to {loop.maxToolCalls} total
        </text>
      </g>
      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--answer">
        <rect x="320" y="34" width="50" height="38" rx="5" />
        <text x="345" y="57" textAnchor="middle">
          Answer
        </text>
      </g>

      <text className="runtime-loop-diagram__deadline-note" x="190" y="94" textAnchor="middle">
        deadline stops gathering → writes answer
      </text>
    </svg>
  );
}

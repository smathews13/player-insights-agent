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
      viewBox="0 0 420 118"
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={titleId}>Runtime loop limits</title>
      <desc id={descriptionId}>
        An Ask repeats up to {loop.maxSteps} reasoning steps. Those steps may make up to {loop.maxToolCalls} tool calls
        total across the run, then produce an Answer. A run-wide time boundary stops gathering after{' '}
        {loop.maxRunSeconds} seconds and preserves time to write the answer.
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

      <rect className="runtime-loop-diagram__budget-frame" x="1" y="1" width="418" height="116" rx="10" />

      <path
        className="runtime-loop-diagram__edge"
        d="M 62 57 H 87"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />
      <path
        className="runtime-loop-diagram__edge runtime-loop-diagram__edge--loop"
        d="M 200 42 C 214 31, 221 31, 235 42"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />
      <path
        className="runtime-loop-diagram__edge runtime-loop-diagram__edge--loop"
        d="M 235 72 C 221 84, 214 84, 200 72"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />
      <path
        className="runtime-loop-diagram__edge"
        d="M 333 57 H 355"
        markerEnd={`url(#${markerId})`}
        aria-hidden="true"
      />

      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--ask">
        <rect x="12" y="37" width="50" height="40" rx="6" />
        <text x="37" y="61" textAnchor="middle">
          Ask
        </text>
      </g>
      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--agent">
        <rect x="88" y="26" width="112" height="60" rx="6" />
        <path className="runtime-loop-diagram__node-accent" d="M 92 32 V 80" />
        <text x="144" y="51" textAnchor="middle">
          Reasoning step
        </text>
        <text className="runtime-loop-diagram__node-value" x="144" y="70" textAnchor="middle">
          up to {loop.maxSteps}
        </text>
      </g>
      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--tool">
        <rect x="235" y="26" width="98" height="60" rx="6" />
        <path className="runtime-loop-diagram__node-accent" d="M 239 32 V 80" />
        <text x="284" y="51" textAnchor="middle">
          Tool calls
        </text>
        <text className="runtime-loop-diagram__node-value" x="284" y="70" textAnchor="middle">
          up to {loop.maxToolCalls} total
        </text>
      </g>
      <g className="runtime-loop-diagram__node runtime-loop-diagram__node--answer">
        <rect x="356" y="37" width="52" height="40" rx="6" />
        <text x="382" y="61" textAnchor="middle">
          Answer
        </text>
      </g>

      <text className="runtime-loop-diagram__deadline-note" x="210" y="105" textAnchor="middle">
        Stops after {loop.maxRunSeconds}s · then writes the answer
      </text>
    </svg>
  );
}

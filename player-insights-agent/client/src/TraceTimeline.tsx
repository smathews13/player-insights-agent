/**
 * Where a run's time went, as one component for every surface that shows it.
 *
 * `Waterfall`'s geometry is deliberately not carried over. It sized bars with
 * `Math.max(width, 4)` percent, which in a twenty-four second run inflates
 * anything under a second to a bar twelve times too long, and it scaled against
 * `max(start + duration)` rather than the measured envelope. Both surfaces now
 * read positions from `buildTimeline`, which never invents one.
 */
import { useMemo, useState } from 'react';

import type { TraceStage, TraceSummary } from './answer-shape';
import {
  buildTimeline,
  formatMs,
  reconciliationParts,
  type RollUpRow,
  type TimelineRow,
  type ToolType,
} from './trace-timeline';
import { describePayload, payloadSize } from './trace-payload';

/**
 * The word on the chip.
 *
 * Conventional trace vocabulary, so a run reads the way a reader expects.
 * `agent` is the exception: it covers orchestration steps that standard tracing
 * vocabularies have no separate name for.
 */
const TYPE_LABEL: Record<ToolType, string> = {
  llm: 'llm',
  sql: 'sql',
  discovery: 'discovery',
  plot: 'plot',
  clarify: 'clarify',
  agent: 'agent',
  run: 'run',
};

function KindChip({ type }: { type: ToolType }) {
  return (<span className={`trace-chip trace-chip-${type}`}>
      <i aria-hidden="true" />
      {TYPE_LABEL[type]}
    </span>
  );
}

/**
 * The roll-up: recorded time by type.
 */
function RollUp({
  rows,
  hasWallClock,
  externalCalls,
  derivedTypes,
}: {
  rows: RollUpRow[];
  hasWallClock: boolean;
  externalCalls: number | null;
  derivedTypes: boolean;
}) {
  if (rows.length === 0) return null;
  return (<div className="trace-rollup">
      <div className="trace-panel-heading">
        <h4>Where the time went</h4>
        <p>
          Recorded time by type, over every step. Model deliberation is a step here rather than something between
          them, so this reaches wall clock bar the gaps, which the line above names.
        </p>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Tool type</th>
            <th scope="col">Time</th>
            <th scope="col">{hasWallClock ? 'Of wall clock' : ''}</th>
            <th scope="col">Calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (<tr key={row.type}>
              <td>
                <KindChip type={row.type} />
              </td>
              <td className="trace-num">{formatMs(row.totalMs)}</td>
              {/* Blank rather than 0% when there is no envelope to divide by. */}
              <td className="trace-num trace-muted">{row.sharePct === null ? '' : `${Math.round(row.sharePct)}%`}</td>
              <td className="trace-num">
                {row.calls}
                {row.partialCalls > 0 && <em title="ended partial"> · {row.partialCalls} partial</em>}
                {row.failedCalls > 0 && (<em className="trace-failed" title="failed, and not counted in the time column">
                    {' '}
                    · {row.failedCalls} failed {formatMs(row.failedMs)}
                  </em>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="trace-note">
        {derivedTypes && (<>
            The agent records two kinds, <code>agent</code> and <code>tool</code>; the types above are read from the
            recorded tool name on each step, so they re-describe a measurement rather than adding one. Times are the
            recorded durations either way.{' '}
          </>
        )}
        Failed steps are listed beside their type and left out of its total, because time spent failing is not time
        spent doing that work. It is still counted in recorded activity above, since the run did spend it.
        {externalCalls !== null && (<>
            {' '}
            The agent counted <strong>{externalCalls}</strong> external call{externalCalls === 1 ? '' : 's'} this run,
            which is a different quantity from the row count: some calls increment it without producing a row of their
            own.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * A recorded argument or result, laid out according to what it turned out to be.
 */
function PayloadView({ text }: { text: string }) {
  const payload = describePayload(text);
  if (payload.empty) return <span className="trace-empty">(none recorded)</span>;

  const size = payloadSize(payload);
  return (<div className="trace-payload">
      <div className="trace-payload-meta">
        <span>{size}</span>
        {payload.truncated && (<strong
            className="trace-payload-clipped"
            title="the agent reached its own size ceiling while recording this and said so in the text below"
          >
            clipped by the agent
          </strong>
        )}
      </div>
      {payload.fields ? (<ul className="trace-payload-fields">
          {payload.fields.map((field) => (<li key={field.key} className={field.block ? 'block' : ''}>
              <span className="trace-payload-key">{field.key}</span>
              {field.block ? <pre>{field.value}</pre> : <span className="trace-payload-value">{field.value}</span>}
            </li>
          ))}
        </ul>
      ) : (<pre>{payload.body}</pre>
      )}
    </div>
  );
}

/**
 * One row of the Gantt: the label, the bar, and the true duration.
 *
 * The bar is positioned from `leftPct` and `widthPct`, which `buildTimeline`
 * either measured or left null. There is no fallback branch: a row with no
 * position renders an empty track and says so, rather than being placed
 * somewhere plausible.
 */
function GanttRow({
  row,
  expanded,
  onToggle,
  hasGeometry,
  eventCount,
}: {
  row: TimelineRow;
  expanded: boolean;
  onToggle: () => void;
  hasGeometry: boolean;
  /** Steps the envelope spans, shown on the container row. Null when unknown. */
  eventCount: number | null;
}) {
  const positioned = row.leftPct !== null && row.widthPct !== null;
  return (<>
      <tr
        className={`trace-gantt-row ${expanded ? 'expanded' : ''} ${row.container ? 'container' : ''}`}
        onClick={onToggle}
      >
        <td className="trace-step">{row.step}</td>
        <td>
          <KindChip type={row.type} />
        </td>
        <td className="trace-event">
          <button type="button" aria-expanded={expanded}>
            {row.name}
            {row.fanout && (<span
                className="trace-fanout"
                title="requested in the same turn as another call, so it could have run concurrently"
              >
                ⇉
              </span>
            )}
            {row.status !== 'complete' && <span className={`trace-status ${row.status}`}>{row.status}</span>}
          </button>
        </td>
        {hasGeometry && (<td className="trace-track">
            {positioned ? (<i
                className={`trace-bar trace-bar-${row.type} ${row.status}`}
                style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }}
              />
            ) : (// Said, not left blank: a silently empty track reads as a step
              // that took no time rather than one whose start was not recorded.
              <span className="trace-unmeasured">start not recorded</span>
            )}
          </td>
        )}
        <td className="trace-num trace-duration">{formatMs(row.durationMs)}</td>
      </tr>
      {expanded && (<tr className="trace-detail">
          <td colSpan={hasGeometry ? 5 : 4}>
            {row.container ? (<dl>
                <dt>task</dt>
                <dd>{row.input || '(the prompt was not carried with this answer)'}</dd>
                <dt>started</dt>
                <dd>+0ms: the origin every offset below is measured from</dd>
                <dt>wall clock</dt>
                <dd>{formatMs(row.durationMs)}</dd>
                <dt>events</dt>
                <dd>{eventCount === null ? 'the steps below' : `${eventCount} step${eventCount === 1 ? '' : 's'}`}</dd>
                <dt>note</dt>
                <dd>
                  Run envelope, recorded as the agent&rsquo;s own elapsed at the moment the answer was assembled, on
                  the same clock as every offset below. Model time before the first step and after the last is inside
                  it, which is why this row is longer than the steps it spans and why it is left out of the roll-up.
                </dd>
              </dl>
            ) : (<dl>
                <dt>started</dt>
                <dd>{row.startMs === null ? 'not recorded' : `+${formatMs(row.startMs)} into the run`}</dd>
                <dt>took</dt>
                <dd>
                  {formatMs(row.durationMs)}
                  {row.status !== 'complete' && ` · ended ${row.status}`}
                </dd>
                <dt>arguments</dt>
                <dd>
                  <PayloadView text={row.input} />
                </dd>
                <dt>result</dt>
                <dd>
                  <PayloadView text={row.output} />
                </dd>
              </dl>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The Gantt.
 *
 * Rendered as a table because it is one: every row is a labelled record with a
 * duration, and the bar is a column of it. That also makes it readable by a
 * screen reader and selectable as text, neither of which an SVG would be
 * without extra work, and it keeps the deploy budget where it was, since this
 * adds no dependency at all.
 */
function Gantt({ model, expanded, onToggle }: { model: ReturnType<typeof buildTimeline>; expanded: string | null; onToggle: (id: string) => void }) {
  if (model.rows.length === 0) return null;
  return (<div className="trace-gantt">
      <div className="trace-panel-heading">
        <h4>When each step ran</h4>
        <p>Click any row to expand its full arguments and result.</p>
      </div>
      <div className="trace-gantt-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" className="trace-step">
                step
              </th>
              <th scope="col">kind</th>
              <th scope="col">event</th>
              {model.hasGeometry && (<th scope="col" className="trace-axis-head">
                  <span className="trace-axis">
                    {model.ticks.map((tick) => (<b key={tick.label} style={{ left: `${tick.pct}%` }}>
                        {tick.label}
                      </b>
                    ))}
                  </span>
                </th>
              )}
              <th scope="col" className="trace-num">
                duration
              </th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (<GanttRow
                key={row.id}
                row={row}
                hasGeometry={model.hasGeometry}
                expanded={expanded === row.id}
                onToggle={() => onToggle(row.id)}
                eventCount={model.rows.filter((other) => !other.container).length}
              />
            ))}
          </tbody>
        </table>
      </div>
      <TimelineNotes model={model} />
    </div>
  );
}

/**
 * The notes under the chart, which matter as much as the chart.
 *
 * Each one is conditional on what the data actually shows. The serial claim in
 * particular is a measurement here rather than a promise: `overlappingRows`
 * counts rows that overlap, so if a future change made two steps genuinely
 * concurrent, or turned a step row into a container charged for its children,
 * this paragraph would stop asserting otherwise on its own.
 */
function TimelineNotes({ model }: { model: ReturnType<typeof buildTimeline> }) {
  return (<>
      {model.hasGeometry && (<p className="trace-note">
          Geometry is read directly from recorded timestamps, bar left edges and widths are exact. Bars thinner than
          2px are widened to 2px for visibility (right edge only); the duration column is always the true value. The
          run envelope is excluded from the roll-up because its time is the sum of everything inside it.
          {model.originIsRebased && (<> Offsets are measured from the first recorded step, because this run reported an absolute clock.</>
          )}
        </p>
      )}
      <p className="trace-note">
        {model.overlappingRows === 0 ? (<>
            No two rows overlap, which is what a serial run looks like: the agent loop runs its tool calls in a plain
            loop of blocking calls, so nothing here could have overlapped and nothing is drawn as if it did. Step rows
            close when the model returns, before their tool calls run, so a step and the calls beneath it are never
            charged for the same milliseconds.
          </>
        ) : (<>
            {model.overlappingRows} row{model.overlappingRows === 1 ? '' : 's'} overlap another in time. The agent loop
            is serial, so this is a property of the recording rather than of the run, most likely a step measured as
            enclosing the calls made inside it, which would also mean the roll-up counts those milliseconds twice.
            Reported rather than smoothed over.
          </>
        )}
      </p>
      {model.unsettledRows > 0 && (<p className="trace-note">
          {model.unsettledRows} step{model.unsettledRows === 1 ? '' : 's'} did not finish cleanly and{' '}
          {model.unsettledRows === 1 ? 'is' : 'are'} drawn hatched rather than solid, most often the run reaching its
          step budget with work still outstanding. The time is still charged to it, because the run really spent it, so
          the roll-up and the header above continue to reconcile.
        </p>
      )}
      {model.failedRows > 0 && (<p className="trace-note">
          {model.failedRows} step{model.failedRows === 1 ? '' : 's'} failed. Their time is listed beside their type but
          left out of its total, since time spent failing is not time spent doing that work.
        </p>
      )}
      {model.concurrency.length > 0 && (<p className="trace-note">
          {model.concurrency.length} turn{model.concurrency.length === 1 ? '' : 's'} requested more than one tool call
          at once; those rows are marked ⇉. Running each such group concurrently would have saved up to{' '}
          <strong>{formatMs(model.concurrencySavingMs)}</strong>. That is a flag on a missed opportunity, not a claim
          that anything ran in parallel. They ran one after another, as drawn.
        </p>
      )}
    </>
  );
}

export function TraceTimeline({
  trace,
  question = '',
  afterPlanApproval = false,
  className = '',
}: {
  trace: TraceSummary | { stages: TraceStage[]; totalMs?: number; toolCalls?: number } | null | undefined;
  /** The run's own prompt, shown on the envelope row. Display text, not a measurement. */
  question?: string;
  /**
   * Whether this answer followed a plan the user approved.
   *
   * The plan turn is a separate message with no trace and no run, so the time
   * spent proposing it and waiting for approval is outside `totalMs` and cannot
   * be recovered. Half the seeded conversations are like this, and for them the
   * chart is honestly shorter than the wall clock the reader remembers sitting
   * through. Better to say so than to let them find it.
   */
  afterPlanApproval?: boolean;
  className?: string;
}) {
  const summary = (trace ?? null) as TraceSummary | null;
  const model = useMemo(() => buildTimeline(summary, question), [summary, question]);
  // One row open at a time. The rows carry whole SQL statements and whole tool
  // results now that the contract no longer truncates them, and several open at
  // once buries the chart they are meant to explain.
  const [expanded, setExpanded] = useState<string | null>(null);

  if (model.rows.length === 0) {
    return <p className="trace-note">This run recorded no steps, so there is no timing to break down.</p>;
  }

  const externalCalls =
    typeof summary?.toolCalls === 'number' && Number.isFinite(summary.toolCalls) ? summary.toolCalls : null;
  // Whether any row was classified past the two kinds the agent records, which
  // is what the caption about derived types is warning about.
  const derivedTypes = model.rollUp.some((row) => row.type !== 'agent');

  return (<div className={`trace-timeline ${className}`.trim()}>
      <p className="trace-reconciliation">{reconciliationParts(model).join(' · ')}</p>
      <RollUp
        rows={model.rollUp}
        hasWallClock={model.wallClockMs !== null}
        externalCalls={externalCalls}
        derivedTypes={derivedTypes}
      />
      <Gantt
        model={model}
        expanded={expanded}
        onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
      />
      {afterPlanApproval && (<p className="trace-note">
          This answer followed a plan you approved. Proposing that plan and waiting for your approval happened in a
          separate turn that records no trace, so none of that time is in the figures above: the run measured here
          starts when you approved. Expect this chart to be shorter than the time you spent at the screen.
        </p>
      )}
    </div>
  );
}

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
import { ChevronDown } from 'lucide-react';

import type { TraceStage, TraceSummary } from './answer-shape';
import { buildTimeline, formatMs, toolNameFromId, type RollUpRow, type TimelineRow, type ToolType } from './trace-timeline';
import type { RunVerdict } from '../../shared/run-verdict';
import { describePayload, payloadSize } from './trace-payload';
import { BrandIcon } from './BrandIcon';
import { productForTool } from './brand-icons';
import { stepNumber } from './agent-map';
import { Badge } from './ui';
import { MarkdownText } from './StepResult';

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

/**
 * The kind, as the app's neutral chip.
 *
 * It used to carry a coloured dot as well, one hue per kind, so that the kinds did
 * not depend on the label alone. That was the right instinct and the wrong axis:
 * the label was always what a reader used, and the seven hues had to be drawn from
 * whatever the palette had spare, which after the revamp meant the evaluation
 * colour marking every model turn. The word does the work; the chip is neutral, and
 * the RUN envelope gets the outline variant because it is not a kind of step.
 */
function KindChip({ type }: { type: ToolType }) {
  return <span className={`trace-chip trace-chip-${type}`}>{TYPE_LABEL[type]}</span>;
}

/**
 * The Kind cell of a step row: the product's mark where the step called one, and
 * the word chip where it did not.
 *
 * The mark REPLACES the tag here rather than sitting beside it, which is the one
 * place in the application that happens, and the handoff asks for it by name.
 * The reason it is safe here and nowhere else is the column to the right: the
 * event is named in words on the same row -- "Queried governed data", "Checked
 * field definitions" -- so the chip's `sql` or `discovery` was the coarser of
 * two labels for one thing, and the mark is finer than either. It says WHICH
 * product, where `discovery` covered Genie, Unity Catalog and Mosaic AI at once.
 *
 * Model turns and the run envelope keep their tag, because neither is a call on
 * a product, and so does any tool nobody has filed yet: `productForTool` returns
 * null for it and the row falls back rather than picking a mark that fits.
 *
 * The roll-up above the table keeps the word chips whatever this does. Its tiles
 * are per TYPE, and a type is not a product -- `discovery` is three of them --
 * so a mark up there would be a claim the tile cannot support.
 */
function KindCell({ row }: { row: TimelineRow }) {
  const product = productForTool(toolNameFromId(row.id));
  // `labelled`, unusually: everywhere else the mark sits against the product's
  // own name and a title would read it out twice. This cell has no text of its
  // own once the tag is gone, and the event beside it is the STEP's name rather
  // than the product's.
  if (product) return <BrandIcon product={product} size={14} labelled />;
  return <KindChip type={row.type} />;
}

/**
 * The roll-up: recorded time by type, one tile per type.
 *
 * A tile rather than a table row because these numbers are read at a glance and
 * compared against each other, not scanned down a column. Each tile carries the
 * time, its share of wall clock and the call count, which is every column the
 * table it replaced had.
 */
function RollUp({ rows }: { rows: RollUpRow[] }) {
  if (rows.length === 0) return null;
  return (<div className="trace-rollup">
      <div className="trace-panel-heading">
        <h4>Time by tool type</h4>
      </div>
      <div className="trace-kpis">
        {rows.map((row) => (<div key={row.type} className="trace-kpi">
            <div className="trace-kpi-head">
              <KindChip type={row.type} />
              <Badge variant="outline" className="trace-call-badge ast-num">
                {row.calls} call{row.calls === 1 ? '' : 's'}
                {row.partialCalls > 0 && ` · ${row.partialCalls} partial`}
              </Badge>
            </div>
            {/* `ast-num` on the tile's value and on its meta line, because §3 names
                a stat value and a meta slot as two of the four places DM Mono is
                binding. Both rules used to ask DM Sans for `tabular-nums`, which
                that font declares no feature for: the declaration read as done and
                the column of tile values never lined up. */}
            <strong className="ast-num">{formatMs(row.totalMs)}</strong>
            <span className="trace-kpi-meta ast-num">
              {/* Omitted rather than shown as 0% when there is no envelope to
                  divide by. */}
              {row.sharePct !== null && (<span className="trace-kpi-share">{Math.round(row.sharePct)}% of wall clock</span>
              )}
              {row.failedCalls > 0 && (<em
                  className="trace-failed"
                  title="failed: counted in recorded activity, left out of the time above, because time spent failing is not time spent doing that work"
                >
                  {row.failedCalls} failed {formatMs(row.failedMs)}
                </em>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A recorded argument or result, laid out according to what it turned out to be.
 */
export function PayloadView({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const payload = describePayload(text);
  if (payload.empty) return <span className="trace-empty">(none recorded)</span>;

  const size = payloadSize(payload);
  return (<div className="trace-payload">
      <div className="trace-payload-meta ast-num">
        <span>{size}</span>
        {payload.truncated && (<strong
            className="trace-payload-clipped"
            title="the agent reached its own size ceiling while recording this and said so in the text below"
          >
            clipped by the agent
          </strong>
        )}
        <span className="trace-payload-seg" role="group" aria-label="How to show this payload">
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>Rendered</button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
        </span>
      </div>
      {raw ? (<pre>{payload.body}</pre>
      ) : payload.fields ? (<ul className="trace-payload-fields">
          {payload.fields.map((field) => (<li key={field.key} className={field.block ? 'block' : ''}>
              <span className="trace-payload-key">{field.key}</span>
              {field.block
                ? field.key === 'sql' || field.key === 'query'
                  ? <pre>{field.value}</pre>
                  : <MarkdownText text={field.value} />
                : <span className="trace-payload-value">{field.value}</span>}
            </li>
          ))}
        </ul>
      ) : (<MarkdownText text={payload.body} />
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
        {/* The data cell takes the mono face; its column heading does not, because
            the heading is the word "Step" and only the figures under it have to
            line up with each other. */}
        <td className="trace-step ast-num">
          {/* Matches the numbered step badge in Run Explorer's Agent map and
              the live list, so the settled timeline keeps the same visual key. */}
          <span className="step-rail-num" aria-hidden="true">
            {stepNumber(row.step)}
          </span>
          <span className="sr-only">Step {row.step}</span>
        </td>
        <td>
          <KindCell row={row} />
        </td>
        <td className="trace-event">
          <button type="button" aria-expanded={expanded}>
            {row.name}
            {/* Inside the cell that names the row rather than in a column of its
                own: a column of chevrons is a column of the same glyph, and the
                thing being opened is the event. */}
            <ChevronDown aria-hidden="true" />
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
        <td className="trace-num trace-duration ast-num">{formatMs(row.durationMs)}</td>
      </tr>
      {expanded && (<tr className="trace-detail">
          {/* The empty first cell keeps the definition grid aligned under the event
              it belongs to rather than under the step number. */}
          <td />
          <td colSpan={hasGeometry ? 4 : 3}>
            {row.container ? (<dl>
                <dt>Task</dt>
                <dd>{row.input || '(the prompt was not carried with this answer)'}</dd>
                <dt>Started</dt>
                <dd className="trace-measured">+0ms: the origin every offset below is measured from</dd>
                <dt>Wall clock</dt>
                <dd className="trace-measured">{formatMs(row.durationMs)}</dd>
                <dt>Events</dt>
                <dd>{eventCount === null ? 'the steps below' : `${eventCount} step${eventCount === 1 ? '' : 's'}`}</dd>
                <dt>Note</dt>
                <dd>
                  Run envelope, recorded as the agent&rsquo;s own elapsed at the moment the answer was assembled, on
                  the same clock as every offset below. Model time before the first step and after the last is inside
                  it, which is why this row is longer than the steps it spans and why it is left out of the roll-up.
                </dd>
              </dl>
            ) : (<dl>
                <dt>Started</dt>
                {/* In words when it is absent. A dash here would read as a start of
                    zero, which is a different claim about the same blank. */}
                <dd className="trace-measured">
                  {row.startMs === null ? 'not recorded' : `+${formatMs(row.startMs)} into the run`}
                </dd>
                <dt>Took</dt>
                <dd className="trace-measured">
                  {formatMs(row.durationMs)}
                  {row.status !== 'complete' && ` · ended ${row.status}`}
                </dd>
                <dt>Arguments</dt>
                <dd>
                  <PayloadView text={row.input} />
                </dd>
                <dt>Result</dt>
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
      {/* At the head of the steps rather than in a section above them: the tiles
          are the summary of this listing, and stacked separately they were one
          more block to scroll past before reaching it. */}
      <RollUp rows={model.rollUp} />
      <div className="trace-panel-heading">
        <h4>Step timeline</h4>
      </div>
      <div className="trace-gantt-scroll">
        <table>
          <thead>
            <tr>
              {/* Headed with the symbol the design gives it, which is what the
                  column holds and what fits the width the numbers need. The word is
                  kept for anything reading the header rather than looking at it. */}
              <th scope="col" className="trace-step">
                <span aria-hidden="true">#</span>
                <span className="sr-only">Step</span>
              </th>
              <th scope="col">Kind</th>
              <th scope="col">Event</th>
              {model.hasGeometry && (<th scope="col" className="trace-axis-head">
                  {/* The ticks sit in this cell so that they and the bars below
                      share one coordinate space by construction. The column still
                      needs a name of its own: with only the ticks in here, a screen
                      reader announced the bar column by position and nothing else. */}
                  <span className="trace-axis-label">Timeline</span>
                  <span className="trace-axis">
                    {model.ticks.map((tick) => (<b key={tick.label} style={{ left: `${tick.pct}%` }}>
                        {tick.label}
                      </b>
                    ))}
                  </span>
                </th>
              )}
              <th scope="col" className="trace-num">
                Duration
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
    </div>
  );
}

/**
 * No notes under the chart.
 *
 * There used to be five, and they were all about the drawing rather than about
 * the run: how thin bars are widened, which turns could in principle have run
 * concurrently and what that would have saved, that a plan turn records no
 * trace. A reader wants to know where the time went, and a caveat about the
 * rendering is not that. The measurements the last three read are still taken
 * where something real uses them: failed time is reported per type in the
 * roll-up, and an unfinished step is drawn hatched and labelled on its own row.
 */
export function TraceTimeline({
  trace,
  question = '',
  verdict,
  className = '',
}: {
  trace: TraceSummary | { stages: TraceStage[]; totalMs?: number; toolCalls?: number } | null | undefined;
  /** The run's own prompt, shown on the envelope row. Display text, not a measurement. */
  question?: string;
  /**
   * The run's answer status. When Complete, "Prepared the answer" stored as
   * native PARTIAL (optional DSF clip on a finished listing) is shown Complete.
   */
  verdict?: RunVerdict;
  className?: string;
}) {
  const summary = (trace ?? null) as TraceSummary | null;
  const model = useMemo(() => buildTimeline(summary, question, verdict), [summary, question, verdict]);
  // One row open at a time. The rows carry whole SQL statements and whole tool
  // results now that the contract no longer truncates them, and several open at
  // once buries the chart they are meant to explain.
  const [expanded, setExpanded] = useState<string | null>(null);

  if (model.rows.length === 0) {
    return <p className="trace-note">This run recorded no steps, so there is no timing to break down.</p>;
  }

  return (<div className={`trace-timeline ${className}`.trim()}>
      <Gantt
        model={model}
        expanded={expanded}
        onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
      />
    </div>
  );
}

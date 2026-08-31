/**
 * Where a run's time went, as one component for every surface that shows it.
 *
 * `Waterfall`'s geometry is deliberately not carried over. It sized bars with
 * `Math.max(width, 4)` percent, which in a twenty-four second run inflates
 * anything under a second to a bar twelve times too long, and it scaled against
 * `max(start + duration)` rather than the measured envelope. Both surfaces now
 * read positions from `buildTimeline`, which never invents one.
 *
 * Two presentations share the same geometry:
 * - default — Ask's live / settled process: neutral chips, product marks on
 *   tool rows, stakeholder stage names.
 * - explorer — Run Explorer Timeline only: notebook-style kind pills, event
 *   labels (`run - [orchestrator]`, `model call … turn N`, tool + payload),
 *   and bars coloured by kind. Ask must not inherit that look.
 */
import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import type { TraceStage, TraceSummary } from './answer-shape';
import {
  buildTimeline,
  explorerEventLabel,
  formatMs,
  llmTurnByRowId,
  toolNameFromId,
  type RollUpRow,
  type TimelineRow,
  type ToolType,
} from './trace-timeline';
import type { RunVerdict } from '../../shared/run-verdict';
import { describePayload, payloadSize, type Payload } from './trace-payload';
import { BrandIcon } from './BrandIcon';
import { productForTool } from './brand-icons';
import { stepNumber } from './agent-map';
import { Badge } from './ui';
import { MarkdownText, StructuredTableResultView } from './StepResult';
import { structuredTableResult } from './step-results';
import { EntityText, TableEntityList } from './DataEntityLinks';
import { isTableListingStage, stageTableEntities, stageToolNames } from './live-progress';
import { InlineSqlCode, SqlCodeBlocks } from './SqlPresentation';
import { isSqlText, sqlFromStageInput } from './sql-presentation';

/** Which surface is drawing the panel. See file header. */
export type TraceTimelineVariant = 'default' | 'explorer';

/** The byte-for-byte sanitized payload shown only after the reader chooses Raw. */
export function RawPayload({ payload }: { payload: Payload }) {
  return <pre>{payload.body}</pre>;
}

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
 * The kind, as the app's neutral chip (Ask) or a coloured pill (Explorer).
 *
 * Colour lives only under `.trace-timeline--explorer` in the stylesheet, so the
 * default surface keeps the single neutral chip the revamp settled on.
 */
function KindChip({ type }: { type: ToolType }) {
  return <span className={`trace-chip trace-chip-${type}`}>{TYPE_LABEL[type]}</span>;
}

/**
 * The Kind cell of a step row.
 *
 * On Ask, the product's mark replaces the tag for classified tools. On Run
 * Explorer the notebook viz wants the kind word itself (coloured), so marks
 * stay off that surface.
 */
function KindCell({ row, variant }: { row: TimelineRow; variant: TraceTimelineVariant }) {
  if (variant === 'explorer') return <KindChip type={row.type} />;
  const product = productForTool(toolNameFromId(row.id));
  // `labelled`, unusually: everywhere else the mark sits against the product's
  // own name and a title would read it out twice. This cell has no text of its
  // own once the tag is gone, and the event beside it is the STEP's name rather
  // than the product's.
  if (product) return <BrandIcon product={product} size={14} labelled />;
  return <KindChip type={row.type} />;
}

/**
 * The roll-up on Ask: recorded time by type, one tile per type.
 */
function RollUp({ rows }: { rows: RollUpRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="trace-rollup">
      <div className="trace-panel-heading">
        <h4>Time by tool type</h4>
      </div>
      <div className="trace-kpis">
        {rows.map((row) => (
          <div key={row.type} className="trace-kpi">
            <div className="trace-kpi-head">
              <KindChip type={row.type} />
              <Badge variant="outline" className="trace-call-badge ast-num">
                {row.calls} call{row.calls === 1 ? '' : 's'}
                {row.partialCalls > 0 && ` · ${row.partialCalls} partial`}
              </Badge>
            </div>
            <strong className="ast-num">{formatMs(row.totalMs)}</strong>
            <span className="trace-kpi-meta ast-num">
              {row.sharePct !== null && (
                <span className="trace-kpi-share">{Math.round(row.sharePct)}% of wall clock</span>
              )}
              {row.failedCalls > 0 && (
                <em
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
 * Explorer's kind totals as compact KPI badges above the table.
 *
 * Same `model.rollUp` rows and denominators as Ask's tiles. The run envelope is
 * already omitted from that list, so wall clock is not counted twice.
 */
function KindKpis({ rows }: { rows: RollUpRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="trace-kind-kpis" aria-label="Time by kind">
      {rows.map((row) => (
        <div
          key={row.type}
          className="trace-kpi"
          title={
            row.failedCalls > 0
              ? `${row.failedCalls} failed: counted in recorded activity, left out of the time above`
              : undefined
          }
        >
          <KindChip type={row.type} />
          <strong className="ast-num">{formatMs(row.totalMs)}</strong>
        </div>
      ))}
    </div>
  );
}

/**
 * A recorded argument or result, laid out according to what it turned out to be.
 */
export function PayloadView({
  text,
  tables = [],
  tableListing = false,
  label,
}: {
  text: string;
  tables?: readonly string[];
  tableListing?: boolean;
  /** Names the independently switchable pane that owns this payload. */
  label?: string;
}) {
  const [raw, setRaw] = useState(false);
  const payload = describePayload(text);
  if (payload.empty) {
    const empty = tableListing ? (
      <TableEntityList tables={tables} />
    ) : (
      <span className="trace-empty">(none recorded)</span>
    );
    if (!label) return empty;
    return (
      <section className="trace-payload trace-payload--pane" aria-label={`${label} payload`}>
        <header className="trace-payload-head">
          <strong className="trace-payload-label">{label}</strong>
        </header>
        <div className="trace-payload-body">{empty}</div>
      </section>
    );
  }

  const size = payloadSize(payload);
  const tableResult = structuredTableResult(payload.body);
  return (
    <section
      className={`trace-payload${label ? ' trace-payload--pane' : ''}`}
      aria-label={label ? `${label} payload` : undefined}
    >
      <header className="trace-payload-head">
        {label && <strong className="trace-payload-label">{label}</strong>}
        <span className="trace-payload-actions ast-num">
          <span className="trace-payload-size">{size}</span>
          {payload.truncated && (
            <strong
              className="trace-payload-clipped"
              title="the agent reached its own size ceiling while recording this and said so in the text below"
            >
              clipped by the agent
            </strong>
          )}
          <span
            className="trace-payload-seg"
            role="group"
            aria-label={label ? `How to show ${label.toLowerCase()}` : 'How to show this payload'}
          >
            <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
              Rendered
            </button>
            <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
              Raw
            </button>
          </span>
        </span>
      </header>
      <div className="trace-payload-body">
        {raw ? (
          <RawPayload payload={payload} />
        ) : tableResult ? (
          <StructuredTableResultView result={tableResult} />
        ) : tableListing ? (
          <TableEntityList tables={tables} />
        ) : payload.fields ? (
          <ul className="trace-payload-fields">
            {payload.fields.map((field) => {
              const sqlField = field.key === 'sql' || (field.key === 'query' && isSqlText(field.value));
              return (
                <li key={field.key} className={field.block || sqlField ? 'block' : ''}>
                  <span className="trace-payload-key">{field.key}</span>
                  {sqlField ? (
                    <SqlCodeBlocks sql={field.value} className="trace-payload-sql" tables={tables} />
                  ) : field.block ? (
                    <MarkdownText text={field.value} tables={tables} />
                  ) : (
                    <span className="trace-payload-value">
                      <EntityText text={field.value} sources={tables.map((name) => ({ name }))} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <MarkdownText text={payload.body} tables={tables} />
        )}
      </div>
    </section>
  );
}

function EventSummary({
  row,
  eventLabel,
  variant,
  sources,
  tools,
}: {
  row: TimelineRow;
  eventLabel: string;
  variant: TraceTimelineVariant;
  sources: { name: string }[];
  tools: string[];
}) {
  const tool = toolNameFromId(row.id);
  const sql = variant === 'explorer' && tool === 'run_sql' ? sqlFromStageInput(row.input) : '';
  if (sql) {
    return (
      <>
        <EntityText text={tool} sources={sources} tools={[tool]} /> <InlineSqlCode sql={sql} limit={52} />
      </>
    );
  }
  return <EntityText text={eventLabel} sources={sources} tools={tools} />;
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
  eventLabel,
  variant,
  expanded,
  onToggle,
  hasGeometry,
  eventCount,
}: {
  row: TimelineRow;
  eventLabel: string;
  variant: TraceTimelineVariant;
  expanded: boolean;
  onToggle: () => void;
  hasGeometry: boolean;
  /** Steps the envelope spans, shown on the container row. Null when unknown. */
  eventCount: number | null;
}) {
  const positioned = row.leftPct !== null && row.widthPct !== null;
  const tables = stageTableEntities(row);
  const tableListing = isTableListingStage(row);
  const sources = tables.map((name) => ({ name }));
  const tools = stageToolNames(row);
  return (
    <>
      <tr
        className={`trace-gantt-row ${expanded ? 'expanded' : ''} ${row.container ? 'container' : ''}`}
        onClick={onToggle}
      >
        <td className="trace-step ast-num">
          <span className="step-rail-num" aria-hidden="true">
            {stepNumber(row.step)}
          </span>
          <span className="sr-only">Step {row.step}</span>
        </td>
        <td>
          <KindCell row={row} variant={variant} />
        </td>
        <td className="trace-event">
          <button type="button" aria-expanded={expanded}>
            <span
              className="trace-event-label"
              title={variant === 'explorer' && toolNameFromId(row.id) === 'run_sql' ? undefined : eventLabel}
            >
              <EventSummary row={row} eventLabel={eventLabel} variant={variant} sources={sources} tools={tools} />
            </span>
            <ChevronDown aria-hidden="true" />
            {row.status !== 'complete' && <span className={`trace-status ${row.status}`}>{row.status}</span>}
          </button>
        </td>
        {hasGeometry && (
          <td className="trace-track">
            {positioned ? (
              <i
                className={`trace-bar trace-bar-${row.type} ${row.status}`}
                style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }}
              />
            ) : (
              <span className="trace-unmeasured">start not recorded</span>
            )}
          </td>
        )}
        <td className="trace-num trace-duration ast-num">{formatMs(row.durationMs)}</td>
      </tr>
      {expanded && (
        <tr className="trace-detail">
          <td />
          <td colSpan={hasGeometry ? 4 : 3}>
            {row.container ? (
              <dl>
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
                  Run envelope, recorded as the agent&rsquo;s own elapsed at the moment the answer was assembled, on the
                  same clock as every offset below. Model time before the first step and after the last is inside it,
                  which is why this row is longer than the steps it spans and why it is left out of the roll-up.
                </dd>
              </dl>
            ) : (
              <div className="trace-detail-content">
                <dl>
                  <dt>Started</dt>
                  <dd className="trace-measured">
                    {row.startMs === null ? 'not recorded' : `+${formatMs(row.startMs)} into the run`}
                  </dd>
                  <dt>Took</dt>
                  <dd className="trace-measured">
                    {formatMs(row.durationMs)}
                    {row.status !== 'complete' && ` · ended ${row.status}`}
                  </dd>
                </dl>
                <div className="trace-detail-payloads">
                  <PayloadView label="Arguments" text={row.input} tables={tables} />
                  <PayloadView label="Result" text={row.output} tables={tables} tableListing={tableListing} />
                </div>
              </div>
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
 * duration, and the bar is a column of it.
 */
function Gantt({
  model,
  variant,
  eventLabels,
  expanded,
  onToggle,
}: {
  model: ReturnType<typeof buildTimeline>;
  variant: TraceTimelineVariant;
  eventLabels: ReadonlyMap<string, string>;
  expanded: string | null;
  onToggle: (id: string) => void;
}) {
  if (model.rows.length === 0) return null;
  const explorer = variant === 'explorer';
  return (
    <div className="trace-gantt">
      {explorer ? <KindKpis rows={model.rollUp} /> : <RollUp rows={model.rollUp} />}
      {!explorer && (
        <div className="trace-panel-heading">
          <h4>Step timeline</h4>
        </div>
      )}
      <div className="trace-gantt-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" className="trace-step">
                <span aria-hidden="true">#</span>
                <span className="sr-only">Step</span>
              </th>
              <th scope="col">Kind</th>
              <th scope="col">Event</th>
              {model.hasGeometry && (
                <th scope="col" className="trace-axis-head">
                  <span className="trace-axis-label">Timeline</span>
                  <span className="trace-axis">
                    {model.ticks.map((tick) => (
                      <b key={tick.label} style={{ left: `${tick.pct}%` }}>
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
            {model.rows.map((row) => (
              <GanttRow
                key={row.id}
                row={row}
                eventLabel={eventLabels.get(row.id) ?? row.name}
                variant={variant}
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
 * The shared timeline panel.
 *
 * Pass `variant="explorer"` only from Run Explorer. Ask and Monitoring reuse
 * the default presentation so live process copy and product marks stay put.
 */
export function TraceTimeline({
  trace,
  question = '',
  verdict,
  variant = 'default',
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
  /** `explorer` is Run Explorer Timeline only. Default keeps Ask unchanged. */
  variant?: TraceTimelineVariant;
  className?: string;
}) {
  const summary = (trace ?? null) as TraceSummary | null;
  const model = useMemo(() => buildTimeline(summary, question, verdict), [summary, question, verdict]);
  const eventLabels = useMemo(() => {
    if (variant !== 'explorer') {
      return new Map(model.rows.map((row) => [row.id, row.name]));
    }
    const turns = llmTurnByRowId(model.rows);
    return new Map(model.rows.map((row) => [row.id, explorerEventLabel(row, turns)]));
  }, [model.rows, variant]);
  // One row open at a time. The rows carry whole SQL statements and whole tool
  // results now that the contract no longer truncates them, and several open at
  // once buries the chart they are meant to explain.
  const [expanded, setExpanded] = useState<string | null>(null);

  if (model.rows.length === 0) {
    return <p className="trace-note">No steps recorded.</p>;
  }

  const shell = ['trace-timeline', variant === 'explorer' ? 'trace-timeline--explorer' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shell}>
      <Gantt
        model={model}
        variant={variant}
        eventLabels={eventLabels}
        expanded={expanded}
        onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
      />
    </div>
  );
}

import { useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, Copy, ExternalLink, ShieldCheck } from 'lucide-react';
import { BrandIcon } from './BrandIcon';
import { Alert, AlertDescription, Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui';
import { StateSwitch } from './StateSwitch';
import { sqlStatements, truncatedId } from './step-results';
import { formatMs } from './trace-timeline';
import { reportEgress } from './egress-policy';
import type { EgressChannel } from '../../shared/egress-contract';
import type { RunTrace } from './app-types';
import type { TraceStage } from './answer-shape';
import { PayloadView } from './TraceTimeline';
import { EntityText } from './DataEntityLinks';
import { isTableListingStage, stageTableEntities, stageToolNames } from './live-progress';
import { SqlCodeBlocks } from './SqlPresentation';
import { sanitizeSqlForDisplay } from './sql-presentation';

/**
 * Puts a value the page has truncated onto the clipboard whole.
 *
 * Every id on this tab is cut to fit, so the copy is the only way anyone gets
 * the value they came for. The label is an icon and the confirmation replaces
 * it, because a row that is mostly id has no room for the word "Copy" and the
 * reader needs to be told the click landed.
 */
function CopyValue({ value, label, channel }: { value: string; label: string; channel: EgressChannel }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-value"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        // The channel is a prop rather than inferred, because this one component
        // copies two different shapes of thing: an identifier that names
        // infrastructure and a statement the agent wrote. Recording both as
        // whichever the component happened to be written for would make the log
        // undercount one and overcount the other.
        reportEgress({ channel, itemCount: 1 });
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Copy aria-hidden />
      <span className="sr-only" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

/**
 * The trace id, cut to fit, with the ways of using it beside it.
 *
 * It was a titled card, and the title said "MLflow trace" over a wrapped
 * 35-character id -- two lines and a heading to carry one identifier whose only
 * uses are being copied and being opened. Both of those are now on the row.
 */
function TraceRow({ mlflow }: { mlflow: NonNullable<RunTrace['mlflow']> }) {
  return (
    <div className="trace-id-row">
      {/* The destination leads immediately into the identifier it opens. Keeping
          the action here, instead of pinning it to the far edge of the pane,
          makes the wordmark, action and id read as one MLflow reference. */}
      {mlflow.url ? (
        <a href={mlflow.url} target="_blank" rel="noreferrer">
          <BrandIcon product="mlflow" size={12} />
          Open in MLflow experiment
          <ExternalLink aria-hidden />
        </a>
      ) : (
        <BrandIcon product="mlflow" size={12} />
      )}
      <code title={mlflow.traceId}>{truncatedId(mlflow.traceId)}</code>
      <CopyValue value={mlflow.traceId} label="Copy the full trace id" channel="identifier" />
      {!mlflow.url ? (
        <span className="trace-id-note">
          Save an MLflow experiment on the Connections page to link straight to this trace.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The SQL a run generated, one statement per block and one clause per line.
 *
 * The panel printed the recorded field as it arrived, which is one line per
 * statement however long that line is, so two statements wrapped into a
 * paragraph with no way to see where the first ended. The count in the header is
 * read off the same split the blocks are, so it cannot disagree with them.
 */
function GeneratedSql({ sql }: { sql: string }) {
  const safeSql = sanitizeSqlForDisplay(sql);
  const statements = sqlStatements(safeSql);
  if (statements.length === 0) return null;
  return (
    <div className="sql-panel">
      <div className="sql-panel-head">
        <b>Generated SQL</b>
        <span>
          {statements.length} statement{statements.length === 1 ? '' : 's'}
        </span>
        <CopyValue value={safeSql} label="Copy the generated SQL" channel="generated-sql" />
      </div>
      <SqlCodeBlocks sql={safeSql} />
    </div>
  );
}

/**
 * What the trace amounts to, and the trace itself behind a caret.
 *
 * The JSON used to render open, which put ninety-six lines of stage records
 * between the reader and anything else on the tab. The three figures in front of
 * it are what a reader was scrolling that dump to work out.
 */
function TraceSummary({ trace }: { trace: NonNullable<RunTrace['trace']> }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(sanitizedTrace(trace), null, 2);
  const lines = json.split('\n').length;
  return (
    <div className="trace-summary">
      <div className="trace-summary-head">
        <b>Trace</b>
        {/* The figures in mono and the words around them in the body face. §3
            asks for the face on the number rather than on the line, and this
            line is three measurements read against each other: a total, a call
            count and a stage count all lining up is the point of the row. */}
        <span>
          <span className="ast-num">{formatMs(trace.totalMs)}</span> total ·{' '}
          <span className="ast-num">{trace.toolCalls.toLocaleString()}</span> tool call
          {trace.toolCalls === 1 ? '' : 's'} · <span className="ast-num">{trace.stages.length.toLocaleString()}</span>{' '}
          stage
          {trace.stages.length === 1 ? '' : 's'}
        </span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight aria-hidden />
          Raw JSON{' '}
          <span>
            · <span className="ast-num">{lines.toLocaleString()}</span> lines
          </span>
        </button>
      </div>
      {open && <pre>{json}</pre>}
    </div>
  );
}

/** A loose stage field, preserved by the run-trace contract and safe to show. */
function stageField(stage: TraceStage, keys: readonly string[]): string {
  const record = stage as TraceStage & Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return `${value}`;
    return JSON.stringify(value, null, 2) ?? '';
  }
  return '';
}

/** Whether a recorded field contains anything beyond an empty JSON envelope. */
function hasPayload(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null) return false;
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (typeof parsed === 'object') return Object.keys(parsed as Record<string, unknown>).length > 0;
  } catch {
    // Plain text is a real recorded payload.
  }
  return true;
}

/** Retry/error fields use zero, false and empty containers to mean none. */
function hasOptionalPayload(value: unknown): boolean {
  if (!hasPayload(value)) return false;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== 0 && parsed !== false;
  } catch {
    return true;
  }
}

/**
 * The raw JSON disclosure is an allowlisted display projection, not a dump of
 * whatever loose fields a future endpoint adds to a stage.
 */
function sanitizedTrace(trace: NonNullable<RunTrace['trace']>): Record<string, unknown> {
  const record = trace as NonNullable<RunTrace['trace']> & Record<string, unknown>;
  const safe: Record<string, unknown> = {
    id: trace.id,
    totalMs: trace.totalMs,
    toolCalls: trace.toolCalls,
    stages: trace.stages.map((stage) => {
      const item: Record<string, unknown> = {
        id: stage.id,
        name: stage.name,
        kind: stage.kind,
        start: stage.start,
        duration: stage.duration,
        status: stage.status,
        calls: stage.calls,
      };
      if (stage.depth !== undefined) item.depth = stage.depth;
      if (stage.parent_id) item.parent_id = stage.parent_id;
      if (hasPayload(stage.input)) item.input = stage.input;
      if (hasPayload(stage.output)) item.output = stage.output;
      const tables = stageTableEntities(stage);
      if (tables.length > 0) item.tables = tables;
      const retries = stageField(stage, ['retries', 'retry_count', 'retryCount']);
      if (hasOptionalPayload(retries)) item.retries = retries;
      const error = stageField(stage, ['error', 'errors', 'error_message', 'errorMessage']);
      if (hasOptionalPayload(error)) item.error = error;
      return item;
    }),
  };
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) safe[key] = record[key];
  }
  return safe;
}

/**
 * Every stage's sanitized record, open as soon as Advanced is on.
 *
 * The timeline already has the working payload renderer: JSON arguments become
 * labelled fields, SQL keeps its line breaks, and raw text remains available.
 * Reusing it here means Details is an inspection surface rather than a second
 * closed trace summary. Retry/error keys are loose because model versions have
 * used both snake_case and camelCase; absent/empty optional fields render
 * nothing, while actual failures remain visible.
 */
function StageRawIo({ stages }: { stages: readonly TraceStage[] }) {
  if (stages.length === 0) return <p className="stage-raw-io-empty">No stages were recorded in this trace.</p>;
  const payloadStages = stages
    .map((stage, index) => {
      const retries = stageField(stage, ['retries', 'retry_count', 'retryCount']);
      const error = stageField(stage, ['error', 'errors', 'error_message', 'errorMessage']);
      return {
        stage,
        index,
        input: hasPayload(stage.input),
        output: hasPayload(stage.output),
        retries: hasOptionalPayload(retries) ? retries : '',
        error: hasOptionalPayload(error) ? error : '',
      };
    })
    .filter((entry) => entry.input || entry.output || entry.retries || entry.error || isTableListingStage(entry.stage));
  if (payloadStages.length === 0) {
    return <p className="stage-raw-io-empty">No sanitized stage inputs or outputs were recorded.</p>;
  }
  return (
    <section className="stage-raw-io" aria-label="Sanitized stage inputs and outputs">
      <div className="stage-raw-io-head">
        <b>Stage Raw I/O</b>
        <span className="ast-num">
          {payloadStages.length} stage{payloadStages.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="stage-raw-io-list">
        {payloadStages.map(({ stage, index, input, output, retries, error }) => {
          const tables = stageTableEntities(stage);
          const tableListing = isTableListingStage(stage);
          return (
            <article className="stage-raw-io-stage" key={stage.id}>
              <header>
                <b>
                  <span className="ast-num">{index + 1}.</span>{' '}
                  <EntityText
                    text={stage.name}
                    sources={tables.map((name) => ({ name }))}
                    tools={stageToolNames(stage)}
                  />
                </b>
                <span className={`stage-raw-io-status ${stage.status}`}>{stage.status}</span>
              </header>
              <dl>
                {input ? (
                  <>
                    <dt>Input</dt>
                    <dd>
                      <PayloadView text={stage.input} tables={tables} />
                    </dd>
                  </>
                ) : null}
                {output || tableListing ? (
                  <>
                    <dt>Output</dt>
                    <dd>
                      <PayloadView text={stage.output} tables={tables} tableListing={tableListing} />
                    </dd>
                  </>
                ) : null}
                {retries ? (
                  <>
                    <dt>Retries</dt>
                    <dd>
                      <PayloadView text={retries} />
                    </dd>
                  </>
                ) : null}
                {error ? (
                  <>
                    <dt>Errors</dt>
                    <dd>
                      <PayloadView text={error} />
                    </dd>
                  </>
                ) : null}
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The Run Explorer's Details tab, and the switch that decides what is on it.
 *
 * The switch used to live in the page header, and the only thing that read it
 * was this tab. On every other tab -- and Overview is the one the page opens on
 * -- flipping it animated a control and changed nothing anywhere on screen, so
 * the reasonable conclusion, which is the one that was reported, was that the
 * feature was broken. Its own empty state gave it away: "Turn on Advanced ABOVE"
 * is a sentence that can only be read by somebody already looking at this tab.
 *
 * They are one component now, and that is the fix rather than a tidier
 * arrangement of the same parts. A control cannot be visible without its effect
 * if the two are rendered by the same return: `RunExplorer` mounts this only
 * inside the Details tab, and Radix mounts a tab's content only while it is the
 * open one, so there is no arrangement of tabs that puts the switch on screen
 * beside content it does not govern. run-details-render.test.tsx asserts that by
 * rendering the page rather than by reading it.
 *
 * The state stays in `RunExplorer` on purpose; see the note at its declaration.
 */
export function RunDetails({
  trace,
  advanced,
  onAdvancedChange,
  unavailable,
}: {
  /** The selected run's trace, or null while there is nothing to show. */
  trace: RunTrace | null;
  advanced: boolean;
  onAdvancedChange: (next: boolean) => void;
  /**
   * What to draw instead of the payloads when the run has no trace: the page's
   * own explanation of why a pane is empty, which distinguishes loading from
   * missing from unreachable. Passed in rather than imported because it lives in
   * RunExplorer.tsx, and a component the page renders cannot import the page.
   */
  unavailable: ReactNode;
}) {
  return (
    <>
      <div className="advanced-toggle">
        <span>Advanced</span>
        <StateSwitch
          checked={advanced}
          onCheckedChange={onAdvancedChange}
          aria-label="Show sanitized raw payloads for this run"
        />
      </div>
      <Alert>
        <ShieldCheck />
        <AlertDescription>
          Inputs and outputs are sanitized before display. Secrets and tokens are never shown.
        </AlertDescription>
      </Alert>
      {/* The trace id is an identifier, not payload, so it is not behind the
          Advanced gate: it is the only handle anyone has for finding this
          answer's trace in MLflow. */}
      {trace?.mlflow && <TraceRow mlflow={trace.mlflow} />}
      {advanced ? (
        trace?.trace ? (
          <>
            {trace.sql && <GeneratedSql sql={trace.sql} />}
            {trace.undeclaredKeys.length > 0 && (
              <Alert>
                <CircleAlert />
                <AlertDescription>
                  This run carries fields the app does not render yet: {trace.undeclaredKeys.join(', ')}.
                </AlertDescription>
              </Alert>
            )}
            <StageRawIo stages={trace.trace.stages} />
            <TraceSummary trace={trace.trace} />
          </>
        ) : (
          unavailable
        )
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheck />
            </EmptyMedia>
            <EmptyTitle>Advanced details are hidden</EmptyTitle>
            {/* Names the control and where it is, which is now a place the reader
                can see from here. The word it must not go back to is "above",
                which is what it said while the switch was in the page header: a
                direction to a control on a different part of the screen, given
                on the one tab where following it would have worked. */}
            <EmptyDescription>
              Turn on Advanced, at the top of this tab, to inspect sanitized inputs, outputs, generated SQL, retries,
              and errors.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

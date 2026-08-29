/**
 * The run's stages as a chain of nodes, drawn in two arrangements.
 *
 * Split out of App.tsx when the pages became modules. Ask PIA draws it in the
 * narrow right-hand rail and Run Explorer draws it full width on the Agent map
 * tab, which is the whole reason there is a prop.
 *
 * `compact` chooses the arrangement, and the component does not guess: the
 * container declares which one it is and the class it writes, `compact` or `map`,
 * is what every rule in trace.css hangs off. Both classes are always present on
 * one of the two branches, so no geometry is a bare default that the other
 * variant silently inherits. That is not a style preference, it is the bug that
 * put this file in front of a customer: the map's wrapping was written as the
 * default on `.dag-step`, a 190px flex basis, and in the rail's column that basis
 * is a HEIGHT. Every step in the rail became a 190px box holding a 60px card, so
 * the pane drew four cards separated by a card's worth of nothing with the
 * connector labels stranded in the middle of it.
 *
 * THE TWO DRAW DIFFERENT CARDS, and that is worth stating plainly rather than
 * leaving to be discovered. The map's card is a two-line tile -- a kind chip, a
 * two-digit step number and a right-pinned duration above a clamped name -- in
 * rows of four. The rail's is one line in a 264px column: a numbered badge, a
 * 13px mark, the name, and the duration pinned right. One markup bent into both
 * shapes by CSS is how the 190px basis came to be written at all.
 *
 * What is shared is the only thing that ever mattered: the READINGS. Both take
 * their duration from `formatMs`, their step number from `stepNumber`, their tool
 * name from `toolNameFromId` and their order from the stage list, so neither can
 * describe a measurement differently from the other or from the Timeline tab, and
 * a step is the same number in both.
 *
 * The rail is now specified as well, in
 * docs/design-handoff-pia-dubois-revamp/live-agent-path.md, which is where its
 * numbering, its indent and its three connector shapes come from. It is the pane
 * shown while a run is in flight, so it is the only one with a live state: the
 * card at `activeIndex` is the step in progress, and `elapsedMs` is how long it
 * has been going. Both are decided by the caller, which is the only place that
 * knows whether the run is still going; a component that read the clock itself
 * is how a finished run gets left counting.
 *
 * BOTH OPEN, AND BY THE SAME PRESS. A node is a button, and pressing it reveals
 * what the stage actually recorded -- the tool's real name, when it started, what
 * it was handed and what came back. Neither card can hold that itself: the map's
 * is one of twelve in a grid and a card that grows to fit a SQL statement takes
 * its whole row with it, and the rail's is a one-line tile whose height the
 * connectors are drawn against. So the panel is a row of its own at the foot of
 * either arrangement, and the cards stay the fixed, alignable tiles they were.
 *
 * The rail was plain divs until the column was widened, and the argument for that
 * was arithmetic rather than principle: at 264px with a transcript beside it there
 * was nowhere to read a payload, and a step that looks pressable and is not is
 * worse than the record it already is. The column is 340px now and the premise is
 * gone with it. What has not changed is that there is ONE panel: the rail seats
 * the map's own, so a step reads the same either side of the app rather than being
 * described twice.
 *
 * Every string either card prints is decided in `agent-map.ts` rather than here,
 * because vitest runs on `node`: a rule that only exists inside markup can be
 * asserted against a rendered tree and never against itself.
 */
import { useId, useState, type CSSProperties } from 'react';
import { Badge } from './ui';
import { ChevronRight, Copy, Database, Search, Wrench } from 'lucide-react';
import { AstrolabeMark } from './AstrolabeMark';
import { AgentPathConstellation } from './AgentConstellation';
import { AnswerCharts, type Chart } from './AnswerCharts';
import { BrandIcon } from './BrandIcon';
import { productForTool } from './brand-icons';
import { reportEgress } from './egress-policy';
import type { TraceStage, TraceSummary } from './answer-shape';
import { takeawayWhenTablesLanded, withDisplayedStageStatus, type RunVerdict } from '../../shared/run-verdict';
import { describePayload, payloadSize, type Payload } from './trace-payload';
import { buildTimeline, formatMs, runOrigin, toolNameFromId } from './trace-timeline';
import {
  AgentReport,
  ChipText,
  EntityName,
  GenieCard,
  MarkdownText,
  ResultSource,
  SemanticCard,
  StructuredTableResultView,
} from './StepResult';
import {
  argumentLabel,
  genieResult,
  reportSections,
  resultShape,
  semanticResult,
  structuredTableResult,
  type ResultShape,
} from './step-results';
import { astPill } from './run-header';
import { EntityText, TableEntityList } from './DataEntityLinks';
import { isTableListingStage, stageTableEntities, stageToolNames } from './live-progress';
import {
  cardCalls,
  cardTiming,
  isOrchestratorStep,
  describeResult,
  detailTiming,
  railConnector,
  railGlyph,
  railTiming,
  rawIo,
  runContainerSummary,
  sqlLines,
  sqlTokens,
  stepNumber,
  RAIL_CONNECTOR_HEIGHT,
  type RailGlyph,
  type RunContainerSummary,
} from './agent-map';

/**
 * How many lines of a statement show before the block is clamped.
 *
 * The design clamps the SQL block near 196px, and at 12px on a 1.65 leading that
 * is a shade under ten lines. Counted in lines rather than measured in pixels
 * because the decision it drives -- whether to offer the way past the clamp at
 * all -- is made while rendering, and a height is not knowable then. A statement
 * that already fits is not offered a link to reveal what is on screen, and it is
 * not covered by a fade with nothing behind it.
 */
const CLAMP_LINES = 9;

/**
 * What kind of step this was, as a 22px chip.
 *
 * Two fills and no more, which is the design's own distinction: an agent decision
 * sits on Ice, the AI-context surface, and a tool call on the neutral wash. The
 * glyph says WHICH tool; the fill says whether the agent was thinking or calling
 * something.
 *
 * AN AGENT DECISION IS CHIPPED WITH THE MARK, because the mark IS the agent.
 * `astrolabe-rebuild-spec.md` §1 settles it and §9 lists the orange robot among
 * the things this design retires rather than restyles, so the robot's chip is not
 * restained here -- the figure inside it is a different figure. The Ice fill is
 * §2's replacement for the oat the robot used to sit on, and it is the same
 * surface every other agent-context object in this design gets.
 *
 * The rail marks its own agent steps with the same mark, out of the same file, at
 * 13px and with no chip behind it, which is what makes a step the same thing in
 * both panes.
 *
 * The chip is a report and not an affordance -- the whole card is the button --
 * so nothing here changes on hover or on focus.
 *
 * A TOOL CALL IS CHIPPED WITH ITS PRODUCT'S MARK, recoloured, at the handoff's
 * 14px, and which product that is comes out of the shared map rather than out of
 * one declared here. It used to be declared here, over three DuBois INTERFACE
 * glyphs -- a bookmarked document, the letters S/Q/L, a sparkle -- filed under
 * Unity Catalog, Databricks SQL and Genie. They are not those products' marks.
 * They are the icons that sit beside carets and padlocks, and a reader who knows
 * the Databricks marks read one as a product mark and was then wrong about which
 * product ran.
 *
 * Recoloured rather than full-colour: §9 retires the full-colour marks from the
 * UI, and `brand-icons.ts` holds both cuts in one module, so no surface can file
 * a tool under a second product. The wrench still stands for a tool nobody has
 * classified, which is the case that has no honest mark.
 *
 * The chip names its product in a tooltip, because this is the one seating in
 * the app where no text label sits beside the mark: the card's line below names
 * the TOOL, not the product behind it, and four logos at 14px are not four
 * things every reader can tell apart.
 */
function KindChip({ stage }: { stage: TraceStage }) {
  if (stage.kind === 'agent') {
    return (
      <span className="dag-chip agent">
        <AstrolabeMark size={13} />
      </span>
    );
  }
  const product = productForTool(toolNameFromId(stage.id));
  if (product) {
    return (
      <span className="dag-chip tool">
        <BrandIcon product={product} size={14} labelled />
      </span>
    );
  }
  return (
    <span className="dag-chip tool">
      <Wrench aria-hidden="true" />
    </span>
  );
}

const RAIL_TOOL_GLYPHS: Record<Exclude<RailGlyph, 'agent'>, typeof Wrench> = {
  search: Search,
  wrench: Wrench,
  database: Database,
};

/**
 * The rail's 13px mark: the astrolabe mark, or the tool family's glyph.
 *
 * The mark is `AstrolabeMark`, the same drawing the map's kind chip carries. Its
 * ink comes from the component's `ink` prop and `astrolabe-mark.css` behind it,
 * so this seating cannot be a second, slightly different astrolabe blue. `light`
 * is the default and is right here: the rail is a white pane.
 *
 * The tool glyphs are lucide and monochrome, and which one a step gets is decided
 * in `railGlyph` rather than here, so the mapping can be asserted without a DOM.
 * They stay lucide because `#12ar` draws them that way: on the rail the mark and
 * the glyph are one 13px column in a 264px pane, and three line glyphs standing
 * for three tool FAMILIES is a coarser and more honest claim than a product mark
 * at that size beside a name the row already prints.
 */
function RailMark({ stage }: { stage: TraceStage }) {
  const glyph = railGlyph(stage);
  if (glyph === 'agent') {
    return (
      <span className="dag-mark agent">
        <AstrolabeMark size={13} />
      </span>
    );
  }
  const Glyph = RAIL_TOOL_GLYPHS[glyph];
  // No `title`. The map names the product behind each mark because its chips are
  // the official ones; these are three plain lucide glyphs standing for three
  // families, and a tooltip naming a family the row's own name already states is
  // the noise this pane was cleared of.
  return (
    <span className="dag-mark tool">
      <Glyph aria-hidden="true" />
    </span>
  );
}

/**
 * The line between two cards in the rail, as drawn SVG rather than as borders.
 *
 * Three shapes and no words: an elbow out to a tool the decision called, an
 * elbow back to the next decision, and a straight drop between siblings. The
 * relation is the shape, which is what replaced the "calls" and "then" labels
 * that used to sit in this gap.
 *
 * SVG rather than a CSS border because of the arrowheads: a border-drawn head is
 * two rotated pseudo-elements whose join softens at any zoom that is not 100%,
 * and this pane is read at whatever zoom the reader keeps their browser at.
 *
 * The coordinates are the RAIL's, measured from its left edge, so a connector
 * inside an indented step has to shed that step's indent again -- which the
 * stylesheet does with the same custom property the indent is applied from,
 * rather than with a number written twice.
 */
function RailConnectorRow({ fromDepth, toDepth }: { fromDepth: number; toDepth: number }) {
  const { shape, width, line, head } = railConnector(fromDepth, toDepth);
  return (
    <div className={`dag-edge ${shape}`} aria-hidden="true">
      <svg
        width={width}
        height={RAIL_CONNECTOR_HEIGHT}
        viewBox={`0 0 ${width} ${RAIL_CONNECTOR_HEIGHT}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={line} />
        <path d={head} />
      </svg>
    </div>
  );
}

/**
 * A stage's name, with the tool's own identifier set in mono on the map.
 *
 * The split is `nameParts`, which finds the identifier in the stage id rather
 * than by pattern, so a word that merely looks like a tool name is left alone.
 * Mono is what keeps it whole: the shared `overflow-wrap: anywhere` list broke
 * "Called search_semantics" as "search_semantic" with a lone "s" underneath.
 *
 * Both panes split it now, for that same reason: the rail is a 264px column, so
 * it is the narrower of the two and the likelier place for a long identifier to
 * be broken. It still does not clamp the name or repeat it in a title -- it has
 * the width to print one down a column -- so `clamp` stays the map's.
 */
function StageName({ stage, mono, clamp }: { stage: TraceStage; mono: boolean; clamp: boolean }) {
  const tables = stageTableEntities(stage);
  return (
    <span className="dag-name" title={clamp ? stage.name : undefined}>
      <EntityText
        text={stage.name}
        sources={tables.map((name) => ({ name }))}
        tools={mono ? stageToolNames(stage) : []}
        toolClassName="dag-name-tool"
      />
    </span>
  );
}

/** A recorded field the run has nothing in, said in words rather than left blank. */
function Absent() {
  return <span className="dag-detail-absent">(none recorded)</span>;
}

/**
 * The agent's own size ceiling, labelled where it applies.
 *
 * A cap the reader does not notice is worse than no cap: they would believe they
 * were looking at the whole value. Not in the design, and kept anyway, because it
 * is the difference between a short result and a clipped one.
 */
function Clipped() {
  return (
    <strong
      className="dag-clipped"
      title="the agent reached its own size ceiling while recording this and said so in the text below"
    >
      clipped by the agent
    </strong>
  );
}

/** The argument that is the question the step was asked, when it has one. */
function askedField(payload: Payload, skipKey: string | null) {
  const fields = payload.fields?.filter((field) => field.key !== skipKey) ?? null;
  return fields?.find((field) => field.key === 'question' || field.key === 'prompt') ?? null;
}

/**
 * What a tool was handed.
 *
 * No character count, which the design is explicit about: the arguments are short
 * enough to read, and a count above them is a measurement of the display rather
 * than of the run.
 *
 * The QUESTION is drawn as a sentence with its table and column names as chips,
 * because that is what it is -- one written by the model in ordinary English --
 * and a `question` key in front of it was labelling the obvious. A scalar
 * `kind: table` becomes the chip "tables only" beside it rather than a second
 * mono row: it is a filter on the question, not a second question.
 *
 * Every other key keeps the block it had, keys and all, because
 * `{"sql": "\nSELECT\n..."}` unwrapped into its keys is what turns a recorded
 * payload back into the query it was -- the reading is `trace-payload.ts`, shared
 * with the Timeline tab.
 *
 * `skipKey` is the field the Generated SQL block below draws instead. Printing a
 * statement twice on one panel is worse than either placement on its own.
 */
function ArgumentBlock({ payload, skipKey }: { payload: Payload; skipKey: string | null }) {
  if (payload.empty) return <Absent />;
  const fields = payload.fields?.filter((field) => field.key !== skipKey) ?? null;
  const asked = askedField(payload, skipKey);
  const filters = fields?.filter((field) => field.key === 'kind' && field.value.trim() !== '') ?? [];
  const rest = fields?.filter((field) => field !== asked && !filters.includes(field)) ?? null;
  return (
    <>
      {payload.truncated && (
        <div className="dag-detail-flag">
          <Clipped />
        </div>
      )}
      {asked && (
        <div className="dag-asked-row">
          <span className="dag-asked">
            <ChipText text={asked.value} />
          </span>
          {filters.map((filter) => (
            <span className="dag-arg-chip" key={filter.key}>
              {filter.value}s only
            </span>
          ))}
        </div>
      )}
      {rest === null ? (
        <MarkdownText text={payload.body} />
      ) : rest.length === 0 ? null : (
        <div className="dag-args">
          {rest.map((field) => (
            <div className="dag-arg" key={field.key}>
              <b>{field.key}</b>
              {field.block ? <MarkdownText text={field.value} /> : <span>{field.value}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * A recorded result laid out as whatever it turned out to be.
 *
 * The shape comes first: a result from a tool whose output has a known structure
 * is drawn as that structure, and `StepResult.tsx` holds the four readings and
 * their fallbacks. What is left is every tool with no shape of its own, where the
 * reading is `describeResult` and its refusal is the important half -- a result is
 * drawn as a table only when every line is a consistent grid, because half a table
 * read as a table silently drops the rows that did not parse.
 *
 * A result that is neither is rendered as markdown rather than as the paragraphs
 * it used to be, so `**12,000 distinct players**` arrives as bold instead of as
 * four asterisks. The Raw segment shows the untouched text whichever branch ran,
 * which is what makes the reading safe to attempt at all.
 */
function RenderedResult({
  shape,
  text,
  tables = [],
  tableListing = false,
}: {
  shape: ResultShape;
  text: string;
  tables?: readonly string[];
  tableListing?: boolean;
}) {
  const tableResult = structuredTableResult(text);
  if (tableResult) return <StructuredTableResultView result={tableResult} />;
  if (tableListing) return <TableEntityList tables={tables} />;
  // A shape that will not parse FALLS THROUGH rather than rendering markdown here,
  // and the difference matters: a `data_genie` result that is a bare grid instead
  // of a Genie conversation is still drawn as a grid below. An agent step with
  // nothing but prose falls through for the same reason -- a report of one prose
  // section is markdown with an extra wrapper round it.
  if (shape === 'genie') {
    const result = genieResult(text);
    if (result) return <GenieCard result={result} />;
  } else if (shape === 'semantic') {
    const result = semanticResult(text);
    if (result) return <SemanticCard result={result} />;
  } else if (shape === 'report') {
    const sections = reportSections(text);
    if (sections.some((section) => section.kind !== 'prose')) return <AgentReport sections={sections} />;
  }
  const view = describeResult(text);
  if (view.kind === 'text') return <MarkdownText text={text} />;
  return (
    <div className="dag-result-table">
      <table>
        <thead>
          <tr>
            {view.head.map((cell, at) => (
              <th key={view.head.slice(0, at + 1).join('|')} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr
              key={`${row.finding ? 'finding' : 'plain'}-${row.cells.join('|')}`}
              className={row.finding ? 'finding' : undefined}
            >
              {row.cells.map((cell, cellAt) => (
                <td key={row.cells.slice(0, cellAt + 1).join('|')}>
                  {cell.split('.').length === 3 ? <EntityName>{cell}</EntityName> : cell}
                </td>
              ))}
            </tr>
          ))}
          {/* The uniform tail as one plain row. It carries no tint on purpose:
              the rows folded into it are the ones with nothing to report, and a
              marked row saying "all 0.00%" would be the tint contradicting the
              value beside it. */}
          {view.tail && (
            <tr className="dag-result-tail">
              <td colSpan={view.head.length}>
                {view.tail.count} more rows, all {view.tail.value}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The statement the step generated, with the keywords the design picks out.
 *
 * Clamped rather than scrolled, and the clamp opens: a scrollbar inside a panel
 * inside a grid is the arrangement that parked half of this map off-screen the
 * last time, and a reader who wants the whole statement can say so once. The way
 * past the clamp appears only when there is something behind it -- a fade and a
 * "show all" over a statement that already fits is a control that does nothing,
 * drawn on top of the last line it is pretending to hide.
 *
 * Copy puts the statement on the clipboard exactly as recorded -- not the
 * tokenised version above, which is the same characters in spans, and not the
 * clamped fragment on screen.
 */
function SqlBlock({ sql }: { sql: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = sqlLines(sql);
  const clamps = lines.length > CLAMP_LINES;
  return (
    <div className={`dag-sql ${expanded || !clamps ? 'open' : ''}`}>
      <div className="dag-sql-head">
        <strong>Generated SQL</strong>
        <span className="dag-sql-lines ast-num">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          className="dag-sql-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(sql);
            // The same one-line report the run details' copies make. This is a
            // second button onto a channel that already reports, so nothing was
            // unrecorded -- but a path that reports from one of its buttons and
            // not the other undercounts, and an undercount is worse than a hole
            // because it looks like an answer.
            reportEgress({ channel: 'generated-sql', itemCount: 1 });
          }}
          aria-label="Copy the generated SQL"
        >
          <Copy aria-hidden="true" />
        </button>
      </div>
      <div className="dag-sql-body">
        <pre>
          {lines.map((line, at) => (
            <span key={lines.slice(0, at + 1).join('\n')}>
              {sqlTokens(line).map((token, tokenAt) =>
                token.keyword ? (
                  <b
                    key={sqlTokens(line)
                      .slice(0, tokenAt + 1)
                      .map(({ text }) => text)
                      .join('|')}
                  >
                    {token.text}
                  </b>
                ) : (
                  <span
                    key={sqlTokens(line)
                      .slice(0, tokenAt + 1)
                      .map(({ text }) => text)
                      .join('|')}
                  >
                    {token.text}
                  </span>
                )
              )}
              {'\n'}
            </span>
          ))}
        </pre>
        {clamps && !expanded && (
          <button type="button" className="dag-sql-more" onClick={() => setExpanded(true)}>
            Show all {lines.length} lines
          </button>
        )}
      </div>
    </div>
  );
}

function RunSummaryDetail({ stage, summary, id }: { stage: TraceStage; summary: RunContainerSummary; id: string }) {
  return (
    <div className={`dag-detail run-summary ${summary.status.replaceAll(' ', '-')}`} id={id}>
      <div className="dag-detail-head">
        <KindChip stage={stage} />
        <strong>Run summary</strong>
        <Badge variant="outline" className={astPill(summary.status)}>
          {summary.status}
        </Badge>
      </div>
      <dl aria-label="Run summary evidence">
        <dt>Execution</dt>
        <dd className="run-summary-execution">
          <span className="ast-num">{summary.stageCount}</span> {summary.stageCount === 1 ? 'stage' : 'stages'}
          {' · '}
          <span className="ast-num">{summary.agentStepCount}</span>{' '}
          {summary.agentStepCount === 1 ? 'agent step' : 'agent steps'}
          {summary.toolCalls !== null ? (
            <>
              {' · '}
              <span className="ast-num">{summary.toolCalls}</span>{' '}
              {summary.toolCalls === 1 ? 'tool call' : 'tool calls'}
            </>
          ) : null}
          {summary.wallTimeMs !== null ? (
            <>
              {' · '}
              <span className="ast-num">{formatMs(summary.wallTimeMs)}</span> wall time
            </>
          ) : null}
        </dd>
        <dt>Final stage</dt>
        <dd>
          {summary.finalStage ? (
            <>
              <span>{summary.finalStage.name}</span>
              <Badge variant="outline" className={astPill(summary.finalStage.status)}>
                {summary.finalStage.status}
              </Badge>
            </>
          ) : (
            'No stage recorded yet'
          )}
        </dd>
        <dt>Final answer</dt>
        <dd>{summary.answerAvailability}</dd>
        {summary.traceId ? (
          <>
            <dt>Trace</dt>
            <dd>
              <code className="dag-detail-mono" title={summary.traceId}>
                {summary.traceId}
              </code>
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * What one stage recorded, opened from its node on the map.
 *
 * Every line is read off the stage and nothing is filled in. The header carries
 * the offset, the elapsed and the call count on one right-pinned line, which is
 * the design's arrangement and also removes the two labelled rows a reader had to
 * scan a grid for. A start that was never measured says so in words rather than
 * printing a zero, for the reason `startMeasured` exists at all: a missing origin
 * and an origin of zero arrive as the same number, and the first stage of every
 * run legitimately starts at zero.
 *
 * There is no token count here, and that is not an omission -- the agent meters
 * tokens per RUN and not per stage, so a figure on this panel would be the run's
 * total attributed to whichever step the reader happened to open.
 *
 * A STAGE THAT FAILED OPENS ON RAW. The design asks for the server quoted
 * verbatim, and `Rendered` is a reading of the text: paragraphs, or a table if
 * the lines happen to form a grid. An error message is neither, and putting one
 * through a renderer is exactly where a stack trace loses the line breaks that
 * make it legible. `Reference` is the stage's own id, which is the only handle
 * the record carries for finding this step again; the design asks for a
 * correlation id and the agent does not write one.
 *
 * Exported for the test that renders it on its own. The suite runs without a
 * DOM, so there is no button to press and no other way to see what a node
 * reveals; the alternative was asserting against this file's source text, which
 * would pin the code rather than what a reader is told.
 */
export function StageDetail({
  stage,
  step,
  origin,
  id,
  charts,
  runSummary = null,
}: {
  stage: TraceStage;
  step: number;
  origin: number;
  id: string;
  charts?: Chart[];
  runSummary?: RunContainerSummary | null;
}) {
  const failed = stage.status === 'failed';
  const [raw, setRaw] = useState(failed);
  if (runSummary) return <RunSummaryDetail stage={stage} summary={runSummary} id={id} />;
  // The tool's real name, which the stage id carries verbatim. `_TOOL_STAGE_NAMES`
  // in agent.py gives a tool a reader's label ("Queried governed data") and falls
  // back to "Called {name}" for one it has no label for, so this is the only place
  // the model's own vocabulary is recoverable for every stage rather than some.
  const tool = toolNameFromId(stage.id);
  const args = describePayload(stage.input);
  const result = describePayload(takeawayWhenTablesLanded(stage.output, stage.input));
  // The one argument that becomes the Generated SQL block. Named rather than
  // sniffed for SQL keywords: `data_genie` and `run_sql` both record the
  // statement under a key, and a heuristic would eventually promote a question
  // that happened to contain the word "select".
  const sql = args.fields?.find((field) => field.key === 'sql' || field.key === 'query') ?? null;
  const shape = resultShape(stage.kind, tool);
  const tables = stageTableEntities(stage);
  const tableListing = isTableListingStage(stage);
  const argumentFields = args.fields?.filter((field) => field.key !== (sql?.key ?? null)) ?? null;
  const hasArguments = !args.empty && (argumentFields === null || argumentFields.length > 0);
  const hasResult = !result.empty || (tableListing && tables.length > 0) || stage.name === 'Built the charts';
  return (
    <div className={`dag-detail ${stage.status}`} id={id}>
      <div className="dag-detail-head">
        <KindChip stage={stage} />
        <strong>
          Step {step} · <StageName stage={stage} mono clamp={false} />
        </strong>
        <span className="dag-detail-measures ast-num">{detailTiming(stage, origin)}</span>
      </div>
      <dl>
        {tool && (
          <>
            <dt>Tool</dt>
            <dd className="dag-detail-mono">{tool}</dd>
          </>
        )}
        {stage.status !== 'complete' && (
          <>
            <dt>Ended</dt>
            <dd>{stage.status}</dd>
            <dt>Reference</dt>
            <dd className="dag-detail-mono">{stage.id}</dd>
          </>
        )}
        {hasArguments ? (
          <>
            <dt>{argumentLabel(shape, askedField(args, sql?.key ?? null) !== null)}</dt>
            <dd>
              <ArgumentBlock payload={args} skipKey={sql?.key ?? null} />
            </dd>
          </>
        ) : null}
        {hasResult ? (
          <>
            <dt>Result</dt>
            <dd>
              {stage.name === 'Built the charts' ? (
                charts?.length ? (
                  <div className="dag-result-charts">
                    <AnswerCharts charts={charts} />
                  </div>
                ) : (
                  <p className="dag-chart-empty">
                    {charts
                      ? 'This step completed without a chart.'
                      : 'The chart payload is unavailable for this stored run.'}
                  </p>
                )
              ) : null}
              {result.empty ? (
                tableListing ? (
                  <TableEntityList tables={tables} />
                ) : (
                  <Absent />
                )
              ) : (
                <>
                  <div className="dag-result-meta">
                    {/* What answered, read off the same parse the body is drawn from,
                    so this line cannot name a Genie space the card below did not
                    come from. Absent for a shape with no source to name, and for
                    one whose parse refused. */}
                    <ResultSource shape={shape} text={result.body} />
                    {result.truncated && <Clipped />}
                    {/* Two states of one control, so it is a group of pressed
                    buttons rather than two independent ones. A radio group
                    would announce a form field; this changes how one value is
                    drawn and changes nothing about the run. */}
                    <span className="dag-seg" role="group" aria-label="How to show this result">
                      <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
                        Rendered
                      </button>
                      {/* The size moves onto the Raw segment, which is the only place
                      it means anything: it is the measure of what pressing that
                      button shows, and above a rendered card it was the length of
                      a payload the reader was no longer looking at. The character
                      count stays in the title rather than on the label, which the
                      design keeps to the line count. */}
                      <button type="button" aria-pressed={raw} onClick={() => setRaw(true)} title={payloadSize(result)}>
                        Raw{result.lines > 1 ? ` · ${result.lines.toLocaleString()} lines` : ''}
                      </button>
                    </span>
                  </div>
                  {raw ? (
                    <pre className="dag-block">{result.body}</pre>
                  ) : (
                    <RenderedResult shape={shape} text={result.body} tables={tables} tableListing={tableListing} />
                  )}
                </>
              )}
            </dd>
          </>
        ) : null}
      </dl>
      {sql && <SqlBlock sql={sql.value} />}
    </div>
  );
}

/**
 * The whole run's payloads, behind one collapsed row at the foot of the map.
 *
 * Shut by default and shut on every visit: the JSON is several hundred lines on
 * an ordinary run, and a panel that opens itself is a panel that pushes the map
 * off the screen. It discloses nothing the step panel above does not -- it is
 * the same `input` and `output` without the reading applied -- so the only thing
 * being weighed here is length.
 */
function RawIo({ stages }: { stages: TraceStage[] }) {
  const [open, setOpen] = useState(false);
  const panelId = `${useId()}raw`;
  const io = rawIo(stages);
  return (
    <div className={`dag-raw ${open ? 'open' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight aria-hidden="true" />
        <span className="dag-raw-label">Raw I/O</span>
        <span className="dag-raw-meta ast-num">{io.lines} lines · request and response of every stage</span>
      </button>
      {open && (
        <pre className="dag-block" id={panelId}>
          {io.text}
        </pre>
      )}
    </div>
  );
}

export function TraceDag({
  stages,
  activeIndex,
  compact = false,
  elapsedMs = null,
  charts,
  trace = null,
  question = '',
  verdict,
  runStatus,
}: {
  stages: TraceStage[];
  activeIndex: number;
  /** Whether this is the narrow rail. The container's declaration, not a guess. */
  compact?: boolean;
  /**
   * How long the step in progress has been going, from the caller's one clock.
   *
   * Null while nothing is in progress, and null the moment the run ends, which
   * is what stops the counter: the number is passed in rather than measured
   * here, so a finished run cannot be left counting by a component that kept a
   * timer of its own. Ignored for every stage that reported a duration.
   */
  elapsedMs?: number | null;
  /** The answer's canonical Plotly payload, shown only by its chart-building stage. */
  charts?: Chart[];
  /** The measured run envelope, shown as map row 1 when available. */
  trace?: TraceSummary | null;
  /** The run prompt carried by the envelope's detail panel. */
  question?: string;
  /**
   * The run's answer status. When Complete, "Prepared the answer" stored as
   * native PARTIAL is shown Complete, matching Ask.
   */
  verdict?: RunVerdict;
  /** Stored run state, including waiting/cancelled states outside answer verdicts. */
  runStatus?: string | null;
}) {
  const shownStages = [...withDisplayedStageStatus(stages, verdict)];
  const envelope =
    !compact && trace ? buildTimeline(trace, question, verdict).rows.find((row) => row.container) : undefined;
  const envelopeStage: TraceStage | null = envelope
    ? {
        id: envelope.id,
        name: envelope.name,
        kind: 'agent',
        start: envelope.startMs ?? 0,
        duration: envelope.durationMs,
        status: envelope.status,
        calls: trace?.toolCalls ?? 0,
        input: envelope.input,
        output: envelope.output,
        startMeasured: true,
      }
    : null;
  const summary = envelopeStage
    ? runContainerSummary({ stages: shownStages, trace, activeIndex, runStatus, verdict })
    : null;
  const displayedStages = envelopeStage ? [envelopeStage, ...shownStages] : shownStages;
  const displayedActiveIndex = envelopeStage && activeIndex >= 0 ? activeIndex + 1 : activeIndex;
  // The step the reader opened, by id rather than by position, and looked up in
  // the current stages rather than trusted: selecting a different run in the
  // Explorer replaces this list under the component, and an index would then
  // open whatever stage had moved into that slot.
  const [openId, setOpenId] = useState<string | null>(null);
  const panelId = `${useId()}detail`;
  const openIndex = displayedStages.findIndex((item) => item.id === openId);
  const open = openIndex === -1 ? null : displayedStages[openIndex];
  // The instant the panel's offsets are measured from, decided in one place for
  // the whole app. See runOrigin: `start` is milliseconds since the run's own
  // origin today, and an absolute clock if the agent's convention ever changes.
  const { origin } = runOrigin(shownStages);
  // Every stage, in both arrangements, in the order the run recorded them and
  // never re-sorted. The rail used to draw four evenly spread ones and drop the
  // rest, which live.css already records as the defect the live step list was
  // built to replace: "on a twenty-one step run silently dropped seventeen of
  // them". It was invisible while the nodes were unlabelled and became a support
  // question the moment they were numbered, which is the usual way round -- the
  // numbering did not break the pane, it published what the pane had been doing.
  const steps = (
    <div className={`trace-dag ${compact ? 'compact' : `map${envelopeStage ? ' has-run-envelope' : ''}`}`}>
      {displayedStages.map((item, index) => {
        // Capped, because the indent is a reading aid and a deep run should not
        // push its last stages off the side of the rail. Handed to the stylesheet
        // as a custom property rather than as an inline padding, which is how the
        // live step list already does it: the two arrangements indent different
        // boxes -- the rail indents the step by 26px a level, the map indents
        // inside the card so that a nested stage does not break the grid's
        // columns -- and a pixel value written here could only ever be right for
        // one of them. The rail's 26px is `RAIL_INDENT`, and the connectors are
        // drawn from the same figure, which is why they land on the badges.
        const depth = Math.min(item.depth ?? 0, 3);
        const next = displayedStages[index + 1];
        const isOpen = open?.id === item.id;
        const runEnvelope = item.id === '__run__';
        const itemStatus = runEnvelope && summary ? summary.status : item.status;
        const statusClass = itemStatus.replaceAll(' ', '-');
        const nodeClass = `dag-node ${statusClass} ${displayedActiveIndex === index ? 'active' : ''}`;
        return (
          <div
            key={item.id}
            className={`dag-step ${runEnvelope ? 'run-envelope' : ''}`.trim()}
            style={depth ? ({ '--dag-depth': depth } as CSSProperties) : undefined}
          >
            {compact ? (
              <button
                type="button"
                className={isOpen ? `${nodeClass} open` : nodeClass}
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onClick={() => setOpenId((current) => (current === item.id ? null : item.id))}
              >
                {/* The rail's tile: the step's number, the kind mark, the name,
                    and the duration pinned right. One line, and the whole line is
                    the button -- the same press the map's card takes, opening the
                    same panel at the foot of the column.

                    The number is the same number the map prints for the same
                    step, out of the same `stepNumber`, because the design asks a
                    reader to carry it between the two panes. */}
                {/* `ast-num` because it is a figure in a column: §3 puts every
                    number in a column, a cell, a stat value or a right-aligned
                    meta slot in DM Mono, and that class is where the rule lives.
                    It matters here rather than being a formality -- DM Sans
                    declares no `tnum` feature, so `font-variant-numeric` on it is
                    a no-op that reads as done, and a "1" is just over half the
                    width of a "0" in that family. A column of step numbers set in
                    it does not line up however it is marked. */}
                <span className={`dag-num ast-num ${item.kind === 'agent' ? 'agent' : 'tool'}`}>
                  {stepNumber(index + 1)}
                </span>
                <RailMark stage={item} />
                <strong>
                  <StageName stage={item} mono clamp={false} />
                </strong>
                {/* railTiming, so this is `formatMs` -- the Timeline's and the
                    panel's -- rather than a second rounding of its own. The call
                    count is gone with the design's own instruction: a step that
                    made three calls shows the three as its own indented
                    children, so "· 3 calls" here counted them twice. */}
                <span className="dag-elapsed ast-num">{railTiming(item, elapsedMs)}</span>
                {/* Only when it is worth saying. A badge reading "complete" on
                    every node of a finished trace is a column of the same word,
                    and the status that matters — a stage that stopped partway —
                    was buried in the middle of it. `running` is excluded for the
                    same reason: the ring and the moving counter are already
                    saying it, in the two places the design put it. */}
                {item.status !== 'complete' && item.status !== 'running' && (
                  <Badge variant="outline" className={astPill(item.status)}>
                    {item.status}
                  </Badge>
                )}
              </button>
            ) : (
              <button
                type="button"
                className={`${nodeClass} ${isOpen ? 'open' : ''}`}
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onClick={() => setOpenId((current) => (current === item.id ? null : item.id))}
              >
                <span className={`dag-index ast-num ${item.kind === 'agent' ? 'agent' : 'tool'}`}>
                  {stepNumber(index + 1)}
                </span>
                <span className="dag-card-body">
                  <span className="dag-card-title">
                    <KindChip stage={item} />
                    <StageName stage={item} mono clamp />
                  </span>
                  <span className="dag-card-meta">
                    {isOrchestratorStep(item) && (
                      <Badge variant="outline" className="dag-role-badge">
                        Orchestrator step
                      </Badge>
                    )}
                    <Badge variant="outline" className="dag-metric-badge dag-duration-badge ast-num">
                      {cardTiming(item)}
                    </Badge>
                    <Badge variant="outline" className="dag-metric-badge dag-call-badge ast-num">
                      {cardCalls(item, runEnvelope)}
                    </Badge>
                    {itemStatus !== 'complete' && (
                      <Badge variant="outline" className={`dag-status-badge ${astPill(itemStatus)}`}>
                        {itemStatus}
                      </Badge>
                    )}
                  </span>
                </span>
              </button>
            )}
            {next &&
              (compact ? ( // The rail draws the relation rather than naming it: an elbow out
                // to a tool a decision called, an elbow back to the decision
                // after it, a straight drop between siblings. The words "calls"
                // and "then" used to sit here and are gone -- the shape says the
                // same thing in a gutter too narrow to letter.
                <RailConnectorRow fromDepth={depth} toDepth={Math.min(next.depth ?? 0, 3)} />
              ) : (
                // On the map the arrow hangs in the column gutter to the card's
                // right, so the LAST card of a row has nowhere to draw one and
                // does not: see the clip in trace.css. Rendering it here and
                // letting the layout decide is the only version of this that
                // works at every column count. The word is read out rather than
                // drawn, because 26px is nowhere to letter one.
                <div className="dag-edge">
                  <span>{(next.depth ?? 0) > depth ? 'calls' : 'then'}</span>
                </div>
              ))}
          </div>
        );
      })}
      {/* Rows of their own, spanning the grid, at the foot of the map rather than
          under the card that opened it: a panel spliced into the middle of the
          grid would leave the rest of that row empty and shunt every later card
          into a different column, which is the alignment this map exists to
          have. `key` is the stage, so opening a different step gets a panel that
          starts on Rendered rather than one that kept the last step's segment. */}
      {!compact && open && (
        <StageDetail
          key={open.id}
          stage={open}
          step={openIndex + 1}
          origin={origin}
          id={panelId}
          charts={charts}
          runSummary={open.id === '__run__' ? summary : null}
        />
      )}
      {!compact && stages.length > 0 && <RawIo stages={stages} />}
    </div>
  );
  /*
   * The rail's panel, seated in the map's own container rather than restyled.
   *
   * It is the same component either side of the app, and this is what keeps the
   * stylesheet honest about that: `.dag-detail` and everything under it is written
   * once, under `.map`, and the rail borrows the seat instead of carrying a second
   * copy of a panel's worth of rules that would then have to be kept level with
   * it. `grid-column: 1 / -1` spans whatever track count the seat resolves to, so
   * the panel does not need to know how wide the column it is in happens to be.
   *
   * OUTSIDE the rail's own list, not inside it, and that placement is load-bearing:
   * `.trace-dag.compact .dag-name` clips a name to one line with an ellipsis,
   * which is right for a tile in a column and wrong for the one place the whole
   * name is spelled out. A panel nested inside the list would inherit it.
   */
  const railPanel = open ? (
    <div className="trace-dag map">
      <StageDetail key={open.id} stage={open} step={openIndex + 1} origin={origin} id={panelId} charts={charts} />
    </div>
  ) : null;
  /*
   * The wide form is the Run Explorer's agent map: the operable stage cards and
   * their detail panel, with no constellation stacked above them. The finished
   * constellation belongs to Ask, where it is the one persistent view of the run.
   * Keeping this branch to one representation is what prevents a completed run
   * from showing the same steps twice on either page.
   */
  if (!compact) {
    return <div className="agent-map">{steps}</div>;
  }
  /*
   * The rail gets the vertical path (`#18a`) IN BOTH STATES, and the band is the
   * same band before and after the answer lands.
   *
   * It used to be drawn only while `activeIndex` named a step in progress, on the
   * reasoning that the band's subject is the line arriving into that step and a
   * settled run has no such step. What that produced is the fault this change is
   * about: the constellation a reader watched their run through was substituted,
   * the instant it finished, for the plain list underneath it -- the drawing
   * vanishing at exactly the moment the run became a thing worth reading back.
   *
   * At rest it is a drawing of the run's shape, which is what the map's own band
   * is for a finished run, and its status line names how the run ended rather than
   * leaving a step described as happening. Nothing here decides that: `activeIndex`
   * is the caller's statement that a step is in progress, and -1 the same caller
   * saying none is, so a finished run cannot be left animating by this component.
   *
   * THE TILES ARE ON THE SCREEN IN BOTH STATES NOW. While a run was going they sat
   * in an `sr-only` box, on the argument that the band is the design's whole
   * account of a run in flight (`#18a`) and the tiles under it drew the same run
   * twice in a column 264px wide. They are how a reader opens a step now, so
   * off-screen would leave every step of a live run reachable by keyboard and
   * invisible to whoever pressed it -- the fault that box was written to avoid,
   * inverted. The band is the run's shape at a glance; the tiles are the record,
   * and the record opens.
   */
  return (
    <div className="agent-path">
      <AgentPathConstellation stages={shownStages} activeIndex={activeIndex} elapsedMs={elapsedMs} />
      {steps}
      {railPanel}
    </div>
  );
}

/**
 * One answered turn: the takeaway, the narrative, the figures the agent
 * returned, what to keep in mind about them, and how the run got there.
 *
 * Split out of App.tsx when the pages became modules. Ask PIA is its only
 * caller, and the card is the largest thing in the transcript, so it is the one
 * most worth being able to work on without holding the whole of Ask PIA open.
 *
 * The order of the sections below is the specification's and is argued for
 * there. It is not a layout preference: the fallback banner leads because it
 * governs how every number under it reads, the caveats sit under the figures
 * they qualify, and the run process sits under the answer it produced.
 */
import './styles/answer-body.css';
import './styles/answer-charts.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dataAccessDisclosure } from './analytical-execution';
import type { TraceStage } from './answer-shape';
import { answerBadge, answerFallbackNotice, splitCaveats } from './degraded-answer';
import { answerHonesty, readerFacingNarrative, readerFacingTakeaway } from './reader-facing-answer';
import { isMlflowTraceId, withoutUntracedTimeline } from '../../shared/mlflow-trace-id';
import { answerRunVerdict } from '../../shared/run-verdict';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './ui';
import { Check, ChevronDown, CircleAlert, ThumbsDown, ThumbsUp } from 'lucide-react';
import { AnswerEvidence } from './AnswerEvidence';
import { AstrolabeMark } from './AstrolabeMark';
import { AnswerProse, EntityText } from './DataEntityLinks';
import { mentionedIdentifiers } from './data-entities';
import { SourcesModule } from './SourcesModule';
import { TraceTimeline, type TraceTimelineVariant } from './TraceTimeline';
import { evidenceLinkedSourceNames } from './answer-table-origins';
import type { Answer, FeedbackEntry } from './app-types';
import type { FeedbackDirection } from '../../shared/feedback-direction';
import { StateSwitch } from './StateSwitch';
import { SqlCodeBlocks } from './SqlPresentation';
import { AIAnalysisCaveat } from './AIAnalysisCaveat';
import { readRunProcessPreference, writeRunProcessPreference } from './run-process-preference';
import { normalizeReaderAnswer } from '../../shared/answer-content-policy';
import { answerHasGeneratedSql } from './answer-sql';

/** Shared by Ask and Monitoring, which mounts this same answer card. */
export function AnswerSql({ sql }: { sql: string }) {
  return (
    <div className="code-panel">
      <div className="code-panel-head">
        <Badge variant="outline" className="ast-pill ast-pill--neutral-outline">
          Read only
        </Badge>
      </div>
      <SqlCodeBlocks sql={sql} />
    </div>
  );
}

export function AnswerCard({
  answer,
  id,
  question = '',
  feedback,
  onFeedbackChange,
  saveFeedback,
  showFeedback,
  showRunProcess = true,
  defaultRunProcessOpen = true,
  runProcessPreferenceKey,
  processStages,
  runProcessVariant = 'default',
  afterEvidence,
  headerExtra,
}: {
  answer: Answer;
  /**
   * DOM id of this row, so a link that names one answer can bring that answer
   * into view. React's `key` is not one: the transcript has always keyed these
   * by message id, and none of it reached the document, so an answer halfway up
   * a thread was unaddressable and a deep link could only open the thread.
   * Optional, because the id is only useful where something links to it.
   */
  id?: string;
  /** The prompt this answer replied to, shown on the timeline's envelope row. */
  question?: string;
  feedback: FeedbackEntry;
  onFeedbackChange: (changes: Partial<FeedbackEntry>) => void;
  saveFeedback: (sentiment: FeedbackDirection, options?: { keepCommentOpen?: boolean }) => Promise<void>;
  showFeedback: boolean;
  /**
   * Whether this card draws the run process panel.
   *
   * True by default: Ask PIA and Monitoring both mount this card as the whole
   * run view, so the timeline sits under the answer it produced. Tests that
   * isolate a later section turn it off so they are not asserting against the
   * process panel as well. Same shape as `showFeedback`, which Monitoring turns
   * off because the rating there belongs to the asker rather than to the admin
   * reading it.
   */
  showRunProcess?: boolean;
  /**
   * Whether this surface opens the finished run timeline on first sight.
   *
   * Dedicated process surfaces leave this true. Ask passes false because the
   * answer is the primary content there and the process is supporting detail.
   */
  defaultRunProcessOpen?: boolean;
  /**
   * Session-scoped identity for an explicit open/closed choice.
   *
   * Ask passes the message id so a reader can inspect one answer without
   * expanding every answer in a conversation. Dedicated surfaces omit it.
   */
  runProcessPreferenceKey?: string;
  /**
   * Steps the page already has when the stored answer does not.
   *
   * The prose-only path used to persist an empty trace over a run the stream
   * had already narrated. Ask can still hold those rows after the card lands,
   * and a reopen can recover them from the conversation run. They are only
   * used when the answer itself recorded none, so a real stored path is never
   * replaced.
   */
  processStages?: TraceStage[];
  /** Shared Timeline presentation selected by the surface hosting this card. */
  runProcessVariant?: TraceTimelineVariant;
  /**
   * A note that belongs after the figures and before Sources.
   *
   * Monitoring uses this for the run's token line so that line is a grid sibling
   * of the tables rather than a later flex child of the dialog. A sibling after
   * the card sat on the last table row whenever the card shrank inside the
   * modal's height-capped column. Ask does not pass one.
   */
  afterEvidence?: ReactNode;
  /**
   * A compact chip that belongs in the same top-left corner as "Live agent
   * response". Monitoring passes Asked-by here so that name is a corner chip
   * on the answer, not a washed bar above it. Ask does not pass one.
   */
  headerExtra?: ReactNode;
}) {
  const readerAnswer = normalizeReaderAnswer(answer);
  const hasGeneratedSql = answerHasGeneratedSql(readerAnswer.sql);
  const [advanced, setAdvanced] = useState(false);
  const feedbackInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (feedback.open) feedbackInputRef.current?.focus();
  }, [feedback.open]);
  const [showProcess, setShowProcess] = useState(
    () => readRunProcessPreference(runProcessPreferenceKey) ?? defaultRunProcessOpen
  );
  const changeProcessVisibility = (open: boolean) => {
    setShowProcess(open);
    writeRunProcessPreference(runProcessPreferenceKey, open);
  };
  // A degradation is not a caveat about the answer, it is a statement about
  // whether the answer is the answer. Separated so it can be shown above the
  // figures instead of below them in a list of five, see degraded-answer.ts.
  const { ordinary: ordinaryCaveats } = splitCaveats(readerAnswer.caveats);
  // Whether this card may be read as an answer to the question at all, and if
  // not, which of the two ways it failed. See degraded-answer.ts for why this
  // reads `mode` rather than looking for the representative caveat.
  //
  // Local stages without an MLflow id are not a recorded run. The live rail
  // can still narrate them while the turn is in flight; the finished card
  // must not draw a Gantt that looks traced. `processStages` from the stream
  // is the same reconstruction and is ignored here unless the id is real.
  const recorded = isMlflowTraceId(answer.trace.id);
  const processTrace = !recorded
    ? withoutUntracedTimeline(answer.trace)
    : answer.trace.stages.length > 0 || !processStages?.length
      ? answer.trace
      : {
          ...answer.trace,
          stages: processStages,
          toolCalls: processStages.filter((stage) => stage.kind === 'tool').length,
          totalMs: processStages.reduce((sum, stage) => sum + stage.duration, 0),
        };
  const displayed = processTrace === answer.trace ? answer : { ...answer, trace: processTrace };
  const fallbackNotice = answerFallbackNotice(
    displayed === answer ? readerAnswer : { ...readerAnswer, trace: displayed.trace }
  );
  const honesty = answerHonesty({
    caveats: readerAnswer.caveats,
    figures: readerAnswer.figures,
    narrative: readerAnswer.narrative,
    content: readerAnswer.content,
    stages: displayed.trace.stages,
  });
  const processVerdict = answerRunVerdict({
    stages: displayed.trace.stages,
    caveats: readerAnswer.caveats,
    figures: readerAnswer.figures,
    narrative: readerAnswer.narrative,
    content: readerAnswer.content,
  });
  const headline = readerFacingTakeaway(readerAnswer.takeaway, readerAnswer.narrative, {
    figures: readerAnswer.figures,
    content: readerAnswer.content,
  });
  const narrative = readerFacingNarrative(readerAnswer.takeaway, readerAnswer.narrative, {
    figures: readerAnswer.figures,
    content: readerAnswer.content,
  });
  const keepCaveats = ordinaryCaveats;
  const badge = answerBadge(readerAnswer);
  const usedAttachments = processTrace.stages.some((stage) => stage.id === 'attachment');
  const missingDocumentFootnotes = usedAttachments && readerAnswer.document_snippets.length === 0;
  // Null on a run that did not record which identity read the data, and the
  // footer then simply ends earlier. See analytical-execution.ts.
  const dataAccess = dataAccessDisclosure(readerAnswer.executionIdentity);
  /*
   * A label is not an id: two measures can both be called "Current", and keying
   * only on it makes React reconcile the second against the first. The content
   * signature is stable if figures move, unlike an array position. Exact
   * duplicates get an occurrence suffix so even a repeated object stays present.
   */
  const figureOccurrences = new Map<string, number>();
  const keyedFigures = readerAnswer.figures.map((figure) => {
    const signature = JSON.stringify([figure.label, figure.value, figure.display, figure.comparison]);
    const occurrence = figureOccurrences.get(signature) ?? 0;
    figureOccurrences.set(signature, occurrence + 1);
    return { figure, key: `${signature}:${occurrence}` };
  });
  return (
    <Card className="answer-card" id={id}>
      <CardHeader>
        <div className="answer-card-head">
          <div className="answer-card-identity">
            <span className="answer-card-mark">
              <AstrolabeMark size={18} ink="light" />
            </span>
            <div className="answer-card-badges flex flex-wrap items-center gap-1.5">
              <Badge variant={badge.variant} className="provenance-chip" data-tone={badge.tone}>
                {badge.label}
              </Badge>
              {headerExtra}
              {honesty.tone === 'partial' && (
                <Badge variant="outline" className="provenance-chip ast-pill ast-pill--warn">
                  {honesty.eyebrow}
                </Badge>
              )}
              {fallbackNotice && (
                <Badge variant="outline" className="provenance-chip" data-tone={fallbackNotice.tone}>
                  {fallbackNotice.badge}
                </Badge>
              )}
            </div>
          </div>
          {headline ? (
            <CardTitle className="answer-takeaway">
              <EntityText text={headline} sources={readerAnswer.sources} />
            </CardTitle>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="answer-card-content">
        {/* First in the card, above the narrative and the figures, because it
            governs how every number below it should be read. Below them it was
            a footnote to a conclusion the reader had already drawn. */}
        {fallbackNotice && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>
              {/* One child, holding the whole sentence. AppKit lays the
                  description slot out as a grid that puts every direct child on
                  a row of its own, so the bolded headline and the sentence
                  continuing it would otherwise break across two rows mid-
                  sentence -- the defect that shipped the storage banner reading
                  "Nothing stored yet.Lakebase is connected". */}
              <p>
                <strong>{fallbackNotice.headline}</strong>
              </p>
            </AlertDescription>
          </Alert>
        )}
        <div className="answer-main-row">
          <div className="answer-narrative">
            <AnswerProse
              text={narrative}
              sources={readerAnswer.sources}
              columns={mentionedIdentifiers([narrative])}
              blocks="prose"
            />
            {readerAnswer.content ? (
              <AnswerProse
                text={readerAnswer.content}
                sources={readerAnswer.sources}
                columns={mentionedIdentifiers([readerAnswer.content])}
                badges
                blocks="prose"
              />
            ) : null}
          </div>
          {readerAnswer.figures.length > 0 ? (
            <aside className="answer-stat-rail" aria-label="Key figures">
              {keyedFigures.map(({ figure, key }) => (
                <div className="answer-stat" key={key}>
                  <span className="answer-stat-label">{figure.label}</span>
                  <b className="answer-stat-value ast-num">{figure.display ?? figure.value}</b>
                  {/* Two visible lines keep the baseline in the card without
                      making the stat rail sprawl. The focusable text expands in
                      place, so keyboard and touch readers can reach the complete
                      comparison without depending on a pointer-only title. */}
                  {figure.comparison ? (
                    <span
                      className="answer-stat-context provenance-detail"
                      tabIndex={0}
                      aria-label={`Comparison: ${figure.comparison}`}
                    >
                      {figure.comparison}
                    </span>
                  ) : null}
                </div>
              ))}
            </aside>
          ) : null}
        </div>
        {/* Charts XOR tables, which is the specification's rule and is about what
            the reader is shown, not about what the answer is allowed to keep. One
            representation of a set of numbers is evidence; the same numbers twice
            is a reader checking a chart against a table instead of reading either.

            So when this answer charted, the Markdown rows are FOLDED rather than
            dropped. Two things made folding necessary instead of the plain `else`
            this was:

            1. A chart can fail to draw -- a chunk that 404s after a redeploy, a
               spec Plotly refuses -- and the panel then said so into a card with
               no figures anywhere in it. The evidence was gone and the answer
               still read as answered. `chartsFailed` unfolds the rows.
            2. A plot summarises. The two-panel rule pairs a full series with a
               recent window, so the rows behind it can hold dates and values no
               panel plots. A reader who wants those had nowhere to go.

            Folded, so the card still reads as one piece of evidence. Reachable,
            so nothing the agent measured is only in a picture. */}
        <AnswerEvidence
          narrative={narrative}
          content={readerAnswer.content}
          charts={readerAnswer.charts}
          sources={readerAnswer.sources}
        />
        {afterEvidence}
        <SourcesModule
          sources={readerAnswer.sources}
          caveats={keepCaveats}
          derivation={readerAnswer.derivation}
          sql={readerAnswer.sql}
          hideWorkspaceLinks={evidenceLinkedSourceNames(
            narrative,
            readerAnswer.content,
            readerAnswer.charts,
            readerAnswer.sources
          )}
        />
        {readerAnswer.document_snippets.length > 0 ? (
          <section className="answer-content document-footnotes" aria-label="Document footnotes">
            <h3 className="answer-heading">Document footnotes</h3>
            <ol>
              {readerAnswer.document_snippets.map((snippet) => (
                <li key={`${snippet.filename}-${snippet.quote}-${snippet.supports}`}>
                  <q>{snippet.quote}</q>
                  <p>
                    <strong>{snippet.filename}</strong> supports {snippet.supports}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {missingDocumentFootnotes ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>
              Validation: Verify document-based claims against the attached reports before using them.
            </AlertDescription>
          </Alert>
        ) : null}
        {/* Two layers over the same run, deliberately not the same view twice.
            The right-hand rail is "what happened, in order"; this is "where the
            time went". It used to hold a horizontal strip of step cards, which
            was the rail's content again in a second shape, so a reader who
            opened it learnt nothing they had not already been shown.

            "And does it reconcile" was the other half of that sentence, and it
            went with the line that answered it: the reconciliation figures --
            wall clock against recorded activity, and the difference as
            unaccounted -- were removed on request. The panel measures where the
            time went and does not audit itself in front of the reader.

            One panel rather than a bar and a separate box under it: the head
            and the timeline are the same disclosure, and two edges around them
            read as two sections of which one happens to be a heading. What is
            drawn inside is TraceTimeline's, and this file owns only the
            container it is drawn in. */}
        {/* The panel's edge is on a wrapper rather than on the Collapsible
            itself, so that trace-panel.test.ts keeps its literal on the element
            whose default state it is there to pin. */}
        {showRunProcess && recorded && (
          <div className="run-process">
            <Collapsible open={showProcess} onOpenChange={changeProcessVisibility}>
              <div className="run-process-head">
                <p className="font-medium text-sm">Run process</p>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm">
                    {showProcess ? 'Hide process' : 'View process'}
                    <ChevronDown className={`transition-transform ${showProcess ? 'rotate-180' : ''}`} />
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="run-process-body">
                <TraceTimeline
                  trace={processTrace}
                  question={question}
                  verdict={processVerdict}
                  variant={runProcessVariant}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
        {recorded ? (
          <>
            <div className="advanced-row">
              <div>
                {/* The toggle row's label takes its size and weight from
                    `.advanced-row > div > p` in answer-body.css. */}
                <p>Advanced trace details</p>
              </div>
              <StateSwitch checked={advanced} onCheckedChange={setAdvanced} aria-label="Show advanced trace details" />
            </div>
            {advanced && (
              <Tabs defaultValue={hasGeneratedSql ? 'sql' : 'raw'}>
                <TabsList>
                  {hasGeneratedSql ? <TabsTrigger value="sql">Generated SQL</TabsTrigger> : null}
                  <TabsTrigger value="raw">Raw I/O</TabsTrigger>
                </TabsList>
                {hasGeneratedSql ? (
                  <TabsContent value="sql">
                    {/* The one pill recipe stays outlined on this tinted header.
                      SQL itself uses the same structural renderer as live,
                      reloaded Explorer, and Monitoring trace payloads. */}
                    <AnswerSql sql={readerAnswer.sql} />
                  </TabsContent>
                ) : null}
                <TabsContent value="raw">
                  <div className="code-panel">
                    <pre>
                      {JSON.stringify(
                        processTrace.stages.map(({ id, input, output }) => ({ id, input, output })),
                        null,
                        2
                      )}
                    </pre>
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </>
        ) : null}
        {showFeedback && (
          <div className="feedback">
            <span>Was this answer useful?</span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Mark answer helpful"
              aria-pressed={feedback.sentiment === 'up'}
              className={`feedback-rating feedback-rating--up${feedback.sentiment === 'up' ? ' feedback-chosen' : ''}`}
              disabled={feedback.saving}
              onClick={() => {
                onFeedbackChange({ open: false, comment: '' });
                void saveFeedback('up');
              }}
            >
              <ThumbsUp aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Mark answer not helpful"
              aria-pressed={feedback.sentiment === 'down'}
              className={`feedback-rating feedback-rating--down${feedback.sentiment === 'down' ? ' feedback-chosen' : ''}`}
              disabled={feedback.saving}
              onClick={() => {
                onFeedbackChange({ open: true });
                void saveFeedback('down', { keepCommentOpen: true });
              }}
            >
              <ThumbsDown aria-hidden="true" />
            </Button>
            {feedback.open && (
              <div className="feedback-comment">
                <Input
                  ref={feedbackInputRef}
                  value={feedback.comment}
                  onChange={(event) => onFeedbackChange({ comment: event.target.value })}
                  placeholder="What could be better?"
                  aria-label="Tell us what could be better"
                />
                <Button size="sm" disabled={feedback.saving} onClick={() => void saveFeedback('down')}>
                  {feedback.saving ? 'Saving…' : 'Save feedback'}
                </Button>
              </div>
            )}
            {feedback.saved && (
              <span className="saved" role="status" aria-live="polite">
                <Check /> Feedback saved
              </span>
            )}
            {feedback.error && (
              <span className="feedback-error" role="alert" aria-live="assertive">
                {feedback.error}
              </span>
            )}
          </div>
        )}
        {/* The identity sentence is the run's, not a constant. It read "Data
            access executed by the Player Insights service principal", which was
            true of an arrangement this app no longer uses: the reader's token is
            forwarded to the endpoint and the model is logged with user
            authorization, so the warehouse enforces the reader's own grants. A
            footer naming a service principal told every reader the one thing
            about their answer this product exists to be trusted on, backwards.
            `dataAccessDisclosure` says what the run reported, and says nothing
            at all where nothing reported one: a run with no recorded identity
            is not a run to make any claim about, in either direction.

            Kept on its own line because the generic AI caveat must contain only
            its shared sentence; access provenance is evidence about this run,
            not boilerplate about AI. */}
        {dataAccess ? <p className="data-access-note">{dataAccess}</p> : null}
        <AIAnalysisCaveat className="ai-note" />
      </CardContent>
    </Card>
  );
}

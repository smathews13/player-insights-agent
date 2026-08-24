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
import { useState } from 'react';
import { dataAccessDisclosure } from './analytical-execution';
import { answerBadge, answerFallback, ANSWER_FALLBACK_NOTICES, splitCaveats } from './degraded-answer';
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
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './ui';
import { Check, ChevronDown, CircleAlert, ThumbsDown, ThumbsUp } from 'lucide-react';
import { AnswerCharts } from './AnswerCharts';
import { AstrolabeMark } from './AstrolabeMark';
import { AnswerProse, EntityText } from './DataEntityLinks';
import { parseAnswerMarkdown } from './answer-markdown';
import { mentionedIdentifiers } from './data-entities';
import { SourcesModule } from './SourcesModule';
import { TraceTimeline } from './TraceTimeline';
import { ratedThumb } from './stored-feedback';
import type { Answer, FeedbackEntry } from './app-types';

export function AnswerCard({
  answer,
  id,
  question = '',
  feedback,
  onFeedbackChange,
  saveFeedback,
  showFeedback,
  showRunProcess = true,
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
  saveFeedback: (rating: number) => Promise<void>;
  showFeedback: boolean;
  /**
   * Whether this card draws the run process panel, or the surface around it does.
   *
   * True everywhere the card is the whole run view, which is Ask PIA's transcript.
   * False in Monitoring's drawer, which draws the timeline itself under its own
   * "What ran" heading and captions it with the run's token count and its trace
   * links. Left on, the drawer showed two Step timelines listing the same steps,
   * one inside this card and one below it.
   *
   * A flag rather than a deletion because the panel is not redundant in general:
   * it is redundant on a surface that already draws one. Same reason and the same
   * shape as `showFeedback`, which is off in that drawer because the rating there
   * belongs to the asker rather than to the admin reading it.
   */
  showRunProcess?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  /** Which thumb this answer's rating lights, or neither. See stored-feedback.ts. */
  const rated = ratedThumb(feedback.usefulness);
  /**
   * Open, because a reader who wanted the timing had to find the control first
   * and nothing under it is expensive to render. Still closable, and nothing
   * remembers the choice: a stored "shut" from before this default would have
   * hidden the panel from exactly the readers who asked for it.
   */
  const [showProcess, setShowProcess] = useState(true);
  /**
   * Whether the Markdown evidence rows are unfolded under this answer's charts.
   *
   * Shut, because the charts are the evidence when an answer has them. A chart
   * that fails to draw opens it (see the evidence section below), and it stays a
   * control the reader can shut again afterwards: a failed panel is a reason to
   * show the numbers, not a reason to take the choice away.
   */
  const [showRows, setShowRows] = useState(false);
  // A degradation is not a caveat about the answer, it is a statement about
  // whether the answer is the answer. Separated so it can be shown above the
  // figures instead of below them in a list of five, see degraded-answer.ts.
  const { degraded: degradedCaveats, ordinary: ordinaryCaveats } = splitCaveats(answer.caveats);
  // Whether this card may be read as an answer to the question at all, and if
  // not, which of the two ways it failed. See degraded-answer.ts for why this
  // reads `mode` rather than looking for the representative caveat.
  const fallback = answerFallback(answer);
  const badge = answerBadge(answer);
  const usedAttachments = answer.trace.stages.some((stage) => stage.id === 'attachment');
  const missingDocumentFootnotes = usedAttachments && answer.document_snippets.length === 0;
  // Null on a run that did not record which identity read the data, and the
  // footer then simply ends earlier. See analytical-execution.ts.
  const dataAccess = dataAccessDisclosure(answer.executionIdentity);
  const hasCharts = Array.isArray(answer.charts) && answer.charts.length > 0;
  const hasTables = [answer.narrative, answer.content ?? ''].some((text) =>
    parseAnswerMarkdown(text).some((block) => block.kind === 'table')
  );
  const evidenceTables = (
    <>
      <AnswerProse
        text={answer.narrative}
        sources={answer.sources}
        columns={mentionedIdentifiers([answer.narrative])}
        blocks="tables"
      />
      {answer.content ? (
        <AnswerProse
          text={answer.content}
          sources={answer.sources}
          columns={mentionedIdentifiers([answer.content])}
          blocks="tables"
        />
      ) : null}
    </>
  );
  /*
   * A label is not an id: two measures can both be called "Current", and keying
   * only on it makes React reconcile the second against the first. The content
   * signature is stable if figures move, unlike an array position. Exact
   * duplicates get an occurrence suffix so even a repeated object stays present.
   */
  const figureOccurrences = new Map<string, number>();
  const keyedFigures = answer.figures.map((figure) => {
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
              {fallback && (
                <Badge variant="destructive" className="provenance-chip" data-tone="stored">
                  {ANSWER_FALLBACK_NOTICES[fallback].badge}
                </Badge>
              )}
            </div>
          </div>
          <CardTitle className="answer-takeaway">{answer.takeaway}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="answer-card-content">
        {/* First in the card, above the narrative and the figures, because it
            governs how every number below it should be read. Below them it was
            a footnote to a conclusion the reader had already drawn. */}
        {fallback && (
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
                <strong>{ANSWER_FALLBACK_NOTICES[fallback].headline}</strong>{' '}
                {/* Whatever produced the card stated the reason here, which for a
                    prose reply is PROSE_ONLY_ANSWER_CAVEAT and for an agent that
                    fell back to its own SQL is the agent's own sentence. Empty
                    for a stored demo conversation and for rows written before the
                    ask route stopped answering failures from the fixture, where
                    the headline above is the whole of what is known. */}
                {degradedCaveats.length > 0 && <EntityText text={degradedCaveats.join(' ')} sources={answer.sources} />}
              </p>
            </AlertDescription>
          </Alert>
        )}
        <div className="answer-main-row">
          <div className="answer-narrative">
            <AnswerProse
              text={answer.narrative}
              sources={answer.sources}
              columns={mentionedIdentifiers([answer.narrative])}
              blocks="prose"
            />
            {answer.content ? (
              <AnswerProse
                text={answer.content}
                sources={answer.sources}
                columns={mentionedIdentifiers([answer.content])}
                badges
                blocks="prose"
              />
            ) : null}
          </div>
          {answer.figures.length > 0 ? (
            <aside className="answer-stat-rail" aria-label="Key figures">
              {keyedFigures.map(({ figure, key }) => (
                <div className="answer-stat" key={key}>
                  <span className="answer-stat-label">{figure.label}</span>
                  <b className="answer-stat-value ast-num">{figure.display ?? figure.value}</b>
                  {/* `title` because the rail clips this line to one row: a
                      comparison naming a window and a baseline is longer than a
                      quarter-width column, and ellipsised it stopped saying what
                      the figure is being compared against. */}
                  {figure.comparison ? (
                    <span className="answer-stat-context" title={figure.comparison}>
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
        {hasCharts || hasTables ? (
          <section className="answer-evidence" aria-label={hasCharts ? 'Chart evidence' : 'Table evidence'}>
            {hasCharts ? <AnswerCharts charts={answer.charts} onFailure={() => setShowRows(true)} /> : null}
            {hasCharts && hasTables ? (
              <Collapsible open={showRows} onOpenChange={setShowRows}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="answer-evidence-rows">
                    {showRows ? 'Hide the rows' : 'Show the rows behind this'}
                    <ChevronDown className={`transition-transform ${showRows ? 'rotate-180' : ''}`} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>{evidenceTables}</CollapsibleContent>
              </Collapsible>
            ) : null}
            {!hasCharts && hasTables ? evidenceTables : null}
          </section>
        ) : null}
        <SourcesModule sources={answer.sources} caveats={ordinaryCaveats} derivation={answer.derivation} />
        {answer.document_snippets.length > 0 ? (
          <section className="answer-content document-footnotes" aria-label="Document footnotes">
            <h3 className="answer-heading">Document footnotes</h3>
            <ol>
              {answer.document_snippets.map((snippet) => (
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
              Attached reports were used, but this answer includes no document footnotes or quoted snippets. Verify its
              document-based claims against the attachments before using them.
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
        {showRunProcess && (
          <div className="run-process">
            <Collapsible open={showProcess} onOpenChange={setShowProcess}>
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
                <TraceTimeline trace={answer.trace} question={question} />
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
        <div className="advanced-row">
          <div>
            {/* Both lines take their size, weight and colour from
                `.advanced-row > div > p` in answer-body.css. They carried
                `font-medium text-sm` and `text-xs text-muted-foreground`, and
                the stylesheet already outranked both, so the markup named one
                size the row does not draw and one it happens to agree with. */}
            <p>Advanced trace details</p>
            {/* Two things, not three. The caption named "all declared sources"
                as a third, and the tab behind it was the source list a second
                time: the same names, the same links, the same governance line,
                under a heading promising something the module above had already
                given. */}
            <p>Generated SQL and raw input and output of every stage</p>
          </div>
          <Switch checked={advanced} onCheckedChange={setAdvanced} aria-label="Show advanced trace details" />
        </div>
        {advanced && (
          <Tabs defaultValue="sql">
            <TabsList>
              <TabsTrigger value="sql">Generated SQL</TabsTrigger>
              <TabsTrigger value="raw">Raw I/O</TabsTrigger>
            </TabsList>
            <TabsContent value="sql">
              <div className="code-panel">
                <div>
                  {/* The one pill recipe, outlined rather than filled: this chip
                      sits on the panel's own tinted header band, and a neutral
                      tint on that band reads as a rendering fault rather than as
                      a chip. */}
                  <Badge variant="outline" className="ast-pill ast-pill--neutral-outline">
                    Read only
                  </Badge>
                  <span>Generated by the agent, inspect before reuse</span>
                </div>
                <pre>{answer.sql}</pre>
              </div>
            </TabsContent>
            <TabsContent value="raw">
              <div className="code-panel">
                <pre>
                  {JSON.stringify(
                    answer.trace.stages.map(({ id, input, output }) => ({ id, input, output })),
                    null,
                    2
                  )}
                </pre>
              </div>
            </TabsContent>
          </Tabs>
        )}
        {showFeedback && (
          <div className="feedback">
            <span>Was this answer useful?</span>
            {/* `aria-pressed` and the class both come from the rating the answer
                carries, which is now read back out of the store rather than
                remembered for one session. A reader who rated an answer, was
                told it was saved and came back found both controls blank, and
                the only honest reading of two blank thumbs is that nothing was
                recorded. */}
            <Button
              variant="outline"
              size="icon"
              aria-label="Thumbs up"
              aria-pressed={rated === 'up'}
              className={rated === 'up' ? 'feedback-chosen' : ''}
              disabled={feedback.saving}
              onClick={() => void saveFeedback(5)}
            >
              <ThumbsUp />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Thumbs down"
              aria-pressed={rated === 'down'}
              className={rated === 'down' ? 'feedback-chosen' : ''}
              disabled={feedback.saving}
              onClick={() => onFeedbackChange({ open: true })}
            >
              <ThumbsDown />
            </Button>
            {feedback.open && (
              <div className="feedback-comment">
                <Input
                  value={feedback.comment}
                  onChange={(event) => onFeedbackChange({ comment: event.target.value })}
                  placeholder="What could be better?"
                  aria-label="What could be better?"
                />
                <Button size="sm" disabled={feedback.saving} onClick={() => void saveFeedback(2)}>
                  {feedback.saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
            {feedback.saved && (
              <span className="saved">
                <Check /> Feedback saved
              </span>
            )}
            {/* A rating that did not reach the table must not look recorded, since
                the usefulness figure is computed from that table. */}
            {feedback.error && <span className="feedback-error">{feedback.error}</span>}
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
            is not a run to make any claim about, in either direction. */}
        <p className="ai-note">
          <AstrolabeMark size={14} /> astrolabe analysis. Verify material decisions against cited sources.
          {dataAccess ? ` ${dataAccess}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}

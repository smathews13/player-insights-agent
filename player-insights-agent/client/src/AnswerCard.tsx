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
import { mentionedIdentifiers } from './data-entities';
import { SourcesModule } from './SourcesModule';
import { TraceTimeline } from './TraceTimeline';
import { ratedThumb } from './stored-feedback';
import type { Answer, FeedbackEntry } from './app-types';

/**
 * Whether a comparison reads as a rise, a fall, or neither.
 *
 * Green is the reachable-or-saved colour and red is the failure one, so
 * spending either on a figure's delta is a claim about the number's direction.
 * The claim is made only when the string actually opens with a sign, because
 * `comparison` is free text from the agent: "vs. the previous window" carries
 * no direction at all and was previously painted as though it carried a
 * positive one, on the strength of not beginning with a hyphen.
 *
 * Both minus characters count. The agent writes U+2212 in prose it has
 * formatted for display and ASCII hyphen elsewhere, and a check for the second
 * alone read every typographic minus as a rise -- a fall shown in the colour of
 * a gain, which is the one direction error a reader cannot catch from the
 * colour.
 *
 * The sign itself stays in the text, so the direction is never carried by
 * colour alone.
 */
function comparisonDirection(comparison: string | undefined): 'positive' | 'negative' | '' {
  const text = (comparison ?? '').trim();
  if (text.startsWith('-') || text.startsWith('\u2212')) return 'negative';
  if (text.startsWith('+')) return 'positive';
  return '';
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
  return (<Card className="answer-card" id={id}>
      <CardHeader>
        {/* A grid rather than a flex row so the mark aligns to the header row --
            the chip row -- rather than to the top of a block that grows as the
            takeaway wraps. The chip row and the takeaway share the second column,
            which keeps the takeaway indented under the chips; the mark centres
            against the chip row in the first. Placement is in answer.css. */}
        <div className="answer-card-head">
          {/* The mark is the agent, so the card an answer arrives in is signed
              with the drawing the top bar carries rather than with a figure of
              its own. 32 because the seat is 32: the graduation ring is dropped
              below that, and a smaller size here would paint the small cut and
              let the stylesheet scale it back up to a blunter mark. */}
          <div className="agent-avatar">
            <AstrolabeMark size={32} />
          </div>
          <div className="answer-card-badges flex flex-wrap items-center gap-1.5">
              {/* Three tones, from `tone` rather than from `variant`: solid navy
                  for a live answer, the warning family tinted for one whose
                  narrative is live and whose figures are stored, and a solid
                  negative for one where nothing ran. The third exists because
                  the first two of those are different amounts of wrong and
                  `variant` cannot say so -- it is AppKit's, it has no rung
                  between fine and failure, and both non-live answers wore the
                  same chip.

                  Deliberately not the action colour: blue is what you press in
                  this app, and a blue pill above the takeaway reads as a control
                  rather than as a statement about where the figures came from.

                  Not secondary either, for the two that are not live. A grey
                  chip reading "Representative response" sat beside a complete,
                  confident, correct-looking answer and read as a label for a
                  demo mode rather than as a warning that none of the numbers
                  under it were queried. */}
              <Badge variant={badge.variant} className="provenance-chip" data-tone={badge.tone}>
                {badge.label}
              </Badge>
              {/* Beside the "Live agent response" badge, because that badge is
                  the thing being qualified. A run whose Genie space refused it
                  is still a live run and still earns the badge, and the badge
                  alone reads as an assurance the answer has not earned. */}
              {fallback && (<Badge variant="destructive" className="provenance-chip" data-tone="stored">
                  {ANSWER_FALLBACK_NOTICES[fallback].badge}
                </Badge>
              )}
          </div>
          <CardTitle className="answer-takeaway">{answer.takeaway}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* First in the card, above the narrative and the figures, because it
            governs how every number below it should be read. Below them it was
            a footnote to a conclusion the reader had already drawn. */}
        {fallback && (<Alert variant="destructive">
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
                {degradedCaveats.length > 0 && (<EntityText text={degradedCaveats.join(' ')} sources={answer.sources} />
                )}
              </p>
            </AlertDescription>
          </Alert>
        )}
        {/* The tables this answer declared as sources are links to where the app
            tracks them, rather than inert text a reader has to go and look up.
            Only those, and only when the Connections page has a row for them, see
            data-entities.ts for why that pair of rules is the whole feature.

            The columns are marked as well, which they were not: `columns` was
            left empty here and filled only for the caveats, so a narrative that
            said the figure came from `active_players` set the one word a reader
            was looking for in the same grey as the sentence around it. The
            candidate set is the identifiers this narrative itself names, and
            the underscore rule in data-entities.ts is what keeps an English
            word out of it. */}
        <AnswerProse
          className="leading-7"
          text={answer.narrative}
          sources={answer.sources}
          columns={mentionedIdentifiers([answer.narrative])}
        />
        {answer.content ? (<section className="answer-content" aria-label="Answer content">
            <h3 className="answer-heading">Content</h3>
            {/* The data package is a list of values, not sentences: the window
                and the labels are set as badges here so the four facts on the
                line read as four rather than as one run of grey. The source
                table beside them was already a chip. See answer-badges.ts. */}
            <AnswerProse
              text={answer.content}
              sources={answer.sources}
              columns={mentionedIdentifiers([answer.content])}
              badges
            />
          </section>
        ) : null}
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
              Attached reports were used, but this answer includes no document footnotes or quoted
              snippets. Verify its document-based claims against the attachments before using them.
            </AlertDescription>
          </Alert>
        ) : null}
        {/* Above the figure breakdown: the chart is the shape of the result, the figures
            beneath it are the numbers that shape is made of. Renders nothing when the
            answer carries no charts, which is every representative answer. */}
        <AnswerCharts charts={answer.charts} />
        {answer.figures.length > 0 && (<Card className="chart-card">
            <CardHeader>
              <CardTitle>Result breakdown</CardTitle>
            </CardHeader>
            <CardContent className="bar-chart">
              {answer.figures.map((figure) => (<div className="bar-row" key={figure.label}>
                  <span>{figure.label}</span>
                  <div>
                    <i style={{ width: `${Math.min(Math.max(figure.value, 0), 100)}%` }} />
                  </div>
                  {/* `.ast-num` is DM Mono, and it is here because of where this
                      figure sits rather than because of what it is. It is a
                      column: a second value sits directly above and below it on
                      every answer with more than one row, so the digits have to
                      line up. They could not before, whatever the stylesheet
                      said -- DM Sans in this repository declares no `tnum`
                      feature and its digits are proportional, a `1` being just
                      over half the width of a `0`, so `font-variant-numeric`
                      was switching on a feature the file does not carry. */}
                  <b className="ast-num">{figure.display ?? figure.value}</b>
                  {/* Guarded: the response is cast, not validated, and a figure missing its
                      comparison would otherwise throw and blank the whole transcript.
                      Mono for the same reason as the value: it is read down the
                      column beside it. */}
                  <em className={`ast-num ${comparisonDirection(figure.comparison)}`.trim()}>{figure.comparison}</em>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        {/* Where the answer came from and what to keep in mind about it, as one
            card. It was three: this strip, an "All sources" tab under Advanced
            trace details listing the same tables again, and a standalone amber
            caveats box below both. The strip and the tab each printed the
            governance line and an "Open in Databricks" link on every row, so an
            answer that read five tables said the same two facts ten times and
            the one fact that differs per row -- what each table was read for --
            was the hardest thing in the block to find.

            Every table the run read, not the first one. This was `sources[0]`,
            and the list is in the order the run read them, so an answer that
            looked up two definitions and then queried three tables cited the
            dictionary and nothing else.

            The caveats are the module's footer and are passed here rather than
            drawn separately, so an answer with caveats and no sources still
            renders the card with the footer alone. The component is shared with
            the Run Explorer's Final answer tab, which used to render no caveats
            whatsoever, so the same answer disclosed less the second time it was
            read. */}
        <SourcesModule
          sources={answer.sources}
          caveats={ordinaryCaveats}
          derivation={answer.derivation}
        />
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
        {showRunProcess && (<div className="run-process">
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
        {advanced && (<Tabs defaultValue="sql">
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
                  {JSON.stringify(answer.trace.stages.map(({ id, input, output }) => ({ id, input, output })),
                    null,
                    2
                  )}
                </pre>
              </div>
            </TabsContent>
          </Tabs>
        )}
        {showFeedback && (<div className="feedback">
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
            {feedback.open && (<div className="feedback-comment">
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
            {feedback.saved && (<span className="saved">
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

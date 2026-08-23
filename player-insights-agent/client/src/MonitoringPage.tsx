/**
 * Monitoring: every question anyone has asked this deployment, and one question
 * in full.
 *
 * Modelled on the Monitor tab of a Databricks Genie Agent, which is the surface
 * this audience already knows. Three levels in one page rather than a modal
 * stack: the strip, the list, and a right-hand drawer over the list. The drawer
 * is not a route change, so closing it returns the reader to their filters and
 * their place.
 *
 * WHAT THIS FILE DOES NOT DECIDE. Every claim about a number is made in
 * `monitoring-view.ts` and every claim about the URL in `monitoring-filters.ts`,
 * so both can be asserted without rendering anything. This file is layout and
 * ARIA. The things it deliberately does not own at all:
 *
 *  - The Refresh control and its freshness line, which are `RefreshControl`. The
 *    app had four hand-rolled copies of that pair and they had drifted.
 *  - The time-range control, which is shared with Ops so that the two tabs
 *    cannot be over different windows. This page renders it and reads the range
 *    it wrote from the URL, and writes no range parameter itself.
 *  - The answer body, which is Ask PIA's own `AnswerCard`. An admin reading
 *    somebody else's answer should see the answer they saw, and a second
 *    renderer here would eventually show them a different one.
 *  - The timeline, which is the existing `TraceTimeline`.
 *  - The storage-failure panel, which is `UnavailablePanel`.
 *
 * NO POLLING. This is a review surface, not a console. An admin reading a
 * conversation does not want the list reordering underneath them, and the query
 * behind it scans every message in the range.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Search, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { astPill, type AstPillFamily } from './astrolabe-pill';
import { BrandIcon } from './BrandIcon';
import { Button, Input, Skeleton } from './ui';
import { AppSelect } from './AppSelect';
import { PageHeading } from './page-chrome';
import { RefreshControl } from './RefreshControl';
import { UnavailablePanel } from './UnavailablePanel';
import { unavailableNotice } from './unavailable-copy';
import { AnswerCard } from './AnswerCard';
import { TraceTimeline } from './TraceTimeline';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { UserIdentityChip } from './UserIdentityChip';
import { identityName, possessiveName } from './user-identity';
import type { Answer, FeedbackEntry } from './app-types';
import {
  answerTimeTile,
  askedAtLabel,
  askerGrantsLine,
  conditioningLine,
  emptyCopy,
  formatDuration,
  grantBadge,
  GRANTS_UNRESOLVED_LINE,
  LIVE_VERSUS_RECORDED,
  localPart,
  medianAnswerTimeTile,
  monitoringState,
  newestFirst,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  outcomeTile,
  partialSentence,
  peopleAskingTile,
  questionsAskedTile,
  ratedHelpfulTile,
  ratedTile,
  readScopes,
  tablesReadTile,
  tokenCostTile,
  tokensTile,
  whatRanHeading,
  whenLabel,
  type EmptyState,
  type MonitoringState,
  type TileValue,
} from './monitoring-view';
import {
  applyFilters,
  chipsActive,
  clearedFilters,
  closedDrawer,
  drawerFromParams,
  filtersActive,
  filtersFromParams,
  onlyDrawerChanged,
  openPerson,
  openQuestion,
  scrollMemory,
  withFilters,
  type MonitoringFilters,
} from './monitoring-filters';
// Shared with Ops, so the two tabs cannot be over different windows.
import { TimeRangeControl } from './TimeRangeControl';
import { rangeWindow } from './time-range';
import { codesForCause } from '../../shared/monitoring-contract';
import type {
  MonitoringDetail,
  MonitoringQuestion,
  MonitoringQuestionsPayload,
  PersonPanelPayload,
} from '../../shared/monitoring-contract';

/* ── The summary strip ───────────────────────────────────────────────────── */

/** One hairline tile. A tile never renders blank and never renders both. */
export function SummaryTile({ label, tile }: { label: string; tile: TileValue }) {
  return (
    <div className="monitoring-tile">
      <p className="monitoring-tile-label">{label}</p>
      {tile.value !== null ? (
        <p className="monitoring-tile-value ast-num">{tile.value}</p>
      ) : (
        /* Not a dash and not a zero. The sentence is the value here, at body
           size rather than at the figure size, so it does not read as a
           measurement. */
        <p className="monitoring-tile-absent">{tile.absence}</p>
      )}
      <p className="monitoring-tile-caption">{tile.caption}</p>
    </div>
  );
}

/**
 * The five figures, of which the third is one tile holding four run outcomes.
 *
 * REFUSED AND FAILED ARE NEVER ADDED, here or anywhere. A refusal is the app
 * working correctly and telling somebody they cannot read something; a failure is
 * the app not working. The two are separately coloured and separately counted,
 * and the caption only claims they sum to the questions asked when they do.
 */
export function SummaryStrip({ payload, rangeLabel }: { payload: MonitoringQuestionsPayload; rangeLabel: string }) {
  const outcomes = outcomeTile(payload.summary);
  return (
    <div className="monitoring-strip" aria-label="Summary for the selected range">
      <SummaryTile label="Questions asked" tile={questionsAskedTile(payload.summary, rangeLabel)} />
      <SummaryTile label="People asking" tile={peopleAskingTile(payload.summary)} />
      <div className="monitoring-tile">
        <p className="monitoring-tile-label">Completed · Partial · Refused · Failed</p>
        <p className="monitoring-tile-value ast-num">
          <span>{outcomes.completed}</span>
          <span className="monitoring-partial"> · {outcomes.partial}</span>
          <span className="monitoring-refused"> · {outcomes.refused}</span>
          <span className="monitoring-failed"> · {outcomes.failed}</span>
        </p>
        <p className="monitoring-tile-caption">{outcomes.caption}</p>
      </div>
      <SummaryTile label="Rated helpful" tile={ratedHelpfulTile(payload.summary)} />
      <SummaryTile label="Median answer time" tile={medianAnswerTimeTile(payload.summary)} />
    </div>
  );
}

/** The skeleton strip, which is five tiles of the same geometry and no numbers. */
function SkeletonStrip() {
  return (
    <div className="monitoring-strip" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="monitoring-tile" key={index}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/* ── The filter row ──────────────────────────────────────────────────────── */

/**
 * "No filter", as a value the menu can hold.
 *
 * Radix refuses an item whose value is the empty string, because that is how it
 * represents "nothing chosen" internally. So the unset state travels as this
 * sentinel between the control and the URL, where it is '' as it always was.
 */
const NO_FILTER = '__any__';

/**
 * One filter dropdown: the app's own Select, not a native one.
 *
 * It was a native `<select>`. A native select opens the operating system's menu,
 * which is drawn by the platform and cannot be styled where it matters, so it
 * looked like nothing else in the app and appeared detached from the control
 * that opened it. This is the same Radix Select the rest of the app's components
 * come from, through `./ui`: it opens anchored to the trigger, at the trigger's
 * width, and it is drawn by the app, so it takes DuBois tokens like everything
 * else.
 *
 * Accessibility is not traded for the appearance. The trigger is a combobox
 * whose accessible name is the filter and whose value is the current choice, so
 * a reader hears "Person, All" as it heard from the native control. Arrow keys
 * move through the options, typing jumps to one, Escape dismisses, and the
 * chosen option carries a tick in the open menu rather than being marked only on
 * the closed trigger.
 */
function FilterChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  /** The first is the unset option, and its label is the word for "no filter". */
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const active = value !== '';
  const selectOptions = options.map((option) => ({
    value: option.value || NO_FILTER,
    label: option.label,
  }));
  return (
    <span className={active ? 'monitoring-chip monitoring-chip-active' : 'monitoring-chip'}>
      <AppSelect
        label={label}
        ariaLabel={label}
        value={active ? value : NO_FILTER}
        options={selectOptions}
        onValueChange={(next) => onChange(next === NO_FILTER ? '' : next)}
        className="monitoring-chip-trigger"
        contentClassName="monitoring-chip-menu"
      />
      {/* Only when set, and outside the trigger: a button inside a button is not
          a thing, and the trigger is a button. */}
      {active ? (
        <button
          type="button"
          className="monitoring-chip-clear"
          onClick={() => onChange('')}
          aria-label={`Clear the ${label.toLowerCase()} filter`}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * The search box, which is Run Explorer's search box.
 *
 * Same `Input`, same magnifying glass, same `.run-search` class, so the two
 * surfaces match rather than resembling each other. It is not imported as a
 * component because there is no component: Run Explorer holds the markup inline,
 * and pulling it out would mean editing that file, which another agent has open.
 * Sharing the class is the version of "reuse" available today; when that file is
 * free, this and it should become one component.
 *
 * TYPING IS LOCAL, THE URL IS DEBOUNCED. The field is driven from local state so
 * that every keystroke shows immediately, and the URL is written a short moment
 * after typing stops. Writing on each keystroke put one history entry per letter
 * in the browser's back button, which made the back button useless for its
 * actual job of leaving the page.
 */
const SEARCH_URL_DELAY_MS = 250;

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [typed, setTyped] = useState(value);
  // Held in a ref so the debounce timer below does not restart every time the
  // parent re-renders and hands down a new closure. Written in an effect rather
  // than during render, which is the rule and also the honest description of when
  // it happens.
  const commit = useRef(onChange);
  useEffect(() => {
    commit.current = onChange;
  }, [onChange]);

  // The URL is the store, so a value arriving from it wins: a back button press,
  // a pasted link or a cleared-filters action has to be able to move this field.
  useEffect(() => {
    setTyped(value);
  }, [value]);

  useEffect(() => {
    if (typed === value) return;
    const timer = setTimeout(() => commit.current(typed), SEARCH_URL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, value]);

  // Clearing is immediate rather than debounced. The delay above exists to keep
  // one history entry per word instead of one per letter while somebody types;
  // pressing a clear button is a finished intention, and making it wait a
  // quarter second reads as the button not having worked.
  const clear = () => {
    setTyped('');
    commit.current('');
  };

  return (
    <div className="run-search monitoring-search">
      <Search />
      <Input
        type="search"
        placeholder="Search questions or people…"
        aria-label="Search questions by text or person"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      {/* The app's own clear, not the browser's. `type="search"` draws a cancel
          button in Chrome and Safari and nothing at all in Firefox, so the only
          way to empty this field was a browser feature a third of readers do
          not have. The native one is hidden in the stylesheet so there are not
          two crosses side by side.

          Drawn only when there is something to clear, and it matches the ✕ on
          the chips beside it, so "there is a cross, press it" is one rule
          across the whole row rather than a per-control discovery. */}
      {typed !== '' ? (
        <button type="button" className="monitoring-search-clear" onClick={clear} aria-label="Clear the search">
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The filter row, which stays live while the list is loading.
 *
 * A reader who already knows what they want should not have to wait for a read
 * to finish before they can type it, so this is rendered outside every state
 * branch below and is never disabled.
 */
export function FilterRow({
  filters,
  people,
  tables,
  onChange,
  onClearFilters,
}: {
  filters: MonitoringFilters;
  people: string[];
  tables: string[];
  onChange: (next: MonitoringFilters) => void;
  onClearFilters: () => void;
}) {
  return (
    <div className="monitoring-filters">
      {/* THE PERIOD IS NOT ONE OF THE FILTERS BESIDE IT, and this group exists to
          say so. A question list is always over some window, so "no period" has
          no meaning; there is no state this control can be in that is the
          absence of a choice. The chips to its right are the opposite: every one
          of them has an off position and a ✕ that reaches it.

          Sam read the segmented control as one of those, tried to unclick the
          active segment, and nothing happened. That is the control behaving
          correctly and looking wrong. So it now carries a name, sits in its own
          bordered group, and is separated from the chips by a rule. A reader who
          can see it is a labelled selector rather than a set chip stops looking
          for a cross on it.

          IT HAS AN ALL-TIME SEGMENT, and it no longer rests on the store being
          small. It used to: the read paired each answer to its question with a
          correlated subquery and joined on the RESULT of that subquery, which no
          index can serve, so the pairing ran once per question and the cost grew
          with the square of the questions in the window. That was held back
          twice, and shipped once with a line on the page warning about the
          growth instead of a guard.

          `MONITORING_QUESTIONS_QUERY` now pairs in the other direction: a page
          of the newest questions first, then two indexed lookups per question on
          that page. The answer-side work is bounded by the PAGE rather than by
          the window, so an unbounded range costs a page what a day costs, and
          the warning it needed is gone with it. The range's own totals are still
          proportional to the window, deliberately, because an exact denominator
          is worth an index scan. Section 5.8 of the admin Monitoring and Ops
          plan has all of it, and the note on that query has the rest. */}
      <span className="monitoring-period">
        {/* Visual only. The group inside already carries "Time range for
            Monitoring" as its accessible name, so a second name here would be
            read twice. */}
        <span className="monitoring-period-label" aria-hidden="true">
          Period
        </span>
        {/* The shared control, imported rather than copied, so this tab and Ops
            cannot be over different windows. It owns the range parameters in the
            URL; nothing on this page writes them. */}
        <TimeRangeControl page="Monitoring" />
      </span>
      <span className="monitoring-filters-rule" aria-hidden="true" />
      <FilterChip
        label="Person"
        value={filters.person}
        onChange={(person) => onChange({ ...filters, person })}
        options={[{ value: '', label: 'All' }, ...people.map((email) => ({ value: email, label: localPart(email) }))]}
      />
      <FilterChip
        label="Outcome"
        value={filters.outcome}
        onChange={(outcome) => onChange({ ...filters, outcome: outcome as MonitoringFilters['outcome'] })}
        options={[
          { value: '', label: 'All' },
          { value: 'completed', label: 'Completed' },
          { value: 'partial', label: 'Partial' },
          { value: 'refused', label: 'Refused' },
          { value: 'failed', label: 'Failed' },
        ]}
      />
      <FilterChip
        label="Rating"
        value={filters.rating}
        onChange={(rating) => onChange({ ...filters, rating: rating as MonitoringFilters['rating'] })}
        options={[
          { value: '', label: 'All' },
          { value: 'up', label: 'Helpful' },
          { value: 'down', label: 'Not helpful' },
          { value: 'unrated', label: 'Not rated' },
        ]}
      />
      {/* The PIA-specific one, and the one worth more than the others: every
          question whose run read a given table. It is what an admin reaches for
          when a table changes and they want to know who will notice. */}
      <FilterChip
        label="Table"
        value={filters.table}
        onChange={(table) => onChange({ ...filters, table })}
        options={[{ value: '', label: 'Any' }, ...tables.map((table) => ({ value: table, label: table }))]}
      />
      {/* Clearing the whole row, offered here whenever anything is set.
          
          It was only ever offered from the empty state, which meant the reader
          who had filtered down to nothing had a way out and the reader who had
          filtered down to two rows did not. That is the same need: undoing four
          controls one at a time is the work this saves, and having to first
          filter down to zero results to be offered the shortcut is not a design.

          The same words as the empty state's button, deliberately. Two controls
          doing one thing under two names read as two things.

          The period is untouched by this. `clearedFilters` names the five
          parameters this row owns and leaves every other one alone, so a cleared
          view keeps its window and any open drawer. */}
      {filtersActive(filters) ? (
        <Button variant="ghost" size="sm" className="monitoring-clear-all" onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : null}
      {/* Last in the row and pushed to the right edge, which is where Sam asked
          for it. It was between the range control and the Person chip, which put
          a 240px field in the middle of a row of chips and separated the range
          from the filters it applies to.

          The sentence that used to hold this end of the row is gone. See the
          note on `.monitoring-search` in monitoring.css: the behaviour it
          described is unchanged and still tested, and the row now says nothing a
          reader has to decide whether to act on. */}
      <SearchBox value={filters.search} onChange={(search) => onChange({ ...filters, search })} />
    </div>
  );
}

/* ── The question list ───────────────────────────────────────────────────── */

/**
 * The view layer's three tones, in the palette's own families.
 *
 * `monitoring-view.ts` names semantic tones, which are statements
 * about a reading rather than about a colour, and that is the right vocabulary
 * for a module with no stylesheet in front of it. This is the one place the
 * translation happens, so a fourth tone there is a compile error here rather
 * than a pill that renders with no family and no tint.
 *
 * `neutral` takes the OUTLINED form deliberately. A refusal is neither a success
 * nor a failure, and it sits in a table row beside filled green and filled red;
 * a third fill there reads as a third verdict rather than as the absence of one.
 */
const PILL_FAMILY: Record<'ok' | 'warn' | 'neutral' | 'bad', AstPillFamily> = {
  ok: 'pos',
  warn: 'warn',
  neutral: 'neutral-outline',
  bad: 'neg',
};

/** The pill. The word is the status; the tone is decoration over it. */
function OutcomePill({ question }: { question: MonitoringQuestion }) {
  return (
    <span
      className={astPill(PILL_FAMILY[OUTCOME_TONE[question.outcome]], 'monitoring-pill')}
      /* The taxonomy's own sentence for a refusal or a failure, and nothing at
         all where no code was recorded. A generic sentence here would be this
         build describing a refusal it has no definition of. */
      title={question.outcomeDetail ?? undefined}
    >
      {OUTCOME_LABEL[question.outcome]}
    </span>
  );
}

function AskerMark({ email }: { email: string }) {
  return <UserIdentityChip identity={email} compact className="monitoring-asker-who" />;
}

function RatingMark({ rating }: { rating: 'up' | 'down' | null }) {
  if (rating === 'up') return <ThumbsUp className="size-3.5 monitoring-thumb-up" aria-label="Rated helpful" />;
  if (rating === 'down') {
    return <ThumbsDown className="size-3.5 monitoring-thumb-down" aria-label="Rated not helpful" />;
  }
  return <span className="sr-only">Not rated</span>;
}

/**
 * One row per question, and the whole row is one control.
 *
 * Not seven links. A reader clicking a question wants the question, and a row of
 * separately-clickable cells makes them aim. `role="button"` with a key handler
 * rather than a nested `<button>`, because a button spanning a table row cannot
 * be laid out as one and a row of buttons is seven tab stops.
 */
export function QuestionList({
  questions,
  selectedId,
  now,
  onOpen,
}: {
  questions: MonitoringQuestion[];
  selectedId: string;
  now: number;
  onOpen: (question: MonitoringQuestion) => void;
}) {
  return (
    <table className="monitoring-table">
      <thead>
        {/* The widths are the design's, and they are on the header cells because
            that is where a table's column widths are settled. Without them the
            browser sizes every column from its content, which on a range whose
            questions are all short gives six narrow columns and a Question
            column no wider than the rest. The design makes the question the
            largest thing in the row; a rule that only holds when the questions
            happen to be long is not that rule. */}
        <tr>
          <th scope="col">Question</th>
          <th scope="col" className="monitoring-col-asker">
            Asked by
          </th>
          <th scope="col" className="monitoring-col-when">
            When
          </th>
          <th scope="col" className="monitoring-col-outcome">
            Outcome
          </th>
          <th scope="col" className="monitoring-numeric monitoring-col-time">
            Time
          </th>
          <th scope="col" className="monitoring-numeric monitoring-col-tools">
            Tools
          </th>
          <th scope="col" className="monitoring-col-rating">
            Rating
          </th>
        </tr>
      </thead>
      <tbody>
        {newestFirst(questions).map((question) => (
          <tr
            key={question.id}
            role="button"
            tabIndex={0}
            aria-current={question.id === selectedId ? 'true' : undefined}
            className={question.id === selectedId ? 'monitoring-row monitoring-row-selected' : 'monitoring-row'}
            onClick={() => onOpen(question)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onOpen(question);
            }}
          >
            {/* The largest thing in the row, and truncated to two lines rather
                than one: a question is the reader's index into this table, and
                one line of a comparison question is usually the preamble.

                THE CLAMP IS ON THE SPAN, NOT ON THE CELL. A two-line clamp needs
                `display: -webkit-box`, and setting that on a `td` stops the cell
                being a table cell, which takes it out of the column sizing the
                header row above just settled. It was on the cell. */}
            <td className="monitoring-question">
              <span className="monitoring-question-text">{question.question}</span>
            </td>
            {/* The local part, with the full address on hover. A column of
                identical domains is a column of noise. */}
            <td className="monitoring-asker" title={question.askedBy}>
              <AskerMark email={question.askedBy} />
            </td>
            <td className="monitoring-when">{whenLabel(question.askedAt, now)}</td>
            <td>
              <OutcomePill question={question} />
            </td>
            {/*
              A CELL THIS LIST HAS NO FIGURE FOR SAYS NOTHING, and it used to say
              "Not recorded". That is a claim about the world, and this list
              cannot substantiate it.

              What it must not do is stay empty for a run that HAS figures. This
              emptying went in while Monitoring's query paired an approved-plan
              turn to the proposed plan, whose trace carries neither key, so the
              cells were blank for every such run while Run Explorer showed both
              on the next tab. The query now pairs to the answer that carries the
              figures (see MONITORING_QUESTIONS_QUERY), so these cells fill, and
              the two tabs agree.

              Empty is therefore what it says on its face again: this run
              recorded no figure. A table column with no entry on one row is the
              ordinary way a table says it has nothing for that row, and the row
              opens the drawer, where the trace itself is.

              The zero this used to be protecting against is still refused: an
              unmeasured run must never render `0.0s`, and there is no branch
              here that could produce one.
            */}
            <td className="monitoring-numeric ast-num">{formatDuration(question.durationMs) ?? ''}</td>
            <td className="monitoring-numeric ast-num">{question.toolCalls === null ? '' : question.toolCalls}</td>
            <td>
              <RatingMark rating={question.rating} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Eight rows of the same geometry. The filter row above stays live. */
function SkeletonRows() {
  return (
    <div className="monitoring-skeleton-rows" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
        <Skeleton className="h-9 w-full" key={index} />
      ))}
    </div>
  );
}

/* ── The drawer ──────────────────────────────────────────────────────────── */

/**
 * The stored answer as a shape Ask PIA's own card will render, or null.
 *
 * Null for a plan proposal and for a clarification, which are stored in the same
 * column and are not answers. Rendering one through the answer card would put a
 * takeaway of "The agent returned an answer with no summary line." over a
 * question the agent asked back.
 */
function answerFrom(raw: unknown): Answer | null {
  if (!raw || typeof raw !== 'object') return null;
  const wire = raw as WireAnswer;
  if (wire.type !== 'answer' && typeof wire.takeaway !== 'string') return null;
  return normalizeAnswer(wire) as Answer;
}

/**
 * Feedback is read-only here. An admin does not rate somebody else's answer, so
 * the card is passed `showFeedback={false}` and this stands in for state that is
 * never rendered and never written.
 *
 * `usefulness` is null rather than the asker's score deliberately. The score
 * would be drawn as a pressed thumb belonging to the reader looking at it, and
 * an admin who then pressed the other one would be writing over the asker's
 * rating. The asker's rating is reported in the list's own rating column, where
 * it reads as theirs.
 *
 * Annotated rather than inferred so that the next field added to `FeedbackEntry`
 * fails here, at the one place that has to decide what it means for a reader who
 * cannot rate, instead of at the call site.
 */
const READ_ONLY_FEEDBACK: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

export function QuestionDrawer({
  detail,
  onClose,
  onOpenPerson,
}: {
  detail: MonitoringDetail;
  onClose: () => void;
  onOpenPerson: (email: string) => void;
}) {
  const answer = detail.conditioning ? null : answerFrom(detail.answer);
  const trace = (detail.trace ?? null) as Parameters<typeof TraceTimeline>[0]['trace'];
  return (
    <aside className="monitoring-drawer" role="dialog" aria-modal="true" aria-label="Question detail">
      <div className="monitoring-drawer-head">
        <h3 className="monitoring-drawer-question">{detail.question}</h3>
        <Button variant="outline" size="sm" className="monitoring-drawer-close" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </Button>
      </div>
      {/* Who, when, and whose grants the data was read under, in the app's own
          footer wording. Its purpose is narrow and worth stating: an admin
          comparing two people's answers to the same question needs to know why
          the numbers differ, and the reason is usually that the two readers have
          different grants, row filters or column masks.

          Joined rather than concatenated because the third segment is absent on
          a run that recorded no identity, and a hardcoded separator would leave
          the line ending in a dangling middot. */}
      <div className="monitoring-drawer-meta-row">
        <UserIdentityChip identity={detail.askedBy} label="Asked by" compact />
        <p className="monitoring-drawer-meta">
          {[askedAtLabel(detail.askedAt), askerGrantsLine(detail.execution, identityName(detail.askedBy))]
            .filter((segment): segment is string => Boolean(segment))
            .join(' · ')}
        </p>
      </div>

      <div className="monitoring-drawer-links">
        {/* Keep the drilldown's onward actions near its heading, where they are
            available before a long answer and trace. The MLflow action remains
            absent rather than dead when the run recorded no trace id. */}
        {detail.mlflowUrl ? (
          <a href={detail.mlflowUrl} target="_blank" rel="noreferrer">
            {/* Sized by height, not boxed: MLflow is published as a wordmark. */}
            <BrandIcon product="mlflow" size={12} />
            Open the MLflow trace ↗
          </a>
        ) : null}
        {detail.runId ? <Link to={`/runs?run=${encodeURIComponent(detail.runId)}`}>Open in Run Explorer</Link> : null}
        {/* Named, not "this person". The row already says who asked, and a
            reader following the link is going to that person's panel -- so the
            link says whose. The fallback is the old wording, for the run that
            recorded no identity: `identityName` would hand us "Unknown" and
            "see Unknown's activity" names nobody. */}
        <button type="button" className="monitoring-linklike" onClick={() => onOpenPerson(detail.askedBy)}>
          {detail.askedBy?.trim()
            ? `see ${possessiveName(identityName(detail.askedBy))} activity`
            : "see this person's activity"}
        </button>
      </div>

      {detail.conditioning ? (
        /* One line where the content would have been, in the same type as the
           surrounding body text. No warning colour, no icon, no modal, no
           acknowledgement step. Everything below still renders. */
        <p className="monitoring-conditioned">
          {conditioningLine(detail.conditioning.table, detail.conditioning.permission)}
        </p>
      ) : answer ? (
        <AnswerCard
          answer={answer}
          question={detail.question}
          feedback={READ_ONLY_FEEDBACK}
          onFeedbackChange={() => {}}
          saveFeedback={async () => {}}
          showFeedback={false}
          /* The card's own run process panel is off because this drawer draws
             the timeline itself, in the section below, under the heading and
             above the captions that were written for it. With the card's panel
             left on, both were on screen: two Step timelines listing the same
             ten steps, and no way for a reader to tell they were one run. */
          showRunProcess={false}
        />
      ) : (
        /* A refusal or a failure: the taxonomy's own sentence, with the code in
           monospace beneath it. Not a blank panel, and not an invented reason. */
        <div className="monitoring-drawer-outcome">
          <p>{detail.outcomeDetail ?? 'This question produced no stored answer, and no reason was recorded.'}</p>
          {detail.outcomeCode ? <code className="monitoring-code">{detail.outcomeCode}</code> : null}
        </div>
      )}

      <section className="monitoring-drawer-section">
        {/* "What ran", plus the duration and the tool count when the run
            recorded them, which is what 7b draws on this heading. Both come from
            the run's own trace, the same place the list's Time and Tools columns
            read, so the drawer cannot report a duration the row disagrees with.
            A run that recorded neither gets the two words alone rather than a
            heading full of zeroes nobody measured. */}
        <h4 className="monitoring-eyebrow">{whatRanHeading(trace)}</h4>
        {/* The existing timeline, reused rather than respecified, and the only
            one on this surface: see `showRunProcess` on the card above. */}
        <TraceTimeline trace={trace} question={detail.question} />
      </section>

      {detail.tokens ? (
        <p className="monitoring-drawer-tokens">
          {detail.tokens.total === null
            ? 'This run reported no token total, so the total is unknown rather than zero.'
            : `${detail.tokens.total.toLocaleString()} tokens recorded on this run.`}
        </p>
      ) : (
        <p className="monitoring-drawer-tokens">This run was not metred, so no token count was recorded.</p>
      )}

      {detail.rating || detail.usefulness !== null || detail.comment ? (
        <section className="monitoring-drawer-section">
          <h4 className="monitoring-eyebrow">Rating and feedback</h4>
          <p className="monitoring-drawer-rating">
            <RatingMark rating={detail.rating} />
            {detail.rating === 'up' ? 'Rated helpful' : detail.rating === 'down' ? 'Rated not helpful' : 'Not rated'}
            {detail.usefulness !== null ? ` · usefulness ${detail.usefulness} of 5` : ''}
          </p>
          {/* Verbatim. A comment paraphrased is a comment nobody wrote. */}
          {detail.comment ? <p className="monitoring-drawer-comment">{detail.comment}</p> : null}
        </section>
      ) : null}
    </aside>
  );
}

/* ── The per-user panel ──────────────────────────────────────────────────── */

/**
 * A small tile on the person panel. Same absence discipline as the strip.
 *
 * `wide` takes the whole grid row. The one tile that carries a fully-qualified
 * table name gets it, because that name is the tile's entire content and a third
 * of a 620px drawer is not enough for one: at a third it wrapped mid-word, which
 * is the one break a reader cannot tell from the end of a name.
 */
function PanelTile({
  label,
  tile,
  mono,
  wide,
}: {
  label: string;
  tile: TileValue;
  mono?: string | null;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'monitoring-panel-tile monitoring-panel-tile-wide' : 'monitoring-panel-tile'}>
      <p className="monitoring-panel-tile-label">{label}</p>
      {mono ? (
        // The mono value on this tile is a Unity Catalog table name -- it is the
        // "Tables read most" tile and nothing else passes `mono` -- so it gets
        // the product's mark before it, as the grant rows below do. `title`
        // carries the whole name, because the line truncates with an ellipsis
        // rather than breaking inside a word.
        <p className="monitoring-mono monitoring-panel-tile-mono" title={mono}>
          <BrandIcon product="unity-catalog" size={14} />
          {mono}
        </p>
      ) : tile.value !== null ? (
        <p className="monitoring-panel-tile-value ast-num">{tile.value}</p>
      ) : (
        <p className="monitoring-tile-absent">{tile.absence}</p>
      )}
      {/* `title` only on the tile whose caption truncates. On the tables tile the
          caption carries a second table name; everywhere else it is a run of
          ordinary words that wraps, and a `title` repeating visible text is a
          tooltip that teaches a reader nothing. */}
      <p className="monitoring-tile-caption" title={wide ? tile.caption : undefined}>
        {tile.caption}
      </p>
    </div>
  );
}

export function PersonPanel({
  panel,
  now,
  rangeLabel,
  onClose,
  onOpenQuestion,
}: {
  panel: PersonPanelPayload;
  now: number;
  /**
   * The window everything on this panel is counted over.
   *
   * The panel is opened from a list the reader has already narrowed and then
   * covers the control that narrowed it, so every figure and every question
   * below is over a range the reader can no longer see. It goes on the two
   * headings that own range-scoped content rather than into a sentence: the
   * range is a fact about the numbers under the heading, not an explanation of
   * the panel.
   */
  rangeLabel: string;
  onClose: () => void;
  onOpenQuestion: (question: MonitoringQuestion) => void;
}) {
  const times = answerTimeTile(panel.durationsMs);
  const tables = tablesReadTile(panel.tablesReadMost);
  const outcomes = outcomeTile(panel.summary);
  const scopes = readScopes(panel);
  return (
    <aside className="monitoring-drawer" role="dialog" aria-modal="true" aria-label="Activity for one person">
      <div className="monitoring-drawer-head">
        <div className="monitoring-panel-who">
          <div className="min-w-0">
            <h3 className="monitoring-panel-name">
              <UserIdentityChip identity={panel.email} />
            </h3>
            <p className="monitoring-drawer-meta">
              {panel.firstSeen ? `First seen ${whenLabel(panel.firstSeen, now)}` : 'First seen not recorded'}
              {' · '}
              {panel.lastSeen ? `Last seen ${whenLabel(panel.lastSeen, now)}` : 'Last seen not recorded'}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" className="monitoring-drawer-close" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      <h4 className="monitoring-eyebrow">
        What they asked <span className="monitoring-eyebrow-range">{rangeLabel}</span>
      </h4>
      <div className="monitoring-panel-grid">
        <div className="monitoring-panel-tile">
          <p className="monitoring-panel-tile-label">Questions</p>
          <p className="monitoring-panel-tile-value ast-num">{panel.summary.questionsAsked.toLocaleString()}</p>
          <p className="monitoring-tile-caption">
            {`${outcomes.completed} completed`}
            <span className="monitoring-partial">{` · ${outcomes.partial} partial`}</span>
            <span className="monitoring-refused">{` · ${outcomes.refused} refused`}</span>
            <span className="monitoring-failed">{` · ${outcomes.failed} failed`}</span>
          </p>
        </div>
        <PanelTile label="Tokens" tile={tokensTile(panel.tokens)} />
        <PanelTile label="Token cost" tile={tokenCostTile(panel.tokenCostUsd)} />
        <div className="monitoring-panel-tile">
          <p className="monitoring-panel-tile-label">Answer time</p>
          {times.value !== null ? (
            <p className="monitoring-panel-tile-value ast-num">
              {times.value} <span className="monitoring-panel-tile-unit">median</span>
            </p>
          ) : (
            <p className="monitoring-tile-absent">{times.absence}</p>
          )}
          {/* The 95th percentile, or the slowest run labelled as the slowest run.
              Under twenty runs a percentile is the second-slowest of a handful,
              and naming it one invites comparison with a real one. */}
          <p className="monitoring-tile-caption">{times.tail}</p>
        </div>
        <PanelTile label="Rated" tile={ratedTile(panel.ratedUp, panel.ratedDown)} />
        <PanelTile label="Tables read most" tile={tables} mono={tables.table} wide />
      </div>

      <h4 className="monitoring-eyebrow">What they can read · permissions, not data</h4>
      {/* Badges, where this was three paragraphs of prose. Each one is a
          permission some of their runs carried and the number that carried it.
          This section says what a person is entitled to reach and shows none of
          their rows and none of their answers. It is not the conditioning in the
          drawer and must not be read as it.

          Nothing renders where no run recorded an identity, and there is no
          access-gate row: see `readScopes` for both. */}
      {scopes.length > 0 ? (
        <div className="monitoring-scopes">
          {scopes.map((scope) => (
            <span className={astPill(PILL_FAMILY[scope.tone], 'monitoring-pill monitoring-scope')} key={scope.label}>
              {scope.label}
              <span className="monitoring-scope-runs ast-num">{scope.runs}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="monitoring-grants">
        <p className="monitoring-grants-head">
          Effective grants on the tables PIA reads · read now, as the application
        </p>
        {panel.grants === null ? (
          /* Not an empty table. An empty table reads as "no grants", which is a
             finding about the person that nobody established. */
          <p className="monitoring-grants-absent">
            The grants for this person could not be read just now, so none are shown. This says nothing about what they
            can reach.
          </p>
        ) : (
          panel.grants.map((grant) => {
            const badge = grantBadge(grant);
            return (
              <div className="monitoring-grant-row" key={grant.table}>
                <p className="monitoring-grant-line">
                  {/* Unity Catalog's mark before each table name, at the handoff's
                    14px. Every row here is a UC table and the heading says so,
                    so this is decorative: the name is the next element. */}
                  <BrandIcon product="unity-catalog" size={14} />
                  {/* `title` carries the whole name, because the span truncates
                    with an ellipsis rather than letting the row's own clipping
                    slice a three-part name mid-word. */}
                  <span className="monitoring-mono monitoring-grant-table" title={grant.table}>
                    {grant.table}
                  </span>
                  <span className={astPill(PILL_FAMILY[badge.tone], 'monitoring-pill')}>{badge.label}</span>
                  {/* The privilege that was found missing. Not printed where the
                    badge is already the words "Not checked". */}
                  {grant.missing && grant.missing !== badge.label ? (
                    <span className="monitoring-grant-missing">{grant.missing}</span>
                  ) : null}
                </p>
                {/* What a filter or a mask IS, never what it did to a run. A
                  filtered query succeeds and returns fewer rows, and nothing in
                  the result says a filter ran. */}
                {grant.rowFilter ? (
                  <p className="monitoring-grant-note">
                    Row filter applied. Two people with different group membership will see different totals from this
                    table.
                  </p>
                ) : null}
                {grant.maskedColumns && grant.maskedColumns.length > 0 ? (
                  <p className="monitoring-grant-note">{`Column mask on ${grant.maskedColumns.join(', ')}.`}</p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* TWO TILES, NEVER SUMMED. The first is a grant somebody can make. The
          second is a change to the release, or to the question. Added together
          they make a number that goes up for two unrelated reasons and can be
          brought down by fixing either. */}
      <div className="monitoring-refusal-tiles">
        <div className="monitoring-panel-tile">
          <p className="monitoring-panel-tile-label" title={codesForCause('missing-grant').join(', ')}>
            Refused for a missing grant
          </p>
          <p className="monitoring-panel-tile-value ast-num">{panel.refusedMissingGrant.toLocaleString()}</p>
          <p className="monitoring-tile-caption">a grant somebody can make</p>
        </div>
        <div className="monitoring-panel-tile">
          <p className="monitoring-panel-tile-label" title={codesForCause('agent-rules').join(', ')}>
            Refused by the agent&apos;s own rules
          </p>
          <p className="monitoring-panel-tile-value ast-num">{panel.refusedAgentRules.toLocaleString()}</p>
          <p className="monitoring-tile-caption">a release or question change</p>
        </div>
      </div>
      {/* Load-bearing. A grant made this morning changes the live rows above and
          changes nothing about a refusal from last week, and an admin looking at
          both on one screen will otherwise assume they disagree. */}
      <p className="monitoring-tile-caption">{LIVE_VERSUS_RECORDED}</p>

      <h4 className="monitoring-eyebrow">
        Their questions <span className="monitoring-eyebrow-range">{rangeLabel}</span>
      </h4>
      {panel.questions.length === 0 ? (
        <p className="monitoring-empty-line">No questions from this person in this range.</p>
      ) : (
        <QuestionList questions={panel.questions} selectedId="" now={now} onOpen={onOpenQuestion} />
      )}
    </aside>
  );
}

/* ── The body, which is the state machine ────────────────────────────────── */

export interface MonitoringBodyProps {
  state: MonitoringState;
  payload: MonitoringQuestionsPayload | null;
  questions: MonitoringQuestion[];
  filters: MonitoringFilters;
  rangeLabel: string;
  selectedId: string;
  now: number;
  onOpen: (question: MonitoringQuestion) => void;
  onChangeFilters: (next: MonitoringFilters) => void;
  onClearFilters: () => void;
  onRetry: () => void;
}

/**
 * Everything between the heading and the drawer, for one state.
 *
 * Split out of the page so each of the six states can be rendered and read in a
 * test. This repository has been bitten by screens that were wrong while every
 * assertion about their source was true, so the claims about what a reader sees
 * are made against rendered output, and that needs a component that can be handed
 * a state rather than one that has to be fetched into it.
 */
export function MonitoringBody({
  state,
  payload,
  questions,
  filters,
  rangeLabel,
  selectedId,
  now,
  onOpen,
  onChangeFilters,
  onClearFilters,
  onRetry,
}: MonitoringBodyProps) {
  if (state === 'unavailable') {
    /* The page body is replaced rather than half-populated. The heading and the
       Refresh control stay above this, because re-reading is the one useful thing
       to do here and a filter row would be a control over nothing. */
    return (
      <UnavailablePanel
        notice={unavailableNotice({
          surface: 'conversations',
          code: 'PERSISTENCE_UNAVAILABLE',
          interactive: false,
          detail: 'The questions in this range could not be read.',
        })}
        /* The label is not ours to choose. The panel draws the shared Refresh
           button, which is the same control and the same word as the heading's. */
        onRetry={onRetry}
      />
    );
  }
  return (
    <>
      {state === 'loading' ? (
        <SkeletonStrip />
      ) : payload ? (
        <SummaryStrip payload={payload} rangeLabel={rangeLabel} />
      ) : null}

      {/* A partial read renders its figures and says what they are over, so a
          number is never shown over an unknown denominator. */}
      {payload?.readState === 'partial' && payload.countedQuestions !== undefined ? (
        <p className="monitoring-note">{partialSentence(payload.countedQuestions, payload.foundQuestions ?? null)}</p>
      ) : null}

      {/* Live and interactive immediately, including while the list below is
          still a set of skeletons. A reader who knows what they want should not
          wait for a read to finish before they can type it. */}
      <FilterRow
        filters={filters}
        people={payload?.people ?? []}
        tables={payload?.tables ?? []}
        onChange={onChangeFilters}
        onClearFilters={onClearFilters}
      />

      {/* One line, in body text, no warning colour. Nothing is hidden when the
          check could not run: an admin's grants normally cover whatever was
          asked, and Unity Catalog is still the boundary either way. */}
      {payload?.grantsResolution === 'failed' ? <p className="monitoring-note">{GRANTS_UNRESOLVED_LINE}</p> : null}

      {/* The list is a pane, on the same recipe as the tiles above it.
          
          It used to sit bare on the page, which on white reads as a table and on
          the night sky reads as a table with a constellation running through it:
          the stars are behind the page rather than behind a surface, so a row of
          figures had points of light between the digits. The three states share
          the pane deliberately -- skeletons, an emptiness and the rows themselves
          are the same block of the page, and a surface that appears only once
          there is data makes the read look like a layout change. */}
      <div className="monitoring-list-pane">
        {state === 'loading' ? (
          <SkeletonRows />
        ) : state === 'empty-range' || state === 'empty-filters' || state === 'empty-search' ? (
          <EmptyList
            state={state}
            filters={filters}
            onClearFilters={onClearFilters}
            onChangeFilters={onChangeFilters}
          />
        ) : (
          <QuestionList questions={questions} selectedId={selectedId} now={now} onOpen={onOpen} />
        )}
      </div>
    </>
  );
}

/**
 * An empty list, and the way back out of whichever emptiness this is.
 *
 * Three of them, because they have three different causes and three different
 * remedies. The range holding nothing is not a problem and gets no button. A
 * chip excluding everything is undone by clearing the chips. A word matching
 * nothing is undone by clearing the word, and where a chip is narrowing as well
 * both buttons are offered, because clearing one would leave the reader still
 * looking at nothing and no wiser.
 */
function EmptyList({
  state,
  filters,
  onClearFilters,
  onChangeFilters,
}: {
  state: EmptyState;
  filters: MonitoringFilters;
  onClearFilters: () => void;
  onChangeFilters: (next: MonitoringFilters) => void;
}) {
  const copy = emptyCopy(state, { search: filters.search, chips: chipsActive(filters) });
  return (
    <div className="monitoring-empty">
      <p className="monitoring-empty-line">{copy.sentence}</p>
      <div className="monitoring-empty-actions">
        {copy.clearSearch ? (
          <Button variant="outline" size="sm" onClick={() => onChangeFilters({ ...filters, search: '' })}>
            Clear search
          </Button>
        ) : null}
        {copy.clearFilters ? (
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

export function MonitoringPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<MonitoringQuestionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<MonitoringDetail | null>(null);
  const [panel, setPanel] = useState<PersonPanelPayload | null>(null);
  // The clock is read once per render pass rather than per row, so every
  // relative stamp on one paint is relative to the same instant.
  const [now, setNow] = useState(() => Date.now());
  const scroll = useRef(scrollMemory());
  const lastSearch = useRef(location.search);

  const filters = filtersFromParams(searchParams);
  const drawer = drawerFromParams(searchParams);
  const window_ = rangeWindow(searchParams, now);

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/monitoring/questions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      // A 403 is the guard doing its job for a consumer who reached the URL.
      // The body still parses as a payload shape, and `readState` carries the
      // outcome, so there is no separate error path to keep in step.
      const body = (await response.json()) as MonitoringQuestionsPayload;
      setPayload(response.ok ? body : { ...body, readState: 'unavailable' });
    } catch {
      // No stand-in rows and no invented figures. The page swaps its body for
      // the storage-failure panel, which says the list is blank because nobody
      // could read it.
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Once, and again on the range or on Refresh. Never on a filter change, which
  // is applied in the browser, and never on a drawer opening.
  useEffect(() => {
    void load(window_.from, window_.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, searchParams.get('range'), searchParams.get('from'), searchParams.get('to')]);

  // The drawer's own read, keyed on which question is open.
  useEffect(() => {
    if (!drawer.question) {
      setDetail(null);
      return;
    }
    let live = true;
    void fetch(
      `/api/monitoring/questions/${encodeURIComponent(drawer.question)}` +
        `?from=${encodeURIComponent(window_.from)}&to=${encodeURIComponent(window_.to)}`
    )
      .then((response) => (response.ok ? (response.json() as Promise<MonitoringDetail>) : null))
      .then((body) => {
        if (live) setDetail(body);
      })
      .catch(() => {
        if (live) setDetail(null);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer.question]);

  useEffect(() => {
    if (!drawer.person) {
      setPanel(null);
      return;
    }
    let live = true;
    void fetch(
      `/api/monitoring/people/${encodeURIComponent(drawer.person)}` +
        `?from=${encodeURIComponent(window_.from)}&to=${encodeURIComponent(window_.to)}`
    )
      .then((response) => (response.ok ? (response.json() as Promise<PersonPanelPayload>) : null))
      .then((body) => {
        if (live) setPanel(body);
      })
      .catch(() => {
        if (live) setPanel(null);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer.person]);

  /**
   * Closing the drawer puts the reader back exactly where they were.
   *
   * Two halves, and both are promises the design makes. The filters survive
   * because `closedDrawer` removes two parameters and copies the rest, so it
   * cannot drop one. The scroll position survives because it was captured when
   * the drawer opened and is reapplied after the URL changes.
   */
  const close = useCallback(() => {
    void navigate({ search: closedDrawer(location.search) }, { replace: true });
    const offset = scroll.current.take();
    if (offset !== null && typeof globalThis.scrollTo === 'function') {
      globalThis.scrollTo({ top: offset });
    }
  }, [location.search, navigate]);

  const open = useCallback(
    (question: MonitoringQuestion) => {
      scroll.current.capture(typeof globalThis.scrollY === 'number' ? globalThis.scrollY : 0);
      void navigate({ search: openQuestion(location.search, question.id) });
    },
    [location.search, navigate]
  );

  const openPersonPanel = useCallback(
    (email: string) => {
      scroll.current.capture(typeof globalThis.scrollY === 'number' ? globalThis.scrollY : 0);
      void navigate({ search: openPerson(location.search, email) });
    },
    [location.search, navigate]
  );

  // A filter change rewrites only the filter parameters. Everything else in the
  // URL, including the range and an open drawer, is copied across.
  const changeFilters = useCallback(
    (next: MonitoringFilters) => {
      setSearchParams(new URLSearchParams(withFilters(location.search, next)), { replace: true });
    },
    [location.search, setSearchParams]
  );

  // Kept so a later read can tell a drawer change from a range change without
  // re-deriving it, and so the reason that matters is written down where it is
  // used rather than in a commit message.
  if (!onlyDrawerChanged(lastSearch.current, location.search)) lastSearch.current = location.search;

  const visible = payload ? applyFilters(payload.questions, filters) : [];
  const state: MonitoringState = monitoringState({
    loading,
    readState: payload?.readState ?? null,
    rowCount: visible.length,
    filtersActive: filtersActive(filters),
    searchActive: filters.search !== '',
  });

  return (
    <div className="page-shell monitoring-page">
      <PageHeading
        title="Monitoring"
        actions={
          /* The shared pair. This page supplies the two things only it knows:
             whether a read is in flight, and when the last one finished. */
          <RefreshControl
            busy={loading}
            checkedAt={payload?.readAt ?? ''}
            now={now}
            onRefresh={() => {
              setNow(Date.now());
              void load(window_.from, window_.to);
            }}
          />
        }
      />

      <MonitoringBody
        state={state}
        payload={payload}
        questions={visible}
        filters={filters}
        rangeLabel={window_.label}
        selectedId={drawer.question}
        now={now}
        onOpen={open}
        onChangeFilters={changeFilters}
        onClearFilters={() => setSearchParams(new URLSearchParams(clearedFilters(location.search)), { replace: true })}
        onRetry={() => void load(window_.from, window_.to)}
      />

      {detail && drawer.question ? (
        <QuestionDrawer detail={detail} onClose={close} onOpenPerson={openPersonPanel} />
      ) : null}
      {panel && drawer.person ? (
        <PersonPanel panel={panel} now={now} rangeLabel={window_.label} onClose={close} onOpenQuestion={open} />
      ) : null}
    </div>
  );
}

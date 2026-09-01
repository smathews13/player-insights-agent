/**
 * Monitoring: every question anyone has asked this deployment, and one question
 * in full.
 *
 * Modelled on the Monitor tab of a Databricks Genie Agent, which is the surface
 * this audience already knows. The strip and the list stay on the page. Opening
 * a question puts Ask PIA's own `AnswerCard` in a centered modal over that list,
 * so closing either detail returns the reader to their filters and their place.
 * User activity uses the same centered modal foundation without stacking.
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
 *    renderer here would eventually show them a different one. The run process
 *    lives inside that card, the same way it does on Ask; this file does not
 *    draw a second timeline over it.
 *  - The storage-failure panel, which is `UnavailablePanel`.
 *
 * NO POLLING. This is a review surface, not a console. An admin reading a
 * conversation does not want the list reordering underneath them, and the query
 * behind it scans every message in the range.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, ChevronRight, Search, ThumbsDown, ThumbsUp, Users, X } from 'lucide-react';
import { astPill, type AstPillFamily } from './astrolabe-pill';
import { BrandIcon } from './BrandIcon';
import { Button, Input, Skeleton } from './ui';
import { AppSelect } from './AppSelect';
import { PageHeading } from './page-chrome';
import { RefreshControl } from './RefreshControl';
import { UnavailablePanel } from './UnavailablePanel';
import { unavailableNotice } from './unavailable-copy';
import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { SourceEntityName, VisitInDatabricks } from './DataEntityLinks';
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
  localPart,
  medianAnswerTimeTile,
  monitoringState,
  newestFirst,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  outcomeTile,
  partialSentence,
  questionsAskedTile,
  ratedHelpfulTile,
  ratedTile,
  readScopes,
  tokenCostTile,
  tokensTile,
  userThreadsTile,
  whenLabel,
  type EmptyState,
  type MonitoringState,
  type TileValue,
} from './monitoring-view';
import {
  applyFilters,
  chipsActive,
  clearedFilters,
  backToUserBrowser,
  closedUserMonitoring,
  closedDrawer,
  drawerFromParams,
  filtersActive,
  filtersFromParams,
  openPerson,
  openQuestion,
  openUserBrowser,
  openUserFromBrowser,
  scrollMemory,
  userBrowserFromParams,
  withFilters,
  type MonitoringFilters,
} from './monitoring-filters';
// Shared with Ops, so the two tabs cannot be over different windows.
import { TimeRangeControl } from './TimeRangeControl';
import './styles/routes/monitoring.css';
import {
  monitoringPageForOwner,
  monitoringRangeId,
  rememberMonitoringSearch,
  useMonitoringQuestions,
} from './monitoring-session';
import {
  beginPanelLoad,
  idlePanel,
  monitoringDetailKey,
  panelStateForKey,
  personDetailUrl,
  questionDetailUrl,
  rejectPanelLoad,
  resolvePanelLoad,
  type PanelLoadState,
} from './monitoring-detail-state';
import { rangeLabel, rangeWindow } from './time-range';
import { codesForCause } from '../../shared/monitoring-contract';
import type {
  MonitoringDetail,
  MonitoringPagination,
  MonitoringQuestion,
  MonitoringQuestionsPayload,
  PersonPanelPayload,
} from '../../shared/monitoring-contract';
import type { OpsCostPayload } from '../../shared/ops-contract';
import type { UserSpendProfile, UserSpendQuality } from '../../shared/user-spend-contract';
import type { UserMonitoringPayload, UserMonitoringRow } from '../../shared/user-monitoring-contract';
import { ROLE_WORD, isRole } from '../../shared/user-roster-contract';
import { UsedThisRun } from './UsedThisRun';
import { Dialog } from './Dialog';

/* ── The summary strip ───────────────────────────────────────────────────── */

/** The compact, visual-only timebox repeated on every KPI card. */
function PeriodBadge({ label }: { label: string }) {
  return (
    <span className={astPill('neutral-outline', 'monitoring-period-badge')} aria-hidden="true">
      {label}
    </span>
  );
}

/** One hairline tile. A tile never renders blank and never renders both. */
export function SummaryTile({
  label,
  tile,
  periodLabel,
  className = '',
}: {
  label: string;
  tile: TileValue;
  periodLabel: string;
  className?: string;
}) {
  return (
    <div
      className={['monitoring-tile', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={`${label}, ${periodLabel}`}
    >
      <div className="monitoring-tile-head">
        <p className="monitoring-tile-label">{label}</p>
        <PeriodBadge label={periodLabel} />
      </div>
      {tile.value !== null ? (
        <p className="monitoring-tile-value ast-num">{tile.value}</p>
      ) : (
        /* Not a dash and not a zero. The sentence is the value here, at body
           size rather than at the figure size, so it does not read as a
           measurement. */
        <p className="monitoring-tile-absent">{tile.absence}</p>
      )}
      {tile.caption ? <p className="monitoring-tile-caption">{tile.caption}</p> : null}
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
export function SummaryStrip({ payload, periodLabel }: { payload: MonitoringQuestionsPayload; periodLabel: string }) {
  const outcomes = outcomeTile(payload.summary);
  const outcomeMetrics = [
    { label: 'Completed', value: outcomes.completed, count: payload.summary.completed, className: '' },
    { label: 'Partial', value: outcomes.partial, count: payload.summary.partial, className: 'monitoring-partial' },
    { label: 'Refused', value: outcomes.refused, count: payload.summary.refused, className: 'monitoring-refused' },
    { label: 'Failed', value: outcomes.failed, count: payload.summary.failed, className: 'monitoring-failed' },
  ];
  return (
    <div className="monitoring-strip" aria-label={`Summary for ${periodLabel}`}>
      <SummaryTile
        label="Questions asked"
        tile={questionsAskedTile(payload.summary)}
        periodLabel={periodLabel}
        className="monitoring-summary-questions"
      />
      <SummaryTile
        label="User threads"
        tile={userThreadsTile(payload.summary)}
        periodLabel={periodLabel}
        className="monitoring-summary-threads"
      />
      <div
        className="monitoring-tile monitoring-outcomes-tile"
        role="group"
        aria-label={`Final run outcomes, ${periodLabel}`}
      >
        <div className="monitoring-tile-head">
          <p className="monitoring-tile-label">Final run outcomes</p>
          <PeriodBadge label={periodLabel} />
        </div>
        <dl className="monitoring-outcome-grid" aria-label="Final run outcomes">
          {outcomeMetrics.map((metric) => (
            <div
              className="monitoring-outcome-metric"
              role="group"
              aria-label={`${metric.label}: ${metric.value}`}
              key={metric.label}
            >
              <dt className="monitoring-tile-label">{metric.label}</dt>
              <dd
                className={[
                  'monitoring-outcome-value',
                  'ast-num',
                  metric.className,
                  metric.count === 0 ? 'monitoring-outcome-value-zero' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {metric.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="monitoring-tile-caption">{outcomes.caption}</p>
      </div>
      <SummaryTile
        label="Rated helpful"
        tile={ratedHelpfulTile(payload.summary)}
        periodLabel={periodLabel}
        className="monitoring-summary-rated"
      />
      <SummaryTile
        label="Median answer time"
        tile={medianAnswerTimeTile(payload.summary)}
        periodLabel={periodLabel}
        className="monitoring-summary-median"
      />
    </div>
  );
}

/** The skeleton strip, which is five tiles of the same geometry and no numbers. */
function SkeletonStrip({ periodLabel }: { periodLabel: string }) {
  return (
    <div className="monitoring-strip" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="monitoring-tile" key={index}>
          <div className="monitoring-tile-head">
            <Skeleton className="h-3 w-24" />
            <PeriodBadge label={periodLabel} />
          </div>
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
 * a reader hears "User, All" as it heard from the native control. Arrow keys
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

function SearchBox({
  value,
  onChange,
  placeholder = 'Search questions or users…',
  ariaLabel = 'Search questions by text or user',
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
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
    <div className={`run-search monitoring-search ${className}`.trim()}>
      <Search className="monitoring-search-icon" aria-hidden="true" focusable="false" />
      <Input
        type="search"
        placeholder={placeholder}
        aria-label={ariaLabel}
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
  onOpenUsers,
}: {
  filters: MonitoringFilters;
  people: string[];
  tables: string[];
  onChange: (next: MonitoringFilters) => void;
  onClearFilters: () => void;
  onOpenUsers?: () => void;
}) {
  return (
    <div className="monitoring-filters">
      <FilterChip
        label="User"
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
          for it. It was between the range control and the User chip, which put
          a 240px field in the middle of a row of chips and separated the range
          from the filters it applies to.

          The sentence that used to hold this end of the row is gone. See the
          note on `.monitoring-search` in monitoring.css: the behaviour it
          described is unchanged and still tested, and the row now says nothing a
          reader has to decide whether to act on. */}
      <SearchBox value={filters.search} onChange={(search) => onChange({ ...filters, search })} />
      {onOpenUsers ? (
        <Button variant="default" size="sm" className="monitoring-user-browser-trigger" onClick={onOpenUsers}>
          <Users aria-hidden="true" />
          User Monitoring
        </Button>
      ) : null}
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

function AskerMark({ email, onOpen }: { email: string; onOpen?: (email: string) => void }) {
  const mark = <UserIdentityChip identity={email} compact className="monitoring-asker-who" />;
  if (!onOpen) return mark;
  return (
    <button
      type="button"
      className="monitoring-asker-button"
      aria-label={`Open ${identityName(email)}'s profile`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(email);
      }}
    >
      {mark}
    </button>
  );
}

function RatingMark({ rating }: { rating: 'up' | 'down' | null }) {
  if (rating === 'up') return <ThumbsUp className="size-3.5 monitoring-thumb-up" aria-label="Rated helpful" />;
  if (rating === 'down') {
    return <ThumbsDown className="size-3.5 monitoring-thumb-down" aria-label="Rated not helpful" />;
  }
  return <span className="sr-only">Not rated</span>;
}

function QuestionRow({
  question,
  selected,
  now,
  onOpen,
  onOpenPerson,
}: {
  question: MonitoringQuestion;
  selected: boolean;
  now: number;
  onOpen: (question: MonitoringQuestion) => void;
  onOpenPerson?: (email: string) => void;
}) {
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      className={selected ? 'monitoring-row monitoring-row-selected' : 'monitoring-row'}
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
        <AskerMark email={question.askedBy} onOpen={onOpenPerson} />
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
  );
}

export const MONITORING_COMPACT_MAX_WIDTH_PX = 799;
export const MONITORING_COMPACT_QUERY = `(max-width: ${MONITORING_COMPACT_MAX_WIDTH_PX}px)`;

function useCompactQuestionList(forced?: boolean): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (forced !== undefined || typeof globalThis.matchMedia !== 'function') return;
    const query = globalThis.matchMedia(MONITORING_COMPACT_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [forced]);
  return forced ?? compact;
}

function QuestionCard({
  question,
  selected,
  now,
  onOpen,
  onOpenPerson,
}: {
  question: MonitoringQuestion;
  selected: boolean;
  now: number;
  onOpen: (question: MonitoringQuestion) => void;
  onOpenPerson?: (email: string) => void;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        className={selected ? 'monitoring-question-card monitoring-row-selected' : 'monitoring-question-card'}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onOpen(question)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onOpen(question);
        }}
      >
        <span className="monitoring-question-card-text">{question.question}</span>
        <span className="monitoring-question-card-meta">
          <AskerMark email={question.askedBy} onOpen={onOpenPerson} />
          <span>{whenLabel(question.askedAt, now)}</span>
          <OutcomePill question={question} />
        </span>
        <span className="monitoring-question-card-facts">
          {formatDuration(question.durationMs) ? (
            <span>
              Time <span className="ast-num">{formatDuration(question.durationMs)}</span>
            </span>
          ) : null}
          {question.toolCalls !== null ? (
            <span>
              Tools <span className="ast-num">{question.toolCalls}</span>
            </span>
          ) : null}
          <RatingMark rating={question.rating} />
        </span>
      </div>
    </li>
  );
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
  onOpenPerson,
  compact: forcedCompact,
}: {
  questions: MonitoringQuestion[];
  selectedId: string;
  now: number;
  onOpen: (question: MonitoringQuestion) => void;
  onOpenPerson?: (email: string) => void;
  /** Test seam; normal callers follow the 800px media query. */
  compact?: boolean;
}) {
  const compact = useCompactQuestionList(forcedCompact);
  if (compact) {
    return (
      <ul className="monitoring-card-list" aria-label="Questions">
        {newestFirst(questions).map((question) => (
          <QuestionCard
            key={question.id}
            question={question}
            selected={question.id === selectedId}
            now={now}
            onOpen={onOpen}
            onOpenPerson={onOpenPerson}
          />
        ))}
      </ul>
    );
  }
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
          <QuestionRow
            key={question.id}
            question={question}
            selected={question.id === selectedId}
            now={now}
            onOpen={onOpen}
            onOpenPerson={onOpenPerson}
          />
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

export function MonitoringPaginationControls({
  pagination,
  page,
  onPrevious,
  onNext,
}: {
  pagination: MonitoringPagination;
  page: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (page === 0 && !pagination.hasMore) return null;
  const count = pagination.total;
  return (
    <nav className="monitoring-pagination" aria-label="Question pages">
      <p aria-live="polite">
        Page {page + 1}
        {count !== null ? ` · ${count.toLocaleString()} matching questions` : ''}
      </p>
      <div>
        <Button variant="outline" size="sm" onClick={onPrevious} disabled={page === 0}>
          Previous
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!pagination.hasMore}>
          Next
        </Button>
      </div>
    </nav>
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

function tokensNote(tokens: MonitoringDetail['tokens']) {
  return (
    <p className="monitoring-drawer-tokens">
      {tokens
        ? tokens.total === null
          ? 'This run reported no token total, so the total is unknown rather than zero.'
          : `${tokens.total.toLocaleString()} tokens recorded on this run.`
        : 'This run was not metred, so no token count was recorded.'}
    </p>
  );
}

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

  return (
    <Dialog
      overlayClassName="monitoring-question-overlay"
      contentClassName="monitoring-question-modal"
      overlayTestId="monitoring-question-overlay"
      labelledBy="monitoring-question-title"
      onDismiss={onClose}
    >
      <div className="monitoring-drawer-head">
        <h3 id="monitoring-question-title" className="monitoring-drawer-question">
          {detail.question}
        </h3>
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
      {/* Asked-by is a compact corner chip on the answer card, the same
            register as "Live agent response". It stays here only when there is
            no card: a conditioned or failed run still has to name who asked.
            The timestamp and grants stay a caption, not a second washed bar. */}
      <div className="monitoring-drawer-meta-row">
        {!answer ? <UserIdentityChip identity={detail.askedBy} label="Asked by" compact /> : null}
        <p className="monitoring-drawer-meta">
          {[askedAtLabel(detail.askedAt), askerGrantsLine(detail.execution, identityName(detail.askedBy))]
            .filter((segment): segment is string => Boolean(segment))
            .join(' · ')}
        </p>
      </div>
      <UsedThisRun used={detail.runtimeUsed ?? null} />

      <div className="monitoring-drawer-links">
        {/* Keep the drilldown's onward actions near its heading, where they are
              available before a long answer. The MLflow action remains absent
              rather than dead when the run recorded no trace id. */}
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
             surrounding body text. No warning colour, no icon, no acknowledgement
             step. Everything below still renders. */
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
          afterEvidence={tokensNote(detail.tokens)}
          headerExtra={<UserIdentityChip identity={detail.askedBy} label="Asked by" compact />}
        />
      ) : (
        /* A refusal or a failure: the taxonomy's own sentence, with the code in
             monospace beneath it. Not a blank panel, and not an invented reason. */
        <div className="monitoring-drawer-outcome">
          <p>{detail.outcomeDetail ?? 'This question produced no stored answer, and no reason was recorded.'}</p>
          {detail.outcomeCode ? <code className="monitoring-code">{detail.outcomeCode}</code> : null}
        </div>
      )}

      {/* Tokens sit inside the card when there is one, after the tables and
            before Sources. A sibling after the card is what painted them on the
            last table row. They stay a dialog child only when there is no card. */}
      {!answer ? tokensNote(detail.tokens) : null}

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
    </Dialog>
  );
}

export function QuestionPanel({
  state,
  title,
  onClose,
  onOpenPerson,
  onRetry,
}: {
  state: PanelLoadState<MonitoringDetail>;
  title: string;
  onClose: () => void;
  onOpenPerson: (email: string) => void;
  onRetry: () => void;
}) {
  if (state.status === 'ready') {
    return <QuestionDrawer detail={state.data} onClose={onClose} onOpenPerson={onOpenPerson} />;
  }
  return (
    <Dialog
      overlayClassName="monitoring-question-overlay"
      contentClassName="monitoring-question-modal monitoring-panel-status"
      overlayTestId="monitoring-question-overlay"
      labelledBy="monitoring-question-title"
      ariaBusy={state.status === 'loading' || state.status === 'idle'}
      onDismiss={onClose}
    >
      <div className="monitoring-drawer-head">
        <h3 id="monitoring-question-title" className="monitoring-drawer-question">
          {title || 'Question details'}
        </h3>
        <Button variant="outline" size="sm" className="monitoring-drawer-close" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </Button>
      </div>
      {state.status === 'error' ? (
        <div role="alert" className="monitoring-panel-message">
          <p>{state.error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <div role="status" className="monitoring-panel-message">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <span className="sr-only">Loading question details</span>
        </div>
      )}
    </Dialog>
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
function PanelTile({ label, tile }: { label: string; tile: TileValue }) {
  return (
    <div className="monitoring-panel-tile">
      <p className="monitoring-panel-tile-label">{label}</p>
      {tile.value !== null ? (
        <p className="monitoring-panel-tile-value ast-num">{tile.value}</p>
      ) : (
        <p className="monitoring-tile-absent">{tile.absence}</p>
      )}
      {tile.caption ? <p className="monitoring-tile-caption">{tile.caption}</p> : null}
    </div>
  );
}

/**
 * The ranked source tables recorded by this person's runs in the selected
 * period. Nothing configured is borrowed to fill an empty list: these rows are
 * evidence from the runs, and the server has already deduplicated and capped
 * them.
 */
export function TablesReadMost({ rows }: { rows: PersonPanelPayload['tablesReadMost'] }) {
  if (rows.length === 0) return null;
  return (
    <section className="monitoring-panel-tile monitoring-panel-tile-wide monitoring-tables-read">
      <p className="monitoring-panel-tile-label">Tables read most</p>
      <ol className="monitoring-table-ranking">
        {rows.map((row) => (
          <li key={row.table}>
            <span className="monitoring-ranked-table" title={row.table} aria-label={row.table}>
              <VisitInDatabricks name={row.table} />
              <span className="source-name-pill" data-tone="queried">
                <SourceEntityName name={row.table} />
              </span>
            </span>
            <span className="monitoring-table-runs ast-num">
              {row.runs.toLocaleString()} {row.runs === 1 ? 'run' : 'runs'}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const SPEND_QUALITY: Record<UserSpendQuality, { label: string; tone: AstPillFamily; description: string }> = {
  direct: { label: 'Direct', tone: 'pos', description: 'A platform usage row explicitly named this OAuth user.' },
  joined: {
    label: 'Joined',
    tone: 'info',
    description: 'Measured spend joined to a durable request or run owned by this user.',
  },
  allocated: {
    label: 'Allocated',
    tone: 'warn',
    description: 'Shared measured spend apportioned by recorded usage. This is not an individual invoice.',
  },
  unattributed: {
    label: 'Unattributed',
    tone: 'neutral-outline',
    description: 'Measured app spend that cannot safely be assigned to a person.',
  },
  unavailable: {
    label: 'Unavailable',
    tone: 'neutral-outline',
    description: 'The source, identity, or price coverage needed for this figure is unavailable.',
  },
  partial: {
    label: 'Partial',
    tone: 'warn',
    description: 'Some attributable spend is shown, but at least one measured component is incomplete.',
  },
};

function spendFigure(amount: number | null, unit: 'USD' | 'DBU', currency = 'USD'): string {
  if (amount === null || !Number.isFinite(amount)) return 'Unavailable';
  return unit === 'DBU'
    ? `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DBU`
    : `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || 'USD'}`;
}

function SpendQualityBadge({ quality }: { quality: UserSpendQuality }) {
  const reading = SPEND_QUALITY[quality];
  return (
    <span className={astPill(reading.tone, 'monitoring-spend-quality')} title={reading.description}>
      {reading.label}
    </span>
  );
}

export function PersonSpend({
  email,
  state,
  refreshing = false,
}: {
  email: string;
  state: PanelLoadState<OpsCostPayload>;
  refreshing?: boolean;
}) {
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <section className="monitoring-spend" aria-labelledby="monitoring-spend-title" aria-busy="true">
        <h4 id="monitoring-spend-title" className="monitoring-eyebrow">
          Spend
        </h4>
        <div role="status" className="monitoring-spend-loading">
          <Skeleton className="monitoring-spend-skeleton-total" />
          {[0, 1, 2].map((row) => (
            <div className="monitoring-spend-skeleton-row" key={row}>
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          ))}
          <span className="sr-only">Loading attributable spend</span>
        </div>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="monitoring-spend" aria-labelledby="monitoring-spend-title">
        <h4 id="monitoring-spend-title" className="monitoring-eyebrow">
          Spend
        </h4>
        <p className="monitoring-spend-absent">Unavailable. {state.error}</p>
      </section>
    );
  }
  const spend = state.data.spendByUser;
  const profile = spend?.users.find((user) => user.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
  if (!spend || !profile) {
    return (
      <section className="monitoring-spend" aria-labelledby="monitoring-spend-title">
        <h4 id="monitoring-spend-title" className="monitoring-eyebrow">
          Spend
        </h4>
        <p className="monitoring-spend-absent">
          {spend?.state === 'unavailable' ? 'Unavailable.' : 'Not attributable in this period.'}
          {spend?.reason ? ` ${spend.reason}` : ''}
        </p>
      </section>
    );
  }
  return <SpendProfile profile={profile} payload={state.data} refreshing={refreshing} />;
}

function profileCoverage(profile: UserSpendProfile): UserSpendQuality {
  const readings = [profile.total.usd, profile.total.dbu];
  const measured = readings.filter((reading) => reading.amount !== null);
  if (measured.length === 0) return 'unavailable';
  if (measured.length !== readings.length || measured.some((reading) => reading.quality === 'partial'))
    return 'partial';
  if (measured.some((reading) => reading.quality === 'allocated')) return 'allocated';
  if (measured.some((reading) => reading.quality === 'joined')) return 'joined';
  return 'direct';
}

function SpendProfile({
  profile,
  payload,
  refreshing,
}: {
  profile: UserSpendProfile;
  payload: OpsCostPayload;
  refreshing: boolean;
}) {
  const spend = payload.spendByUser!;
  const visible = profile.components.filter(
    (component) => component.usd.amount !== null || component.dbu.amount !== null || component.reason
  );
  const allUnavailable =
    visible.length > 0 && visible.every((component) => component.usd.amount === null && component.dbu.amount === null);
  if (allUnavailable) {
    return (
      <section className="monitoring-spend" aria-labelledby="monitoring-spend-title">
        <h4 id="monitoring-spend-title" className="monitoring-eyebrow">
          Spend
        </h4>
        <p className="monitoring-spend-absent">
          Unavailable for {spend.range.from} to {spend.range.to}. {spend.reason}
        </p>
      </section>
    );
  }
  return (
    <section className="monitoring-spend" aria-labelledby="monitoring-spend-title" aria-busy={refreshing || undefined}>
      <div className="monitoring-spend-heading">
        <div>
          <h4 id="monitoring-spend-title" className="monitoring-eyebrow">
            Spend
          </h4>
          <p className="monitoring-spend-total ast-num">
            {spendFigure(profile.total.usd.amount, 'USD', payload.currency)}
            <span>{spendFigure(profile.total.dbu.amount, 'DBU')}</span>
          </p>
        </div>
        <div className="monitoring-spend-badges" aria-label="Attribution coverage">
          <SpendQualityBadge quality={profileCoverage(profile)} />
          {refreshing ? <span className="monitoring-spend-refreshing">Refreshing…</span> : null}
        </div>
      </div>
      <p className="monitoring-spend-note">
        Attributable for {spend.range.from} to {spend.range.to}. Allocated figures apportion shared measured cost and
        are not an individual invoice.
      </p>
      {profile.genieAllowance ? (
        <p className="monitoring-spend-note">
          Genie {profile.genieAllowance.month}: {profile.genieAllowance.usedDbus.toFixed(2)} DBU allowance used ·{' '}
          {profile.genieAllowance.remainingDbus.toFixed(2)} remaining ·{' '}
          {profile.genieAllowance.promotionalDbus.toFixed(2)} promotional ·{' '}
          {profile.genieAllowance.chargedEffectiveDbus.toFixed(2)} charged
        </p>
      ) : null}
      <ul className="monitoring-spend-components">
        <li className="monitoring-spend-columns" aria-hidden="true">
          <span>Resource</span>
          <span>Amount</span>
          <span>Attribution</span>
        </li>
        {visible.map((component) => {
          const quality =
            component.usd.amount !== null
              ? component.usd.quality
              : component.dbu.amount !== null
                ? component.dbu.quality
                : 'unavailable';
          return (
            <li key={component.id}>
              <span className="monitoring-spend-component-name">
                {component.label}
                {component.reason ? <small title={component.reason}>{component.reason}</small> : null}
              </span>
              <span className="monitoring-spend-component-amount ast-num">
                {component.usd.amount === null && component.dbu.amount === null
                  ? 'Unavailable'
                  : `${spendFigure(component.usd.amount, 'USD', payload.currency)} · ${spendFigure(component.dbu.amount, 'DBU')}`}
              </span>
              <SpendQualityBadge quality={quality} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PersonPanel({
  panel,
  spendState = idlePanel<OpsCostPayload>(),
  spendRefreshing = false,
  now,
  rangeLabel,
  onClose,
  onOpenQuestion,
  page = 0,
  onPreviousPage = () => {},
  onNextPage = () => {},
  compactQuestions,
  onBack,
}: {
  panel: PersonPanelPayload;
  spendState?: PanelLoadState<OpsCostPayload>;
  spendRefreshing?: boolean;
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
  page?: number;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
  compactQuestions?: boolean;
  onBack?: () => void;
}) {
  const times = answerTimeTile(panel.durationsMs);
  const outcomes = outcomeTile(panel.summary);
  const scopes = readScopes(panel);
  const cost = tokenCostTile(panel.tokenCostUsd);
  return (
    <Dialog
      overlayClassName="monitoring-person-overlay"
      contentClassName="monitoring-person-modal"
      labelledBy="monitoring-person-title"
      describedBy="monitoring-person-description"
      onDismiss={onClose}
    >
      <div className="monitoring-person-modal-head">
        <div className="monitoring-panel-who">
          {onBack ? (
            <Button variant="ghost" size="sm" className="monitoring-users-back" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              Back to all users
            </Button>
          ) : null}
          <div className="min-w-0">
            <h3 id="monitoring-person-title" className="monitoring-panel-name">
              <UserIdentityChip identity={panel.email} />
            </h3>
            <p id="monitoring-person-description" className="monitoring-drawer-meta">
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
      <div className="monitoring-person-modal-body">
        <PersonSpend email={panel.email} state={spendState} refreshing={spendRefreshing} />
        <h4 className="monitoring-eyebrow">
          What they asked <span className="monitoring-eyebrow-range">{rangeLabel}</span>
        </h4>
        <div className={`monitoring-panel-grid${cost ? '' : ' monitoring-panel-grid-without-cost'}`}>
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
          {cost ? <PanelTile label="Token cost" tile={cost} /> : null}
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
          <TablesReadMost rows={panel.tablesReadMost} />
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
              The grants for this person could not be read just now, so none are shown. This says nothing about what
              they can reach.
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
                  {grant.rowFilter ? <p className="monitoring-grant-note">Row filter applied.</p> : null}
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
          </div>
          <div className="monitoring-panel-tile">
            <p className="monitoring-panel-tile-label" title={codesForCause('agent-rules').join(', ')}>
              Refused by the agent&apos;s own rules
            </p>
            <p className="monitoring-panel-tile-value ast-num">{panel.refusedAgentRules.toLocaleString()}</p>
          </div>
        </div>

        <h4 className="monitoring-eyebrow">
          Their questions <span className="monitoring-eyebrow-range">{rangeLabel}</span>
        </h4>
        {panel.questions.length === 0 ? (
          <p className="monitoring-empty-line">No questions from this person in this range.</p>
        ) : (
          <QuestionList
            questions={panel.questions}
            selectedId=""
            now={now}
            onOpen={onOpenQuestion}
            compact={compactQuestions}
          />
        )}
        <MonitoringPaginationControls
          pagination={panel.pagination}
          page={page}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
        />
      </div>
    </Dialog>
  );
}

export function PersonPanelShell({
  state,
  spendState = idlePanel<OpsCostPayload>(),
  spendRefreshing = false,
  email,
  now,
  rangeLabel,
  page,
  onClose,
  onOpenQuestion,
  onPreviousPage,
  onNextPage,
  onRetry,
  onBack,
}: {
  state: PanelLoadState<PersonPanelPayload>;
  spendState?: PanelLoadState<OpsCostPayload>;
  spendRefreshing?: boolean;
  email: string;
  now: number;
  rangeLabel: string;
  page: number;
  onClose: () => void;
  onOpenQuestion: (question: MonitoringQuestion) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onRetry: () => void;
  onBack?: () => void;
}) {
  if (state.status === 'ready') {
    return (
      <PersonPanel
        panel={state.data}
        spendState={spendState}
        spendRefreshing={spendRefreshing}
        now={now}
        rangeLabel={rangeLabel}
        page={page}
        onClose={onClose}
        onOpenQuestion={onOpenQuestion}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onBack={onBack}
      />
    );
  }
  return (
    <Dialog
      overlayClassName="monitoring-person-overlay"
      contentClassName="monitoring-person-modal monitoring-panel-status"
      labelledBy="monitoring-person-title"
      describedBy="monitoring-person-description"
      ariaBusy={state.status === 'loading' || state.status === 'idle'}
      onDismiss={onClose}
    >
      <div className="monitoring-person-modal-head">
        <div>
          {onBack ? (
            <Button variant="ghost" size="sm" className="monitoring-users-back" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              Back to all users
            </Button>
          ) : null}
          <h3 id="monitoring-person-title" className="monitoring-panel-name">
            {localPart(email) || 'User activity'}
          </h3>
          <p id="monitoring-person-description" className="sr-only">
            User activity and attributable spend
          </p>
        </div>
        <Button variant="outline" size="sm" className="monitoring-drawer-close" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </Button>
      </div>
      <div className="monitoring-person-modal-body">
        {state.status === 'error' ? (
          <div role="alert" className="monitoring-panel-message">
            <p>{state.error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <div role="status" className="monitoring-panel-message">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <span className="sr-only">Loading person activity</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function userSpendFigure(row: UserMonitoringRow, unit: 'USD' | 'DBU'): string {
  const reading = unit === 'USD' ? row.spend.usd : row.spend.dbu;
  if (reading.amount === null) return 'Unavailable';
  return unit === 'USD'
    ? `$${reading.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${reading.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DBU`;
}

export function UserMonitoringPanel({
  state,
  browser,
  rangeLabel,
  now,
  onClose,
  onOpenUser,
  onSearch,
  onRole,
  onUnit,
  onClear,
  onNext,
  onPrevious,
}: {
  state: PanelLoadState<OpsCostPayload>;
  browser: ReturnType<typeof userBrowserFromParams>;
  rangeLabel: string;
  now: number;
  onClose: () => void;
  onOpenUser: (email: string) => void;
  onSearch: (search: string) => void;
  onRole: (role: string) => void;
  onUnit: (unit: 'USD' | 'DBU') => void;
  onClear: () => void;
  onNext: (cursor: string) => void;
  onPrevious: () => void;
}) {
  const payload: UserMonitoringPayload | null = state.status === 'ready' ? (state.data.userMonitoring ?? null) : null;
  const changed = Boolean(browser.search || browser.role);
  return (
    <Dialog
      overlayClassName="monitoring-person-overlay"
      contentClassName="monitoring-person-modal monitoring-users-modal"
      labelledBy="monitoring-users-title"
      describedBy="monitoring-users-description"
      ariaBusy={state.status === 'loading' || state.status === 'idle'}
      onDismiss={onClose}
    >
      <div className="monitoring-person-modal-head">
        <div>
          <h3 id="monitoring-users-title" className="monitoring-users-title">
            User Monitoring
          </h3>
          <p id="monitoring-users-description" className="monitoring-drawer-meta">
            Per-user activity and attributable spend · {rangeLabel}
          </p>
        </div>
        <Button variant="outline" size="sm" className="monitoring-drawer-close" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Close User Monitoring</span>
        </Button>
      </div>
      <div className="monitoring-person-modal-body monitoring-users-body">
        <div className="monitoring-users-toolbar">
          <SearchBox
            value={browser.search}
            onChange={onSearch}
            placeholder="Search users…"
            ariaLabel="Search users by display name or email"
            className="monitoring-users-search"
          />
          <AppSelect
            label="Role"
            ariaLabel="Filter users by role"
            value={browser.role || NO_FILTER}
            options={[
              { value: NO_FILTER, label: 'All roles' },
              { value: 'super_admin', label: 'Super admin' },
              { value: 'admin', label: 'Admin' },
              { value: 'consumer', label: 'Consumer' },
            ]}
            onValueChange={(role) => onRole(role === NO_FILTER ? '' : role)}
          />
          <TimeRangeControl page="User Monitoring" />
          <div className="monitoring-users-unit" role="radiogroup" aria-label="Per-user spend unit">
            {(['USD', 'DBU'] as const).map((unit) => (
              <Button
                key={unit}
                variant={browser.unit === unit ? 'default' : 'outline'}
                size="sm"
                role="radio"
                aria-checked={browser.unit === unit}
                onClick={() => onUnit(unit)}
              >
                {unit === 'USD' ? '$' : unit}
              </Button>
            ))}
          </div>
          {changed ? (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
        </div>

        {state.status === 'error' ? (
          <p className="monitoring-spend-absent" role="alert">
            {state.error}
          </p>
        ) : state.status === 'loading' || state.status === 'idle' ? (
          <div className="monitoring-users-skeleton" role="status">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} />
            ))}
            <span className="sr-only">Loading users</span>
          </div>
        ) : !payload ? (
          <p className="monitoring-spend-absent" role="status">
            User activity is available only when the server-authorized spend snapshot can be read.
          </p>
        ) : (
          <>
            {payload.reason ? <p className="monitoring-users-coverage">{payload.reason}</p> : null}
            <div className="monitoring-users-list" role="list" aria-label="Users ordered by attributable spend">
              <div className="monitoring-users-columns" aria-hidden="true">
                <span>User</span>
                <span>Role</span>
                <span>Last active</span>
                <span>Questions / runs</span>
                <span>Amount</span>
                <span>Coverage</span>
              </div>
              {payload.users.map((row) => (
                <button
                  type="button"
                  className="monitoring-user-row"
                  role="listitem"
                  key={row.email}
                  onClick={() => onOpenUser(row.email)}
                  aria-label={`Open ${localPart(row.email)} User Overview`}
                >
                  <span className="monitoring-user-identity">
                    <UserIdentityChip identity={row.email} compact />
                  </span>
                  <span>
                    <span className="monitoring-users-mobile-label">Role</span>
                    {ROLE_WORD[row.role]}
                  </span>
                  <span>
                    <span className="monitoring-users-mobile-label">Last active</span>
                    {row.lastActive ? whenLabel(row.lastActive, now) : 'Not recorded'}
                  </span>
                  <span className="ast-num">
                    <span className="monitoring-users-mobile-label">Questions / runs</span>
                    {row.questions.toLocaleString()} / {row.runs.toLocaleString()}
                  </span>
                  <span className="monitoring-user-amount ast-num">
                    <span className="monitoring-users-mobile-label">Amount</span>
                    {userSpendFigure(row, browser.unit)}
                  </span>
                  <span className="monitoring-user-coverage">
                    <SpendQualityBadge quality={row.coverage} />
                    <ChevronRight aria-hidden="true" />
                  </span>
                </button>
              ))}
            </div>
            {payload.users.length === 0 ? (
              <p className="monitoring-empty-line">
                No users match {browser.search ? `"${browser.search}"` : 'the active filters'}
                {browser.role ? ` and ${ROLE_WORD[isRole(browser.role) ? browser.role : 'consumer']} role` : ''}.
              </p>
            ) : null}
            <div className="monitoring-users-pagination">
              <Button variant="outline" size="sm" disabled={!browser.cursor} onClick={onPrevious}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!payload.pagination.nextCursor}
                onClick={() => payload.pagination.nextCursor && onNext(payload.pagination.nextCursor)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
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
  onOpenPerson?: (email: string) => void;
  onOpenUsers?: () => void;
  onChangeFilters: (next: MonitoringFilters) => void;
  onClearFilters: () => void;
  onRetry: () => void;
  page?: number;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
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
  onOpenPerson,
  onOpenUsers,
  onChangeFilters,
  onClearFilters,
  onRetry,
  page = 0,
  onPreviousPage = () => {},
  onNextPage = () => {},
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
        <SkeletonStrip periodLabel={rangeLabel} />
      ) : payload ? (
        <SummaryStrip payload={payload} periodLabel={rangeLabel} />
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
        onOpenUsers={onOpenUsers}
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
            paged={page > 0 || payload?.pagination.hasMore === true}
            onClearFilters={onClearFilters}
            onChangeFilters={onChangeFilters}
          />
        ) : (
          <QuestionList
            questions={questions}
            selectedId={selectedId}
            now={now}
            onOpen={onOpen}
            onOpenPerson={onOpenPerson}
          />
        )}
      </div>
      {payload && state !== 'loading' ? (
        <MonitoringPaginationControls
          pagination={payload.pagination}
          page={page}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
        />
      ) : null}
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
  paged,
  onClearFilters,
  onChangeFilters,
}: {
  state: EmptyState;
  filters: MonitoringFilters;
  paged: boolean;
  onClearFilters: () => void;
  onChangeFilters: (next: MonitoringFilters) => void;
}) {
  const copy = emptyCopy(state, { search: filters.search, chips: chipsActive(filters) });
  const sentence =
    paged && state !== 'empty-range'
      ? state === 'empty-search'
        ? `No questions on this page match "${filters.search.trim()}".`
        : 'No questions on this page match these filters.'
      : copy.sentence;
  return (
    <div className="monitoring-empty">
      <p className="monitoring-empty-line">{sentence}</p>
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

const PANEL_CACHE_MS = 60_000;
const panelCache = new Map<string, { expiresAt: number; data: unknown }>();

function usePanelRequest<T>(key: string, url: string, errorMessage: string) {
  const [state, setState] = useState<PanelLoadState<T>>(() => idlePanel<T>());
  const [attempt, setAttempt] = useState(0);
  const [refreshingKey, setRefreshingKey] = useState('');

  useEffect(() => {
    if (!key || !url) {
      setState(idlePanel<T>());
      return;
    }
    const controller = new AbortController();
    const requestId = ++panelRequestSequence;
    const cached = panelCache.get(key);
    const retained = cached && cached.expiresAt > Date.now() ? (cached.data as T) : null;
    if (cached && !retained) panelCache.delete(key);
    setState(
      retained ? { status: 'ready', key, requestId, data: retained, error: null } : beginPanelLoad<T>(key, requestId)
    );
    setRefreshingKey(retained ? key : '');

    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 403 ? 'forbidden' : `http_${response.status}`);
        return (await response.json()) as T;
      })
      .then((data) => {
        panelCache.set(key, { expiresAt: Date.now() + PANEL_CACHE_MS, data });
        setState((current) => resolvePanelLoad(current, key, requestId, data));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        const message =
          error instanceof Error && error.message === 'forbidden'
            ? 'You do not have access to these Monitoring details.'
            : errorMessage;
        if (!retained) setState((current) => rejectPanelLoad(current, key, requestId, message));
      })
      .finally(() => setRefreshingKey((current) => (current === key ? '' : current)));

    return () => controller.abort();
  }, [attempt, errorMessage, key, url]);

  // Effects start after render. Mask a completed prior key synchronously so a
  // URL/range change cannot paint old-range data under the new range label for
  // even one frame while the abort and replacement request are being scheduled.
  const visibleState = panelStateForKey(state, key, 0);
  return {
    state: visibleState,
    refreshing: refreshingKey === key && visibleState.status === 'ready',
    retry: () => setAttempt((value) => value + 1),
  };
}

let panelRequestSequence = 0;

interface CursorPages {
  owner: string;
  cursors: string[];
  index: number;
}

function cursorFor(owner: string, pages: CursorPages): string {
  return pages.owner === owner ? (pages.cursors[pages.index] ?? '') : '';
}

export function MonitoringHeading({
  loading,
  checkedAt,
  now,
  onRefresh,
}: {
  loading: boolean;
  checkedAt: string;
  now: number;
  onRefresh: () => void;
}) {
  return (
    <PageHeading
      title="Monitoring"
      actions={
        <div className="monitoring-heading-actions">
          <div className="monitoring-heading-period">
            <span className="monitoring-heading-period-label" aria-hidden="true">
              Period
            </span>
            <TimeRangeControl page="Monitoring" />
          </div>
          <RefreshControl busy={loading} checkedAt={checkedAt} now={now} onRefresh={onRefresh} />
        </div>
      }
    />
  );
}

export function MonitoringPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // The clock is read once per render pass rather than per row, so every
  // relative stamp on one paint is relative to the same instant.
  const [now, setNow] = useState(() => Date.now());
  const scroll = useRef(scrollMemory());

  const filters = filtersFromParams(searchParams);
  const drawer = drawerFromParams(searchParams);
  const userBrowser = userBrowserFromParams(searchParams);
  const window_ = rangeWindow(searchParams, now);
  const periodLabel = rangeLabel(searchParams);
  const rangeId = monitoringRangeId(searchParams);
  const filterKey = JSON.stringify(filters);
  const listOwner = `${rangeId}|${window_.from}|${window_.to}|${filterKey}`;
  const [listPages, setListPages] = useState<CursorPages>({ owner: listOwner, cursors: [''], index: 0 });
  const listCursor = cursorFor(listOwner, listPages);
  const listPage = monitoringPageForOwner(listOwner, listPages);
  const { payload, loading, refresh } = useMonitoringQuestions({
    rangeId,
    from: window_.from,
    to: window_.to,
    filters,
    cursor: listCursor,
  });

  // The top navigation restores this view's controls after another tab. Detail
  // panel parameters are deliberately excluded by rememberMonitoringSearch.
  useEffect(() => {
    rememberMonitoringSearch(location.search);
  }, [location.search]);

  const personOwner = `${drawer.person.toLowerCase()}|${window_.from}|${window_.to}|${filterKey}`;
  const [personPages, setPersonPages] = useState<CursorPages>({
    owner: personOwner,
    cursors: [''],
    index: 0,
  });
  const personCursor = cursorFor(personOwner, personPages);
  const personPage = monitoringPageForOwner(personOwner, personPages);

  const questionKey = drawer.question ? monitoringDetailKey('question', drawer.question, window_.from, window_.to) : '';
  const questionRequest = usePanelRequest<MonitoringDetail>(
    questionKey,
    drawer.question ? questionDetailUrl(drawer.question, window_.from, window_.to) : '',
    'Question details could not be loaded.'
  );
  const personKey = drawer.person
    ? monitoringDetailKey('person', drawer.person, window_.from, window_.to, personCursor)
    : '';
  const personRequest = usePanelRequest<PersonPanelPayload>(
    personKey,
    drawer.person ? personDetailUrl(drawer.person, window_.from, window_.to, filters, personCursor) : '',
    'User activity could not be loaded.'
  );
  const spendParams = new URLSearchParams({ from: window_.from, to: window_.to });
  if (drawer.person) spendParams.set('spendUser', drawer.person);
  const personSpendKey = drawer.person
    ? monitoringDetailKey('person', `spend:${drawer.person}`, window_.from, window_.to)
    : '';
  const personSpendRequest = usePanelRequest<OpsCostPayload>(
    personSpendKey,
    drawer.person ? `/api/ops/cost?${spendParams.toString()}` : '',
    'Attributable spend could not be loaded.'
  );
  const userBrowserParams = new URLSearchParams({
    from: window_.from,
    to: window_.to,
    userBrowse: '1',
    unit: userBrowser.unit,
    pageSize: '25',
  });
  if (userBrowser.search) userBrowserParams.set('userSearch', userBrowser.search);
  if (userBrowser.role) userBrowserParams.set('role', userBrowser.role);
  if (userBrowser.cursor) userBrowserParams.set('userCursor', userBrowser.cursor);
  const userBrowserKey =
    userBrowser.open && !drawer.person
      ? `users|${window_.from}|${window_.to}|${userBrowser.unit}|${userBrowser.search}|${userBrowser.role}|${userBrowser.cursor}`
      : '';
  const userBrowserRequest = usePanelRequest<OpsCostPayload>(
    userBrowserKey,
    userBrowserKey ? `/api/ops/cost?${userBrowserParams.toString()}` : '',
    'User Monitoring could not be loaded.'
  );

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

  const closeUserMonitoring = useCallback(() => {
    void navigate({ search: closedUserMonitoring(location.search) }, { replace: true });
    const offset = scroll.current.take();
    if (offset !== null && typeof globalThis.scrollTo === 'function') globalThis.scrollTo({ top: offset });
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

  const userBrowserUnit = userBrowser.unit;
  const openUsers = () => {
    scroll.current.capture(typeof globalThis.scrollY === 'number' ? globalThis.scrollY : 0);
    void navigate({ search: openUserBrowser(location.search, userBrowserUnit) });
  };

  const updateUserBrowser = useCallback(
    (name: 'userSearch' | 'userRole' | 'userUnit' | 'userCursor', value: string) => {
      const next = new URLSearchParams(location.search);
      next.set('users', '1');
      if (value) next.set(name, value);
      else next.delete(name);
      if (name !== 'userCursor') next.delete('userCursor');
      void navigate({ search: next.toString() }, { replace: name === 'userSearch' });
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

  const visible = payload ? applyFilters(payload.questions, filters) : [];
  const state: MonitoringState = monitoringState({
    // A refresh keeps the last successful strip and page visible. Only a view
    // with nothing retained uses the full skeleton.
    loading: loading && !payload,
    readState: payload?.readState ?? null,
    rowCount: visible.length,
    filtersActive: filtersActive(filters),
    searchActive: filters.search !== '',
  });
  const refreshView = useCallback(() => {
    const refreshedAt = Date.now();
    const refreshedWindow = rangeWindow(searchParams, refreshedAt);
    setNow(refreshedAt);
    refresh({
      rangeId,
      from: refreshedWindow.from,
      to: refreshedWindow.to,
      filters,
      cursor: listCursor,
    });
  }, [filters, listCursor, rangeId, refresh, searchParams]);

  return (
    <div className="page-shell monitoring-page">
      <MonitoringHeading loading={loading} checkedAt={payload?.readAt ?? ''} now={now} onRefresh={refreshView} />

      <MonitoringBody
        state={state}
        payload={payload}
        questions={visible}
        filters={filters}
        rangeLabel={periodLabel}
        selectedId={drawer.question}
        now={now}
        onOpen={open}
        onOpenPerson={openPersonPanel}
        onOpenUsers={openUsers}
        onChangeFilters={changeFilters}
        onClearFilters={() => setSearchParams(new URLSearchParams(clearedFilters(location.search)), { replace: true })}
        onRetry={refreshView}
        page={listPage}
        onPreviousPage={() =>
          setListPages((current) => ({
            owner: listOwner,
            cursors: current.owner === listOwner ? current.cursors : [''],
            index: Math.max(0, current.owner === listOwner ? current.index - 1 : 0),
          }))
        }
        onNextPage={() => {
          const next = payload?.pagination.nextCursor;
          if (!next) return;
          setListPages((current) => {
            const cursors = current.owner === listOwner ? current.cursors.slice(0, current.index + 1) : [''];
            return { owner: listOwner, cursors: [...cursors, next], index: cursors.length };
          });
        }}
      />

      {drawer.question ? (
        <QuestionPanel
          state={questionRequest.state}
          title={payload?.questions.find((question) => question.id === drawer.question)?.question ?? 'Question details'}
          onClose={close}
          onOpenPerson={openPersonPanel}
          onRetry={questionRequest.retry}
        />
      ) : null}
      {drawer.person ? (
        <PersonPanelShell
          state={personRequest.state}
          spendState={personSpendRequest.state}
          spendRefreshing={personSpendRequest.refreshing}
          email={drawer.person}
          now={now}
          rangeLabel={window_.label}
          page={personPage}
          onClose={userBrowser.open ? closeUserMonitoring : close}
          onBack={userBrowser.open ? () => void navigate({ search: backToUserBrowser(location.search) }) : undefined}
          onOpenQuestion={open}
          onRetry={personRequest.retry}
          onPreviousPage={() =>
            setPersonPages((current) => ({
              owner: personOwner,
              cursors: current.owner === personOwner ? current.cursors : [''],
              index: Math.max(0, current.owner === personOwner ? current.index - 1 : 0),
            }))
          }
          onNextPage={() => {
            const next = personRequest.state.status === 'ready' ? personRequest.state.data.pagination.nextCursor : null;
            if (!next) return;
            setPersonPages((current) => {
              const cursors = current.owner === personOwner ? current.cursors.slice(0, current.index + 1) : [''];
              return { owner: personOwner, cursors: [...cursors, next], index: cursors.length };
            });
          }}
        />
      ) : null}
      {userBrowser.open && !drawer.person && !drawer.question ? (
        <UserMonitoringPanel
          state={userBrowserRequest.state}
          browser={userBrowser}
          rangeLabel={window_.label}
          now={now}
          onClose={closeUserMonitoring}
          onOpenUser={(email) => void navigate({ search: openUserFromBrowser(location.search, email) })}
          onSearch={(search) => updateUserBrowser('userSearch', search)}
          onRole={(role) => updateUserBrowser('userRole', role)}
          onUnit={(unit) => updateUserBrowser('userUnit', unit)}
          onClear={() => {
            const next = new URLSearchParams(location.search);
            next.delete('userSearch');
            next.delete('userRole');
            next.delete('userCursor');
            void navigate({ search: next.toString() }, { replace: true });
          }}
          onNext={(cursor) => updateUserBrowser('userCursor', cursor)}
          onPrevious={() => void navigate(-1)}
        />
      ) : null}
    </div>
  );
}

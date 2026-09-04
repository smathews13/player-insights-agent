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
import { Link, useLocation, useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { ArrowLeft, ArrowUpRight, ChevronRight, Search, ThumbsDown, ThumbsUp, Users, X } from 'lucide-react';
import { astPill, type AstPillFamily } from './pia-pill';
import { BrandIcon } from './BrandIcon';
import { Button, Input, Skeleton } from './ui';
import { AppSelect } from './AppSelect';
import { PiaFlicker } from './PiaFlicker';
import { PiaEmptyStateMark, PiaMark } from './PiaMark';
import { showsAdminSurfaces, type AppOutletContext } from './role';
import { PageHeading } from './page-chrome';
import { RefreshControl } from './RefreshControl';
import { UnavailablePanel } from './UnavailablePanel';
import { unavailableNotice } from './unavailable-copy';
import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { SourceEntityName, VisitInDatabricks } from './DataEntityLinks';
import { UserIdentityChip } from './UserIdentityChip';
import { UserDrilldownLink } from './UserDrilldownLink';
import { UnitSegmentedControl } from './UnitSegmentedControl';
import { RoleBadgePill } from './RoleBadge';
import { EstimatedBadge } from './EstimatedBadge';
import { identityName } from './user-identity';
import { ToolCallsLabel } from './ToolCallsLabel';
import { OrganizationAvatar } from './OrganizationAvatar';
import { UserOrganizationSelect } from './UserOrganizationSelect';
import type { Answer, FeedbackEntry } from './app-types';
import { tokenTotalUsageView } from './token-usage-view';
import { isMlflowTraceId } from '../../shared/mlflow-trace-id';
import { profileAskedHeading } from './profile-heading';
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
  feedbackTile,
  personFeedbackTile,
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
  closedFeedbackBrowser,
  closedUserMonitoring,
  closedDrawer,
  drawerFromParams,
  feedbackBrowserFromParams,
  filtersActive,
  filtersFromParams,
  openFeedbackBrowser,
  openPerson,
  openQuestion,
  openUserBrowser,
  openUserFromBrowser,
  scrollMemory,
  userBrowserFromParams,
  withFilters,
  withUserBrowserFilters,
  type MonitoringFilters,
} from './monitoring-filters';
import { monitoringQuestionRowHandlers } from './monitoring-row-activation';
// Shared with Ops, so the two tabs cannot be over different windows.
import { TimeRangeControl, TimeRangeSegments } from './TimeRangeControl';
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
import { rangeFromParams, rangeLabel, rangeWindow, type RangeKey } from './time-range';
import type {
  MonitoringDetail,
  MonitoringPagination,
  MonitoringQuestion,
  MonitoringQuestionsPayload,
  PersonPanelPayload,
} from '../../shared/monitoring-contract';
import type { OpsCostPayload } from '../../shared/ops-contract';
import type { UserSpendKpi } from '../../shared/user-spend-contract';
import { deriveCoreUserSpendMetrics, deriveUserTokenAverages } from '../../shared/user-spend-metrics';
import {
  USER_MONITORING_SCHEMA_REVISION,
  type UserMonitoringPayload,
  type UserMonitoringRow,
} from '../../shared/user-monitoring-contract';
import { ROLE_WORD, isRole, type Role } from '../../shared/user-roster-contract';
import { decodeUserMonitoringCostPayload, decodeUserSpendPayload } from './user-monitoring-payload';
import {
  cacheUserSpendTotal,
  cachedUserSpendTotal,
  clearUserSpendTotalCache,
  requestUserSpendTotal,
  userSpendTotalBaseKey,
  type CachedUserSpendTotal,
  type UserSpendTotalCoordinates,
} from './user-spend-total-cache';
import { listenForIdentitySettingsChanges } from './identity-settings-events';
import { USER_SPEND_DIAGNOSES, userSpendHttpDiagnosis, userSpendPayloadDiagnosis } from './user-spend-diagnosis';
import { UsedThisRun } from './UsedThisRun';
import { Dialog } from './Dialog';
import { FeedbackBrowserPanel } from './FeedbackBrowserPanel';
import {
  invalidateFeedbackBrowserSession,
  useFeedbackBrowser,
  type FeedbackBrowserFilters,
} from './feedback-browser-session';
import type { MonitoringFeedbackRow } from '../../shared/monitoring-feedback-contract';

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
  onOpen,
  actionLabel,
}: {
  label: string;
  tile: TileValue;
  periodLabel: string;
  className?: string;
  onOpen?: () => void;
  actionLabel?: string;
}) {
  const content = (
    <>
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
      {onOpen && actionLabel ? (
        <span className="monitoring-tile-affordance">
          {actionLabel}
          <ChevronRight aria-hidden="true" />
        </span>
      ) : null}
    </>
  );
  const classes = ['monitoring-tile', 'ast-surface-primary', onOpen ? 'monitoring-tile-action' : '', className]
    .filter(Boolean)
    .join(' ');
  return onOpen ? (
    <button type="button" className={classes} aria-label={`${label}, ${periodLabel}. ${actionLabel}`} onClick={onOpen}>
      {content}
    </button>
  ) : (
    <div className={classes} role="group" aria-label={`${label}, ${periodLabel}`}>
      {content}
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
export function SummaryStrip({
  payload,
  periodLabel,
  onOpenFeedback,
}: {
  payload: MonitoringQuestionsPayload;
  periodLabel: string;
  onOpenFeedback?: () => void;
}) {
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
        className="monitoring-tile monitoring-outcomes-tile ast-surface-primary"
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
        label="Feedback"
        tile={feedbackTile(payload.summary)}
        periodLabel={periodLabel}
        className="monitoring-summary-rated"
        onOpen={onOpenFeedback}
        actionLabel={onOpenFeedback ? 'Open feedback' : undefined}
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
        <div className="monitoring-tile ast-surface-primary" key={index}>
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
 * One filter dropdown, through the app's shared non-modal primitive.
 *
 * It was a native `<select>`. A native select opens the operating system's menu,
 * which is drawn by the platform and cannot be styled where it matters, so it
 * looked like nothing else in the app and appeared detached from the control
 * that opened it. The menu opens in a body portal anchored to the trigger, owns
 * its scrolling, and does not lock or resize the document.
 *
 * Accessibility is not traded for the appearance. The trigger is a combobox
 * whose accessible name is the filter and whose value is the current choice, so
 * a reader hears "User, All users" as it heard from the native control. Arrow keys
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
  ariaLabel = 'Search questions or users',
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
        options={[
          { value: '', label: 'All users' },
          ...people.map((email) => ({ value: email, label: localPart(email) })),
        ]}
      />
      <FilterChip
        label="Outcome"
        value={filters.outcome}
        onChange={(outcome) => onChange({ ...filters, outcome: outcome as MonitoringFilters['outcome'] })}
        options={[
          { value: '', label: 'All outcomes' },
          { value: 'completed', label: 'Completed' },
          { value: 'partial', label: 'Partial' },
          { value: 'refused', label: 'Refused' },
          { value: 'failed', label: 'Failed' },
        ]}
      />
      <FilterChip
        label="Feedback"
        value={filters.feedback ?? ''}
        onChange={(feedback) => onChange({ ...filters, feedback: feedback as MonitoringFilters['feedback'] })}
        options={[
          { value: '', label: 'All feedback' },
          { value: 'up', label: 'Helpful' },
          { value: 'down', label: 'Not helpful' },
          { value: 'none', label: 'No feedback' },
        ]}
      />
      {/* The PIA-specific one, and the one worth more than the others: every
          question whose run read a given table. It is what an admin reaches for
          when a table changes and they want to know who will notice. */}
      <FilterChip
        label="Table"
        value={filters.table}
        onChange={(table) => onChange({ ...filters, table })}
        options={[{ value: '', label: 'Any table' }, ...tables.map((table) => ({ value: table, label: table }))]}
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
      <div className="monitoring-filter-actions">
        {onOpenUsers ? (
          <Button variant="default" size="sm" className="monitoring-user-browser-trigger" onClick={onOpenUsers}>
            <Users aria-hidden="true" />
            User Monitoring
          </Button>
        ) : null}
        <SearchBox value={filters.search} onChange={(search) => onChange({ ...filters, search })} />
      </div>
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
  if (!onOpen) return <UserIdentityChip identity={email} compact className="monitoring-asker-who" />;
  return <UserDrilldownLink identity={email} compact className="monitoring-asker-who" canOpen showArrow />;
}

function FeedbackMark({ feedback }: { feedback: 'up' | 'down' | null | undefined }) {
  if (feedback === 'up') return <ThumbsUp className="size-3.5 monitoring-thumb-up" aria-label="Helpful" />;
  if (feedback === 'down') {
    return <ThumbsDown className="size-3.5 monitoring-thumb-down" aria-label="Not helpful" />;
  }
  return <span className="sr-only">No feedback</span>;
}

function TotalTokens({ value }: { value: number | null }) {
  const tokens = tokenTotalUsageView(value);
  return (
    <span className="monitoring-token-total ast-num" title={tokens.exactLabel} aria-label={tokens.exactLabel}>
      {tokens.compact}
    </span>
  );
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
  const activation = monitoringQuestionRowHandlers(question, onOpen);
  return (
    <tr
      aria-current={selected ? 'true' : undefined}
      aria-haspopup="dialog"
      aria-label={`Open question details: ${question.question}`}
      className={selected ? 'monitoring-row monitoring-row-selected' : 'monitoring-row'}
      tabIndex={0}
      {...activation}
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
      <td className="monitoring-numeric monitoring-token-cell">
        <TotalTokens value={question.totalTokens} />
      </td>
      <td className="monitoring-numeric monitoring-tool-cell">
        {question.toolCalls === null ? null : (
          <ToolCallsLabel>
            <span className="ast-num">{question.toolCalls}</span>
          </ToolCallsLabel>
        )}
      </td>
      <td>
        <FeedbackMark feedback={question.feedback ?? question.rating} />
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
  const activation = monitoringQuestionRowHandlers(question, onOpen);
  return (
    <li
      className={selected ? 'monitoring-question-card monitoring-row-selected' : 'monitoring-question-card'}
      aria-current={selected ? 'true' : undefined}
      aria-haspopup="dialog"
      aria-label={`Open question details: ${question.question}`}
      tabIndex={0}
      {...activation}
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
        <span>
          Total tokens <TotalTokens value={question.totalTokens} />
        </span>
        {question.toolCalls !== null ? (
          <span className="monitoring-tool-inline">
            <ToolCallsLabel>Tools</ToolCallsLabel> <span className="ast-num">{question.toolCalls}</span>
          </span>
        ) : null}
        <FeedbackMark feedback={question.feedback ?? question.rating} />
      </span>
    </li>
  );
}

/**
 * One focusable row per question, with a separate user link when the reader may
 * open profiles. The row keeps its native table/list semantics while its click
 * and keyboard handlers ignore that nested link and any future real controls.
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
          <th scope="col" className="monitoring-numeric monitoring-col-tokens">
            Total tokens
          </th>
          <th scope="col" className="monitoring-numeric monitoring-col-tools">
            <ToolCallsLabel>Tools</ToolCallsLabel>
          </th>
          <th scope="col" className="monitoring-col-rating">
            Feedback
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
 * Feedback is read-only here. The shared KPI may report the asker's stored
 * direction, while `showFeedback={false}` keeps interactive thumbs absent so an
 * admin can never overwrite it.
 */
function readOnlyFeedback(detail: MonitoringDetail): FeedbackEntry {
  const sentiment = detail.feedback ?? detail.rating ?? null;
  return {
    open: false,
    comment: detail.comment ?? '',
    saved: sentiment !== null || detail.usefulness != null,
    saving: false,
    error: null,
    sentiment,
    usefulness: detail.usefulness,
  };
}

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
  canOpenUser,
}: {
  detail: MonitoringDetail;
  onClose: () => void;
  canOpenUser: boolean;
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
            It is identity context rather than a second link to the same profile;
            the one user-overview control sits in the onward-actions row below.
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
            Open the MLflow trace
            <ArrowUpRight className="monitoring-link-arrow size-3.5" aria-hidden="true" />
          </a>
        ) : null}
        {detail.runId ? (
          <Link to={`/runs?run=${encodeURIComponent(detail.runId)}`}>
            Open in Run Explorer
            <ArrowUpRight className="monitoring-link-arrow size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
        {/* The shared identity chip is the whole control: one accessible name,
              no nested button, and no possessive activity sentence. It writes the
              canonical `who` URL as a normal router entry, so Back restores this
              question and its filters. Unknown/system actors stay plain content,
              and the explicit gate keeps the same chip non-interactive when the
              reader cannot open User Monitoring. */}
        <UserDrilldownLink identity={detail.askedBy} compact canOpen={canOpenUser} showArrow />
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
          feedback={readOnlyFeedback(detail)}
          onFeedbackChange={() => {}}
          saveFeedback={async () => {}}
          showFeedback={false}
          runProcessVariant="monitoring"
          afterEvidence={
            isMlflowTraceId(answer.trace.id) &&
            answer.trace.stages.length > 0 &&
            answer.trace.total_tokens !== undefined
              ? undefined
              : tokensNote(detail.tokens)
          }
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

      {(detail.feedback ?? detail.rating) || detail.comment ? (
        <section className="monitoring-drawer-section">
          <h4 className="monitoring-eyebrow">Feedback</h4>
          <p className="monitoring-drawer-rating">
            <FeedbackMark feedback={detail.feedback ?? detail.rating} />
            {(detail.feedback ?? detail.rating) === 'up'
              ? 'Helpful'
              : (detail.feedback ?? detail.rating) === 'down'
                ? 'Not helpful'
                : 'No feedback'}
          </p>
          {/* Verbatim. A comment paraphrased is a comment nobody wrote. */}
          {(detail.feedback ?? detail.rating) === 'down' && detail.comment ? (
            <p className="monitoring-drawer-comment">{detail.comment}</p>
          ) : null}
        </section>
      ) : null}
    </Dialog>
  );
}

export function QuestionPanel({
  state,
  title,
  onClose,
  canOpenUser,
  onRetry,
}: {
  state: PanelLoadState<MonitoringDetail>;
  title: string;
  onClose: () => void;
  canOpenUser: boolean;
  onRetry: () => void;
}) {
  if (state.status === 'ready') {
    return <QuestionDrawer detail={state.data} onClose={onClose} canOpenUser={canOpenUser} />;
  }
  return (
    <Dialog
      overlayClassName="monitoring-question-overlay"
      contentClassName="monitoring-question-modal monitoring-question-status"
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
        <div role="alert" className="monitoring-question-message">
          <p>{state.error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <div role="status" className="monitoring-question-message">
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
    <div className="user-profile-modal-kpi">
      <p className="user-profile-modal-kpi-label">{label}</p>
      {tile.value !== null ? (
        <p className="user-profile-modal-kpi-value ast-num">{tile.value}</p>
      ) : (
        <p className="user-profile-modal-kpi-absent">{tile.absence}</p>
      )}
      {tile.caption ? <p className="user-profile-modal-kpi-caption">{tile.caption}</p> : null}
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
  return (
    <section className="user-profile-modal-tables" aria-labelledby="user-profile-tables-title">
      <h4 id="user-profile-tables-title" className="user-profile-modal-section-title">
        Tables read most
      </h4>
      {rows.length === 0 ? (
        <p className="user-profile-modal-state">No table reads were recorded in this range.</p>
      ) : (
        <ol className="user-profile-modal-table-list">
          {rows.map((row) => (
            <li key={row.table}>
              <span className="user-profile-modal-table-name" title={row.table} aria-label={row.table}>
                <VisitInDatabricks name={row.table} />
                <span className="source-name-pill" data-tone="queried">
                  <SourceEntityName name={row.table} />
                </span>
              </span>
              <span className="user-profile-modal-table-runs ast-num">
                {row.runs.toLocaleString()} {row.runs === 1 ? 'run' : 'runs'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function spendFigure(amount: number, unit: 'USD' | 'DBU', currency = 'USD'): string {
  const formatted = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  return unit === 'DBU' ? `${formatted} DBU` : `${formatted} ${currency || 'USD'}`;
}

function spendMetricFigure(
  metric: UserSpendKpi,
  kind: 'spend' | 'percent',
  unit: 'USD' | 'DBU',
  currency: string
): string {
  if (metric.value === null) return '–';
  if (kind === 'percent') return `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  return spendFigure(metric.value, unit, currency);
}

function SpendMetric({
  label,
  metric,
  kind,
  unit,
  currency,
}: {
  label: string;
  metric: UserSpendKpi;
  kind: 'spend' | 'percent';
  unit: 'USD' | 'DBU';
  currency: string;
}) {
  const figure = metric.state === 'unavailable' ? metric.subtitle : spendMetricFigure(metric, kind, unit, currency);
  return (
    <div className="user-profile-modal-spend-kpi">
      <div className="user-profile-modal-spend-kpi-head">
        <span className="user-profile-modal-spend-kpi-label">{label}</span>
        <EstimatedBadge />
      </div>
      <strong className="user-profile-modal-spend-kpi-value ast-num" aria-label={`${label}: ${figure}`}>
        {figure}
      </strong>
      {metric.state === 'unavailable' || !metric.subtitle ? null : (
        <span className="user-profile-modal-spend-kpi-subtitle">{metric.subtitle}</span>
      )}
    </div>
  );
}

function LoadingSpendMetric({ label, animated = false }: { label: string; animated?: boolean }) {
  return (
    <div className="user-profile-modal-spend-kpi user-profile-modal-spend-kpi-loading">
      <div className="user-profile-modal-spend-kpi-head">
        <span className="user-profile-modal-spend-kpi-label">{label}</span>
        <EstimatedBadge />
      </div>
      <div className="user-profile-modal-spend-kpi-loading-body">
        {animated ? (
          <PiaFlicker seat="inline" />
        ) : (
          <PiaMark size={16} className="user-profile-modal-spend-static-mark" />
        )}
      </div>
    </div>
  );
}

function compactTokens(value: number): string {
  return value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}

function AverageTokensMetric({ metrics }: { metrics: ReturnType<typeof deriveUserTokenAverages> }) {
  const exact = metrics.totalTokens?.toLocaleString() ?? '';
  const perRun = metrics.perRun;
  const perQuestion = metrics.perQuestion;
  return (
    <div className="user-profile-modal-spend-kpi">
      <div className="user-profile-modal-spend-kpi-head">
        <span className="user-profile-modal-spend-kpi-label">Average tokens</span>
        <EstimatedBadge />
      </div>
      <strong
        className="user-profile-modal-spend-kpi-value ast-num"
        title={
          perRun !== null
            ? `${exact} tokens across ${metrics.coveredRuns?.toLocaleString()} token-covered runs`
            : undefined
        }
        aria-label={
          perRun !== null
            ? `Average tokens per run: ${Math.round(perRun).toLocaleString()}`
            : 'Average tokens: token evidence unavailable'
        }
      >
        {perRun === null ? 'Token evidence unavailable' : `${compactTokens(perRun)} / run`}
      </strong>
      {perQuestion !== null ? (
        <span
          className="user-profile-modal-spend-kpi-subtitle ast-num"
          title={`${exact} tokens across ${metrics.coveredQuestions?.toLocaleString()} token-covered questions`}
        >
          {compactTokens(perQuestion)} / question
        </span>
      ) : null}
    </div>
  );
}

export function PersonSpend({
  email,
  state,
  unit,
  refreshing = false,
}: {
  email: string;
  state: PanelLoadState<OpsCostPayload>;
  unit: 'USD' | 'DBU';
  refreshing?: boolean;
}) {
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <section className="user-profile-modal-spend" aria-busy="true">
        <span className="sr-only" role="status" aria-live="polite">
          Calculating user spend metrics
        </span>
        <div className="user-profile-modal-spend-kpis">
          <LoadingSpendMetric label="Loading user spend" animated />
          <LoadingSpendMetric label="Calculating cost per question" />
          <LoadingSpendMetric label="Calculating average tokens" />
          <LoadingSpendMetric label="Calculating daily spend" />
          <LoadingSpendMetric label="Calculating share of app spend" />
        </div>
      </section>
    );
  }
  if (state.status === 'error') {
    const diagnosis = USER_SPEND_DIAGNOSES.find((candidate) => candidate === state.error) ?? null;
    return (
      <section className="user-profile-modal-spend" aria-labelledby="user-profile-spend-title">
        <h4 id="user-profile-spend-title" className="user-profile-modal-section-title">
          User spend
        </h4>
        <div className="user-profile-modal-spend-diagnosis" role="status">
          <strong>{diagnosis ?? 'Attributable spend could not be loaded.'}</strong>
          {diagnosis === 'Lakebase update required' ? (
            <Link to="/connections">Update Lakebase</Link>
          ) : diagnosis === 'Preparing user spend' ? (
            <span>Retry shortly while the first read completes.</span>
          ) : diagnosis === 'Billing access required' ? (
            <span>Retry with an administrator identity that can read the app billing sources.</span>
          ) : diagnosis === 'User not added in Identity settings' ? (
            <span>Add this user in Identity settings before monitoring their spend.</span>
          ) : null}
        </div>
      </section>
    );
  }
  const spend = state.status === 'ready' ? state.data.spendByUser : null;
  const profile = spend?.users.find((user) => user.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
  const reading = unit === 'USD' ? profile?.total.usd : profile?.total.dbu;
  const authoritative = profile?.metrics?.unit === unit ? profile.metrics : null;
  const amount =
    reading?.amount !== null && reading?.amount !== undefined && Number.isFinite(reading.amount)
      ? reading.amount
      : null;
  const core = deriveCoreUserSpendMetrics({
    amount,
    questions: authoritative?.questions ?? null,
    coveredDays: authoritative?.coveredDays ?? null,
    unit,
    estimated: reading?.quality === 'allocated' || reading?.quality === 'partial',
  });
  const averageTokens =
    authoritative?.averageTokens ??
    deriveUserTokenAverages({ totalTokens: null, coveredRuns: null, coveredQuestions: null });
  const costPerQuestion =
    authoritative?.costPerQuestion.state === 'value' ? authoritative.costPerQuestion : core.costPerQuestion;
  const averageDaily = authoritative?.averageDaily.state === 'value' ? authoritative.averageDaily : core.averageDaily;
  const appShare =
    authoritative?.appShare ?? ({ value: null, state: 'unavailable', subtitle: 'No comparable app total' } as const);
  return (
    <section
      className="user-profile-modal-spend"
      aria-labelledby="user-profile-spend-title"
      aria-busy={refreshing || undefined}
    >
      <h4 id="user-profile-spend-title" className="user-profile-modal-section-title">
        User spend
      </h4>
      <div className="user-profile-modal-spend-kpis">
        <div className="user-profile-modal-spend-kpi">
          <div className="user-profile-modal-spend-kpi-head">
            <span className="user-profile-modal-spend-kpi-label">Total user spend</span>
            <EstimatedBadge />
          </div>
          <strong className="user-profile-modal-spend-kpi-value ast-num">
            {amount === null
              ? 'Spend not available yet'
              : spendFigure(amount, unit, state.status === 'ready' ? state.data.currency : '')}
          </strong>
        </div>
        {refreshing && costPerQuestion.state === 'unavailable' ? (
          <LoadingSpendMetric label="Calculating cost per question" />
        ) : (
          <SpendMetric
            label="Cost / question"
            metric={costPerQuestion}
            kind="spend"
            unit={unit}
            currency={state.status === 'ready' ? state.data.currency : ''}
          />
        )}
        {refreshing && averageTokens.totalTokens === null ? (
          <LoadingSpendMetric label="Calculating average tokens" />
        ) : (
          <AverageTokensMetric metrics={averageTokens} />
        )}
        {refreshing && averageDaily.state === 'unavailable' ? (
          <LoadingSpendMetric label="Calculating daily spend" />
        ) : (
          <SpendMetric
            label="Average daily spend"
            metric={averageDaily}
            kind="spend"
            unit={unit}
            currency={state.status === 'ready' ? state.data.currency : ''}
          />
        )}
        {refreshing && appShare.state === 'unavailable' ? (
          <LoadingSpendMetric label="Calculating share of app spend" animated />
        ) : (
          <SpendMetric
            label="Share of app spend"
            metric={appShare.state === 'value' ? { ...appShare, subtitle: '' } : appShare}
            kind="percent"
            unit={unit}
            currency={state.status === 'ready' ? state.data.currency : ''}
          />
        )}
      </div>
      {refreshing ? (
        <span className="sr-only" role="status" aria-live="polite">
          Calculating remaining user spend metrics
        </span>
      ) : null}
    </section>
  );
}

function ProfileQuestionHistory({
  questions,
  now,
  onOpen,
}: {
  questions: MonitoringQuestion[];
  now: number;
  onOpen: (question: MonitoringQuestion) => void;
}) {
  return (
    <div className="user-profile-modal-question-frame">
      <table className="user-profile-modal-question-table">
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col">When</th>
            <th scope="col">Outcome</th>
            <th scope="col">Time</th>
            <th scope="col" className="user-profile-modal-tools-column">
              <ToolCallsLabel>Tools</ToolCallsLabel>
            </th>
            <th scope="col" className="user-profile-modal-feedback-column">
              Feedback
            </th>
          </tr>
        </thead>
        <tbody>
          {questions.map((question) => (
            <tr key={question.id}>
              <td data-label="Question">
                <button type="button" className="user-profile-modal-question-open" onClick={() => onOpen(question)}>
                  {question.question}
                </button>
              </td>
              <td data-label="When">{whenLabel(question.askedAt, now)}</td>
              <td data-label="Outcome">
                <OutcomePill question={question} />
              </td>
              <td data-label="Time" className="ast-num">
                {formatDuration(question.durationMs) ?? 'Not recorded'}
              </td>
              <td data-label="Tools" className="user-profile-modal-tools-column">
                {question.toolCalls === null ? (
                  'Not recorded'
                ) : (
                  <ToolCallsLabel>
                    <span className="ast-num">{question.toolCalls}</span>
                  </ToolCallsLabel>
                )}
              </td>
              <td data-label="Feedback" className="user-profile-modal-feedback-column">
                <FeedbackMark feedback={question.feedback ?? question.rating} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function profilePersonaName(persona: { name: string } | null | undefined): string {
  const name = persona?.name.trim() ?? '';
  return /^(no persona|none|unassigned|n\/a|null|unknown)$/i.test(name) ? '' : name;
}

function ProfileIdentityBadges({ role, persona }: { role: Role; persona: { name: string } | null | undefined }) {
  const personaName = profilePersonaName(persona);
  return (
    <div className="user-profile-modal-identity-badges">
      <RoleBadgePill state={role} />
      {personaName ? (
        <span
          className={astPill('neutral', 'user-profile-modal-persona')}
          title={personaName}
          aria-label={`Persona: ${personaName}`}
        >
          {personaName}
        </span>
      ) : null}
    </div>
  );
}

export function PersonPanel({
  panel,
  spendState = idlePanel<OpsCostPayload>(),
  spendUnit = 'USD',
  spendRefreshing = false,
  now,
  rangeLabel,
  onClose,
  onOpenQuestion,
  page = 0,
  onPreviousPage = () => {},
  onNextPage = () => {},
  onBack,
  backLabel = 'Back to all users',
}: {
  panel: PersonPanelPayload;
  spendState?: PanelLoadState<OpsCostPayload>;
  spendUnit?: 'USD' | 'DBU';
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
  backLabel?: string;
}) {
  const times = answerTimeTile(panel.durationsMs);
  const outcomes = outcomeTile(panel.summary);
  const scopes = readScopes(panel);
  const cost = tokenCostTile(panel.tokenCostUsd);
  const askedHeading = profileAskedHeading(panel.displayName, panel.email);
  return (
    <Dialog
      overlayClassName="user-profile-modal-overlay"
      contentClassName="user-profile-modal"
      labelledBy="user-profile-modal-title"
      describedBy="user-profile-modal-description"
      onDismiss={onClose}
    >
      <header className="user-profile-modal-header">
        <div className="user-profile-modal-header-content">
          {onBack ? (
            <Button variant="ghost" size="sm" className="user-profile-modal-back" onClick={onBack}>
              <ArrowLeft className="monitoring-link-arrow size-3.5" aria-hidden="true" />
              {backLabel}
            </Button>
          ) : null}
          <div className="user-profile-modal-user">
            <div className="user-profile-modal-identity-row">
              <h3 id="user-profile-modal-title">
                <UserIdentityChip
                  identity={panel.email}
                  showFullIdentity
                  className="user-profile-modal-identity-chip"
                  icon={<OrganizationAvatar organization={panel.organization} />}
                />
              </h3>
              <ProfileIdentityBadges role={panel.role} persona={panel.persona} />
            </div>
            <p id="user-profile-modal-description" className="user-profile-modal-description">
              {panel.firstSeen ? `First seen ${whenLabel(panel.firstSeen, now)}` : 'First seen not recorded'}
              {' · '}
              {panel.lastSeen ? `Last seen ${whenLabel(panel.lastSeen, now)}` : 'Last seen not recorded'}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" className="user-profile-modal-close" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </Button>
      </header>
      <div className="user-profile-modal-body">
        <PersonSpend email={panel.email} state={spendState} unit={spendUnit} refreshing={spendRefreshing} />
        <section className="user-profile-modal-asked" aria-labelledby="user-profile-asked-title">
          <h4
            id="user-profile-asked-title"
            className="user-profile-modal-section-title"
            aria-label={`${askedHeading}, ${rangeLabel}`}
          >
            {askedHeading} <span className="user-profile-modal-range">{rangeLabel}</span>
          </h4>
          <div className="user-profile-modal-kpi-grid">
            <div className="user-profile-modal-kpi">
              <p className="user-profile-modal-kpi-label">Questions</p>
              <p className="user-profile-modal-kpi-value ast-num">{panel.summary.questionsAsked.toLocaleString()}</p>
              <p className="user-profile-modal-kpi-caption">
                {`${outcomes.completed} completed`}
                <span className="monitoring-partial">{` · ${outcomes.partial} partial`}</span>
                <span className="monitoring-refused">{` · ${outcomes.refused} refused`}</span>
                <span className="monitoring-failed">{` · ${outcomes.failed} failed`}</span>
              </p>
            </div>
            <PanelTile label="Tokens" tile={tokensTile(panel.tokens)} />
            {cost ? <PanelTile label="Token cost" tile={cost} /> : null}
            <div className="user-profile-modal-kpi">
              <p className="user-profile-modal-kpi-label">Answer time</p>
              {times.value !== null ? (
                <p className="user-profile-modal-kpi-value ast-num">
                  {times.value} <span className="user-profile-modal-kpi-unit">median</span>
                </p>
              ) : (
                <p className="user-profile-modal-kpi-absent">{times.absence}</p>
              )}
              <p className="user-profile-modal-kpi-caption">{times.tail}</p>
            </div>
            <PanelTile
              label="Feedback"
              tile={personFeedbackTile(panel.helpful ?? panel.ratedUp ?? 0, panel.notHelpful ?? panel.ratedDown ?? 0)}
            />
          </div>
        </section>

        <TablesReadMost rows={panel.tablesReadMost} />

        <section className="user-profile-modal-permissions" aria-labelledby="user-profile-permissions-title">
          <h4 id="user-profile-permissions-title" className="user-profile-modal-section-title">
            What they can read
          </h4>
          <p className="user-profile-modal-note">Permissions, not data.</p>
          {scopes.length > 0 ? (
            <div className="user-profile-modal-scopes">
              {scopes.map((scope) => (
                <span
                  className={astPill(PILL_FAMILY[scope.tone], 'monitoring-pill user-profile-modal-scope')}
                  key={scope.label}
                >
                  {scope.label}
                  <span className="user-profile-modal-scope-runs ast-num">{scope.runs}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="user-profile-modal-grants">
            <p className="user-profile-modal-grants-heading">
              {panel.grantsMode === 'live-self'
                ? 'Declared tables · read now as you'
                : 'Declared tables · verified evidence from this user’s runs'}
            </p>
            {panel.grants === null ? (
              <p className="user-profile-modal-state">
                The grants for this person could not be read just now, so none are shown. This says nothing about what
                they can reach.
              </p>
            ) : (
              panel.grants.map((grant) => {
                const badge =
                  grant.source === 'verified-run'
                    ? {
                        label: `Read in ${grant.verifiedRuns.toLocaleString()} verified ${grant.verifiedRuns === 1 ? 'run' : 'runs'}`,
                        tone: 'ok' as const,
                      }
                    : grant.source === 'no-evidence'
                      ? { label: 'No verified read evidence', tone: 'neutral' as const }
                      : grant.canRead === null
                        ? { label: 'Not checked', tone: 'neutral' as const }
                        : grantBadge({ canRead: grant.canRead, missing: grant.missing });
                return (
                  <div className="user-profile-modal-grant-row" key={grant.table}>
                    <p className="user-profile-modal-grant-line">
                      <BrandIcon product="unity-catalog" size={14} />
                      <span className="user-profile-modal-grant-table" title={grant.table}>
                        {grant.table}
                      </span>
                      <span className={astPill(PILL_FAMILY[badge.tone], 'monitoring-pill')}>{badge.label}</span>
                      {grant.source === 'live-user-probe' && grant.missing && grant.missing !== badge.label ? (
                        <span className="user-profile-modal-grant-detail">{grant.missing}</span>
                      ) : null}
                    </p>
                    {grant.rowFilter ? <p className="user-profile-modal-grant-detail">Row filter applied.</p> : null}
                    {grant.maskedColumns && grant.maskedColumns.length > 0 ? (
                      <p className="user-profile-modal-grant-detail">{`Column mask on ${grant.maskedColumns.join(', ')}.`}</p>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="user-profile-modal-questions" aria-labelledby="user-profile-questions-title">
          <h4 id="user-profile-questions-title" className="user-profile-modal-section-title">
            Their questions <span className="user-profile-modal-range">{rangeLabel}</span>
          </h4>
          {panel.questions.length === 0 ? (
            <p className="user-profile-modal-state">No questions from this person in this range.</p>
          ) : (
            <ProfileQuestionHistory questions={panel.questions} now={now} onOpen={onOpenQuestion} />
          )}
          <MonitoringPaginationControls
            pagination={panel.pagination}
            page={page}
            onPrevious={onPreviousPage}
            onNext={onNextPage}
          />
        </section>
      </div>
    </Dialog>
  );
}

export function PersonPanelShell({
  state,
  spendState = idlePanel<OpsCostPayload>(),
  spendUnit = 'USD',
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
  backLabel,
  identitySeed,
}: {
  state: PanelLoadState<PersonPanelPayload>;
  spendState?: PanelLoadState<OpsCostPayload>;
  spendUnit?: 'USD' | 'DBU';
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
  backLabel?: string;
  identitySeed?: Pick<UserMonitoringRow, 'role' | 'persona' | 'organization'> | null;
}) {
  if (state.status === 'ready') {
    return (
      <PersonPanel
        panel={state.data}
        spendState={spendState}
        spendUnit={spendUnit}
        spendRefreshing={spendRefreshing}
        now={now}
        rangeLabel={rangeLabel}
        page={page}
        onClose={onClose}
        onOpenQuestion={onOpenQuestion}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
        onBack={onBack}
        backLabel={backLabel}
      />
    );
  }
  return (
    <Dialog
      overlayClassName="user-profile-modal-overlay"
      contentClassName="user-profile-modal user-profile-modal-status"
      labelledBy="user-profile-modal-title"
      describedBy="user-profile-modal-description"
      ariaBusy={state.status === 'loading' || state.status === 'idle'}
      onDismiss={onClose}
    >
      <header className="user-profile-modal-header">
        <div className="user-profile-modal-header-content">
          {onBack ? (
            <Button variant="ghost" size="sm" className="user-profile-modal-back" onClick={onBack}>
              <ArrowLeft className="monitoring-link-arrow size-3.5" aria-hidden="true" />
              {backLabel ?? 'Back to all users'}
            </Button>
          ) : null}
          <div className="user-profile-modal-identity-row">
            <h3 id="user-profile-modal-title" className="user-profile-modal-loading-title">
              {identitySeed ? (
                <UserIdentityChip
                  identity={email}
                  showFullIdentity
                  className="user-profile-modal-identity-chip"
                  icon={<OrganizationAvatar organization={identitySeed.organization} />}
                />
              ) : (
                localPart(email) || 'User activity'
              )}
            </h3>
            {identitySeed ? <ProfileIdentityBadges role={identitySeed.role} persona={identitySeed.persona} /> : null}
          </div>
          <p id="user-profile-modal-description" className="sr-only">
            User activity and attributable spend
          </p>
        </div>
        <Button variant="outline" size="sm" className="user-profile-modal-close" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </Button>
      </header>
      <div className="user-profile-modal-body">
        {state.status === 'error' ? (
          <div role="alert" className="user-profile-modal-state user-profile-modal-state-action">
            <p>{state.error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <div role="status" className="user-profile-modal-profile-loading">
            <PiaFlicker seat="inline" />
            <span>Loading user activity</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function userSpendFigure(row: UserMonitoringRow, unit: 'USD' | 'DBU'): string {
  const reading = unit === 'USD' ? row.spend.usd : row.spend.dbu;
  if (reading.amount === null) return '–';
  return unit === 'USD'
    ? `$${reading.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${reading.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DBU`;
}

const userBrowserScroll = new Map<string, number>();
function rememberUserBrowserScroll(key: string, top: number): void {
  userBrowserScroll.delete(key);
  userBrowserScroll.set(key, top);
  if (userBrowserScroll.size > 40) {
    const oldest = userBrowserScroll.keys().next().value;
    if (oldest) userBrowserScroll.delete(oldest);
  }
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
  onPersona = () => {},
  onOrganizations = () => {},
  onRange,
  onUnit,
  onClear,
  onNext,
  onPrevious,
  refreshing = false,
  cacheKey = '',
}: {
  state: PanelLoadState<OpsCostPayload>;
  browser: ReturnType<typeof userBrowserFromParams> & { range: RangeKey };
  rangeLabel: string;
  now: number;
  onClose: () => void;
  onOpenUser: (user: UserMonitoringRow) => void;
  onSearch: (search: string) => void;
  onRole: (role: string) => void;
  onPersona?: (persona: string) => void;
  onOrganizations?: (organizations: readonly string[]) => void;
  onRange: (range: RangeKey) => void;
  onUnit: (unit: 'USD' | 'DBU') => void;
  onClear: () => void;
  onNext: (cursor: string) => void;
  onPrevious: () => void;
  refreshing?: boolean;
  cacheKey?: string;
}) {
  const payload: UserMonitoringPayload | null = state.status === 'ready' ? (state.data.userMonitoring ?? null) : null;
  const changed = Boolean(browser.search || browser.role || browser.persona || browser.organizations.length > 0);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!cacheKey || !body.current) return;
    body.current.scrollTop = userBrowserScroll.get(cacheKey) ?? 0;
  }, [cacheKey]);
  return (
    <Dialog
      overlayClassName="monitoring-users-overlay"
      contentClassName="monitoring-users-modal"
      labelledBy="monitoring-users-title"
      describedBy="monitoring-users-description"
      ariaBusy={state.status === 'loading' || state.status === 'idle'}
      onDismiss={onClose}
    >
      <div className="monitoring-users-header">
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
      <div
        className="monitoring-users-body"
        ref={body}
        onScroll={(event) => {
          if (cacheKey) rememberUserBrowserScroll(cacheKey, event.currentTarget.scrollTop);
        }}
      >
        <div className="monitoring-users-toolbar">
          <div className="monitoring-users-toolbar-filters">
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
              className="monitoring-users-role-trigger"
              value={browser.role || NO_FILTER}
              options={[
                { value: NO_FILTER, label: 'All roles' },
                {
                  value: 'super_admin',
                  label: 'Super admin',
                  content: <RoleBadgePill state="super_admin" />,
                },
                { value: 'admin', label: 'Admin', content: <RoleBadgePill state="admin" /> },
                { value: 'consumer', label: 'Consumer', content: <RoleBadgePill state="consumer" /> },
              ]}
              onValueChange={(role) => onRole(role === NO_FILTER ? '' : role)}
              contentClassName="monitoring-users-filter-menu"
            />
            <AppSelect
              label="Persona"
              ariaLabel="Filter users by current persona"
              className="monitoring-users-persona-trigger"
              value={browser.persona || NO_FILTER}
              options={[
                { value: NO_FILTER, label: 'All personas' },
                ...(payload?.personas ?? []).map((persona) => ({
                  value: persona.id,
                  label: persona.name,
                })),
              ]}
              onValueChange={(persona) => onPersona(persona === NO_FILTER ? '' : persona)}
              contentClassName="monitoring-users-filter-menu"
            />
            <UserOrganizationSelect
              organizations={payload?.organizations ?? []}
              total={(payload?.organizations ?? []).reduce((sum, organization) => sum + organization.count, 0)}
              selected={browser.organizations}
              onChange={onOrganizations}
            />
          </div>
          <div className="monitoring-users-toolbar-view">
            <TimeRangeSegments page="User Monitoring" value={browser.range} onChange={onRange} />
            <UnitSegmentedControl
              unit={browser.unit}
              onChange={onUnit}
              label="Spend unit"
              ariaLabel="Per-user spend unit"
              showLabel={false}
            />
            {changed ? (
              <Button variant="ghost" size="sm" onClick={onClear}>
                Clear filters
              </Button>
            ) : null}
            {refreshing ? <span className="monitoring-users-refreshing">Refreshing…</span> : null}
          </div>
        </div>

        {state.status === 'error' ? (
          <p className="monitoring-users-state" role="alert">
            {state.error}
          </p>
        ) : state.status === 'loading' || state.status === 'idle' ? (
          <div className="monitoring-users-loading" role="status">
            <Users className="monitoring-users-loading-icon ast-anim-center-pulse" aria-hidden="true" />
            <span>Loading users</span>
          </div>
        ) : !payload ? (
          <p className="monitoring-users-state" role="status">
            User activity is available only when the server-authorized spend snapshot can be read.
          </p>
        ) : (
          <>
            {payload.reason ? (
              <p className="monitoring-users-note">
                Some spend sources could not be measured. Open a user for details.
              </p>
            ) : null}
            <div className="monitoring-users-list" role="list" aria-label="Users ordered by attributable spend">
              <div className="monitoring-users-columns" aria-hidden="true">
                <span>User</span>
                <span>Role</span>
                <span>Persona</span>
                <span>Activity</span>
                <span>Questions / runs</span>
                <span>Spend</span>
                <span />
              </div>
              {payload.users.map((row) => (
                <button
                  type="button"
                  className="monitoring-user-row"
                  role="listitem"
                  key={row.email}
                  onClick={() => onOpenUser(row)}
                  aria-label={`Open ${localPart(row.email)} User Overview`}
                >
                  <span className="monitoring-user-identity">
                    <UserIdentityChip
                      identity={row.email}
                      compact
                      icon={<OrganizationAvatar organization={row.organization} />}
                    />
                  </span>
                  <span className="monitoring-user-role">
                    <span className="monitoring-users-mobile-label">Role</span>
                    <RoleBadgePill state={row.role} />
                  </span>
                  <span>
                    <span className="monitoring-users-mobile-label">Persona</span>
                    <span title={row.persona?.name}>{row.persona?.name ?? 'None'}</span>
                  </span>
                  <span>
                    <span className="monitoring-users-mobile-label">Activity</span>
                    {row.lastActive ? whenLabel(row.lastActive, now) : 'Not recorded'}
                  </span>
                  <span className="ast-num">
                    <span className="monitoring-users-mobile-label">Questions / runs</span>
                    {row.questions.toLocaleString()} / {row.runs.toLocaleString()}
                  </span>
                  <span className="monitoring-user-amount ast-num">
                    <span className="monitoring-users-mobile-label">Spend</span>
                    {userSpendFigure(row, browser.unit)}
                  </span>
                  <span className="monitoring-user-open">
                    <ChevronRight aria-hidden="true" />
                  </span>
                </button>
              ))}
            </div>
            {payload.users.length === 0 ? (
              <p className="monitoring-empty-line">
                No users match {browser.search ? `"${browser.search}"` : 'the active filters'}
                {browser.role ? ` and ${ROLE_WORD[isRole(browser.role) ? browser.role : 'consumer']} role` : ''}.
                {browser.persona ? ' No users have the selected current persona.' : ''}
                {browser.organizations.length > 0 ? ' No users belong to the selected organizations.' : ''}
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
  onOpenFeedback?: () => void;
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
  onOpenFeedback,
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
        <SummaryStrip payload={payload} periodLabel={rangeLabel} onOpenFeedback={onOpenFeedback} />
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
      <div className="monitoring-list-pane ast-surface-primary">
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
      <PiaEmptyStateMark size={32} className="monitoring-empty-mark" />
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
const PANEL_CACHE_MAX = 80;
const panelCache = new Map<
  string,
  { expiresAt: number; dataRevision: number; identityRevision: string; data: unknown }
>();

function cachePanel(key: string, data: unknown): void {
  const monitoring =
    typeof data === 'object' && data !== null && 'userMonitoring' in data
      ? (data as OpsCostPayload).userMonitoring
      : null;
  const identityRevision = typeof monitoring?.identityRevision === 'string' ? monitoring.identityRevision : '';
  if (identityRevision) {
    for (const [cachedKey, cached] of panelCache) {
      if (cached.identityRevision && cached.identityRevision !== identityRevision) panelCache.delete(cachedKey);
    }
  }
  panelCache.delete(key);
  panelCache.set(key, {
    expiresAt: Date.now() + PANEL_CACHE_MS,
    dataRevision: typeof monitoring?.dataRevision === 'number' ? monitoring.dataRevision : 0,
    identityRevision,
    data,
  });
  while (panelCache.size > PANEL_CACHE_MAX) {
    const oldest = panelCache.keys().next().value;
    if (!oldest) break;
    panelCache.delete(oldest);
  }
}

function decodePanelData<T>(value: unknown): T {
  return value as T;
}

function usePanelRequest<T>(
  key: string,
  url: string,
  errorMessage: string,
  cacheScope = 'session',
  decode: (value: unknown) => T = decodePanelData,
  retainAcrossKeys = false
) {
  const [state, setState] = useState<PanelLoadState<T>>(() => idlePanel<T>());
  const [attempt, setAttempt] = useState(0);
  const [refreshingKey, setRefreshingKey] = useState('');
  const lastReady = useRef<T | null>(null);
  const scopedKey = key ? `${cacheScope}|${key}` : '';

  useEffect(() => {
    if (!key || !url) {
      setState(idlePanel<T>());
      return;
    }
    const controller = new AbortController();
    const requestId = ++panelRequestSequence;
    const cached = panelCache.get(scopedKey);
    let retained: T | null = null;
    if (cached && cached.expiresAt > Date.now()) {
      try {
        retained = decode(cached.data);
      } catch {
        panelCache.delete(scopedKey);
      }
    }
    if (cached && !retained) panelCache.delete(scopedKey);
    const presented = retained ?? (retainAcrossKeys ? lastReady.current : null);
    if (presented) lastReady.current = presented;
    setState(
      presented ? { status: 'ready', key, requestId, data: presented, error: null } : beginPanelLoad<T>(key, requestId)
    );
    if (retained && attempt === 0) {
      setRefreshingKey('');
      return () => controller.abort();
    }
    setRefreshingKey(presented ? key : '');

    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 403 ? 'forbidden' : `http_${response.status}`);
        return decode(await response.json());
      })
      .then((data) => {
        lastReady.current = data;
        cachePanel(scopedKey, data);
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
  }, [attempt, decode, errorMessage, key, retainAcrossKeys, scopedKey, url]);

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

function spendPayloadFromCache(coordinates: UserSpendTotalCoordinates, cached: CachedUserSpendTotal): OpsCostPayload {
  const unavailable = { amount: null, quality: 'unavailable' as const };
  const unavailableAppShare = { value: null, state: 'unavailable' as const, subtitle: 'No comparable app total' };
  const selected = { amount: cached.amount, quality: cached.quality };
  const core = deriveCoreUserSpendMetrics({
    amount: cached.amount,
    questions: cached.questions,
    coveredDays: cached.coveredDays,
    unit: coordinates.unit,
  });
  const averageTokens = deriveUserTokenAverages(cached.tokenUsage);
  const cachedProfile = cached.profile;
  const cachedReading = coordinates.unit === 'USD' ? cachedProfile?.total.usd : cachedProfile?.total.dbu;
  const profile = cachedProfile
    ? {
        ...cachedProfile,
        total: {
          ...cachedProfile.total,
          [coordinates.unit === 'USD' ? 'usd' : 'dbu']:
            cachedReading?.amount === null && cached.amount !== null ? selected : cachedReading,
        },
        metrics:
          cachedProfile.metrics?.unit === coordinates.unit
            ? {
                ...cachedProfile.metrics,
                questions:
                  !cached.complete &&
                  (cachedProfile.metrics.questions === null || cachedProfile.metrics.questions === 0)
                    ? cached.questions
                    : cachedProfile.metrics.questions,
                coveredDays:
                  !cached.complete &&
                  (cachedProfile.metrics.coveredDays === null || cachedProfile.metrics.coveredDays === 0)
                    ? cached.coveredDays
                    : cachedProfile.metrics.coveredDays,
                averageTokens:
                  !cached.complete && !cachedProfile.metrics.averageTokens
                    ? averageTokens
                    : cachedProfile.metrics.averageTokens,
              }
            : cachedProfile.metrics,
      }
    : {
        email: coordinates.email,
        total: {
          usd: coordinates.unit === 'USD' ? selected : unavailable,
          dbu: coordinates.unit === 'DBU' ? selected : unavailable,
        },
        metrics: {
          unit: coordinates.unit,
          questions: cached.questions,
          coveredDays: cached.coveredDays,
          costPerQuestion: core.costPerQuestion,
          averageDaily: core.averageDaily,
          averageTokens,
          appShare: unavailableAppShare,
        },
        components: [],
      };
  return {
    currency: cached.currency,
    spendByUser: {
      dataRevision: cached.dataRevision,
      readAt: cached.snapshot.split('|')[0] ?? '',
      requestedRange: { from: coordinates.from, to: coordinates.to },
      range: { from: coordinates.from, to: coordinates.to },
      state: 'ready',
      reason: '',
      identityRevision: cached.identityRevision,
      users: [profile],
      unattributed: [],
      reconciliation: {
        usd: { unit: 'USD', appTotal: null, users: null, unattributed: null, difference: null },
        dbu: { unit: 'DBU', appTotal: null, users: null, unattributed: null, difference: null },
      },
    },
  } as unknown as OpsCostPayload;
}

function useUserSpendRequest(coordinates: UserSpendTotalCoordinates | null, url: string) {
  const scope = coordinates?.scope ?? '';
  const email = coordinates?.email ?? '';
  const from = coordinates?.from ?? '';
  const to = coordinates?.to ?? '';
  const unit = coordinates?.unit ?? 'USD';
  const hasCoordinates = coordinates !== null;
  const cacheKey = hasCoordinates ? userSpendTotalBaseKey({ scope, email, from, to, unit }) : '';
  const [state, setState] = useState<PanelLoadState<OpsCostPayload>>(() => idlePanel<OpsCostPayload>());
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!hasCoordinates || !url) {
      setState(idlePanel<OpsCostPayload>());
      setRefreshing(false);
      return;
    }
    const stableCoordinates = { scope, email, from, to, unit };
    let active = true;
    const retained = cachedUserSpendTotal(stableCoordinates);
    const requestId = ++panelRequestSequence;
    if (retained) {
      setState({
        status: 'ready',
        key: cacheKey,
        requestId,
        data: spendPayloadFromCache(stableCoordinates, retained),
        error: null,
      });
    } else {
      setState(beginPanelLoad<OpsCostPayload>(cacheKey, requestId));
    }
    const needsRefresh = !retained || retained.seeded || retained.expiresAt === 0;
    if (!needsRefresh) {
      setRefreshing(false);
      return;
    }
    setRefreshing(Boolean(retained));
    void requestUserSpendTotal(stableCoordinates, async () => {
      const response = await fetch(url);
      if (!response.ok) {
        const diagnosis = await userSpendHttpDiagnosis(response);
        throw new Error(diagnosis ?? (response.status === 403 ? 'forbidden' : `http_${response.status}`));
      }
      const payload = decodeUserSpendPayload(await response.json());
      const spend = payload.spendByUser;
      const diagnosis = userSpendPayloadDiagnosis(spend);
      if (diagnosis) throw new Error(diagnosis);
      const profile =
        spend?.users.find((candidate) => candidate.email.toLowerCase() === stableCoordinates.email.toLowerCase()) ??
        null;
      const reading = stableCoordinates.unit === 'USD' ? profile?.total.usd : profile?.total.dbu;
      return {
        amount: reading?.amount ?? null,
        quality: reading?.quality ?? 'unavailable',
        questions: profile?.metrics?.questions ?? 0,
        coveredDays: profile?.metrics?.coveredDays ?? 0,
        tokenUsage: {
          totalTokens: profile?.metrics?.averageTokens?.totalTokens ?? null,
          coveredRuns: profile?.metrics?.averageTokens?.coveredRuns ?? null,
          coveredQuestions: profile?.metrics?.averageTokens?.coveredQuestions ?? null,
        },
        currency: payload.currency,
        profile,
        dataRevision: spend?.dataRevision ?? 0,
        snapshot: `${spend?.readAt ?? new Date().toISOString()}|${spend?.identityRevision ?? ''}`,
        seeded: false,
        complete:
          spend?.state === 'ready' &&
          profile?.metrics?.unit === stableCoordinates.unit &&
          profile.metrics.questions !== null &&
          profile.metrics.coveredDays !== null,
        identityRevision: spend?.identityRevision ?? '',
      };
    })
      .then((value) => {
        if (!active) return;
        setState({
          status: 'ready',
          key: cacheKey,
          requestId,
          data: spendPayloadFromCache(stableCoordinates, value),
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!active || retained) return;
        const diagnosis =
          error instanceof Error ? USER_SPEND_DIAGNOSES.find((candidate) => candidate === error.message) : null;
        const message =
          diagnosis ??
          (error instanceof Error && error.message === 'forbidden'
            ? 'You do not have access to these Monitoring details.'
            : 'Attributable spend could not be loaded.');
        setState((current) => rejectPanelLoad(current, cacheKey, requestId, message));
      })
      .finally(() => {
        if (active) setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [cacheKey, email, from, hasCoordinates, scope, to, unit, url]);
  return { state: panelStateForKey(state, cacheKey, 0), refreshing };
}

let panelRequestSequence = 0;

function interactionTimestamp(): number {
  return Date.now();
}

interface CursorPages {
  owner: string;
  cursors: string[];
  index: number;
}

const EMPTY_FEEDBACK_FILTERS: FeedbackBrowserFilters = {
  search: '',
  feedback: '',
  user: '',
  role: '',
  persona: '',
  organization: '',
};

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
  const outlet = useOutletContext<AppOutletContext | null>();
  const cacheScope = `${outlet?.subject?.trim().toLowerCase() || 'unknown'}|${outlet?.role.state ?? 'unknown'}`;
  const [profileIdentitySeed, setProfileIdentitySeed] = useState<
    (Pick<UserMonitoringRow, 'email' | 'role' | 'persona' | 'organization'> & { scope: string }) | null
  >(null);
  const [feedbackQuestionWindow, setFeedbackQuestionWindow] = useState<{ from: string; to: string } | null>(null);
  // The clock is read once per render pass rather than per row, so every
  // relative stamp on one paint is relative to the same instant.
  const [now, setNow] = useState(() => Date.now());
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const scroll = useRef(scrollMemory());
  useEffect(
    () =>
      listenForIdentitySettingsChanges(() => {
        panelCache.clear();
        clearUserSpendTotalCache();
        invalidateFeedbackBrowserSession();
        setProfileIdentitySeed(null);
        setIdentityEpoch((value) => value + 1);
      }),
    []
  );

  const filters = filtersFromParams(searchParams);
  const drawer = drawerFromParams(searchParams);
  const routedUserBrowser = userBrowserFromParams(searchParams);
  const feedbackBrowserOpen = feedbackBrowserFromParams(searchParams);
  const [userControls, setUserControls] = useState(() => ({
    search: routedUserBrowser.search,
    role: routedUserBrowser.role,
    persona: routedUserBrowser.persona ?? '',
    organizations: routedUserBrowser.organizations,
    unit: routedUserBrowser.unit,
    range: rangeFromParams(searchParams),
    cursors: [''],
    cursorIndex: 0,
  }));
  const userBrowser = {
    ...userControls,
    open: routedUserBrowser.open,
    cursor: userControls.cursors[userControls.cursorIndex] ?? '',
  };
  const [feedbackControls, setFeedbackControls] = useState(() => ({
    filters: { ...EMPTY_FEEDBACK_FILTERS },
    range: rangeFromParams(searchParams),
    cursors: [''],
    cursorIndex: 0,
  }));
  const feedbackBrowser = {
    ...feedbackControls,
    cursor: feedbackControls.cursors[feedbackControls.cursorIndex] ?? '',
  };
  const window_ = rangeWindow(searchParams, now);
  const userWindow = rangeWindow({ get: (name) => (name === 'range' ? userBrowser.range : null) }, now);
  const feedbackWindow = rangeWindow({ get: (name) => (name === 'range' ? feedbackBrowser.range : null) }, now);
  const profileWindow = userBrowser.open ? userWindow : feedbackBrowserOpen ? feedbackWindow : window_;
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

  const personOwner = `${drawer.person.toLowerCase()}|${profileWindow.from}|${profileWindow.to}|${filterKey}`;
  const [personPages, setPersonPages] = useState<CursorPages>({
    owner: personOwner,
    cursors: [''],
    index: 0,
  });
  const personCursor = cursorFor(personOwner, personPages);
  const personPage = monitoringPageForOwner(personOwner, personPages);

  const questionReadWindow =
    feedbackBrowserOpen && feedbackQuestionWindow ? feedbackQuestionWindow : { from: window_.from, to: window_.to };
  const questionKey = drawer.question
    ? monitoringDetailKey('question', drawer.question, questionReadWindow.from, questionReadWindow.to)
    : '';
  const questionRequest = usePanelRequest<MonitoringDetail>(
    questionKey,
    drawer.question ? questionDetailUrl(drawer.question, questionReadWindow.from, questionReadWindow.to) : '',
    'Question details could not be loaded.',
    cacheScope
  );
  const personKey = drawer.person
    ? monitoringDetailKey('person', drawer.person, profileWindow.from, profileWindow.to, personCursor)
    : '';
  const personRequest = usePanelRequest<PersonPanelPayload>(
    personKey,
    drawer.person ? personDetailUrl(drawer.person, profileWindow.from, profileWindow.to, filters, personCursor) : '',
    'User activity could not be loaded.',
    cacheScope
  );
  const spendParams = new URLSearchParams({ from: profileWindow.from, to: profileWindow.to, unit: userBrowser.unit });
  if (userBrowser.range === '24h') spendParams.set('window', '24h');
  spendParams.set('identityEpoch', String(identityEpoch));
  const personSpendCoordinates = drawer.person
    ? {
        scope: cacheScope,
        email: drawer.person,
        from: profileWindow.from,
        to: profileWindow.to,
        unit: userBrowser.unit,
      }
    : null;
  const personSpendRequest = useUserSpendRequest(
    personSpendCoordinates,
    drawer.person ? `/api/monitoring/user-spend/${encodeURIComponent(drawer.person)}?${spendParams.toString()}` : ''
  );
  const userBrowserParams = new URLSearchParams({
    from: userWindow.from,
    to: userWindow.to,
    unit: userBrowser.unit,
    pageSize: '25',
  });
  if (userBrowser.range === '24h') userBrowserParams.set('window', '24h');
  if (userBrowser.search) userBrowserParams.set('q', userBrowser.search);
  if (userBrowser.role) userBrowserParams.set('role', userBrowser.role);
  if (userBrowser.persona) userBrowserParams.set('persona', userBrowser.persona);
  if (userBrowser.organizations.length > 0) {
    userBrowserParams.set('organization', userBrowser.organizations.join(','));
  }
  if (userBrowser.cursor) userBrowserParams.set('cursor', userBrowser.cursor);
  userBrowserParams.set('identityEpoch', String(identityEpoch));
  const userBrowserKey =
    userBrowser.open && !drawer.person
      ? `users|v${USER_MONITORING_SCHEMA_REVISION}|${identityEpoch}|${userWindow.from}|${userWindow.to}|${userBrowser.unit}|${userBrowser.search}|${userBrowser.role}|${userBrowser.persona}|${userBrowser.organizations.join(',')}|${userBrowser.cursor}|25`
      : '';
  const userBrowserRequest = usePanelRequest<OpsCostPayload>(
    userBrowserKey,
    userBrowserKey ? `/api/monitoring/user-spend?${userBrowserParams.toString()}` : '',
    'User Monitoring could not be loaded.',
    cacheScope,
    decodeUserMonitoringCostPayload,
    true
  );
  const feedbackCursor = feedbackControls.cursors[feedbackControls.cursorIndex] ?? '';
  const feedbackPage = feedbackControls.cursorIndex;
  const feedbackRequestInput = {
    scope: cacheScope,
    from: feedbackWindow.from,
    to: feedbackWindow.to,
    filters: feedbackBrowser.filters,
    cursor: feedbackCursor,
    pageSize: 25,
  };
  const feedbackRequest = useFeedbackBrowser(
    feedbackRequestInput,
    feedbackBrowserOpen && !drawer.person && !drawer.question
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

  const closeFeedbackBrowser = useCallback(() => {
    void navigate({ search: closedFeedbackBrowser(location.search) }, { replace: true });
    const offset = scroll.current.take();
    if (offset !== null && typeof globalThis.scrollTo === 'function') globalThis.scrollTo({ top: offset });
  }, [location.search, navigate]);

  const open = useCallback(
    (question: MonitoringQuestion) => {
      setFeedbackQuestionWindow(null);
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
  const openFeedback = () => {
    scroll.current.capture(typeof globalThis.scrollY === 'number' ? globalThis.scrollY : 0);
    setFeedbackControls((current) => ({
      ...current,
      range: rangeFromParams(searchParams),
      cursors: [''],
      cursorIndex: 0,
    }));
    void navigate({ search: openFeedbackBrowser(location.search) });
  };
  const openFeedbackQuestion = (row: MonitoringFeedbackRow) => {
    const asked = Date.parse(row.askedAt);
    setFeedbackQuestionWindow(
      Number.isFinite(asked)
        ? {
            from: new Date(asked - 1_000).toISOString(),
            to: new Date(asked + 1_000).toISOString(),
          }
        : { from: feedbackWindow.from, to: feedbackWindow.to }
    );
    void navigate({ search: openQuestion(location.search, row.questionId) });
  };
  const openUsers = () => {
    scroll.current.capture(typeof globalThis.scrollY === 'number' ? globalThis.scrollY : 0);
    setUserControls((current) => ({
      ...current,
      range: rangeFromParams(searchParams),
      cursors: [''],
      cursorIndex: 0,
    }));
    void navigate({ search: openUserBrowser(location.search, userBrowserUnit) });
  };

  const updateUserBrowser = (
    updates: Partial<Pick<typeof userControls, 'search' | 'role' | 'persona' | 'organizations' | 'unit' | 'range'>>
  ) => {
    const next = { ...userControls, ...updates };
    setUserControls((current) => ({
      ...current,
      ...updates,
      cursors: [''],
      cursorIndex: 0,
    }));
    setSearchParams(new URLSearchParams(withUserBrowserFilters(location.search, next)), { replace: true });
  };

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
  const refreshView = () => {
    const refreshedAt = interactionTimestamp();
    const refreshedWindow = rangeWindow(searchParams, refreshedAt);
    setNow(refreshedAt);
    refresh({
      rangeId,
      from: refreshedWindow.from,
      to: refreshedWindow.to,
      filters,
      cursor: listCursor,
    });
  };
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
        onOpenFeedback={showsAdminSurfaces(outlet?.role.state ?? 'failed') ? openFeedback : undefined}
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
          canOpenUser={showsAdminSurfaces(outlet?.role.state ?? 'failed')}
          onRetry={questionRequest.retry}
        />
      ) : null}
      {drawer.person ? (
        <PersonPanelShell
          state={personRequest.state}
          spendState={personSpendRequest.state}
          spendUnit={userBrowser.unit}
          spendRefreshing={personSpendRequest.refreshing}
          email={drawer.person}
          now={now}
          rangeLabel={profileWindow.label}
          page={personPage}
          onClose={userBrowser.open ? closeUserMonitoring : feedbackBrowserOpen ? closeFeedbackBrowser : close}
          onBack={
            userBrowser.open || feedbackBrowserOpen
              ? () =>
                  void navigate({
                    search: userBrowser.open ? backToUserBrowser(location.search) : closedDrawer(location.search),
                  })
              : undefined
          }
          backLabel={feedbackBrowserOpen && !userBrowser.open ? 'Back to feedback' : undefined}
          onOpenQuestion={open}
          onRetry={personRequest.retry}
          identitySeed={
            profileIdentitySeed?.scope === cacheScope &&
            profileIdentitySeed.email.toLowerCase() === drawer.person?.toLowerCase()
              ? profileIdentitySeed
              : null
          }
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
          rangeLabel={userWindow.label}
          now={now}
          onClose={closeUserMonitoring}
          onOpenUser={(user) => {
            setProfileIdentitySeed({
              scope: cacheScope,
              email: user.email,
              role: user.role,
              persona: user.persona,
              organization: user.organization,
            });
            const monitoring =
              userBrowserRequest.state.status === 'ready' ? userBrowserRequest.state.data.userMonitoring : null;
            const reading = userBrowser.unit === 'USD' ? user.spend.usd : user.spend.dbu;
            cacheUserSpendTotal(
              {
                scope: cacheScope,
                email: user.email,
                from: userWindow.from,
                to: userWindow.to,
                unit: userBrowser.unit,
              },
              {
                amount: reading.amount,
                quality: reading.quality,
                questions: user.questions,
                coveredDays: user.coveredDays,
                tokenUsage: user.tokenUsage,
                currency: userBrowserRequest.state.status === 'ready' ? userBrowserRequest.state.data.currency : '',
                profile: null,
                dataRevision: monitoring?.dataRevision ?? 0,
                snapshot: `${monitoring?.readAt ?? new Date().toISOString()}|list|${monitoring?.identityRevision ?? ''}`,
                seeded: true,
                complete: false,
                identityRevision: monitoring?.identityRevision ?? '',
              }
            );
            void navigate({ search: openUserFromBrowser(location.search, user.email) });
          }}
          onSearch={(search) => updateUserBrowser({ search })}
          onRole={(role) => updateUserBrowser({ role })}
          onPersona={(persona) => updateUserBrowser({ persona })}
          onOrganizations={(organizations) => updateUserBrowser({ organizations: [...organizations] })}
          onRange={(range) => updateUserBrowser({ range })}
          onUnit={(unit) => updateUserBrowser({ unit })}
          onClear={() => updateUserBrowser({ search: '', role: '', persona: '', organizations: [] })}
          onNext={(cursor) =>
            setUserControls((current) => {
              const cursors = current.cursors.slice(0, current.cursorIndex + 1);
              return { ...current, cursors: [...cursors, cursor], cursorIndex: cursors.length };
            })
          }
          onPrevious={() =>
            setUserControls((current) => ({ ...current, cursorIndex: Math.max(0, current.cursorIndex - 1) }))
          }
          refreshing={userBrowserRequest.refreshing}
          cacheKey={`${cacheScope}|${userBrowserKey}`}
        />
      ) : null}
      {feedbackBrowserOpen && !userBrowser.open && !drawer.person && !drawer.question ? (
        <FeedbackBrowserPanel
          state={feedbackRequest.state}
          filters={feedbackBrowser.filters}
          range={feedbackBrowser.range}
          rangeLabel={feedbackWindow.label}
          page={feedbackPage}
          onClose={closeFeedbackBrowser}
          onFilters={(nextFilters) =>
            setFeedbackControls((current) => ({
              ...current,
              filters: nextFilters,
              cursors: [''],
              cursorIndex: 0,
            }))
          }
          onRange={(range) =>
            setFeedbackControls((current) => ({
              ...current,
              range,
              cursors: [''],
              cursorIndex: 0,
            }))
          }
          onClear={() =>
            setFeedbackControls((current) => ({
              ...current,
              filters: { ...EMPTY_FEEDBACK_FILTERS },
              cursors: [''],
              cursorIndex: 0,
            }))
          }
          onOpenQuestion={openFeedbackQuestion}
          onPrevious={() =>
            setFeedbackControls((current) => ({
              ...current,
              cursorIndex: Math.max(0, current.cursorIndex - 1),
            }))
          }
          onNext={(cursor) =>
            setFeedbackControls((current) => {
              const cursors = current.cursors.slice(0, current.cursorIndex + 1);
              return { ...current, cursors: [...cursors, cursor], cursorIndex: cursors.length };
            })
          }
          onRetry={feedbackRequest.retry}
        />
      ) : null}
    </div>
  );
}

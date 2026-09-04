import { useEffect, useRef, useState } from 'react';
import { MessageSquareText, Search, ThumbsDown, ThumbsUp, X, type LucideIcon } from 'lucide-react';

import type { MonitoringFeedbackPayload, MonitoringFeedbackRow } from '../../shared/monitoring-feedback-contract';
import { isRole } from '../../shared/user-roster-contract';
import type { RangeKey } from './time-range';
import type { PanelLoadState } from './monitoring-detail-state';
import type { FeedbackBrowserFilters } from './feedback-browser-session';
import { monitoringQuestionRowHandlers } from './monitoring-row-activation';
import { AppSelect, type AppSelectOption } from './AppSelect';
import { PiaLoaderMark } from './PiaLoader';
import { PiaEmptyStateMark } from './PiaMark';
import { Button, Input, Skeleton } from './ui';
import { Dialog } from './Dialog';
import { TimeRangeSegments } from './TimeRangeControl';
import { UserDrilldownLink } from './UserDrilldownLink';
import { RoleBadgePill } from './RoleBadge';
import { astPill } from './pia-pill';

const NO_FILTER = '__any__';
const SEARCH_DELAY_MS = 250;

function FeedbackSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [typed, setTyped] = useState(value);
  const commit = useRef(onChange);
  useEffect(() => {
    commit.current = onChange;
  }, [onChange]);
  useEffect(() => {
    setTyped(value);
  }, [value]);
  useEffect(() => {
    if (typed === value) return;
    const timer = setTimeout(() => commit.current(typed), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, value]);
  return (
    <div className="run-search monitoring-search monitoring-feedback-search">
      <Search aria-hidden="true" className="monitoring-search-icon" />
      <Input
        type="search"
        maxLength={200}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder="Search questions, users, or comments…"
        aria-label="Search feedback by question, user, or comment"
      />
      {typed ? (
        <button
          type="button"
          className="monitoring-search-clear"
          aria-label="Clear feedback search"
          onClick={() => {
            setTyped('');
            commit.current('');
          }}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function FeedbackFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<AppSelectOption<string>>;
  onChange: (value: string) => void;
}) {
  return (
    <AppSelect
      label={label}
      ariaLabel={`Filter feedback by ${label.toLowerCase()}`}
      value={value || NO_FILTER}
      options={[{ value: NO_FILTER, label }, ...options]}
      onValueChange={(next) => onChange(next === NO_FILTER ? '' : next)}
      className={`monitoring-feedback-filter-trigger monitoring-feedback-filter-${label.toLowerCase()}`}
      contentClassName="monitoring-users-filter-menu"
    />
  );
}

function FeedbackDirection({ direction }: { direction: 'up' | 'down' }) {
  return direction === 'up' ? (
    <span className="monitoring-feedback-direction monitoring-feedback-direction-up">
      <ThumbsUp aria-hidden="true" />
      Helpful
    </span>
  ) : (
    <span className="monitoring-feedback-direction monitoring-feedback-direction-down">
      <ThumbsDown aria-hidden="true" />
      Not helpful
    </span>
  );
}

function submittedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed));
}

function FeedbackRowsLoading() {
  return (
    <div className="monitoring-feedback-loading" role="status" aria-label="Loading submitted feedback">
      <div className="monitoring-feedback-loading-label">
        <PiaLoaderMark variant="inline" className="monitoring-feedback-loading-mark" />
        <span>Loading feedback</span>
      </div>
      <div className="monitoring-feedback-skeleton" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row}>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

function FeedbackKpi({
  label,
  value,
  unavailable,
  loading,
  icon: Icon,
}: {
  label: string;
  value: string;
  unavailable?: string;
  loading: boolean;
  icon: LucideIcon;
}) {
  return (
    <div className="monitoring-feedback-kpi">
      <div className="monitoring-feedback-kpi-head">
        <span className="monitoring-feedback-kpi-label">
          <Icon aria-hidden="true" />
          {label}
        </span>
      </div>
      {loading ? (
        <Skeleton className="monitoring-feedback-kpi-skeleton" aria-label={`Loading ${label.toLowerCase()}`} />
      ) : unavailable ? (
        <p className="monitoring-feedback-kpi-unavailable">{unavailable}</p>
      ) : (
        <p className="monitoring-feedback-kpi-value ast-num">{value}</p>
      )}
    </div>
  );
}

function FeedbackKpis({ state, period }: { state: PanelLoadState<MonitoringFeedbackPayload>; period: string }) {
  const payload = state.status === 'ready' ? state.data : null;
  const loading = state.status === 'idle' || state.status === 'loading';
  const unavailable = state.status === 'error' ? 'Unavailable' : '';
  const total = payload?.summary.total ?? 0;
  const helpfulRate = total > 0 ? `${Math.round(((payload?.summary.helpful ?? 0) / total) * 100)}%` : '';
  return (
    <div className="monitoring-feedback-kpi-group">
      <div className="monitoring-feedback-kpi-scope">
        <span className={astPill('neutral-outline', 'monitoring-feedback-period-badge')}>{period}</span>
      </div>
      <section className="monitoring-feedback-kpis" aria-label={`Feedback summary, ${period}`}>
        <FeedbackKpi
          label="Total feedback"
          value={(payload?.summary.total ?? 0).toLocaleString()}
          unavailable={unavailable}
          loading={loading}
          icon={MessageSquareText}
        />
        <FeedbackKpi
          label="Helpful"
          value={(payload?.summary.helpful ?? 0).toLocaleString()}
          unavailable={unavailable}
          loading={loading}
          icon={ThumbsUp}
        />
        <FeedbackKpi
          label="Not helpful"
          value={(payload?.summary.notHelpful ?? 0).toLocaleString()}
          unavailable={unavailable}
          loading={loading}
          icon={ThumbsDown}
        />
        <FeedbackKpi
          label="Helpful rate"
          value={helpfulRate}
          unavailable={unavailable || (payload && total === 0 ? 'No feedback' : '')}
          loading={loading}
          icon={ThumbsUp}
        />
        <FeedbackKpi
          label="Comments captured"
          value={(payload?.summary.comments ?? 0).toLocaleString()}
          unavailable={unavailable}
          loading={loading}
          icon={MessageSquareText}
        />
      </section>
    </div>
  );
}

function FeedbackTable({
  rows,
  onOpenQuestion,
}: {
  rows: MonitoringFeedbackRow[];
  onOpenQuestion: (row: MonitoringFeedbackRow) => void;
}) {
  return (
    <div className="monitoring-feedback-table-frame">
      <table className="monitoring-feedback-table">
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col">User</th>
            <th scope="col">Feedback</th>
            <th scope="col">Comment</th>
            <th scope="col">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const activation = monitoringQuestionRowHandlers(row, onOpenQuestion);
            return (
              <tr
                key={row.id}
                tabIndex={0}
                className="monitoring-feedback-row"
                aria-haspopup="dialog"
                aria-label={`Open question details: ${row.question}`}
                {...activation}
              >
                <td data-label="Question">
                  <span className="monitoring-feedback-question">{row.question}</span>
                </td>
                <td data-label="User" title={row.userEmail}>
                  <span className="monitoring-feedback-user">
                    <UserDrilldownLink identity={row.userEmail} compact canOpen showArrow />
                    <RoleBadgePill state={row.role} />
                  </span>
                </td>
                <td data-label="Feedback">
                  <FeedbackDirection direction={row.feedback} />
                </td>
                <td data-label="Comment">
                  <span className={row.comment ? 'monitoring-feedback-comment' : 'monitoring-feedback-comment-empty'}>
                    {row.comment ?? '—'}
                  </span>
                </td>
                <td data-label="Submitted" className="monitoring-feedback-submitted">
                  <time dateTime={row.submittedAt}>{submittedAt(row.submittedAt)}</time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FeedbackBrowserPanel({
  state,
  filters,
  range,
  rangeLabel,
  page,
  onClose,
  onFilters,
  onRange,
  onClear,
  onOpenQuestion,
  onPrevious,
  onNext,
  onRetry,
}: {
  state: PanelLoadState<MonitoringFeedbackPayload>;
  filters: FeedbackBrowserFilters;
  range: RangeKey;
  rangeLabel: string;
  page: number;
  onClose: () => void;
  onFilters: (filters: FeedbackBrowserFilters) => void;
  onRange: (range: RangeKey) => void;
  onClear: () => void;
  onOpenQuestion: (row: MonitoringFeedbackRow) => void;
  onPrevious: () => void;
  onNext: (cursor: string) => void;
  onRetry: () => void;
}) {
  const payload = state.status === 'ready' ? state.data : null;
  const changed = Object.values(filters).some(Boolean);
  return (
    <Dialog
      overlayClassName="monitoring-users-overlay monitoring-feedback-overlay"
      contentClassName="monitoring-users-modal monitoring-feedback-modal"
      labelledBy="monitoring-feedback-title"
      describedBy="monitoring-feedback-description"
      ariaBusy={state.status === 'loading' || state.status === 'idle'}
      onDismiss={onClose}
    >
      <header className="monitoring-users-header monitoring-feedback-header">
        <div>
          <h3 id="monitoring-feedback-title" className="monitoring-users-title">
            Feedback
          </h3>
          <p id="monitoring-feedback-description" className="monitoring-drawer-meta">
            {payload
              ? `${payload.summary.total.toLocaleString()} total · ${payload.summary.helpful.toLocaleString()} helpful · ${payload.summary.notHelpful.toLocaleString()} not helpful`
              : `Submitted question feedback · ${rangeLabel}`}
          </p>
        </div>
        <Button variant="outline" size="sm" className="monitoring-drawer-close" onClick={onClose}>
          <X aria-hidden="true" />
          <span className="sr-only">Close Feedback</span>
        </Button>
      </header>
      <div className="monitoring-users-body monitoring-feedback-body">
        <FeedbackKpis state={state} period={rangeLabel} />
        <div className="monitoring-users-toolbar monitoring-feedback-toolbar">
          <div className="monitoring-feedback-toolbar-primary">
            <FeedbackSearch value={filters.search} onChange={(search) => onFilters({ ...filters, search })} />
            <TimeRangeSegments page="Feedback" value={range} onChange={onRange} />
            {changed ? (
              <Button variant="ghost" size="sm" onClick={onClear}>
                Clear filters
              </Button>
            ) : null}
          </div>
          <div className="monitoring-feedback-filter-row">
            <FeedbackFilter
              label="Feedback"
              value={filters.feedback}
              options={[
                { value: 'up', label: 'Helpful' },
                { value: 'down', label: 'Not helpful' },
              ]}
              onChange={(feedback) =>
                onFilters({ ...filters, feedback: feedback as FeedbackBrowserFilters['feedback'] })
              }
            />
            <FeedbackFilter
              label="User"
              value={filters.user}
              options={(payload?.filters.users ?? []).map((option) => ({
                value: option.value,
                label: `${option.label} (${option.count})`,
              }))}
              onChange={(user) => onFilters({ ...filters, user })}
            />
            <FeedbackFilter
              label="Role"
              value={filters.role}
              options={(payload?.filters.roles ?? []).map((option) => {
                const role = isRole(option.value) ? option.value : null;
                return {
                  value: option.value,
                  label: `${option.label} (${option.count})`,
                  content: role ? (
                    <>
                      <RoleBadgePill state={role} />
                      <span className="monitoring-role-filter-count">({option.count})</span>
                    </>
                  ) : (
                    `${option.label} (${option.count})`
                  ),
                };
              })}
              onChange={(role) => onFilters({ ...filters, role })}
            />
            <FeedbackFilter
              label="Persona"
              value={filters.persona}
              options={(payload?.filters.personas ?? []).map((option) => ({
                value: option.value,
                label: `${option.label} (${option.count})`,
              }))}
              onChange={(persona) => onFilters({ ...filters, persona })}
            />
            <FeedbackFilter
              label="Organization"
              value={filters.organization}
              options={(payload?.filters.organizations ?? []).map((option) => ({
                value: option.value,
                label: `${option.label} (${option.count})`,
              }))}
              onChange={(organization) => onFilters({ ...filters, organization })}
            />
          </div>
        </div>

        {state.status === 'error' ? (
          <div className="monitoring-feedback-error" role="alert">
            <p>{state.error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : state.status === 'loading' || state.status === 'idle' ? (
          <FeedbackRowsLoading />
        ) : payload && payload.rows.length === 0 ? (
          <div className="monitoring-feedback-empty" role="status">
            <PiaEmptyStateMark size={32} />
            <p>No feedback matches these filters</p>
          </div>
        ) : payload ? (
          <FeedbackTable rows={payload.rows} onOpenQuestion={onOpenQuestion} />
        ) : null}

        {payload ? (
          <div className="monitoring-users-pagination" aria-label="Feedback pages">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={onPrevious}>
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
        ) : null}
      </div>
    </Dialog>
  );
}

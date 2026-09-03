import { CalendarDays } from 'lucide-react';

/** A parsed timestamp with separate visible and full-precision representations. */
export interface DateBadgeValue {
  /** Valid HTML date/time value retained at the timestamp's reported precision. */
  dateTime: string;
  /** Compact local date and time drawn in the badge. */
  label: string;
  /** Full source timestamp used by the tooltip and accessible name. */
  full: string;
}

export interface DateRangeValue {
  start: DateBadgeValue;
  end: DateBadgeValue;
}

/** Build a date-only badge without inventing a local midnight time. */
// eslint-disable-next-line react-refresh/only-export-components -- pure date value is shared by every DateBadge caller
export function dateOnlyBadgeValue(day: string): DateBadgeValue {
  const dateTime = day.slice(0, 10);
  const parsed = Date.parse(`${dateTime}T00:00:00Z`);
  return {
    dateTime,
    label: Number.isFinite(parsed)
      ? new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(new Date(parsed))
      : 'Date unavailable',
    full: dateTime || 'Date unavailable',
  };
}

/**
 * One neutral timestamp badge.
 *
 * The calendar is decorative because the `<time>` element names the complete
 * timestamp itself. `title` keeps that precision available to pointer users,
 * while the visible label stays short enough for a fact row.
 */
export function DateBadge({
  value,
  accessiblePrefix = 'Date and time',
}: {
  value: DateBadgeValue;
  accessiblePrefix?: string;
}) {
  return (
    <time
      className="ast-pill ast-pill--neutral date-badge"
      dateTime={value.dateTime}
      title={value.full}
      aria-label={`${accessiblePrefix}: ${value.full}`}
    >
      <CalendarDays size={12} strokeWidth={2} aria-hidden="true" />
      <span>{value.label}</span>
    </time>
  );
}

/** Start and end timestamps separated by the only visible range prose: an en dash. */
export function DateRangeBadges({
  value,
  accessibleLabel = 'Date range',
}: {
  value: DateRangeValue;
  accessibleLabel?: string;
}) {
  return (
    <span className="date-range-badges" aria-label={accessibleLabel}>
      <DateBadge value={value.start} accessiblePrefix="Start date and time" />
      <span className="date-range-separator" aria-hidden="true">
        –
      </span>
      <DateBadge value={value.end} accessiblePrefix="End date and time" />
    </span>
  );
}

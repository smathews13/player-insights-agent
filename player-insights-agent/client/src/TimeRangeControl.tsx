/**
 * The segmented time range: 24h, 7 days, 30 days and All time.
 *
 * One component, imported by Monitoring and by Ops, for the reason the Refresh
 * control is one component: two copies of a control drift, and the drift shows
 * up as two pages that look like they mean the same window and do not.
 *
 * The choice lives in the URL and this reads it from there on every render, so
 * there is no second copy of the range in component state. Pressing a segment is
 * a navigation, which is what makes the browser's back button work on it.
 *
 * Everything about WHICH ranges exist and WHAT window each covers is in
 * time-range.ts. This file owns the markup, ARIA and URL navigation.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import './styles/routes/time-range.css';
import { normalizeTimeRangeSearch, RANGE_SEGMENTS, rangeFromParams, withRange, type RangeKey } from './time-range';

export interface TimeRangeControlProps {
  /**
   * Named on the control's accessible name, because two of these can be on
   * screen in one session and "Time range" alone does not say which page's.
   */
  page: string;
  className?: string;
}

export function TimeRangeSegments({
  page,
  value,
  onChange,
  className,
}: {
  page: string;
  value: RangeKey;
  onChange: (value: RangeKey) => void;
  className?: string;
}) {
  return (
    <div className={className ? `time-range ${className}` : 'time-range'}>
      <div className="time-range-segments" role="radiogroup" aria-label={`Time range for ${page}`}>
        {RANGE_SEGMENTS.map((segment) => (
          <button
            key={segment.key}
            type="button"
            role="radio"
            aria-checked={value === segment.key}
            className="time-range-segment"
            onClick={() => onChange(segment.key)}
          >
            {segment.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TimeRangeControl({ page, className }: TimeRangeControlProps) {
  const [params, setParams] = useSearchParams();
  const active = rangeFromParams(params);
  const currentSearch = params.toString() ? `?${params.toString()}` : '';
  const normalizedSearch = normalizeTimeRangeSearch(currentSearch);

  useEffect(() => {
    if (normalizedSearch === currentSearch) return;
    setParams(new URLSearchParams(normalizedSearch), { replace: true });
  }, [currentSearch, normalizedSearch, setParams]);

  const choose = (key: RangeKey) => {
    const next = withRange(currentSearch, key);

    // Pressing the segment that is already chosen changes nothing, so it must not
    // push a history entry either. There is no unselected state to toggle into --
    // this is a radio group and one range is always in force -- and navigating to
    // the URL already open would leave the reader's Back button undoing presses
    // that never did anything, which reads as a dead Back button rather than as
    // the range control they were using.
    if (next === (params.toString() ? `?${params.toString()}` : '')) return;
    setParams(new URLSearchParams(next), { replace: false });
  };

  return <TimeRangeSegments page={page} value={active} onChange={choose} className={className} />;
}

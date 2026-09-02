import { SlidersHorizontal } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import './styles/routes/time-range.css';

export type DisplayUnit = 'USD' | 'DBU';

const UNITS: ReadonlyArray<{ unit: DisplayUnit; label: string; accessible: string }> = [
  { unit: 'USD', label: '$', accessible: 'US dollars' },
  { unit: 'DBU', label: 'DBU', accessible: 'Databricks units' },
];

function adjacentUnit(unit: DisplayUnit, key: string): DisplayUnit {
  if (key === 'Home' || key === 'ArrowLeft' || key === 'ArrowUp') return 'USD';
  if (key === 'End' || key === 'ArrowRight' || key === 'ArrowDown') return 'DBU';
  return unit;
}

export function UnitSegmentedControl({
  unit,
  onChange,
  label,
  ariaLabel,
  showLabel = true,
}: {
  unit: DisplayUnit;
  onChange: (unit: DisplayUnit) => void;
  label: string;
  ariaLabel: string;
  showLabel?: boolean;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = adjacentUnit(unit, event.key);
    onChange(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-display-unit="${next}"]`)?.focus();
  };

  return (
    <div className="time-range unit-segmented-control" data-unit-segmented-control>
      {showLabel ? (
        <span className="unit-segmented-label">
          <SlidersHorizontal aria-hidden="true" />
          <span>{label}</span>
        </span>
      ) : null}
      <div className="time-range-segments unit-segmented-options" role="radiogroup" aria-label={ariaLabel}>
        {UNITS.map((segment) => (
          <button
            key={segment.unit}
            type="button"
            role="radio"
            aria-checked={unit === segment.unit}
            aria-label={segment.accessible}
            tabIndex={unit === segment.unit ? 0 : -1}
            data-display-unit={segment.unit}
            className="time-range-segment unit-segmented-option"
            onClick={() => onChange(segment.unit)}
            onKeyDown={move}
          >
            {segment.label}
          </button>
        ))}
      </div>
    </div>
  );
}

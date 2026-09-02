import { ChevronDown, ChevronUp } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { Input } from './ui';

export interface TickerNumber {
  empty: boolean;
  valid: boolean;
  value: number | null;
}

function decimalPlaces(value: number): number {
  const text = String(value);
  if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

/** Parse display text without ever turning an empty field into zero. */
// eslint-disable-next-line react-refresh/only-export-components -- shared-control parsing is directly unit tested
export function tickerNumber(raw: string, min = 0, max = Number.MAX_SAFE_INTEGER): TickerNumber {
  const trimmed = raw.trim();
  if (!trimmed) return { empty: true, valid: true, value: null };
  const normalized = trimmed.replaceAll(',', '');
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) return { empty: false, valid: false, value: null };
  const value = Number(normalized);
  return {
    empty: false,
    valid: Number.isFinite(value) && value >= min && value <= max,
    value: Number.isFinite(value) ? value : null,
  };
}

/** Integer-scaled stepping avoids values such as 0.30000000000000004. */
// eslint-disable-next-line react-refresh/only-export-components -- both click and keyboard stepping share this tested helper
export function stepTickerValue(
  raw: string,
  direction: -1 | 1,
  { step, min = 0, max = Number.MAX_SAFE_INTEGER, precision = decimalPlaces(step) }: TickerStepOptions
): string {
  const parsed = tickerNumber(raw, min, max);
  const current = parsed.valid && parsed.value !== null ? parsed.value : min;
  const scale = 10 ** Math.max(precision, decimalPlaces(step));
  const stepped = (Math.round(current * scale) + direction * Math.round(step * scale)) / scale;
  const bounded = Math.min(max, Math.max(min, stepped));
  return precision > 0 ? bounded.toFixed(precision).replace(/\.?0+$/, '') : String(Math.round(bounded));
}

interface TickerStepOptions {
  step: number;
  min?: number;
  max?: number;
  precision?: number;
}

export interface NumberTickerProps extends TickerStepOptions {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  invalid?: boolean;
  disabled?: boolean;
  wide?: boolean;
  title?: string;
}

export function TickerAssumptionGrid({
  children,
  columns,
  legend,
  labelledBy,
  framed = true,
}: {
  children: ReactNode;
  columns: number;
  legend?: string;
  labelledBy?: string;
  framed?: boolean;
}) {
  const style = { '--ops-assumption-columns': columns } as CSSProperties;
  const grid = (
    <div className="ops-ticker-assumption-grid" data-columns={columns} style={style}>
      {children}
    </div>
  );
  if (!framed) {
    return (
      <div className="ops-ticker-assumptions" aria-labelledby={labelledBy}>
        {grid}
      </div>
    );
  }
  return (
    <fieldset className="ops-ticker-assumptions">
      {legend ? <legend>{legend}</legend> : null}
      {grid}
    </fieldset>
  );
}

export function TickerAssumptionField({
  id,
  label,
  helper,
  error,
  unit,
  labelHidden = false,
  children,
}: {
  id: string;
  label: string;
  helper: string;
  error?: string;
  unit?: string;
  labelHidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ops-ticker-assumption">
      <label className={labelHidden ? 'sr-only' : undefined} htmlFor={id}>
        {label}
      </label>
      <span className="ops-ticker-input-row">
        {children}
        {unit ? <small>{unit}</small> : null}
      </span>
      {helper ? <small className="ops-ticker-assumption-helper">{helper}</small> : null}
      {error ? (
        <small className="ops-ticker-assumption-error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

/** Shared numeric ticker used by both Forecasting assumptions and Cost budgets. */
export function NumberTicker({
  id,
  label,
  value,
  onChange,
  placeholder,
  prefix,
  suffix,
  step,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  precision,
  invalid = false,
  disabled = false,
  wide = false,
  title,
}: NumberTickerProps) {
  const parsed = tickerNumber(value, min, max);
  const decreaseDisabled = disabled || (parsed.valid && parsed.value !== null && parsed.value <= min);
  const changeBy = (direction: -1 | 1) => onChange(stepTickerValue(value, direction, { step, min, max, precision }));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    changeBy(event.key === 'ArrowUp' ? 1 : -1);
  };

  return (
    <span
      className={`ops-number-ticker ops-forecast-number-control${wide ? ' ops-number-ticker-wide' : ''}`}
      data-prefix={prefix ? 'true' : undefined}
      data-suffix={suffix ? 'true' : undefined}
    >
      {prefix ? (
        <span className="ops-number-ticker-prefix" aria-hidden="true">
          {prefix}
        </span>
      ) : null}
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        title={title}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {suffix ? (
        <span className="ops-number-ticker-suffix" aria-hidden="true">
          {suffix}
        </span>
      ) : null}
      <span
        className="ops-number-ticker-steppers ops-forecast-steppers"
        role="group"
        aria-label={`${label} step controls`}
      >
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()}`}
          aria-controls={id}
          disabled={disabled}
          onClick={() => changeBy(1)}
        >
          <ChevronUp aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()}`}
          aria-controls={id}
          disabled={decreaseDisabled}
          onClick={() => changeBy(-1)}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </span>
    </span>
  );
}

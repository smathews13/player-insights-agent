import { validIanaTimeZone } from '../../shared/timezone';
import type { AppSelectOption } from './AppSelect';

export const BROWSER_TIMEZONE_VALUE = '__browser_timezone__';
export const OTHER_TIMEZONE_VALUE = '__other_iana_timezone__';

export const COMMON_TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'Coordinated Universal Time', code: 'UTC' },
  { value: 'America/New_York', label: 'Eastern Time (US & Canada)', code: 'America/New_York' },
  { value: 'America/Chicago', label: 'Central Time (US & Canada)', code: 'America/Chicago' },
  { value: 'America/Denver', label: 'Mountain Time (US & Canada)', code: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)', code: 'America/Los_Angeles' },
  { value: 'Europe/London', label: 'London', code: 'Europe/London' },
  { value: 'Europe/Paris', label: 'Paris', code: 'Europe/Paris' },
  { value: 'Asia/Tokyo', label: 'Tokyo', code: 'Asia/Tokyo' },
  { value: 'Asia/Singapore', label: 'Singapore', code: 'Asia/Singapore' },
  { value: 'Australia/Sydney', label: 'Sydney', code: 'Australia/Sydney' },
] as const satisfies readonly AppSelectOption[];

export const COMMON_TIMEZONES = new Set<string>(COMMON_TIMEZONE_OPTIONS.map((option) => option.value));

export function timezoneSelectOptions(timezone: string): readonly AppSelectOption[] {
  const saved = timezone.trim();
  const custom =
    saved && !COMMON_TIMEZONES.has(saved)
      ? [
          {
            value: saved,
            label: validIanaTimeZone(saved) ? 'Custom timezone' : 'Saved timezone (not recognized)',
            code: saved,
          },
        ]
      : [];
  return [
    { value: BROWSER_TIMEZONE_VALUE, label: 'Use browser timezone' },
    ...COMMON_TIMEZONE_OPTIONS,
    ...custom,
    { value: OTHER_TIMEZONE_VALUE, label: 'Other IANA timezone…' },
  ];
}

export type TimezoneInputResult =
  | { kind: 'empty'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; value: string };

export function timezoneInputResult(value: string): TimezoneInputResult {
  if (!value.trim()) return { kind: 'empty', message: 'Enter an IANA timezone, such as Pacific/Auckland.' };
  const valid = validIanaTimeZone(value);
  return valid
    ? { kind: 'valid', value: valid }
    : { kind: 'invalid', message: 'Use a valid IANA timezone, such as Pacific/Auckland.' };
}

/** `null` means reveal the custom editor without changing the staged setting. */
export function timezoneValueFromSelection(value: string): string | null {
  if (value === OTHER_TIMEZONE_VALUE) return null;
  return value === BROWSER_TIMEZONE_VALUE ? '' : value;
}

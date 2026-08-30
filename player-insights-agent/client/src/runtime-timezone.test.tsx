import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { validIanaTimeZone } from '../../shared/timezone';
import { RuntimeTimezoneField } from './RuntimeTimezoneField';
import {
  BROWSER_TIMEZONE_VALUE,
  COMMON_TIMEZONE_OPTIONS,
  OTHER_TIMEZONE_VALUE,
  timezoneInputResult,
  timezoneSelectOptions,
  timezoneValueFromSelection,
} from './runtime-timezone';

const panel = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const field = readFileSync(new URL('./RuntimeTimezoneField.tsx', import.meta.url), 'utf8');
const logic = readFileSync(new URL('./runtime-timezone.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');

describe('Runtime timezone control', () => {
  it('offers friendly common choices with their exact IANA values visible', () => {
    expect(COMMON_TIMEZONE_OPTIONS.map(({ value }) => value)).toEqual([
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
      'Asia/Tokyo',
      'Asia/Singapore',
      'Australia/Sydney',
    ]);
    expect(COMMON_TIMEZONE_OPTIONS.every((option) => option.label && option.code === option.value)).toBe(true);
    expect(field).toContain('<AppSelect');
    expect(logic).toContain("label: 'Other IANA timezone…'");
  });

  it('keeps a valid custom saved timezone selected instead of resetting it', () => {
    const custom = timezoneSelectOptions('Pacific/Auckland');
    expect(custom).toContainEqual({
      value: 'Pacific/Auckland',
      label: 'Custom timezone',
      code: 'Pacific/Auckland',
    });
    expect(custom.at(-1)?.value).toBe(OTHER_TIMEZONE_VALUE);

    const markup = renderToStaticMarkup(<RuntimeTimezoneField value="Pacific/Auckland" update={() => {}} />);
    expect(markup).toContain('aria-label="Timezone: Custom timezone — Pacific/Auckland"');
    expect(markup).toContain('<code>Pacific/Auckland</code>');
  });

  it('uses the Ops IANA validator and changes the staged value only for valid input', () => {
    expect(validIanaTimeZone(' Pacific/Auckland ')).toBe('Pacific/Auckland');
    expect(timezoneInputResult('Not/A_Zone')).toEqual({
      kind: 'invalid',
      message: 'Use a valid IANA timezone, such as Pacific/Auckland.',
    });
    expect(timezoneInputResult('Pacific/Auckland')).toEqual({ kind: 'valid', value: 'Pacific/Auckland' });
    expect(timezoneValueFromSelection(OTHER_TIMEZONE_VALUE)).toBeNull();
    expect(timezoneValueFromSelection(BROWSER_TIMEZONE_VALUE)).toBe('');
    expect(timezoneValueFromSelection('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(field).toContain("if (result.kind === 'valid')");
    expect(field).toContain('update(result.value)');
  });

  it('preserves staged Save and Cancel instead of writing from the dropdown', () => {
    expect(panel).toContain('behavior: { ...current.behavior, timezone }');
    expect(panel).toContain("fetch('/api/admin/runtime-settings'");
    expect(field).not.toContain("fetch('/api/admin/runtime-settings'");
    expect(field).not.toMatch(/\bfetch\(/);
  });

  it('labels the select and custom validation accessibly', () => {
    const markup = renderToStaticMarkup(<RuntimeTimezoneField value="UTC" update={() => {}} />);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-labelledby="runtime-timezone-label"');
    expect(markup).toContain('aria-label="Timezone: Coordinated Universal Time — UTC"');
    expect(field).toContain('aria-label="Other IANA timezone"');
    expect(field).toContain('aria-invalid={customError');
    expect(field).toContain('role="alert"');
  });

  it('uses the established menu styling and stays fluid on narrow settings panes', () => {
    expect(field).toContain('className="runtime-timezone-select"');
    expect(field).toContain('contentClassName="runtime-timezone-menu"');
    expect(styles).toMatch(/\.runtime-timezone-field\s*\{[^}]*width:\s*min\(100%,\s*420px\)/);
    expect(styles).toMatch(/\.runtime-timezone-select\s*\{[^}]*width:\s*100%/);
    expect(styles).toMatch(/\.runtime-timezone-menu\s*\{[^}]*calc\(100vw - 24px\)/);
  });
});

import { useState } from 'react';
import { validIanaTimeZone } from '../../shared/timezone';
import { AppSelect } from './AppSelect';
import {
  BROWSER_TIMEZONE_VALUE,
  COMMON_TIMEZONES,
  timezoneInputResult,
  timezoneSelectOptions,
  timezoneValueFromSelection,
} from './runtime-timezone';
import { Input } from './ui';

export function RuntimeTimezoneField({ value, update }: { value: string; update: (value: string) => void }) {
  const [editingCustom, setEditingCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [customError, setCustomError] = useState('');
  const selectValue = value.trim() || BROWSER_TIMEZONE_VALUE;

  return (
    <section className="runtime-section runtime-section-last">
      <div className="runtime-field runtime-timezone-field" role="group" aria-labelledby="runtime-timezone-label">
        <span id="runtime-timezone-label" className="runtime-section-label">
          Timezone
        </span>
        <span id="runtime-timezone-help" className="runtime-control-note">
          Zone for dates in answers and Ops activity days.
        </span>
        <AppSelect
          label="Timezone"
          ariaLabel="Timezone"
          showLabel={false}
          className="runtime-timezone-select"
          contentClassName="runtime-timezone-menu"
          value={selectValue}
          options={timezoneSelectOptions(value)}
          onValueChange={(next) => {
            const selectedTimezone = timezoneValueFromSelection(next);
            if (selectedTimezone === null) {
              const currentCustom = COMMON_TIMEZONES.has(value.trim()) ? '' : value.trim();
              setCustomDraft(currentCustom);
              setCustomError(currentCustom && !validIanaTimeZone(currentCustom) ? 'Use a valid IANA timezone.' : '');
              setEditingCustom(true);
              return;
            }
            setEditingCustom(false);
            setCustomError('');
            update(selectedTimezone);
          }}
        />
        {editingCustom ? (
          <label className="runtime-timezone-custom">
            <span className="runtime-field-label">Other IANA timezone</span>
            <Input
              className="runtime-timezone-input"
              aria-label="Other IANA timezone"
              aria-describedby={`runtime-timezone-help${customError ? ' runtime-timezone-error' : ''}`}
              aria-invalid={customError ? 'true' : undefined}
              autoComplete="off"
              placeholder="Pacific/Auckland"
              value={customDraft}
              onChange={(event) => {
                const draft = event.target.value;
                const result = timezoneInputResult(draft);
                setCustomDraft(draft);
                if (result.kind === 'valid') {
                  setCustomError('');
                  update(result.value);
                } else {
                  setCustomError(result.message);
                }
              }}
            />
            {customError ? (
              <span id="runtime-timezone-error" className="runtime-timezone-error" role="alert">
                {customError}
              </span>
            ) : null}
          </label>
        ) : null}
      </div>
    </section>
  );
}

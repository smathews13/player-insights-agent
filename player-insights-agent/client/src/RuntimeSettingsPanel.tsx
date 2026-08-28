import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_RUNTIME_SETTINGS,
  FONT_SIZE_IDS,
  fontColorsForScheme,
  isHexColor,
  type FontFamilyId,
  type FontSizeId,
  type RuntimeSettings,
} from '../../shared/runtime-settings';
import { applyColorScheme, type ColorScheme } from './color-scheme';
import { runtimeSettingsFromResponse } from './runtime-settings-api';
import { AppSelect } from './AppSelect';
import { adoptRuntimeEntityStyles, previewRuntimeTypography } from './runtime-entity-styles';
import { wholeNumberFrom } from './runtime-number';
import { saveRetryAfterLoad, type SettingsLoadResult, type SettingsSaveState } from './settings-save-state';
import { StateSwitch } from './StateSwitch';
import { Input } from './ui';

const FONT_FAMILY_OPTIONS: { value: FontFamilyId; label: string }[] = [
  { value: 'dm-sans', label: 'DM Sans' },
  { value: 'system', label: 'System' },
  { value: 'dm-mono', label: 'DM Mono' },
];

const FONT_SIZE_LABELS: Record<FontSizeId, string> = {
  s: 'S',
  m: 'M',
  l: 'L',
};

export const RUNTIME_SETTINGS_FORM_ID = 'settings-runtime-form';

/**
 * One numeric field, and it is a component rather than a helper for a reason.
 *
 * ── WHY THIS IS NOT A PLAIN NUMBER INPUT BOUND TO A NUMBER ──
 *
 * Two faults compounded, and together they are the "I have to type a leading
 * zero to make it take" report.
 *
 * Coercing the raw field text with `Number` turns an EMPTY box into 0, because
 * that is what `Number` does with an empty string. Clearing the field to
 * retype it therefore did not clear it; it set the value to zero, React drew the
 * "0" back, and the digits the reader typed next landed after it.
 *
 * Then the zero could never be got rid of, because react-dom compares a number
 * input's DOM value with the incoming prop using loose equality -- `'0180' !=
 * 180` is FALSE, so having decided the two agree it leaves the box alone. No
 * value this component can pass will normalise `0180` back to `180`. That is why
 * the padding survived every re-render and every reload of the pane.
 *
 * So the box is text with a numeric keypad, where React compares strings
 * strictly and a normalised value actually lands. A local draft holds what the
 * reader is part-way through typing -- including empty -- while the committed
 * settings only ever receive a whole number inside `min`/`max`. On blur the
 * draft is dropped and the box shows the value that will be saved, so what is on
 * screen and what goes to the server cannot disagree.
 *
 * Losing the number type also removes the native `min`/`max` constraint, which
 * is a gain here: a value out of range used to make the browser silently refuse
 * to submit the form and report it on a field scrolled out of view, which is a
 * second way for Save to look like it did nothing.
 */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
  className = '',
  labelClassName = '',
  help,
  helpId,
  placeholder,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  className?: string;
  labelClassName?: string;
  help?: string;
  helpId?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className={`runtime-field ${className}`}>
      <span className={`runtime-field-label ${labelClassName}`.trim()}>{label}</span>
      {help ? (
        <span id={helpId} className="runtime-control-note">
          {help}
        </span>
      ) : null}
      <Input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        aria-describedby={helpId}
        placeholder={placeholder}
        value={draft ?? String(value)}
        onChange={(event) => {
          const typed = event.target.value.replace(/[^0-9]/g, '');
          setDraft(typed);
          // Nothing to commit for an empty box: the last good value stands until
          // the reader types a digit, which is what makes clearing-to-retype work.
          if (typed !== '') onCommit(wholeNumberFrom(typed, min, max, value));
        }}
        onBlur={() => setDraft(null)}
      />
      {placeholder ? <span className="runtime-control-example">Example: {placeholder}</span> : null}
    </label>
  );
}

function AnswerRow({
  label,
  help,
  checked,
  onToggle,
  children,
}: {
  label: string;
  help: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="runtime-answer-row">
      <div className="runtime-answer-head">
        <div>
          <span className="runtime-answer-name">{label}</span>
          <p className="runtime-control-note">{help}</p>
        </div>
        <StateSwitch checked={checked} onCheckedChange={onToggle} aria-label={label} />
      </div>
      {checked && children ? <div className="runtime-answer-body">{children}</div> : null}
    </div>
  );
}

const ENTITY_SAMPLES = {
  catalog: 'analytics',
  schema: 'sales',
  table: 'orders',
  column: 'revenue',
  quote: '2026-07-22 – 2026-08-03',
  tag: 'Northwind, Contoso',
} as const;

/**
 * Paint a theme switch immediately and return the value the form must save.
 *
 * Keeping the paint and draft conversion in one path prevents the exact defect
 * this control had: the switch changed React state, but the only call that
 * changed `<html data-theme>` lived in Save, so the whole app contradicted the
 * control until a second, distant action was pressed.
 */
export function previewColorScheme(dark: boolean): ColorScheme {
  const scheme = dark ? 'dark' : 'light';
  applyColorScheme(scheme);
  return scheme;
}

export function RuntimeSettingsPanel({
  section,
  onSaveState = () => {},
}: {
  section: 'runtime' | 'appearance';
  /** Reports Save's progress to the modal footer, which is the part on screen. */
  onSaveState?: (state: SettingsSaveState) => void;
}) {
  const [settings, setSettings] = useState<RuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed'>('loading');
  const [failure, setFailure] = useState<{ operation: 'load' | 'save'; message: string } | null>(null);
  const savedSettings = useRef<RuntimeSettings | null>(null);
  const appearancePreviewed = useRef(false);

  const load = useCallback(async (): Promise<SettingsLoadResult> => {
    setState('loading');
    setFailure(null);
    try {
      const response = await fetch('/api/runtime-settings');
      const loaded = await runtimeSettingsFromResponse(response, 'loaded');
      savedSettings.current = loaded;
      setSettings(loaded);
      if (!appearancePreviewed.current) applyColorScheme(loaded.colorScheme);
      setState('ready');
      return { ok: true };
    } catch (caught) {
      const message = (caught as Error).message;
      setState('failed');
      setFailure({ operation: 'load', message });
      return { ok: false, message };
    }
  }, []);

  useEffect(() => {
    // Mount fetch: the first paint has to come from the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() writes the fetched settings
    void load();
  }, [load]);

  useEffect(
    () => () => {
      /*
       * The switch is a preview, while Save remains the persistence boundary.
       * Every way out of the pane (Cancel, Escape, the X, clicking the scrim or
       * choosing another section) unmounts it, so one cleanup closes all of the
       * otherwise easy-to-miss ways an unsaved theme could leak into the app.
       */
      if (appearancePreviewed.current && savedSettings.current) {
        adoptRuntimeEntityStyles(savedSettings.current);
      }
    },
    []
  );

  useEffect(() => {
    if (section !== 'appearance' || state === 'loading') return;
    if (!isHexColor(settings.fontBodyColor) || !isHexColor(settings.fontMutedColor)) return;
    appearancePreviewed.current = true;
    previewRuntimeTypography(settings);
  }, [section, state, settings]);

  const save = async () => {
    /*
     * A failed load turns Save into a retry, and now it SAYS so.
     *
     * It already behaved this way and reported nothing, so pressing Save on a
     * pane whose load had failed re-fetched in silence and looked like a dead
     * button -- one of the three things "Save does nothing" turned out to mean.
     */
    if (failure?.operation === 'load') {
      onSaveState({ kind: 'saving' });
      const result = await load();
      onSaveState(saveRetryAfterLoad(result));
      return;
    }
    setState('saving');
    setFailure(null);
    onSaveState({ kind: 'saving' });
    try {
      const response = await fetch('/api/admin/runtime-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const saved = await runtimeSettingsFromResponse(response, 'saved');
      savedSettings.current = saved;
      appearancePreviewed.current = false;
      setSettings(saved);
      adoptRuntimeEntityStyles(saved);
      setState('saved');
      onSaveState({ kind: 'saved' });
    } catch (caught) {
      setState('failed');
      setFailure({ operation: 'save', message: (caught as Error).message });
      onSaveState({ kind: 'failed', message: (caught as Error).message });
    }
  };

  const setLoop = (key: keyof RuntimeSettings['loop'], value: number) =>
    setSettings((current) => ({ ...current, loop: { ...current.loop, [key]: value } }));
  const setAnswer = <K extends keyof RuntimeSettings['answer']>(key: K, value: RuntimeSettings['answer'][K]) =>
    setSettings((current) => ({ ...current, answer: { ...current.answer, [key]: value } }));

  const number = (
    label: string,
    value: number,
    min: number,
    max: number,
    update: (value: number) => void,
    extra: { className?: string; labelClassName?: string; help: string; helpId: string; placeholder: string }
  ) => (
    <NumberField
      key={label}
      label={label}
      value={value}
      min={min}
      max={max}
      onCommit={update}
      className={extra.className}
      labelClassName={extra.labelClassName}
      help={extra.help}
      helpId={extra.helpId}
      placeholder={extra.placeholder}
    />
  );

  const guidance = (
    label: string,
    value: string,
    update: (value: string) => void,
    extra: { help: string; helpId: string; placeholder: string }
  ) => (
    <label className="runtime-field runtime-field-wide">
      <span className="runtime-field-label">{label}</span>
      <span id={extra.helpId} className="runtime-control-note">
        {extra.help}
      </span>
      <textarea
        className="runtime-guidance"
        aria-label={label}
        aria-describedby={extra.helpId}
        placeholder={extra.placeholder}
        value={value}
        onChange={(event) => update(event.target.value)}
      />
    </label>
  );

  return (
    <form
      id={RUNTIME_SETTINGS_FORM_ID}
      className="settings-pane"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {section === 'runtime' ? (
        <>
          <div className="settings-pane-heading">
            <h3>Runtime</h3>
          </div>

          <section className="runtime-section">
            <h4 className="runtime-section-label">Loop structure</h4>
            <div className="runtime-loop-row">
              {number('Max DSF steps', settings.loop.maxSteps, 1, 20, (value) => setLoop('maxSteps', value), {
                labelClassName: 'runtime-loop-label runtime-loop-label--agent ast-pill',
                help: 'Reasoning steps in one Ask.',
                helpId: 'runtime-max-steps-help',
                placeholder: '10',
              })}
              {number('Max tool calls', settings.loop.maxToolCalls, 1, 40, (value) => setLoop('maxToolCalls', value), {
                labelClassName: 'runtime-loop-label runtime-loop-label--tool ast-pill',
                help: 'Tools it may call in one Ask.',
                helpId: 'runtime-max-tool-calls-help',
                placeholder: '15',
              })}
              {number(
                'Run budget (s)',
                settings.loop.maxRunSeconds,
                30,
                200,
                (value) => setLoop('maxRunSeconds', value),
                {
                  labelClassName: 'runtime-loop-label runtime-loop-label--budget ast-pill',
                  help: 'Seconds before the run stops.',
                  helpId: 'runtime-run-budget-help',
                  placeholder: '150',
                }
              )}
            </div>
          </section>

          <section className="runtime-section" id="answer-contract-settings">
            <div className="runtime-answer-header">
              <h4 className="runtime-section-label">Answer content</h4>
            </div>
            <AnswerRow
              label="Takeaway"
              help="Opening line of the answer."
              checked={settings.answer.takeaway}
              onToggle={(value) => setAnswer('takeaway', value)}
            >
              {guidance('Guidance', settings.answer.takeawayGuidance, (value) => setAnswer('takeawayGuidance', value), {
                help: 'Tone for that line.',
                helpId: 'runtime-takeaway-guidance-help',
                placeholder: 'Example: 42 teams increased weekly usage.',
              })}
            </AnswerRow>
            <AnswerRow
              label="Narrative"
              help="Prose under the takeaway."
              checked={settings.answer.narrative}
              onToggle={(value) => setAnswer('narrative', value)}
            >
              {guidance(
                'Guidance',
                settings.answer.narrativeGuidance,
                (value) => setAnswer('narrativeGuidance', value),
                {
                  help: 'How that prose should read.',
                  helpId: 'runtime-narrative-guidance-help',
                  placeholder: 'Explain the result in plain language.',
                }
              )}
              {number(
                'Character cap',
                settings.answer.narrativeMaxCharacters,
                0,
                12_000,
                (value) => setAnswer('narrativeMaxCharacters', value),
                {
                  className: 'runtime-field-short',
                  help: 'Max length. 0 means none.',
                  helpId: 'runtime-character-cap-help',
                  placeholder: '0',
                }
              )}
              <span className="runtime-inline-note">0 = uncapped</span>
            </AnswerRow>
            <AnswerRow
              label="Figures"
              help="Tables in the answer."
              checked={settings.answer.figures}
              onToggle={(value) => setAnswer('figures', value)}
            >
              {number('Max figures', settings.answer.maxFigures, 0, 12, (value) => setAnswer('maxFigures', value), {
                help: 'How many tables.',
                helpId: 'runtime-max-figures-help',
                placeholder: '6',
              })}
              <label className="runtime-field">
                <span className="runtime-field-label">Order</span>
                <span className="runtime-control-note">Which table comes first.</span>
                <AppSelect
                  label="Order"
                  ariaLabel="Order"
                  showLabel={false}
                  value={settings.answer.figuresOrder}
                  onValueChange={(value) => setAnswer('figuresOrder', value)}
                  options={[
                    { value: 'as-ranked', label: 'Recommended order' },
                    { value: 'totals-first', label: 'Totals first' },
                    { value: 'averages-first', label: 'Averages first' },
                  ]}
                />
              </label>
            </AnswerRow>
            <AnswerRow
              label="Charts"
              help="Charts in the answer."
              checked={settings.answer.charts}
              onToggle={(value) => setAnswer('charts', value)}
            >
              {number('Max charts', settings.answer.maxCharts, 0, 6, (value) => setAnswer('maxCharts', value), {
                help: 'How many charts.',
                helpId: 'runtime-max-charts-help',
                placeholder: '3',
              })}
              <label className="runtime-field">
                <span className="runtime-field-label">Types</span>
                <span className="runtime-control-note">Which chart kinds.</span>
                <AppSelect
                  label="Types"
                  ariaLabel="Types"
                  showLabel={false}
                  value={settings.answer.chartsTypes}
                  onValueChange={(value) => setAnswer('chartsTypes', value)}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'bar', label: 'Bar' },
                    { value: 'bar-line', label: 'Bar + line' },
                  ]}
                />
              </label>
            </AnswerRow>
            <AnswerRow
              label="Analyst caveats"
              help="Keep-in-mind notes."
              checked={settings.answer.caveats}
              onToggle={(value) => setAnswer('caveats', value)}
            >
              {number('Max caveats', settings.answer.maxCaveats, 0, 20, (value) => setAnswer('maxCaveats', value), {
                help: 'How many. 0 means all.',
                helpId: 'runtime-max-caveats-help',
                placeholder: '0',
              })}
              <span className="runtime-inline-note">0 = all</span>
            </AnswerRow>
          </section>

          <section className="runtime-section runtime-section-last">
            <label className="runtime-field runtime-timezone-field">
              <span className="runtime-section-label">Timezone (IANA name)</span>
              <span id="runtime-timezone-help" className="runtime-control-note">
                Zone for dates in answers.
              </span>
              <Input
                className="runtime-timezone"
                aria-label="Timezone (IANA name)"
                aria-describedby="runtime-timezone-help"
                placeholder="America/New_York"
                value={settings.behavior.timezone}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    behavior: { ...current.behavior, timezone: event.target.value },
                  }))
                }
              />
            </label>
          </section>
        </>
      ) : (
        <>
          <div className="settings-pane-heading">
            <h3>Appearance</h3>
          </div>
          <section className="runtime-section appearance-theme-section">
            <h4 className="runtime-section-label">Theme</h4>
            <div className="settings-row appearance-theme-row">
              <div>
                <p className="settings-row-label">Dark</p>
              </div>
              <StateSwitch
                checked={settings.colorScheme === 'dark'}
                onLabel="On"
                offLabel="Off"
                onCheckedChange={(on) => {
                  appearancePreviewed.current = true;
                  const colorScheme = previewColorScheme(on);
                  setSettings((current) => ({
                    ...current,
                    colorScheme,
                    ...fontColorsForScheme(current, colorScheme),
                  }));
                }}
                aria-label="Dark"
              />
            </div>
          </section>
          <section className="runtime-section appearance-type-section">
            <div className="appearance-section-heading">
              <h4 className="runtime-section-label">Type</h4>
            </div>
            <div className="appearance-type-colors">
              {(
                [
                  ['fontBodyColor', 'Body text', 'Body text color'],
                  ['fontMutedColor', 'Secondary', 'Secondary text color'],
                ] as const
              ).map(([key, label, aria]) => {
                const hex = settings[key];
                return (
                  <div className="appearance-color" key={key}>
                    <span className="appearance-type-color-label">{label}</span>
                    <span className="appearance-color-swatch">
                      <span aria-hidden="true" style={{ background: hex }} />
                      <input
                        type="color"
                        className="appearance-color-picker"
                        aria-label={`${aria} picker`}
                        value={isHexColor(hex) ? hex : '#000000'}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      />
                    </span>
                    <Input
                      aria-label={aria}
                      value={hex}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                    />
                  </div>
                );
              })}
            </div>
            <div className="appearance-type-controls">
              <label className="runtime-field appearance-type-family">
                <span className="runtime-field-label">Font</span>
                <AppSelect
                  label="Font"
                  ariaLabel="Font"
                  value={settings.fontFamily}
                  onValueChange={(value) => setSettings((current) => ({ ...current, fontFamily: value }))}
                  options={FONT_FAMILY_OPTIONS}
                />
              </label>
              <div className="runtime-field">
                <span className="runtime-field-label" id="appearance-font-size-label">
                  Size
                </span>
                <div className="appearance-size" role="radiogroup" aria-labelledby="appearance-font-size-label">
                  {FONT_SIZE_IDS.map((size) => (
                    <button
                      key={size}
                      type="button"
                      role="radio"
                      aria-checked={settings.fontSize === size}
                      aria-label={`Font size ${FONT_SIZE_LABELS[size]}`}
                      onClick={() => setSettings((current) => ({ ...current, fontSize: size }))}
                    >
                      {FONT_SIZE_LABELS[size]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="appearance-type-preview" aria-hidden="true">
              <p className="appearance-type-preview-kicker">Preview</p>
              <p className="appearance-type-preview-body">How many players returned this week?</p>
              <p className="appearance-type-preview-muted">Secondary text · timestamps · captions</p>
            </div>
          </section>
          <section className="runtime-section runtime-section-last appearance-palette-section">
            <div className="appearance-section-heading">
              <h4 className="runtime-section-label">Entity colors</h4>
            </div>
            <div className="appearance-grid" role="table" aria-label="Answer entity colors">
              <div className="appearance-grid-head" role="row">
                <span role="columnheader">Entity</span>
                <span role="columnheader">Text</span>
                <span role="columnheader">Highlight</span>
                <span role="columnheader">Sample</span>
              </div>
              {(['catalog', 'schema', 'table', 'column', 'quote', 'tag'] as const).map((kind) => (
                <div className="appearance-grid-row" role="row" key={kind}>
                  <strong role="cell">{kind[0].toUpperCase() + kind.slice(1)}</strong>
                  {(['foreground', 'background'] as const).map((property) => {
                    const hex = settings.entityStyles[kind][property];
                    const update = (value: string) =>
                      setSettings((current) => ({
                        ...current,
                        entityStyles: {
                          ...current.entityStyles,
                          [kind]: { ...current.entityStyles[kind], [property]: value },
                        },
                      }));
                    return (
                      <label className="appearance-color" role="cell" key={property}>
                        <span className="appearance-color-swatch">
                          <span aria-hidden="true" style={{ background: hex }} />
                          <input
                            type="color"
                            className="appearance-color-picker"
                            aria-label={`${kind} ${property} picker`}
                            value={isHexColor(hex) ? hex : '#000000'}
                            onChange={(event) => update(event.target.value)}
                          />
                        </span>
                        <Input
                          aria-label={`${kind} ${property}`}
                          value={hex}
                          onChange={(event) => update(event.target.value)}
                        />
                      </label>
                    );
                  })}
                  <span className="appearance-sample-plaque" role="cell">
                    <span
                      className="appearance-sample"
                      style={{
                        color: settings.entityStyles[kind].foreground,
                        background: settings.entityStyles[kind].background,
                      }}
                    >
                      {ENTITY_SAMPLES[kind]}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {state === 'loading' ? <p className="settings-status">Loading settings.</p> : null}
      {state === 'saving' ? <p className="settings-status">Saving settings.</p> : null}
      {state === 'saved' ? (
        <p className="settings-status" role="status">
          Saved. The next ask uses these settings.
        </p>
      ) : null}
      {failure ? (
        <p className="settings-status settings-error" role="alert">
          {failure.message}
        </p>
      ) : null}
    </form>
  );
}

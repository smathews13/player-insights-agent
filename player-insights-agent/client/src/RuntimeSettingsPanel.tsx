import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from '../../shared/runtime-settings';
import { runtimeSettingsFromResponse } from './runtime-settings-api';
import { showsAdminSurfaces, useRole } from './role';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Switch } from './ui';
import { Lock } from 'lucide-react';
import { AppSelect } from './AppSelect';

/**
 * One answer-content section: its name and the toggle that turns it on, with the
 * section's own controls beneath the name only while it is on.
 *
 * NO per-row description (the handoff cut it): the name carries the meaning and
 * the controls that appear when it is on say the rest. When the section is off
 * its controls are hidden, but the VALUES are not discarded -- they stay in the
 * settings object in state and are written back on Save, so turning a section
 * back on restores what was set rather than resetting it.
 */
function AnswerRow({
  label,
  description,
  checked,
  editable,
  onToggle,
  children,
}: {
  label: string;
  description: string;
  checked: boolean;
  editable: boolean;
  onToggle: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="runtime-answer-row">
      <div className="runtime-answer-head">
        <span>
          <span className="runtime-answer-name">{label}</span>
          <span className="runtime-control-note">{description}</span>
        </span>
        <Switch checked={checked} disabled={!editable} onCheckedChange={onToggle} aria-label={label} />
      </div>
      {checked && children ? <div className="runtime-answer-body">{children}</div> : null}
    </div>
  );
}

export function RuntimeSettingsPanel() {
  const role = useRole();
  const editable = showsAdminSurfaces(role.state);
  const [settings, setSettings] = useState<RuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed'>('loading');
  const [failure, setFailure] = useState<{ operation: 'load' | 'save'; message: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setFailure(null);
    try {
      const response = await fetch('/api/runtime-settings');
      const value = await runtimeSettingsFromResponse(response, 'loaded');
      setSettings(value);
      setState('ready');
    } catch (caught) {
      setState('failed');
      setFailure({ operation: 'load', message: (caught as Error).message });
    }
  }, []);

  useEffect(() => {
    const start = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(start);
  }, [load]);

  const setLoop = (key: keyof RuntimeSettings['loop'], value: number) =>
    setSettings((current) => ({ ...current, loop: { ...current.loop, [key]: value } }));
  const setAnswer = <K extends keyof RuntimeSettings['answer']>(key: K, value: RuntimeSettings['answer'][K]) =>
    setSettings((current) => ({ ...current, answer: { ...current.answer, [key]: value } }));

  const number = (
    label: string,
    description: string,
    example: string,
    value: number,
    min: number,
    max: number,
    update: (value: number) => void
  ) => (
    <label className="runtime-field">
      <span className="runtime-field-label">{label}</span>
      <span className="runtime-control-note">{description}</span>
      <Input
        type="number"
        aria-label={label}
        value={value}
        placeholder={example}
        min={min}
        max={max}
        disabled={!editable}
        onChange={(event) => update(Number(event.target.value))}
      />
    </label>
  );

  const guidance = (
    label: string,
    description: string,
    example: string,
    value: string,
    update: (value: string) => void
  ) => (
    <label className="runtime-field runtime-field-wide">
      <span className="runtime-field-label">{label}</span>
      <span className="runtime-control-note">{description}</span>
      <textarea
        className="runtime-guidance"
        aria-label={label}
        rows={2}
        value={value}
        placeholder={example}
        disabled={!editable}
        onChange={(event) => update(event.target.value)}
      />
    </label>
  );

  const save = async () => {
    setState('saving');
    setFailure(null);
    try {
      const response = await fetch('/api/admin/runtime-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const saved = await runtimeSettingsFromResponse(response, 'saved');
      setSettings(saved);
      setState('saved');
    } catch (caught) {
      setState('failed');
      setFailure({ operation: 'save', message: (caught as Error).message });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime settings</CardTitle>
        <CardDescription>
          Live behavior for the next ask. Model, warehouse, Genie and data access stay fixed; change those on
          Connections.
        </CardDescription>
      </CardHeader>
      <CardContent className="runtime-settings">
        <section className="runtime-section">
          <h3 className="runtime-section-label">Loop structure</h3>
          <div className="runtime-loop-row">
            {number(
              'Max DSF steps',
              'Limits how many reasoning passes one ask may take.',
              'Example: 8',
              settings.loop.maxSteps,
              1,
              20,
              (v) => setLoop('maxSteps', v)
            )}
            {number(
              'Max tool calls',
              'Limits how many data and metadata calls one ask may make.',
              'Example: 12',
              settings.loop.maxToolCalls,
              1,
              40,
              (v) => setLoop('maxToolCalls', v)
            )}
            {number(
              'Run budget (s)',
              'Stops new work after this many seconds.',
              'Example: 90',
              settings.loop.maxRunSeconds,
              30,
              180,
              (v) => setLoop('maxRunSeconds', v)
            )}
          </div>
          <p className="runtime-footnote">Bounds the Data Source Finder loop. The agent boundary does not change.</p>
        </section>

        <section className="runtime-section">
          <div className="runtime-answer-header">
            <h3 className="runtime-section-label">Answer content</h3>
            <span className="runtime-answer-header-note">Guidance goes to the agent with every ask.</span>
          </div>

          <AnswerRow
            label="Takeaway"
            description="Shows or hides the decision-ready lead sentence."
            checked={settings.answer.takeaway}
            editable={editable}
            onToggle={(v) => setAnswer('takeaway', v)}
          >
            {guidance(
              'Guidance',
              'Changes how the agent writes the takeaway.',
              'Example: Lead with the recommended decision.',
              settings.answer.takeawayGuidance,
              (v) => setAnswer('takeawayGuidance', v)
            )}
          </AnswerRow>

          <AnswerRow
            label="Narrative"
            description="Shows or hides the explanatory story behind the result."
            checked={settings.answer.narrative}
            editable={editable}
            onToggle={(v) => setAnswer('narrative', v)}
          >
            {guidance(
              'Guidance',
              'Changes how the agent explains its evidence.',
              'Example: Name the source beside each finding.',
              settings.answer.narrativeGuidance,
              (v) => setAnswer('narrativeGuidance', v)
            )}
            {number(
              'Character cap (0 = uncapped)',
              'Trims only the narrative after this many characters.',
              'Example: 1200',
              settings.answer.narrativeMaxCharacters,
              0,
              12_000,
              (v) => setAnswer('narrativeMaxCharacters', v)
            )}
          </AnswerRow>

          <AnswerRow
            label="Figures"
            description="Shows or hides the numeric result breakdown."
            checked={settings.answer.figures}
            editable={editable}
            onToggle={(v) => setAnswer('figures', v)}
          >
            {number(
              'Max figures',
              'Caps the numeric highlights returned with an answer.',
              'Example: 6',
              settings.answer.maxFigures,
              0,
              12,
              (v) => setAnswer('maxFigures', v)
            )}
            <label className="runtime-field">
              <span className="runtime-field-label">Order</span>
              <span className="runtime-control-note">Changes which numeric highlights appear first.</span>
              <AppSelect
                label="Order"
                ariaLabel="Order"
                value={settings.answer.figuresOrder}
                disabled={!editable}
                onValueChange={(value) => setAnswer('figuresOrder', value)}
                options={[
                  { value: 'as-ranked', label: 'As the agent ranks them' },
                  { value: 'totals-first', label: 'Totals first' },
                  { value: 'averages-first', label: 'Averages first' },
                ]}
                className="runtime-select"
              />
            </label>
          </AnswerRow>

          <AnswerRow
            label="Charts"
            description="Shows or hides visualizations built from returned data."
            checked={settings.answer.charts}
            editable={editable}
            onToggle={(v) => setAnswer('charts', v)}
          >
            {number(
              'Max charts',
              'Caps the charts built for one answer.',
              'Example: 2',
              settings.answer.maxCharts,
              0,
              6,
              (v) => setAnswer('maxCharts', v)
            )}
            <label className="runtime-field">
              <span className="runtime-field-label">Types</span>
              <span className="runtime-control-note">Limits which chart shapes the agent may choose.</span>
              <AppSelect
                label="Types"
                ariaLabel="Types"
                value={settings.answer.chartsTypes}
                disabled={!editable}
                onValueChange={(value) => setAnswer('chartsTypes', value)}
                options={[
                  { value: 'auto', label: 'Auto from the data shape' },
                  { value: 'bar', label: 'Bar only' },
                  { value: 'bar-line', label: 'Bar and line' },
                ]}
                className="runtime-select"
              />
            </label>
          </AnswerRow>

          <AnswerRow
            label="Analyst caveats"
            description="Shows or hides concise limitations that affect interpretation."
            checked={settings.answer.caveats}
            editable={editable}
            onToggle={(v) => setAnswer('caveats', v)}
          >
            {number(
              'Max caveats (0 = all)',
              'Caps displayed limitations without weakening safeguards.',
              'Example: 3',
              settings.answer.maxCaveats,
              0,
              20,
              (v) => setAnswer('maxCaveats', v)
            )}
            <p className="runtime-footnote">Governance and outage warnings always remain.</p>
          </AnswerRow>
        </section>

        <section className="runtime-section">
          <h3 className="runtime-section-label">Timezone (IANA name)</h3>
          <Input
            className="runtime-timezone"
            aria-label="Timezone (IANA name)"
            value={settings.behavior.timezone}
            placeholder="Example: America/Los_Angeles"
            disabled={!editable}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                behavior: { ...current.behavior, timezone: event.target.value },
              }))
            }
          />
          <p className="runtime-control-note">Changes how relative dates such as “yesterday” are resolved.</p>
        </section>

        <section className="runtime-section runtime-section-last runtime-entity-section">
          <h3 className="runtime-section-label">Answer entity styling</h3>
          <p className="runtime-footnote">These colors become shared CSS variables used by Ask and Run Explorer.</p>
          {(['catalog', 'schema', 'table', 'column', 'quote', 'tag'] as const).map((kind) => (
            <div className="runtime-entity-row" key={kind}>
              <div>
                <span className="runtime-answer-name">{kind[0].toUpperCase() + kind.slice(1)}</span>
                <span className="runtime-control-note">
                  Changes this entity’s text and highlight colors in answers.
                </span>
              </div>
              {(['foreground', 'background'] as const).map((property) => (
                <label className="runtime-field" key={property}>
                  <span className="runtime-field-label">{property === 'foreground' ? 'Text' : 'Highlight'}</span>
                  <span className="runtime-control-note">Six-digit hex color.</span>
                  <Input
                    aria-label={`${kind} ${property}`}
                    value={settings.entityStyles[kind][property]}
                    placeholder={property === 'foreground' ? 'Example: #ffffff' : 'Example: #0e538b'}
                    disabled={!editable}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        entityStyles: {
                          ...current.entityStyles,
                          [kind]: { ...current.entityStyles[kind], [property]: event.target.value },
                        },
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          ))}
        </section>

        <div className="runtime-foot">
          <p className="runtime-foot-safeguards">
            <Lock aria-hidden="true" className="runtime-foot-lock" />
            Dictionary-first field binding and never-invent-figures are mandatory safeguards, not switches.
          </p>
          {editable ? (
            <Button
              className="runtime-save"
              onClick={() => void (failure?.operation === 'load' ? load() : save())}
              disabled={state === 'loading' || state === 'saving'}
            >
              {state === 'saving'
                ? 'Saving…'
                : state === 'loading'
                  ? 'Loading…'
                  : failure?.operation === 'load'
                    ? 'Retry runtime settings'
                    : 'Save runtime settings'}
            </Button>
          ) : null}
        </div>

        {!editable ? <p className="settings-row-note">Read-only. An administrator can change these values.</p> : null}
        {state === 'saved' ? <p role="status">Saved. The next ask uses these settings.</p> : null}
        {failure ? <p role="alert">{failure.message}</p> : null}
      </CardContent>
    </Card>
  );
}

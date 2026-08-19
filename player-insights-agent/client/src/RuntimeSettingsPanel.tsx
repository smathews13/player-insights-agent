import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from '../../shared/runtime-settings';
import { showsAdminSurfaces, useRole } from './role';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Switch } from './ui';
import { Lock } from 'lucide-react';

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
  checked,
  editable,
  onToggle,
  children,
}: {
  label: string;
  checked: boolean;
  editable: boolean;
  onToggle: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="runtime-answer-row">
      <div className="runtime-answer-head">
        <span className="runtime-answer-name">{label}</span>
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

  useEffect(() => {
    void fetch('/api/runtime-settings')
      .then(async (response) => {
        if (!response.ok) throw new Error('Runtime settings could not be loaded.');
        return response.json() as Promise<{ settings: RuntimeSettings }>;
      })
      .then(({ settings: value }) => {
        setSettings(value);
        setState('ready');
      })
      .catch(() => setState('failed'));
  }, []);

  const setLoop = (key: keyof RuntimeSettings['loop'], value: number) =>
    setSettings((current) => ({ ...current, loop: { ...current.loop, [key]: value } }));
  const setAnswer = <K extends keyof RuntimeSettings['answer']>(key: K, value: RuntimeSettings['answer'][K]) =>
    setSettings((current) => ({ ...current, answer: { ...current.answer, [key]: value } }));

  const number = (label: string, value: number, min: number, max: number, update: (value: number) => void) => (
    <label className="runtime-field">
      <span className="runtime-field-label">{label}</span>
      <Input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        disabled={!editable}
        onChange={(event) => update(Number(event.target.value))}
      />
    </label>
  );

  const guidance = (label: string, value: string, update: (value: string) => void) => (
    <label className="runtime-field runtime-field-wide">
      <span className="runtime-field-label">{label}</span>
      {/* Ships empty, no placeholder prose: an example in the box reads as a
          value already set, and this text goes to the agent verbatim. */}
      <textarea
        className="runtime-guidance"
        aria-label={label}
        rows={2}
        value={value}
        disabled={!editable}
        onChange={(event) => update(event.target.value)}
      />
    </label>
  );

  const save = async () => {
    setState('saving');
    const response = await fetch('/api/admin/runtime-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    });
    setState(response.ok ? 'saved' : 'failed');
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
            {number('Max DSF steps', settings.loop.maxSteps, 1, 20, (v) => setLoop('maxSteps', v))}
            {number('Max tool calls', settings.loop.maxToolCalls, 1, 40, (v) => setLoop('maxToolCalls', v))}
            {number('Run budget (s)', settings.loop.maxRunSeconds, 30, 180, (v) => setLoop('maxRunSeconds', v))}
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
            checked={settings.answer.takeaway}
            editable={editable}
            onToggle={(v) => setAnswer('takeaway', v)}
          >
            {guidance('Guidance', settings.answer.takeawayGuidance, (v) => setAnswer('takeawayGuidance', v))}
          </AnswerRow>

          <AnswerRow
            label="Narrative"
            checked={settings.answer.narrative}
            editable={editable}
            onToggle={(v) => setAnswer('narrative', v)}
          >
            {guidance('Guidance', settings.answer.narrativeGuidance, (v) => setAnswer('narrativeGuidance', v))}
            {number('Character cap (0 = uncapped)', settings.answer.narrativeMaxCharacters, 0, 12_000, (v) =>
              setAnswer('narrativeMaxCharacters', v)
            )}
          </AnswerRow>

          <AnswerRow
            label="Figures"
            checked={settings.answer.figures}
            editable={editable}
            onToggle={(v) => setAnswer('figures', v)}
          >
            {number('Max figures', settings.answer.maxFigures, 0, 12, (v) => setAnswer('maxFigures', v))}
            <label className="runtime-field">
              <span className="runtime-field-label">Order</span>
              <select
                className="runtime-select"
                aria-label="Order"
                value={settings.answer.figuresOrder}
                disabled={!editable}
                onChange={(event) =>
                  setAnswer('figuresOrder', event.target.value as RuntimeSettings['answer']['figuresOrder'])
                }
              >
                <option value="as-ranked">As the agent ranks them</option>
                <option value="totals-first">Totals first</option>
                <option value="averages-first">Averages first</option>
              </select>
            </label>
          </AnswerRow>

          <AnswerRow
            label="Charts"
            checked={settings.answer.charts}
            editable={editable}
            onToggle={(v) => setAnswer('charts', v)}
          >
            {number('Max charts', settings.answer.maxCharts, 0, 6, (v) => setAnswer('maxCharts', v))}
            <label className="runtime-field">
              <span className="runtime-field-label">Types</span>
              <select
                className="runtime-select"
                aria-label="Types"
                value={settings.answer.chartsTypes}
                disabled={!editable}
                onChange={(event) =>
                  setAnswer('chartsTypes', event.target.value as RuntimeSettings['answer']['chartsTypes'])
                }
              >
                <option value="auto">Auto from the data shape</option>
                <option value="bar">Bar only</option>
                <option value="bar-line">Bar and line</option>
              </select>
            </label>
          </AnswerRow>

          <AnswerRow
            label="Analyst caveats"
            checked={settings.answer.caveats}
            editable={editable}
            onToggle={(v) => setAnswer('caveats', v)}
          >
            {number('Max caveats (0 = all)', settings.answer.maxCaveats, 0, 20, (v) => setAnswer('maxCaveats', v))}
            <p className="runtime-footnote">Governance and outage warnings always remain.</p>
          </AnswerRow>
        </section>

        <section className="runtime-section runtime-section-last">
          <h3 className="runtime-section-label">Timezone (IANA name)</h3>
          <Input
            className="runtime-timezone"
            aria-label="Timezone (IANA name)"
            value={settings.behavior.timezone}
            disabled={!editable}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                behavior: { ...current.behavior, timezone: event.target.value },
              }))
            }
          />
        </section>

        <div className="runtime-foot">
          <p className="runtime-foot-safeguards">
            <Lock aria-hidden="true" className="runtime-foot-lock" />
            Dictionary-first field binding and never-invent-figures are mandatory safeguards, not switches.
          </p>
          {editable ? (
            <Button
              className="runtime-save"
              onClick={() => void save()}
              disabled={state === 'loading' || state === 'saving'}
            >
              {state === 'saving' ? 'Saving…' : 'Save runtime settings'}
            </Button>
          ) : null}
        </div>

        {!editable ? <p className="settings-row-note">Read-only. An administrator can change these values.</p> : null}
        {state === 'saved' ? <p role="status">Saved. The next ask uses these settings.</p> : null}
        {state === 'failed' ? <p role="alert">Runtime settings could not be loaded or saved.</p> : null}
      </CardContent>
    </Card>
  );
}

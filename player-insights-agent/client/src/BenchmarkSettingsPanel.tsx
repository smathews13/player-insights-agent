import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_BENCHMARK_SETTINGS,
  EVAL_SET_OPTIONS,
  type BenchmarkSettings,
  type EvalSetId,
} from '../../shared/benchmark-settings';
import { AppSelect } from './AppSelect';
import { benchmarkSettingsFromResponse } from './benchmark-settings-api';
import { SETTINGS_SAVE_IDLE, type SettingsSaveState } from './settings-save-state';
import { Input, Switch } from './ui';
import type { Run, RunTrace } from './app-types';

export const BENCHMARK_SETTINGS_FORM_ID = 'settings-benchmark-form';

export function BenchmarkSettingsPanel({
  enabled,
  onSaveState = () => {},
}: {
  enabled: boolean;
  onSaveState?: (state: SettingsSaveState) => void;
}) {
  const [settings, setSettings] = useState<BenchmarkSettings>(DEFAULT_BENCHMARK_SETTINGS);
  const [experimentUrl, setExperimentUrl] = useState<string | null>(null);
  const [currentAgentEndpoint, setCurrentAgentEndpoint] = useState('');
  const [tracesAlwaysOnInAgent, setTracesAlwaysOnInAgent] = useState(true);
  const [lastTrace, setLastTrace] = useState<{ traceId: string; url: string | null } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed'>('loading');
  const [failure, setFailure] = useState<{ operation: 'load' | 'save'; message: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setFailure(null);
    try {
      const response = await fetch('/api/benchmark-settings');
      const loaded = await benchmarkSettingsFromResponse(response, 'loaded');
      setSettings(loaded.settings);
      setExperimentUrl(loaded.experimentUrl);
      setCurrentAgentEndpoint(loaded.currentAgentEndpoint);
      setTracesAlwaysOnInAgent(loaded.tracesAlwaysOnInAgent);
      setState('ready');
    } catch (caught) {
      setState('failed');
      setFailure({ operation: 'load', message: (caught as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    fetch('/api/runs')
      .then(async (response) => {
        if (!response.ok) return [];
        return (await response.json()) as Run[];
      })
      .then(async (runs) => {
        const latest = runs.find((run) => run.kind === 'conversation') ?? runs[0];
        if (!latest) return;
        const traced = await fetch(`/api/runs/${encodeURIComponent(latest.id)}/trace`);
        if (!traced.ok) return;
        const payload = (await traced.json()) as RunTrace;
        if (!active || !payload.mlflow?.traceId) return;
        setLastTrace({ traceId: payload.mlflow.traceId, url: payload.mlflow.url });
      })
      .catch(() => {
        if (active) setLastTrace(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    if (!enabled) return;
    if (failure?.operation === 'load') {
      onSaveState({ kind: 'saving' });
      await load();
      onSaveState(
        failure.operation === 'load' && state === 'failed'
          ? { kind: 'failed', message: 'These settings could not be read, so there is nothing to save yet.' }
          : SETTINGS_SAVE_IDLE
      );
      return;
    }
    setState('saving');
    setFailure(null);
    onSaveState({ kind: 'saving' });
    try {
      const response = await fetch('/api/admin/benchmark-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const saved = await benchmarkSettingsFromResponse(response, 'saved');
      setSettings(saved.settings);
      setExperimentUrl(saved.experimentUrl);
      setCurrentAgentEndpoint(saved.currentAgentEndpoint);
      setTracesAlwaysOnInAgent(saved.tracesAlwaysOnInAgent);
      setState('saved');
      onSaveState({ kind: 'saved' });
    } catch (caught) {
      setState('failed');
      setFailure({ operation: 'save', message: (caught as Error).message });
      onSaveState({ kind: 'failed', message: (caught as Error).message });
    }
  };

  return (
    <form
      id={BENCHMARK_SETTINGS_FORM_ID}
      className="benchmark-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="benchmark-settings-cluster" disabled={!enabled}>
        <legend className="runtime-section-label">MLflow and benchmarking</legend>
        <p className="settings-row-note">
          {enabled
            ? 'These defaults are what the Benchmarking tab runs. Save them here; do not edit them twice.'
            : 'Turn Benchmarking on above to edit these. The values stay, but nothing here can be changed while the tab is hidden.'}
        </p>

        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">MLflow experiment</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="MLflow experiment"
            placeholder="The experiment id already configured for this app"
            value={settings.experimentId}
            onChange={(event) => setSettings((current) => ({ ...current, experimentId: event.target.value }))}
          />
          <span className="runtime-control-note">
            Traces go to the experiment already configured for this deployment. Type a different id only
            when more than one exists and you mean to switch. The list cannot be browsed as you — Apps has
            no MLflow scope.
          </span>
          {experimentUrl ? (
            <a className="benchmark-settings-link" href={experimentUrl} target="_blank" rel="noreferrer">
              Open this experiment
            </a>
          ) : null}
        </label>

        <div className="settings-row">
          <div>
            <p className="settings-row-label">Always-on traces · {settings.alwaysOnTraces ? 'On' : 'Off'}</p>
            <p className="settings-row-note">
              {tracesAlwaysOnInAgent
                ? 'Every Ask already writes a trace. Leave this on to keep the experiment and last-trace link in view. Turning it off does not stop the served agent from tracing.'
                : 'When on, every Ask writes a trace to the experiment above.'}
            </p>
          </div>
          <Switch
            checked={settings.alwaysOnTraces}
            disabled={!enabled}
            onCheckedChange={(checked) => setSettings((current) => ({ ...current, alwaysOnTraces: checked }))}
            aria-label="Always-on traces"
          />
        </div>

        {settings.alwaysOnTraces && lastTrace ? (
          <p className="settings-row-note">
            Last trace <code>{lastTrace.traceId}</code>
            {lastTrace.url ? (
              <>
                {' · '}
                <a className="benchmark-settings-link" href={lastTrace.url} target="_blank" rel="noreferrer">
                  Open the MLflow trace
                </a>
              </>
            ) : (
              ' · Save an experiment id to link straight to it.'
            )}
          </p>
        ) : null}

        <AppSelect
          label="Eval set"
          ariaLabel="Eval set"
          value={settings.evalSetId}
          options={EVAL_SET_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
          disabled={!enabled}
          onValueChange={(value) => setSettings((current) => ({ ...current, evalSetId: value as EvalSetId }))}
        />
        <p className="runtime-control-note">
          {EVAL_SET_OPTIONS.find((option) => option.id === settings.evalSetId)?.note}
        </p>

        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Judge model</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="Judge model"
            placeholder="Serving endpoint name, same as Connections"
            value={settings.judgeEndpoint}
            onChange={(event) => setSettings((current) => ({ ...current, judgeEndpoint: event.target.value }))}
          />
          <span className="runtime-control-note">
            The endpoint Connections already uses to score a suite. Changing it here updates that same setting.
          </span>
        </label>

        <div className="benchmark-settings-compare">
          <p className="runtime-section-label">Compare two versions</p>
          <label className="runtime-field">
            <span className="runtime-field-label">Side A</span>
            <Input
              type="text"
              autoComplete="off"
              aria-label="Compare side A"
              value={settings.compareSideA}
              onChange={(event) => setSettings((current) => ({ ...current, compareSideA: event.target.value }))}
            />
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Side B</span>
            <Input
              type="text"
              autoComplete="off"
              aria-label="Compare side B"
              placeholder="Optional second serving endpoint"
              value={settings.compareSideB}
              onChange={(event) => setSettings((current) => ({ ...current, compareSideB: event.target.value }))}
            />
          </label>
          <span className="runtime-control-note">
            Use <code>current</code> for this deployment&apos;s agent
            {currentAgentEndpoint ? ` (${currentAgentEndpoint})` : ''}. A second name starts a second suite
            run against that endpoint. Leave side B blank for one run.
          </span>
        </div>
      </fieldset>
    </form>
  );
}

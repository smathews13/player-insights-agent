import { useCallback, useEffect, useState } from 'react';
import {
  AGENT_JUDGE_IDS,
  MULTI_TURN_JUDGES,
  type AgentJudgeId,
  type CustomJudge,
  type MultiTurnJudgeId,
} from '../../shared/eval-dataset';
import { DEFAULT_BENCHMARK_SETTINGS, type BenchmarkSettings } from '../../shared/benchmark-settings';
import { benchmarkSettingsFromResponse } from './benchmark-settings-api';
import { SETTINGS_SAVE_IDLE, type SettingsSaveState } from './settings-save-state';
import { Input, Switch, Textarea } from './ui';
import type { Run, RunTrace } from './app-types';

export const BENCHMARK_SETTINGS_FORM_ID = 'settings-benchmark-form';

function toggleJudge(current: AgentJudgeId[], judge: AgentJudgeId, enabled: boolean): AgentJudgeId[] {
  const next = enabled ? [...new Set([...current, judge])] : current.filter((id) => id !== judge);
  return next.length > 0 ? next : current;
}

function toggleMultiTurn(current: MultiTurnJudgeId[], judge: MultiTurnJudgeId, enabled: boolean): MultiTurnJudgeId[] {
  return enabled ? [...new Set([...current, judge])] : current.filter((id) => id !== judge);
}

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
  const [customDraft, setCustomDraft] = useState<CustomJudge>({ name: '', guidelines: '' });

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
        <legend className="runtime-section-label">Evaluation path</legend>
        <p className="settings-row-note">
          {enabled
            ? 'On the Benchmarking tab: build a dataset, score a Genie space, then run agent judges into this experiment. Save the defaults here; do not edit them twice.'
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

        <p className="runtime-control-note">
          The evaluation dataset lives on the Benchmarking tab. Each row is a question, optional
          ground-truth SQL for Genie accuracy, and an optional expected answer for agent judges.
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
            The model that scores Phase B (built-in, multi-turn, and custom judges). Changing it here
            updates the same setting Connections already uses.
          </span>
        </label>

        {AGENT_JUDGE_IDS.map((judge) => (
          <div className="settings-row" key={judge}>
            <div>
              <p className="settings-row-label">
                {judge === 'groundedness' ? 'Groundedness' : judge === 'relevance' ? 'Relevance' : 'Guidelines'}
                {' · '}
                {settings.enabledJudges.includes(judge) ? 'On' : 'Off'}
              </p>
              <p className="settings-row-note">
                {judge === 'groundedness'
                  ? 'Built-in MLflow judge: is the answer supported by what was retrieved?'
                  : judge === 'relevance'
                    ? 'Built-in MLflow judge: does the answer address the question?'
                    : 'Built-in MLflow Guidelines judge. Uses the text below, or a row’s expected answer.'}
              </p>
            </div>
            <Switch
              checked={settings.enabledJudges.includes(judge)}
              disabled={!enabled}
              onCheckedChange={(checked) =>
                setSettings((current) => ({
                  ...current,
                  enabledJudges: toggleJudge(current.enabledJudges, judge, checked),
                }))
              }
              aria-label={judge === 'groundedness' ? 'Groundedness judge' : judge === 'relevance' ? 'Relevance judge' : 'Guidelines judge'}
            />
          </div>
        ))}

        <p className="runtime-section-label">Multi-turn judges</p>
        <p className="settings-row-note">
          Conversational judges from MLflow. Pick the ones you want. Each is{' '}
          <code>Guidelines(name=…, guidelines=…)</code> over the question and answer as a conversation.
        </p>
        {MULTI_TURN_JUDGES.map((judge) => (
          <div className="settings-row" key={judge.id}>
            <div>
              <p className="settings-row-label">
                {judge.label}
                {' · '}
                {settings.enabledMultiTurnJudges.includes(judge.id) ? 'On' : 'Off'}
              </p>
              <p className="settings-row-note">{judge.note}</p>
            </div>
            <Switch
              checked={settings.enabledMultiTurnJudges.includes(judge.id)}
              disabled={!enabled}
              onCheckedChange={(checked) =>
                setSettings((current) => ({
                  ...current,
                  enabledMultiTurnJudges: toggleMultiTurn(current.enabledMultiTurnJudges, judge.id, checked),
                }))
              }
              aria-label={judge.label}
            />
          </div>
        ))}

        <p className="runtime-section-label">Custom judges</p>
        <p className="settings-row-note">
          Your own <code>Guidelines(name=…, guidelines=…)</code> judges. Saved here, used on the next Phase B run.
        </p>
        {settings.customJudges.map((judge, index) => (
          <div className="eval-custom-judge" key={`${judge.name}-${index}`}>
            <p className="settings-row-label">{judge.name}</p>
            <p className="settings-row-note">{judge.guidelines}</p>
            <button
              type="button"
              className="tile-link"
              disabled={!enabled}
              onClick={() =>
                setSettings((current) => ({
                  ...current,
                  customJudges: current.customJudges.filter((_, entryIndex) => entryIndex !== index),
                }))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Custom judge name</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="Custom judge name"
            placeholder="e.g. english"
            value={customDraft.name}
            disabled={!enabled}
            onChange={(event) => setCustomDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Custom judge guidelines</span>
          <Textarea
            aria-label="Custom judge guidelines"
            rows={2}
            placeholder="e.g. The response must be in English."
            value={customDraft.guidelines}
            disabled={!enabled}
            onChange={(event) => setCustomDraft((current) => ({ ...current, guidelines: event.target.value }))}
          />
        </label>
        <button
          type="button"
          className="tile-link"
          disabled={!enabled}
          onClick={() => {
            const next = { name: customDraft.name.trim(), guidelines: customDraft.guidelines.trim() };
            if (!next.name || !next.guidelines) return;
            setSettings((current) => ({ ...current, customJudges: [...current.customJudges, next].slice(0, 12) }));
            setCustomDraft({ name: '', guidelines: '' });
          }}
        >
          Add this custom judge
        </button>

        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Guidelines</span>
          <Textarea
            aria-label="Guidelines"
            rows={3}
            value={settings.guidelinesText}
            onChange={(event) => setSettings((current) => ({ ...current, guidelinesText: event.target.value }))}
          />
          <span className="runtime-control-note">
            Passed to <code>Guidelines(name=…, guidelines=…, model=databricks:/…)</code> on the agent
            evaluate path. A row with its own expected answer uses that instead.
          </span>
        </label>

        <div className="benchmark-settings-compare">
          <p className="runtime-section-label">Baseline vs candidate</p>
          <label className="runtime-field">
            <span className="runtime-field-label">Baseline</span>
            <Input
              type="text"
              autoComplete="off"
              aria-label="Compare side A"
              value={settings.compareSideA}
              onChange={(event) => setSettings((current) => ({ ...current, compareSideA: event.target.value }))}
            />
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Candidate</span>
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
            Phase B runs both on the same questions and shows the scores side by side. Promote the
            winner on the Benchmarking tab so the next Ask uses it. Use <code>current</code> for this
            deployment&apos;s agent
            {currentAgentEndpoint ? ` (${currentAgentEndpoint})` : ''}. Leave candidate blank until you
            have a second endpoint.
          </span>
        </div>
      </fieldset>
    </form>
  );
}

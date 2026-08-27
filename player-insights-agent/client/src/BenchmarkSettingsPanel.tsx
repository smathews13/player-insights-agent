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
import { saveRetryAfterLoad, type SettingsLoadResult, type SettingsSaveState } from './settings-save-state';
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
  const [lastTrace, setLastTrace] = useState<{ traceId: string; url: string | null } | null>(null);
  const [failure, setFailure] = useState<{ operation: 'load' | 'save'; message: string } | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomJudge>({ name: '', guidelines: '', prompt: '' });

  const load = useCallback(async (): Promise<SettingsLoadResult> => {
    setFailure(null);
    try {
      const response = await fetch('/api/benchmark-settings');
      const loaded = await benchmarkSettingsFromResponse(response, 'loaded');
      setSettings(loaded.settings);
      setExperimentUrl(loaded.experimentUrl);
      return { ok: true };
    } catch (caught) {
      const message = (caught as Error).message;
      setFailure({ operation: 'load', message });
      return { ok: false, message };
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
      const result = await load();
      onSaveState(saveRetryAfterLoad(result));
      return;
    }
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
      onSaveState({ kind: 'saved' });
    } catch (caught) {
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
        {!enabled ? (
          <p className="settings-row-note">Turn Benchmarking on above to edit these.</p>
        ) : null}

        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">MLflow experiment</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="MLflow experiment"
            value={settings.experimentId}
            onChange={(event) => setSettings((current) => ({ ...current, experimentId: event.target.value }))}
          />
          {experimentUrl ? (
            <a className="benchmark-settings-link" href={experimentUrl} target="_blank" rel="noreferrer">
              Open this experiment
            </a>
          ) : null}
        </label>

        <div className="settings-row">
          <div>
            <p className="settings-row-label">Always-on traces · {settings.alwaysOnTraces ? 'On' : 'Off'}</p>
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
            ) : null}
          </p>
        ) : null}

        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Judge model</span>
          <Input
            type="text"
            autoComplete="off"
            aria-label="Judge model"
            value={settings.judgeEndpoint}
            onChange={(event) => setSettings((current) => ({ ...current, judgeEndpoint: event.target.value }))}
          />
        </label>

        {AGENT_JUDGE_IDS.map((judge) => (
          <div className="settings-row" key={judge}>
            <div>
              <p className="settings-row-label">
                {judge === 'groundedness' ? 'Groundedness' : judge === 'relevance' ? 'Relevance' : 'Guidelines'}
                {' · '}
                {settings.enabledJudges.includes(judge) ? 'On' : 'Off'}
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
        {MULTI_TURN_JUDGES.map((judge) => (
          <div className="settings-row" key={judge.id}>
            <div>
              <p className="settings-row-label">
                {judge.label}
                {' · '}
                {settings.enabledMultiTurnJudges.includes(judge.id) ? 'On' : 'Off'}
              </p>
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
        {settings.customJudges.map((judge, index) => (
          <div className="eval-custom-judge" key={`${judge.name}-${index}`}>
            <p className="settings-row-label">{judge.name}</p>
            {judge.guidelines ? <p className="settings-row-note">{judge.guidelines}</p> : null}
            {judge.prompt ? <p className="settings-row-note">Prompt: {judge.prompt}</p> : null}
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
        <label className="runtime-field runtime-field-wide">
          <span className="runtime-field-label">Custom judge prompt</span>
          <Textarea
            aria-label="Custom judge prompt"
            rows={3}
            placeholder="Optional. What to score and how. Use {{question}}, {{response}}, {{conversation}}."
            value={customDraft.prompt}
            disabled={!enabled}
            onChange={(event) => setCustomDraft((current) => ({ ...current, prompt: event.target.value }))}
          />
        </label>
        <button
          type="button"
          className="tile-link"
          disabled={!enabled}
          onClick={() => {
            const next = {
              name: customDraft.name.trim(),
              guidelines: customDraft.guidelines.trim(),
              prompt: customDraft.prompt.trim(),
            };
            if (!next.name || (!next.guidelines && !next.prompt)) return;
            setSettings((current) => ({ ...current, customJudges: [...current.customJudges, next].slice(0, 12) }));
            setCustomDraft({ name: '', guidelines: '', prompt: '' });
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
        </div>
      </fieldset>
    </form>
  );
}

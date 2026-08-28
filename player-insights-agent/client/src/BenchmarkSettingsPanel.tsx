import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AGENT_JUDGE_IDS,
  MULTI_TURN_JUDGES,
  type AgentJudgeId,
  type CustomJudge,
  type MultiTurnJudgeId,
} from '../../shared/eval-dataset';
import { DEFAULT_BENCHMARK_SETTINGS, type BenchmarkSettings } from '../../shared/benchmark-settings';
import { ExperimentalStatus } from './ExperimentalBadge';
import { benchmarkSettingsFromResponse } from './benchmark-settings-api';
import {
  changedSettingKeys,
  saveRetryAfterLoad,
  type SettingsLoadResult,
  type SettingsSaveState,
} from './settings-save-state';
import { Button, Input, Switch, Textarea } from './ui';
import type { Run, RunTrace } from './app-types';

export const BENCHMARK_SETTINGS_FORM_ID = 'settings-benchmark-form';

const AGENT_JUDGE_COPY: Record<AgentJudgeId, { label: string; help: string; aria: string }> = {
  groundedness: {
    label: 'Groundedness',
    help: 'Stays in the tables it retrieved.',
    aria: 'Groundedness judge',
  },
  relevance: {
    label: 'Relevance',
    help: 'Answers the question that was asked.',
    aria: 'Relevance judge',
  },
  guidelines: {
    label: 'Guidelines',
    help: 'Applies the deployment’s saved Guidelines rubric.',
    aria: 'Guidelines judge',
  },
};

function toggleJudge(current: AgentJudgeId[], judge: AgentJudgeId, enabled: boolean): AgentJudgeId[] {
  const next = enabled ? [...new Set([...current, judge])] : current.filter((id) => id !== judge);
  return next.length > 0 ? next : current;
}

function toggleMultiTurn(current: MultiTurnJudgeId[], judge: MultiTurnJudgeId, enabled: boolean): MultiTurnJudgeId[] {
  return enabled ? [...new Set([...current, judge])] : current.filter((id) => id !== judge);
}

function SettingField({
  label,
  help,
  helpId,
  children,
}: {
  label: string;
  help: string;
  helpId: string;
  children: ReactNode;
}) {
  return (
    <label className="runtime-field runtime-field-wide">
      <span className="runtime-field-label">{label}</span>
      <span id={helpId} className="runtime-control-note">
        {help}
      </span>
      {children}
    </label>
  );
}

function JudgeToggleRow({
  name,
  help,
  on,
  disabled,
  ariaLabel,
  onCheckedChange,
}: {
  name: string;
  help: string;
  on: boolean;
  disabled: boolean;
  ariaLabel: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <tr>
      <td>
        <span className="exp-feature-title">{name}</span>
        <p className="runtime-control-note">{help}</p>
      </td>
      <td>
        <ExperimentalStatus on={on} onLabel="On" offLabel="Off" />
      </td>
      <td className="exp-feature-control">
        <Switch checked={on} disabled={disabled} onCheckedChange={onCheckedChange} aria-label={ariaLabel} />
      </td>
    </tr>
  );
}

export function BenchmarkSettingsPanel({
  enabled,
  onSaveState = () => {},
  onDirtyChange = () => {},
  additionalChangeCount = 0,
  onCommitStaged = async () => {},
}: {
  enabled: boolean;
  onSaveState?: (state: SettingsSaveState) => void;
  onDirtyChange?: (count: number) => void;
  additionalChangeCount?: number;
  onCommitStaged?: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<BenchmarkSettings>(DEFAULT_BENCHMARK_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<BenchmarkSettings | null>(null);
  const [experimentUrl, setExperimentUrl] = useState<string | null>(null);
  const [lastTrace, setLastTrace] = useState<{ traceId: string; url: string | null } | null>(null);
  const [failure, setFailure] = useState<{ operation: 'load' | 'save'; message: string } | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomJudge>({ name: '', guidelines: '', prompt: '' });

  const load = useCallback(async (): Promise<SettingsLoadResult> => {
    setFailure(null);
    try {
      const response = await fetch('/api/benchmark-settings');
      const loaded = await benchmarkSettingsFromResponse(response, 'loaded');
      setSavedSettings(loaded.settings);
      setSettings(loaded.settings);
      setExperimentUrl(loaded.experimentUrl);
      return { ok: true };
    } catch (caught) {
      const message = (caught as Error).message;
      setFailure({ operation: 'load', message });
      return { ok: false, message };
    }
  }, []);

  const changedCount = savedSettings ? changedSettingKeys(savedSettings, settings).length : 0;

  useEffect(() => {
    onDirtyChange(changedCount);
  }, [changedCount, onDirtyChange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() writes the fetched settings
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
    if (failure?.operation === 'load') {
      onSaveState({ kind: 'saving' });
      const result = await load();
      onSaveState(saveRetryAfterLoad(result));
      return;
    }
    setFailure(null);
    onSaveState({ kind: 'saving' });
    try {
      if (changedCount > 0) {
        const response = await fetch('/api/admin/benchmark-settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(settings),
        });
        const saved = await benchmarkSettingsFromResponse(response, 'saved');
        setSavedSettings(saved.settings);
        setSettings(saved.settings);
        setExperimentUrl(saved.experimentUrl);
      }
      await onCommitStaged();
      onDirtyChange(0);
      onSaveState({ kind: 'saved', count: changedCount + additionalChangeCount });
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
        {!enabled ? <p className="settings-row-note">Turn Benchmarking on above to edit these.</p> : null}

        <SettingField label="MLflow experiment" help="Experiment ID traces write to." helpId="bench-mlflow-help">
          <Input
            type="text"
            autoComplete="off"
            aria-label="MLflow experiment"
            aria-describedby="bench-mlflow-help"
            placeholder="1234567890123456"
            value={settings.experimentId}
            onChange={(event) => setSettings((current) => ({ ...current, experimentId: event.target.value }))}
          />
          {experimentUrl ? (
            <a className="benchmark-settings-link" href={experimentUrl} target="_blank" rel="noreferrer">
              Open this experiment
            </a>
          ) : null}
        </SettingField>

        <SettingField label="Judge model" help="Serving endpoint that scores answers." helpId="bench-judge-model-help">
          <Input
            type="text"
            autoComplete="off"
            aria-label="Judge model"
            aria-describedby="bench-judge-model-help"
            placeholder="databricks-claude-sonnet-4-5"
            value={settings.judgeEndpoint}
            onChange={(event) => setSettings((current) => ({ ...current, judgeEndpoint: event.target.value }))}
          />
        </SettingField>

        <table className="exp-feature-table">
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Status</th>
              <th scope="col">Control</th>
            </tr>
          </thead>
          <tbody>
            <JudgeToggleRow
              name="Always-on traces"
              help="Write an MLflow trace for every Ask."
              on={settings.alwaysOnTraces}
              disabled={!enabled}
              ariaLabel="Always-on traces"
              onCheckedChange={(checked) => setSettings((current) => ({ ...current, alwaysOnTraces: checked }))}
            />
            {AGENT_JUDGE_IDS.map((judge) => (
              <JudgeToggleRow
                key={judge}
                name={AGENT_JUDGE_COPY[judge].label}
                help={AGENT_JUDGE_COPY[judge].help}
                on={settings.enabledJudges.includes(judge)}
                disabled={!enabled}
                ariaLabel={AGENT_JUDGE_COPY[judge].aria}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({
                    ...current,
                    enabledJudges: toggleJudge(current.enabledJudges, judge, checked),
                  }))
                }
              />
            ))}
          </tbody>
        </table>

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

        <table className="exp-feature-table">
          <thead>
            <tr>
              <th scope="col">Multi-turn judges</th>
              <th scope="col">Status</th>
              <th scope="col">Control</th>
            </tr>
          </thead>
          <tbody>
            {MULTI_TURN_JUDGES.map((judge) => (
              <JudgeToggleRow
                key={judge.id}
                name={judge.label}
                help={judge.note}
                on={settings.enabledMultiTurnJudges.includes(judge.id)}
                disabled={!enabled}
                ariaLabel={judge.label}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({
                    ...current,
                    enabledMultiTurnJudges: toggleMultiTurn(current.enabledMultiTurnJudges, judge.id, checked),
                  }))
                }
              />
            ))}
          </tbody>
        </table>

        <p className="runtime-section-label">Custom judges</p>
        {settings.customJudges.map((judge, index) => (
          // Stored judges have no identifier; position distinguishes duplicate drafts until server normalization.
          // eslint-disable-next-line react/no-array-index-key
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
        <SettingField label="Custom judge name" help="Name shown in Lab." helpId="bench-custom-name-help">
          <Input
            type="text"
            autoComplete="off"
            aria-label="Custom judge name"
            aria-describedby="bench-custom-name-help"
            placeholder="english"
            value={customDraft.name}
            disabled={!enabled}
            onChange={(event) => setCustomDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </SettingField>
        <SettingField
          label="Custom judge guidelines"
          help="Yes/no rule this judge scores."
          helpId="bench-custom-guidelines-help"
        >
          <Textarea
            aria-label="Custom judge guidelines"
            aria-describedby="bench-custom-guidelines-help"
            rows={2}
            placeholder="The response must be in English."
            value={customDraft.guidelines}
            disabled={!enabled}
            onChange={(event) => setCustomDraft((current) => ({ ...current, guidelines: event.target.value }))}
          />
        </SettingField>
        <SettingField
          label="Custom judge prompt"
          help="Optional. Use {{question}}, {{response}}, {{conversation}}."
          helpId="bench-custom-prompt-help"
        >
          <Textarea
            aria-label="Custom judge prompt"
            aria-describedby="bench-custom-prompt-help"
            rows={3}
            placeholder="Score whether the answer stays in English."
            value={customDraft.prompt}
            disabled={!enabled}
            onChange={(event) => setCustomDraft((current) => ({ ...current, prompt: event.target.value }))}
          />
        </SettingField>
        <Button
          type="button"
          className="benchmark-add-judge"
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
        </Button>
      </fieldset>
    </form>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AGENT_JUDGE_IDS,
  MULTI_TURN_JUDGES,
  type AgentJudgeId,
  type MultiTurnJudgeId,
} from '../../shared/eval-dataset';
import { DEFAULT_BENCHMARK_SETTINGS, type BenchmarkSettings } from '../../shared/benchmark-settings';
import { ExperimentalStatus } from './ExperimentalBadge';
import { benchmarkSettingsFromResponse } from './benchmark-settings-api';
import { notifyBenchmarkSettingsSaved } from './benchmark-settings-events';
import { validateCustomJudgeDraft, type CustomJudgeDraft, type CustomJudgeDraftIssue } from './custom-judge-draft';
import {
  benchmarkSettingsChangedCount,
  createBenchmarkSettingsDraftStore,
  removeBenchmarkCustomJudge,
  replaceBenchmarkSettingsDraft,
  saveBenchmarkSettingsDraft,
  stageBenchmarkCustomJudge,
  updateBenchmarkSettingsDraft,
} from './benchmark-settings-draft';
import { saveRetryAfterLoad, type SettingsLoadResult, type SettingsSaveState } from './settings-save-state';
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
  help?: string;
  helpId?: string;
  children: ReactNode;
}) {
  return (
    <label className="runtime-field runtime-field-wide">
      <span className="runtime-field-label">{label}</span>
      {help ? (
        <span id={helpId} className="runtime-control-note">
          {help}
        </span>
      ) : null}
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
        <ExperimentalStatus on={on} />
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
  const [customDraft, setCustomDraft] = useState<CustomJudgeDraft>({ name: '', guidelines: '', prompt: '' });
  const [customJudgeNotice, setCustomJudgeNotice] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);
  const settingsDraftRef = useRef(createBenchmarkSettingsDraftStore(DEFAULT_BENCHMARK_SETTINGS));
  const addingCustomJudgeRef = useRef(false);

  const load = useCallback(async (): Promise<SettingsLoadResult> => {
    setFailure(null);
    try {
      const response = await fetch('/api/benchmark-settings');
      const loaded = await benchmarkSettingsFromResponse(response, 'loaded');
      replaceBenchmarkSettingsDraft(settingsDraftRef.current, loaded.settings, true);
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

  const changedCount = benchmarkSettingsChangedCount(settingsDraftRef.current);
  const customDraftValidation = validateCustomJudgeDraft(customDraft, settings.customJudges);
  const customDraftIssue: CustomJudgeDraftIssue | null =
    customDraftValidation.ok === true ? null : customDraftValidation.issue;
  const editable = enabled && savedSettings !== null && failure?.operation !== 'load';

  useEffect(() => {
    onDirtyChange(changedCount);
  }, [changedCount, onDirtyChange]);

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

  const updateSettings = (update: (current: BenchmarkSettings) => BenchmarkSettings) => {
    setSettings(updateBenchmarkSettingsDraft(settingsDraftRef.current, update));
  };

  const save = async () => {
    if (failure?.operation === 'load') {
      onSaveState({ kind: 'saving' });
      const result = await load();
      onSaveState(saveRetryAfterLoad(result));
      return;
    }
    if (settingsDraftRef.current.saveInFlight) return;
    if (benchmarkSettingsChangedCount(settingsDraftRef.current) + additionalChangeCount === 0) return;
    setFailure(null);
    onSaveState({ kind: 'saving' });
    try {
      const result = await saveBenchmarkSettingsDraft(settingsDraftRef.current, {
        additionalChangeCount,
        persist: async (draft) => {
          const response = await fetch('/api/admin/benchmark-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          });
          const saved = await benchmarkSettingsFromResponse(response, 'saved');
          setExperimentUrl(saved.experimentUrl);
          return saved.settings;
        },
        onPersisted: (saved, draftChangedDuringSave) => {
          setSavedSettings(saved);
          if (!draftChangedDuringSave) setSettings(saved);
        },
        onRefresh: notifyBenchmarkSettingsSaved,
        commitStaged: onCommitStaged,
      });
      if (result.kind === 'busy' || result.kind === 'noop') return;

      setFailure(null);
      if (result.customJudgesChanged) {
        setCustomJudgeNotice({
          tone: 'ok',
          text: 'Custom judges saved. Benchmark Lab refreshed.',
        });
      }
      onDirtyChange(result.remainingCount);
      onSaveState({ kind: 'saved', count: result.count });
    } catch (caught) {
      setFailure({ operation: 'save', message: (caught as Error).message });
      onSaveState({ kind: 'failed', message: (caught as Error).message });
    }
  };

  const updateCustomDraft = (patch: Partial<CustomJudgeDraft>) => {
    setCustomJudgeNotice(null);
    setCustomDraft((current) => ({ ...current, ...patch }));
  };

  const addCustomJudge = () => {
    if (addingCustomJudgeRef.current) return;
    addingCustomJudgeRef.current = true;
    try {
      const staged = stageBenchmarkCustomJudge(settingsDraftRef.current, customDraft);
      if (staged.ok === false) {
        setCustomJudgeNotice({ tone: 'error', text: staged.message });
        return;
      }
      setSettings(settingsDraftRef.current.current);
      setCustomDraft({ name: '', guidelines: '', prompt: '' });
      setCustomJudgeNotice({
        tone: 'ok',
        text: `${staged.judge.name} staged. Save Settings to apply it in Benchmark Lab.`,
      });
    } finally {
      queueMicrotask(() => {
        addingCustomJudgeRef.current = false;
      });
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
      <fieldset className="benchmark-settings-cluster" disabled={!editable}>
        <legend className="runtime-section-label">Evaluation path</legend>
        {!enabled ? <p className="settings-row-note">Turn Benchmarking on above to edit these.</p> : null}
        {enabled && savedSettings === null && !failure ? (
          <p className="settings-row-note" role="status">
            Reading benchmarking settings.
          </p>
        ) : null}
        {failure?.operation === 'load' ? (
          <p className="settings-row-note settings-error" role="alert">
            {failure.message}
          </p>
        ) : null}

        <SettingField label="MLflow experiment" help="Experiment ID traces write to." helpId="bench-mlflow-help">
          <Input
            type="text"
            autoComplete="off"
            aria-label="MLflow experiment"
            aria-describedby="bench-mlflow-help"
            placeholder="1234567890123456"
            value={settings.experimentId}
            onChange={(event) => updateSettings((current) => ({ ...current, experimentId: event.target.value }))}
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
            onChange={(event) => updateSettings((current) => ({ ...current, judgeEndpoint: event.target.value }))}
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
              onCheckedChange={(checked) => updateSettings((current) => ({ ...current, alwaysOnTraces: checked }))}
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
                  updateSettings((current) => ({
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
                  updateSettings((current) => ({
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
          // Stored judges have no identifier; position keeps any legacy duplicate rows distinct.
          // eslint-disable-next-line react/no-array-index-key
          <div className="eval-custom-judge" key={`${judge.name}-${index}`}>
            <p className="settings-row-label">{judge.name}</p>
            {judge.guidelines ? <p className="settings-row-note">{judge.guidelines}</p> : null}
            {judge.prompt ? <p className="settings-row-note">Prompt: {judge.prompt}</p> : null}
            <button
              type="button"
              className="tile-link"
              disabled={!enabled}
              onClick={() => {
                const removal = removeBenchmarkCustomJudge(settingsDraftRef.current, index);
                if (!removal.removed) return;
                setSettings(removal.settings);
                setCustomJudgeNotice({
                  tone: 'ok',
                  text: `${removal.removed.name} removed. Save Settings to apply this change in Benchmark Lab.`,
                });
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <SettingField label="Custom judge name">
          <Input
            type="text"
            autoComplete="off"
            aria-label="Custom judge name"
            aria-describedby="bench-custom-add-status"
            aria-invalid={customDraftIssue === 'name_required' || customDraftIssue === 'duplicate_name'}
            placeholder="english"
            value={customDraft.name}
            disabled={!enabled}
            onChange={(event) => updateCustomDraft({ name: event.target.value })}
          />
        </SettingField>
        <SettingField
          label="Custom judge guidelines"
          help="Yes/no rule this judge scores."
          helpId="bench-custom-guidelines-help"
        >
          <Textarea
            aria-label="Custom judge guidelines"
            aria-describedby="bench-custom-guidelines-help bench-custom-add-status"
            aria-invalid={customDraftIssue === 'guidelines_required'}
            rows={2}
            placeholder="The response must be in English."
            value={customDraft.guidelines}
            disabled={!enabled}
            onChange={(event) => updateCustomDraft({ guidelines: event.target.value })}
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
            onChange={(event) => updateCustomDraft({ prompt: event.target.value })}
          />
        </SettingField>
        <p
          id="bench-custom-add-status"
          className={`settings-status${customJudgeNotice?.tone === 'error' ? ' settings-error' : ''}`}
          role={customJudgeNotice?.tone === 'error' ? 'alert' : 'status'}
        >
          {customJudgeNotice?.text ??
            (customDraftValidation.ok === true
              ? 'Ready to stage. Save Settings afterward to apply it in Benchmark Lab.'
              : customDraftValidation.message)}
        </p>
        <Button
          type="button"
          className="benchmark-add-judge"
          disabled={!enabled || !customDraftValidation.ok}
          aria-describedby="bench-custom-add-status"
          onClick={addCustomJudge}
        >
          Add this custom judge
        </Button>
      </fieldset>
    </form>
  );
}

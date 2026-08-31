/**
 * Nominal budgets on Ops → Cost.
 *
 * Empty is unset, not zero. The app budget and all resource budgets are two
 * independent dirty/save groups. Each save reloads the current server document,
 * merges only its group, then atomically upserts the complete JSON document.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import {
  COST_BUDGET_MAX,
  EMPTY_COST_BUDGETS,
  costBudgetValue,
  normalizeCostBudget,
  resourceBudget,
  withCostBudgetValue,
  withResourceBudget,
  withTotalBudget,
  type CostBudget,
  type CostBudgetUnit,
  type CostBudgets,
} from '../../shared/cost-budgets';
import type { CostTile, OpsCostPayload } from '../../shared/ops-contract';
import { astPill } from './astrolabe-pill';
import { budgetFieldText } from './cost-budget-amount';
import { COST_BUDGETS_UNREADABLE, loadCostBudgets, saveCostBudgets } from './cost-budgets-api';
import { budgetHelper, budgetPlaceholder, costSpendSummary } from './cost-budget-view';
import { NumberTicker, tickerNumber } from './NumberTicker';
import { spendVersusBudget, tileView, totalBudgetView } from './ops-view';
import { SETTINGS_SAVE_IDLE, saveRetryAfterLoad, type SettingsSaveState } from './settings-save-state';
import { Button } from './ui';
import { ConceptFlicker } from './ConceptFlicker';

export type BudgetSaveGroup = 'total' | 'resources';

// eslint-disable-next-line react-refresh/only-export-components -- pure view-state helper is covered directly
export function costBudgetNotice(state: SettingsSaveState): { tone: 'ok' | 'error'; text: string } | null {
  if (state.kind === 'saved') return { tone: 'ok', text: 'Applied.' };
  if (state.kind === 'failed') return { tone: 'error', text: state.message };
  return null;
}

// eslint-disable-next-line react-refresh/only-export-components -- shared by reducer-level tests
export function sameCostBudget(left: CostBudget, right: CostBudget): boolean {
  const a = normalizeCostBudget(left);
  const b = normalizeCostBudget(right);
  return a.USD === b.USD && a.DBU === b.DBU;
}

// eslint-disable-next-line react-refresh/only-export-components -- shared by reducer-level tests
export function resourceBudgetsDirty(current: CostBudgets, saved: CostBudgets, tileIds: readonly string[]): boolean {
  return tileIds.some((id) => !sameCostBudget(resourceBudget(current, id), resourceBudget(saved, id)));
}

// eslint-disable-next-line react-refresh/only-export-components -- the server persists this as one JSON upsert
export function mergeBudgetGroup(
  saved: CostBudgets,
  draft: CostBudgets,
  group: BudgetSaveGroup,
  tileIds: readonly string[]
): CostBudgets {
  if (group === 'total') return withTotalBudget(saved, draft.total);
  let merged = saved;
  for (const tileId of tileIds) merged = withResourceBudget(merged, tileId, resourceBudget(draft, tileId));
  return merged;
}

interface CostBudgetApi {
  budgets: CostBudgets;
  saved: CostBudgets;
  currency: string;
  payload: OpsCostPayload;
  unit: CostBudgetUnit;
  setTotal: (budget: CostBudget) => void;
  setResource: (tileId: string, budget: CostBudget) => void;
  setValidity: (field: string, valid: boolean) => void;
  apply: (group: BudgetSaveGroup) => void;
  stateFor: (group: BudgetSaveGroup) => SettingsSaveState;
  dirtyFor: (group: BudgetSaveGroup) => boolean;
  validFor: (group: BudgetSaveGroup) => boolean;
  applying: boolean;
  readable: boolean;
}

const CostBudgetContext = createContext<CostBudgetApi | null>(null);

function useCostBudgets(): CostBudgetApi {
  const api = useContext(CostBudgetContext);
  if (!api) throw new Error('Cost budget controls need the Cost payload.');
  return api;
}

export function CostBudgetProvider({
  payload,
  tileIds,
  unit,
  children,
}: {
  payload: OpsCostPayload;
  tileIds: readonly string[];
  unit: CostBudgetUnit;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<CostBudgets | null>(null);
  const [loaded, setLoaded] = useState<CostBudgets | null>(null);
  const [saveStates, setSaveStates] = useState<Record<BudgetSaveGroup, SettingsSaveState>>({
    total: SETTINGS_SAVE_IDLE,
    resources: SETTINGS_SAVE_IDLE,
  });
  const [validity, setValidityState] = useState<Record<string, boolean>>({});
  const inFlight = useRef<BudgetSaveGroup | null>(null);
  const revisions = useRef<Record<BudgetSaveGroup, number>>({ total: 0, resources: 0 });
  const stored = loaded ?? payload.budgets ?? EMPTY_COST_BUDGETS;
  const budgets = draft ?? stored;
  const readable = loaded !== null || payload.budgetsReadable;
  const applying = inFlight.current !== null || Object.values(saveStates).some((state) => state.kind === 'saving');

  const setTotal = useCallback(
    (budget: CostBudget) => {
      revisions.current.total += 1;
      setDraft((current) => withTotalBudget(current ?? stored, budget));
      setSaveStates((current) => ({ ...current, total: SETTINGS_SAVE_IDLE }));
    },
    [stored]
  );
  const setResource = useCallback(
    (tileId: string, budget: CostBudget) => {
      revisions.current.resources += 1;
      setDraft((current) => withResourceBudget(current ?? stored, tileId, budget));
      setSaveStates((current) => ({ ...current, resources: SETTINGS_SAVE_IDLE }));
    },
    [stored]
  );
  const setValidity = useCallback((field: string, valid: boolean) => {
    setValidityState((current) => (current[field] === valid ? current : { ...current, [field]: valid }));
  }, []);
  const stateFor = useCallback((group: BudgetSaveGroup) => saveStates[group], [saveStates]);
  const dirtyFor = useCallback(
    (group: BudgetSaveGroup) =>
      group === 'total' ? !sameCostBudget(budgets.total, stored.total) : resourceBudgetsDirty(budgets, stored, tileIds),
    [budgets, stored, tileIds]
  );
  const validFor = useCallback(
    (group: BudgetSaveGroup) => {
      const prefix = group === 'total' ? 'total' : 'resource:';
      return Object.entries(validity)
        .filter(([field]) => field.startsWith(prefix))
        .every(([, valid]) => valid);
    },
    [validity]
  );

  const apply = useCallback(
    (group: BudgetSaveGroup) => {
      if (inFlight.current || !dirtyFor(group) || !validFor(group)) return;
      const submitted = budgets;
      const submittedRevision = revisions.current[group];
      inFlight.current = group;
      setSaveStates((current) => ({ ...current, [group]: { kind: 'saving' } }));
      void (async () => {
        try {
          // Always reload before a grouped save. A Cost refresh or another admin
          // may have changed the other group since this panel rendered.
          const current = await loadCostBudgets();
          if (!current.ok || !current.budgets) {
            setSaveStates((states) => ({ ...states, [group]: saveRetryAfterLoad(current) }));
            return;
          }
          const changed = mergeBudgetGroup(current.budgets, submitted, group, tileIds);
          const saved = await saveCostBudgets(changed);
          setLoaded(saved);
          setDraft((latest) => {
            if (!latest) return null;
            if (group === 'total') {
              const total = sameCostBudget(latest.total, submitted.total) ? saved.total : latest.total;
              return { total, resources: latest.resources };
            }
            const resources = { ...saved.resources };
            for (const tileId of tileIds) {
              if (!sameCostBudget(resourceBudget(latest, tileId), resourceBudget(submitted, tileId))) {
                resources[tileId] = normalizeCostBudget(resourceBudget(latest, tileId));
              }
            }
            return { total: latest.total, resources };
          });
          setSaveStates((states) => ({
            ...states,
            [group]: revisions.current[group] === submittedRevision ? { kind: 'saved' } : SETTINGS_SAVE_IDLE,
          }));
        } catch (error) {
          setSaveStates((states) => ({
            ...states,
            [group]: { kind: 'failed', message: (error as Error).message },
          }));
        } finally {
          inFlight.current = null;
        }
      })();
    },
    [budgets, dirtyFor, tileIds, validFor]
  );

  return (
    <CostBudgetContext.Provider
      value={{
        budgets,
        saved: stored,
        currency: payload.currency,
        payload,
        unit,
        setTotal,
        setResource,
        setValidity,
        apply,
        stateFor,
        dirtyFor,
        validFor,
        applying,
        readable,
      }}
    >
      {children}
    </CostBudgetContext.Provider>
  );
}

export function CostTotalBudget() {
  const api = useCostBudgets();
  const state = api.stateFor('total');
  const usd = costSpendSummary(api.payload, 'USD');
  const dbu = costSpendSummary(api.payload, 'DBU');
  const observed = { USD: usd.amount, DBU: dbu.dbus };
  const view = totalBudgetView(api.budgets.total, api.currency, observed, api.unit);
  const notice = costBudgetNotice(state);
  return (
    <div className="ops-cost-total">
      <CostBudgetField
        fieldKey="total"
        ariaLabel="App budget"
        budget={api.budgets.total}
        unit={api.unit}
        observed={observed}
        onCommit={api.setTotal}
        onValidityChange={(valid) => api.setValidity('total', valid)}
      />
      <CostBudgetApplyButton
        state={state}
        disabled={api.applying || !api.dirtyFor('total') || !api.validFor('total')}
        onClick={() => api.apply('total')}
      />
      <BudgetComparison view={view} noun="app budget" />
      <BudgetSaveNotice notice={notice} readable={api.readable} state={state} />
    </div>
  );
}

export function CostSpendSummary({ payload, unit }: { payload: OpsCostPayload; unit: CostBudgetUnit }) {
  const summary = costSpendSummary(payload, unit);
  return (
    <div className="ops-cost-summary-box" aria-label="Total app spend">
      <div className="ops-cost-summary-head">
        <span>Total app spend</span>
      </div>
      <p className="ops-cost-summary-value">
        <span className="ast-num">{summary.label}</span>
        {summary.amount !== null || summary.dbus !== null ? (
          <span>{summary.partial ? 'estimated subtotal' : summary.estimated ? 'estimated total' : 'total'}</span>
        ) : null}
      </p>
    </div>
  );
}

export function CostResourceBudgets({ tiles }: { tiles: readonly CostTile[] }) {
  const api = useCostBudgets();
  const state = api.stateFor('resources');
  const notice = costBudgetNotice(state);
  return (
    <section className="ops-cost-resource-budgets" aria-labelledby="ops-resource-budgets-heading">
      <div className="ops-cost-summary-head">
        <span id="ops-resource-budgets-heading">Resource budgets</span>
      </div>
      <div className="ops-cost-budget-matrix" role="table" aria-label={`Resource actuals and budgets in ${api.unit}`}>
        <div className="ops-cost-budget-matrix-head" role="row">
          <span role="columnheader">Component</span>
          <span role="columnheader">Actual</span>
          <span role="columnheader">Budget</span>
          <span role="columnheader">Status</span>
        </div>
        {tiles.map((tile) => (
          <CostTileBudget key={tile.id} tile={tile} />
        ))}
      </div>
      <div className="ops-resource-budget-actions">
        <CostBudgetApplyButton
          label="Apply resource budgets"
          state={state}
          disabled={api.applying || !api.dirtyFor('resources') || !api.validFor('resources')}
          onClick={() => api.apply('resources')}
        />
        <BudgetSaveNotice notice={notice} readable={api.readable} state={state} />
      </div>
    </section>
  );
}

export function CostTileBudget({ tile }: { tile: CostTile }) {
  const api = useCostBudgets();
  const amount = resourceBudget(api.budgets, tile.id);
  const compared = spendVersusBudget(tile, amount, api.currency, api.unit);
  const actual = tileView(tile, api.currency, api.unit);
  return (
    <div className="ops-tile-budget" role="row">
      <span className="ops-budget-heading" role="rowheader" title={tile.label}>
        <span className="ops-budget-resource">{tile.label}</span>
        {tile.basis === 'per-day' ? <span className="ops-budget-basis">per day</span> : null}
      </span>
      <span className={`ops-budget-actual${actual.figure ? '' : ' ops-budget-actual-unavailable'}`} role="cell">
        {actual.figure || actual.absence}
      </span>
      <span role="cell">
        <CostBudgetField
          fieldKey={`resource:${tile.id}`}
          ariaLabel={`${tile.label} budget${tile.basis === 'per-day' ? ' per day' : ''}`}
          budget={amount}
          unit={api.unit}
          observed={{ USD: tile.amount, DBU: tile.dbus ?? null }}
          onCommit={(value) => api.setResource(tile.id, value)}
          onValidityChange={(valid) => api.setValidity(`resource:${tile.id}`, valid)}
        />
      </span>
      <span role="cell">
        <BudgetComparison view={compared} />
      </span>
    </div>
  );
}

function BudgetComparison({ view, noun = '' }: { view: ReturnType<typeof spendVersusBudget>; noun?: string }) {
  if (view.kind === 'compared') {
    return (
      <span className="ops-budget-compare">
        <span className="ast-num">{view.spendLabel}</span> of <span className="ast-num">{view.budgetLabel}</span>
        {view.over ? <span className={astPill('warn', 'ops-pill')}>Over budget</span> : null}
      </span>
    );
  }
  if (view.kind === 'shared-meter') {
    return (
      <span className="ops-budget-compare">
        <span className="ast-num">{view.spendLabel}</span> of <span className="ast-num">{view.budgetLabel}</span>
        <span className={astPill('neutral-outline', 'ops-pill')}>shared meter vs named budget</span>
      </span>
    );
  }
  if (view.kind === 'budget-only') {
    return (
      <span className="ops-budget-compare">
        <span className="ast-num">{view.budgetLabel}</span>
        {noun ? ` ${noun}` : ' · spend not measured'}
      </span>
    );
  }
  return <span className="ops-budget-compare ops-budget-not-set">No budget</span>;
}

function CostBudgetField({
  fieldKey,
  ariaLabel,
  budget,
  unit,
  observed,
  onCommit,
  onValidityChange,
}: {
  fieldKey: string;
  ariaLabel: string;
  budget: CostBudget;
  unit: CostBudgetUnit;
  observed: Record<CostBudgetUnit, number | null>;
  onCommit: (budget: CostBudget) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [draft, setDraft] = useState<Partial<Record<CostBudgetUnit, string>>>({});
  const baseline = observed[unit];
  const value = draft[unit] ?? budgetFieldText(costBudgetValue(budget, unit));
  const parsed = tickerNumber(value, 0, COST_BUDGET_MAX);
  const update = (raw: string) => {
    const nextDraft = { ...draft, [unit]: raw };
    setDraft(nextDraft);
    const active = tickerNumber(raw, 0, COST_BUDGET_MAX);
    const allValid = (Object.entries(nextDraft) as Array<[CostBudgetUnit, string]>).every(
      ([, text]) => tickerNumber(text, 0, COST_BUDGET_MAX).valid
    );
    onValidityChange(allValid);
    if (active.valid) onCommit(withCostBudgetValue(budget, unit, active.empty ? null : active.value));
  };
  return (
    <div className="ops-budget-field" data-field={fieldKey}>
      <NumberTicker
        id={`ops-budget-${fieldKey.replace(/[^a-z0-9]+/gi, '-')}`}
        label={`${ariaLabel} in ${unit}`}
        value={value}
        placeholder={budgetPlaceholder(observed, unit)}
        prefix={unit === 'USD' ? '$' : undefined}
        suffix={unit === 'DBU' ? 'DBU' : undefined}
        step={0.01}
        precision={2}
        min={0}
        max={COST_BUDGET_MAX}
        invalid={!parsed.valid}
        wide
        title={baseline === null ? `${unit} observed amount unavailable` : `${baseline} ${unit} observed`}
        onChange={update}
      />
      <small className="ops-budget-helper">{budgetHelper(observed, unit)}</small>
      {!parsed.valid ? (
        <small className="ops-budget-validation" role="alert">
          Enter a number from 0 to {COST_BUDGET_MAX.toLocaleString('en-US')}.
        </small>
      ) : null}
    </div>
  );
}

function BudgetSaveNotice({
  notice,
  readable,
  state,
}: {
  notice: ReturnType<typeof costBudgetNotice>;
  readable: boolean;
  state: SettingsSaveState;
}) {
  if (notice?.tone === 'error') {
    return (
      <span className="ops-budget-save-error" role="alert">
        {notice.text}
      </span>
    );
  }
  if (!readable && state.kind !== 'failed') {
    return <span className="ops-budget-save-error">{COST_BUDGETS_UNREADABLE}</span>;
  }
  if (notice?.tone === 'ok') return <span className="ops-budget-save-ok">{notice.text}</span>;
  return null;
}

export function CostBudgetApplyButton({
  state,
  label = 'Apply',
  disabled = false,
  onClick,
}: {
  state: SettingsSaveState;
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const saving = state.kind === 'saving';
  const text = saving ? 'Applying' : state.kind === 'saved' ? 'Applied' : state.kind === 'failed' ? 'Retry' : label;
  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      className="ops-budget-apply"
      disabled={disabled || saving}
      aria-busy={saving || undefined}
      onClick={onClick}
    >
      {saving ? <ConceptFlicker seat="button" /> : null}
      {text}
    </Button>
  );
}

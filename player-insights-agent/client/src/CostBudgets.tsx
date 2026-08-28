/**
 * Nominal budgets on Ops → Cost: one app total, one field per resource tile.
 *
 * THE PERIOD IS THE COST WINDOW ALREADY ON THE TILES. A tile billed "in range"
 * compares against that range; a per-day tile compares against its per-day
 * figure. There is no separate monthly calendar. The app total is the same
 * window and is not a sum of the tiles — those amounts do not mix.
 *
 * Empty is unset, not zero. Save retries a failed load the way Settings does.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import {
  budgetsForVisibleTiles,
  EMPTY_COST_BUDGETS,
  resourceBudget,
  withResourceBudget,
  withTotalBudget,
  type CostBudgets,
} from '../../shared/cost-budgets';
import type { CostTile, OpsCostPayload } from '../../shared/ops-contract';
import { astPill } from './astrolabe-pill';
import { budgetFieldText, moneyAmountFrom } from './cost-budget-amount';
import { COST_BUDGETS_UNREADABLE, loadCostBudgets, saveCostBudgets } from './cost-budgets-api';
import { BASIS_LABEL, spendVersusBudget, totalBudgetView } from './ops-view';
import {
  SETTINGS_SAVE_IDLE,
  saveRetryAfterLoad,
  type SettingsSaveState,
} from './settings-save-state';
import { Button, Input } from './ui';
import { ConceptFlicker } from './ConceptFlicker';

export function costBudgetNotice(state: SettingsSaveState): { tone: 'ok' | 'error'; text: string } | null {
  if (state.kind === 'saved') return { tone: 'ok', text: 'Applied.' };
  if (state.kind === 'failed') return { tone: 'error', text: state.message };
  return null;
}

type BudgetControl = { kind: 'total' } | { kind: 'resource'; tileId: string };

interface CostBudgetApi {
  budgets: CostBudgets;
  currency: string;
  setTotal: (amount: number | null) => void;
  setResource: (tileId: string, amount: number | null) => void;
  apply: (control: BudgetControl) => void;
  stateFor: (control: BudgetControl) => SettingsSaveState;
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
  children,
}: {
  payload: OpsCostPayload;
  tileIds: readonly string[];
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<CostBudgets | null>(null);
  const [loaded, setLoaded] = useState<CostBudgets | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, SettingsSaveState>>({});
  const inFlight = useRef(new Set<string>());
  const stored = loaded ?? payload.budgets ?? EMPTY_COST_BUDGETS;
  const budgets = draft ?? stored;
  const readable = loaded !== null || payload.budgetsReadable;
  const applying = Object.values(saveStates).some((state) => state.kind === 'saving');

  const setTotal = useCallback((amount: number | null) => {
    setDraft((current) => withTotalBudget(current ?? stored, amount));
  }, [stored]);

  const setResource = useCallback(
    (tileId: string, amount: number | null) => {
      setDraft((current) => withResourceBudget(current ?? stored, tileId, amount));
    },
    [stored]
  );

  const keyFor = useCallback(
    (control: BudgetControl) => (control.kind === 'total' ? 'total' : `resource:${control.tileId}`),
    []
  );
  const stateFor = useCallback(
    (control: BudgetControl) => saveStates[keyFor(control)] ?? SETTINGS_SAVE_IDLE,
    [keyFor, saveStates]
  );
  const apply = useCallback((control: BudgetControl) => {
    const key = keyFor(control);
    if (inFlight.current.size > 0) return;
    inFlight.current.add(key);
    setSaveStates((current) => ({ ...current, [key]: { kind: 'saving' } }));
    void (async () => {
      try {
        let base = stored;
        if (!readable) {
          const result = await loadCostBudgets();
          if (!result.ok || !result.budgets) {
            setSaveStates((current) => ({ ...current, [key]: saveRetryAfterLoad(result) }));
            return;
          }
          base = result.budgets;
          setLoaded(base);
        }

        const changed =
          control.kind === 'total'
            ? withTotalBudget(base, budgets.total)
            : withResourceBudget(base, control.tileId, resourceBudget(budgets, control.tileId));
        const saved = await saveCostBudgets(budgetsForVisibleTiles(changed, tileIds));
        setLoaded(saved);
        setDraft((current) => {
          if (!current) return null;
          return control.kind === 'total'
            ? withTotalBudget(current, saved.total)
            : withResourceBudget(current, control.tileId, resourceBudget(saved, control.tileId));
        });
        setSaveStates((current) => ({ ...current, [key]: { kind: 'saved' } }));
      } catch (error) {
        setSaveStates((current) => ({
          ...current,
          [key]: { kind: 'failed', message: (error as Error).message },
        }));
      } finally {
        inFlight.current.delete(key);
      }
    })();
  }, [budgets, keyFor, readable, stored, tileIds]);

  return (
    <CostBudgetContext.Provider
      value={{
        budgets,
        currency: payload.currency,
        setTotal,
        setResource,
        apply,
        stateFor,
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
  const control: BudgetControl = { kind: 'total' };
  const saveState = api.stateFor(control);
  const view = totalBudgetView(api.budgets.total, api.currency);
  return (
    <div className="ops-cost-total">
      <CostBudgetField
        label="Total budget"
        basisLabel={BASIS_LABEL['total-in-range']}
        amount={api.budgets.total}
        currency={api.currency}
        onCommit={api.setTotal}
        saveState={saveState}
        applying={api.applying}
        readable={api.readable}
        onApply={() => api.apply(control)}
      />
      {view.kind === 'budget-only' ? (
        <p className="ops-budget-compare">
          <span className="ast-num">{view.budgetLabel}</span> app budget
        </p>
      ) : null}
    </div>
  );
}

export function CostTileBudget({ tile }: { tile: CostTile }) {
  const api = useCostBudgets();
  const control: BudgetControl = { kind: 'resource', tileId: tile.id };
  const saveState = api.stateFor(control);
  const amount = resourceBudget(api.budgets, tile.id);
  const compared = spendVersusBudget(tile, amount, api.currency);
  return (
    <div className="ops-tile-budget">
      <CostBudgetField
        label="Budget"
        basisLabel={BASIS_LABEL[tile.basis]}
        amount={amount}
        currency={api.currency}
        onCommit={(value) => api.setResource(tile.id, value)}
        saveState={saveState}
        applying={api.applying}
        readable={api.readable}
        onApply={() => api.apply(control)}
      />
      {compared.kind === 'compared' ? (
        <p className="ops-budget-compare">
          <span className="ast-num">{compared.spendLabel}</span>
          {' of '}
          <span className="ast-num">{compared.budgetLabel}</span>
          {compared.over ? <span className={astPill('warn', 'ops-pill')}>Over budget</span> : null}
        </p>
      ) : compared.kind === 'shared-meter' ? (
        <p className="ops-budget-compare">
          <span className="ast-num">{compared.spendLabel}</span>
          {' of '}
          <span className="ast-num">{compared.budgetLabel}</span>
          <span className={astPill('neutral-outline', 'ops-pill')}>shared meter vs named budget</span>
        </p>
      ) : compared.kind === 'budget-only' ? (
        <p className="ops-budget-compare">
          Budget <span className="ast-num">{compared.budgetLabel}</span>
          {tile.amount === null ||
          tile.quality === 'unknown' ||
          (tile.pricing?.match !== undefined &&
            tile.pricing.match !== 'priced' &&
            tile.pricing.match !== 'none')
            ? ' · spend not measured'
            : null}
        </p>
      ) : null}
    </div>
  );
}

function CostBudgetField({
  label,
  basisLabel,
  amount,
  currency,
  onCommit,
  saveState,
  applying,
  readable,
  onApply,
}: {
  label: string;
  basisLabel: string;
  amount: number | null;
  currency: string;
  onCommit: (amount: number | null) => void;
  saveState: SettingsSaveState;
  applying: boolean;
  readable: boolean;
  onApply: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const caption = `${label} ${basisLabel}`;
  const notice = costBudgetNotice(saveState);
  return (
    <div className="ops-budget-field">
      <label>
        <span className="ops-budget-label">{caption}</span>
        <span className="ops-budget-input-row">
          <Input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-label={caption}
            value={draft ?? budgetFieldText(amount)}
            onChange={(event) => {
              const typed = event.target.value.replace(/[^0-9.]/g, '');
              setDraft(typed);
              onCommit(moneyAmountFrom(typed, amount));
            }}
          />
          {currency ? <span className="ops-budget-currency">{currency}</span> : null}
        </span>
      </label>
      <CostBudgetApplyButton
        state={saveState}
        disabled={applying}
        onClick={onApply}
      />
      {notice?.tone === 'error' ? (
        <span
          className="ops-budget-save-error"
          role="alert"
        >
          {notice.text}
        </span>
      ) : null}
      {!readable && saveState.kind !== 'failed' ? (
        <span className="ops-budget-save-error">{COST_BUDGETS_UNREADABLE}</span>
      ) : null}
    </div>
  );
}

export function CostBudgetApplyButton({
  state,
  disabled = false,
  onClick,
}: {
  state: SettingsSaveState;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const saving = state.kind === 'saving';
  const label = saving ? 'Applying' : state.kind === 'saved' ? 'Applied' : state.kind === 'failed' ? 'Failed' : 'Apply';
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
      {label}
    </Button>
  );
}

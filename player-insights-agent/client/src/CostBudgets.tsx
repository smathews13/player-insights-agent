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
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

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
  saveButtonLabel,
  saveInFlight,
  saveRetryAfterLoad,
  type SettingsSaveState,
} from './settings-save-state';
import { Button, Input } from './ui';

export function costBudgetNotice(state: SettingsSaveState): { tone: 'ok' | 'error'; text: string } | null {
  if (state.kind === 'saved') return { tone: 'ok', text: 'Saved.' };
  if (state.kind === 'failed') return { tone: 'error', text: state.message };
  return null;
}

interface CostBudgetApi {
  budgets: CostBudgets;
  currency: string;
  setTotal: (amount: number | null) => void;
  setResource: (tileId: string, amount: number | null) => void;
  save: () => void;
  saveState: SettingsSaveState;
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
  const [saveState, setSaveState] = useState<SettingsSaveState>(SETTINGS_SAVE_IDLE);
  const stored = loaded ?? payload.budgets ?? EMPTY_COST_BUDGETS;
  const budgets = draft ?? stored;
  const readable = loaded !== null || payload.budgetsReadable;

  const setTotal = useCallback((amount: number | null) => {
    setDraft((current) => withTotalBudget(current ?? stored, amount));
  }, [stored]);

  const setResource = useCallback(
    (tileId: string, amount: number | null) => {
      setDraft((current) => withResourceBudget(current ?? stored, tileId, amount));
    },
    [stored]
  );

  const save = useCallback(() => {
    void (async () => {
      if (!readable) {
        setSaveState({ kind: 'saving' });
        const result = await loadCostBudgets();
        setSaveState(saveRetryAfterLoad(result));
        if (result.ok && result.budgets) {
          setLoaded(result.budgets);
          setDraft(null);
        }
        return;
      }
      setSaveState({ kind: 'saving' });
      try {
        const saved = await saveCostBudgets(budgetsForVisibleTiles(budgets, tileIds));
        setLoaded(saved);
        setDraft(null);
        setSaveState({ kind: 'saved' });
      } catch (error) {
        setSaveState({ kind: 'failed', message: (error as Error).message });
      }
    })();
  }, [budgets, readable, tileIds]);

  return (
    <CostBudgetContext.Provider
      value={{
        budgets,
        currency: payload.currency,
        setTotal,
        setResource,
        save,
        saveState,
        readable,
      }}
    >
      {children}
    </CostBudgetContext.Provider>
  );
}

export function CostTotalBudget() {
  const api = useCostBudgets();
  const notice = costBudgetNotice(api.saveState);
  const view = totalBudgetView(api.budgets.total, api.currency);
  return (
    <div className="ops-cost-total">
      <CostBudgetField
        label="App budget"
        basisLabel={BASIS_LABEL['total-in-range']}
        amount={api.budgets.total}
        currency={api.currency}
        onCommit={api.setTotal}
      />
      <p className="ops-cost-total-note">
        Same window as the tiles. Not a sum of them — Cost does not add products together.
      </p>
      {view.kind === 'budget-only' ? (
        <p className="ops-budget-compare">
          <span className="ast-num">{view.budgetLabel}</span> app budget
        </p>
      ) : null}
      <div className="ops-cost-total-save">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saveInFlight(api.saveState)}
          onClick={api.save}
        >
          {saveButtonLabel(api.saveState)}
        </Button>
        {notice ? (
          <span className={notice.tone === 'error' ? 'ops-budget-save-error' : 'ops-budget-save-ok'} role={notice.tone === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </span>
        ) : null}
        {api.readable ? null : <span className="ops-budget-save-error">{COST_BUDGETS_UNREADABLE}</span>}
      </div>
    </div>
  );
}

export function CostTileBudget({ tile }: { tile: CostTile }) {
  const api = useCostBudgets();
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
      />
      {compared.kind === 'compared' ? (
        <p className="ops-budget-compare">
          <span className="ast-num">{compared.spendLabel}</span>
          {' of '}
          <span className="ast-num">{compared.budgetLabel}</span>
          {compared.over ? <span className={astPill('warn', 'ops-pill')}>Over budget</span> : null}
        </p>
      ) : compared.kind === 'budget-only' ? (
        <p className="ops-budget-compare">
          Budget <span className="ast-num">{compared.budgetLabel}</span>
          {tile.amount === null || tile.quality === 'unknown' ? ' · spend not measured' : null}
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
}: {
  label: string;
  basisLabel: string;
  amount: number | null;
  currency: string;
  onCommit: (amount: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const caption = `${label} ${basisLabel}`;
  return (
    <label className="ops-budget-field">
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
          onBlur={() => setDraft(null)}
        />
        {currency ? <span className="ops-budget-currency">{currency}</span> : null}
      </span>
    </label>
  );
}

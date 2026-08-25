/**
 * The compact row that says which runtime a run actually used.
 *
 * One component, quoted by Monitoring's question chrome and Run Explorer
 * Overview, so the two surfaces cannot disagree about a budget. The numbers are
 * the snapshot stored on that Ask, never today's Settings and never the
 * bundle's defaults. A run stored before this field existed says "Not recorded".
 */
import {
  RUN_RUNTIME_USED_ABSENT,
  RUN_RUNTIME_USED_HEADING,
  runRuntimeUsedChips,
  type RunRuntimeUsed,
} from '../../shared/run-runtime-used';

export function UsedThisRun({ used }: { used: RunRuntimeUsed | null | undefined }) {
  const chips = used ? runRuntimeUsedChips(used) : [];
  return (
    <div className="run-runtime-used" data-testid="used-this-run">
      <span className="run-runtime-used-label">{RUN_RUNTIME_USED_HEADING}</span>
      {chips.length === 0 ? (
        <span className="run-runtime-used-absent">{RUN_RUNTIME_USED_ABSENT}</span>
      ) : (
        chips.map((chip) => (
          <span
            key={chip.key}
            className={chip.on === false ? 'run-runtime-used-chip is-off' : 'run-runtime-used-chip'}
          >
            {chip.label} <span className="ast-num">{chip.value}</span>
          </span>
        ))
      )}
    </div>
  );
}

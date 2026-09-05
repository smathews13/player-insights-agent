import { CircleAlert } from 'lucide-react';

import type { LakebaseMigrationReadiness } from '../../shared/lakebase-migrations';
import type { LakebaseMigrationClientState } from './lakebase-migration-status';
import { PiaBusyButtonContent } from './PiaLoader';
import { Badge, Button } from './ui';

function safeFailure(value: LakebaseMigrationReadiness): string {
  if (value.status === 'ahead') return 'Deploy the latest app source before changing Lakebase.';
  if (value.status === 'unavailable') return 'Check the app Lakebase resource, then retry.';
  return value.detail || 'Lakebase could not be updated. Check schema ownership and retry.';
}

export function LakebaseMigrationPanel({
  state,
  onApply,
}: {
  state: LakebaseMigrationClientState;
  onApply: () => void;
}) {
  const value = state.value;
  if ((state.phase === 'idle' || state.phase === 'loading') && !value) return null;

  if (state.phase === 'error' && !value) {
    return (
      <div className="lakebase-migration-status" data-state="unavailable" role="status">
        <CircleAlert className="size-4" aria-hidden="true" />
        <div>
          <strong>Lakebase update status unavailable</strong>
          <p>{state.error}</p>
        </div>
      </div>
    );
  }
  if (!value) return null;

  const applying = state.phase === 'applying';
  const updated = value.status === 'up_to_date' && value.appliedCount !== undefined;
  if (value.status === 'up_to_date') {
    return (
      <div className="lakebase-migration-status" data-state="up-to-date" role="status">
        <div>
          {updated ? <strong>Lakebase updated</strong> : null}
          <div className="lakebase-migration-badges">
            <Badge variant="secondary">Up to date</Badge>
            <span>Schema v{value.targetVersion}</span>
          </div>
        </div>
      </div>
    );
  }

  if (value.status === 'update_required') {
    return (
      <div className="lakebase-migration-status" data-state="update-required" role="status">
        <div className="lakebase-migration-copy">
          <strong>Lakebase update required</strong>
          <p>User spend tables and other app storage updates are pending.</p>
          {state.error ? <p className="lakebase-migration-error">{state.error}</p> : null}
        </div>
        <Button disabled={applying || !value.canApply} aria-busy={applying || undefined} onClick={onApply}>
          <PiaBusyButtonContent busy={applying} label="Update Lakebase" busyLabel="Updating Lakebase" />
        </Button>
      </div>
    );
  }

  const attempted = value.appliedCount !== undefined;
  const heading = attempted
    ? 'Lakebase was not updated'
    : value.status === 'ahead'
      ? 'Lakebase app update required'
      : value.status === 'blocked'
        ? 'Lakebase update blocked'
        : 'Lakebase update status unavailable';
  return (
    <div className="lakebase-migration-status" data-state={value.status} role="alert">
      <CircleAlert className="size-4" aria-hidden="true" />
      <div className="lakebase-migration-copy">
        <strong>{heading}</strong>
        <p>{state.error || safeFailure(value)}</p>
        {value.action && value.action !== safeFailure(value) ? <p>{value.action}</p> : null}
      </div>
      {value.canApply ? (
        <Button disabled={applying} aria-busy={applying || undefined} onClick={onApply}>
          <PiaBusyButtonContent busy={applying} label="Update Lakebase" busyLabel="Updating Lakebase" />
        </Button>
      ) : null}
    </div>
  );
}

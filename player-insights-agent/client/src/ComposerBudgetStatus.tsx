import { CircleAlert } from 'lucide-react';

import type { AppBudgetStatus } from '../../shared/app-budget-contract';
import { PiaBusyButtonContent } from './PiaLoader';
import { Alert, AlertDescription, Button } from './ui';

export function ComposerBudgetStatus({
  status,
  admin,
  busy,
  error,
  onApprove,
}: {
  status: AppBudgetStatus | null;
  admin: boolean;
  busy: boolean;
  error: string;
  onApprove: () => void;
}) {
  if (!status || (status.level !== 'warning' && status.level !== 'approval-required')) return null;

  const approvalRequired = status.level === 'approval-required';
  return (
    <Alert
      className="composer-budget-status"
      role={approvalRequired ? 'alert' : 'status'}
      aria-live={approvalRequired ? 'assertive' : 'polite'}
    >
      <CircleAlert aria-hidden="true" />
      <AlertDescription>
        {approvalRequired ? (
          admin ? (
            <>
              Monthly app budget reached.{' '}
              <Button type="button" size="sm" disabled={busy} aria-busy={busy || undefined} onClick={onApprove}>
                <PiaBusyButtonContent busy={busy} label="Approve continued usage" busyLabel="Approving" />
              </Button>
            </>
          ) : (
            'An administrator must approve continued usage.'
          )
        ) : (
          <>Monthly app budget is {status.percent?.toFixed(2)}% used.</>
        )}
        {error ? <span role="alert"> {error}</span> : null}
      </AlertDescription>
    </Alert>
  );
}

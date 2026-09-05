import { PRIMARY_CONNECTION_BADGE, type ResolvedConnectionState } from './connection-status';
import { piaPill } from './pia-pill';
import { Badge } from './ui';

export function ConnectionStateBadge({
  state,
  subject,
  className,
}: {
  state: ResolvedConnectionState;
  subject: string;
  className?: string;
}) {
  const presentation = PRIMARY_CONNECTION_BADGE[state];
  return (
    <Badge
      variant="outline"
      className={piaPill(presentation.family, ['connection-state-badge', className].filter(Boolean).join(' '))}
      data-connection-state={state}
      aria-label={`${subject} connection status: ${presentation.label}`}
    >
      {presentation.label}
    </Badge>
  );
}

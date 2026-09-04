import { CircleMinus } from 'lucide-react';
import type { ConnectionRemovalNotice } from './declared-connection-controller';

export function ConnectionRemovalStatus({ notice }: { notice: ConnectionRemovalNotice | null }) {
  if (!notice) return null;
  return (
    <span className="connection-removal-status" role="status" aria-live="polite">
      <CircleMinus aria-hidden="true" />
      <span>Connection removed</span>
    </span>
  );
}

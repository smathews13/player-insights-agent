import { Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The shared mark for generic tool-call measurements.
 *
 * Product-specific calls keep their product artwork. This is only for generic
 * labels such as "Tools" and "Agent tool calls", where a neutral wrench helps
 * the same measurement scan consistently across Ask, Run Explorer and
 * Monitoring. The icon is decorative because the adjacent text is the complete
 * accessible label.
 */
export function ToolCallsLabel({ children = 'Tool calls' }: { children?: ReactNode }) {
  return (
    <span className="tool-calls-label">
      <Wrench aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

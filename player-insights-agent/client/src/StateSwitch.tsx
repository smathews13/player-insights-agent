import type { ComponentProps } from 'react';
import { StateStatus } from './ExperimentalBadge';
import { Switch } from './ui';

/**
 * One visible state and one control.
 *
 * A bare switch makes its current meaning depend on colour and thumb position.
 * This wrapper keeps the domain words beside it while preserving the switch's
 * own accessible name and keyboard behaviour.
 */
export function StateSwitch({
  checked,
  className = '',
  ...props
}: Omit<ComponentProps<typeof Switch>, 'checked' | 'className'> & {
  checked: boolean;
  className?: string;
}) {
  return (
    <span className={`state-switch ${className}`.trim()}>
      <StateStatus on={checked} />
      <Switch checked={checked} {...props} />
    </span>
  );
}

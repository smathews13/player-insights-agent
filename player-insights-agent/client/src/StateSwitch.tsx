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
  onLabel = 'On',
  offLabel = 'Off',
  className = '',
  ...props
}: Omit<ComponentProps<typeof Switch>, 'checked' | 'className'> & {
  checked: boolean;
  onLabel?: string;
  offLabel?: string;
  className?: string;
}) {
  return (
    <span className={`state-switch ${className}`.trim()}>
      <StateStatus on={checked} onLabel={onLabel} offLabel={offLabel} />
      <Switch checked={checked} {...props} />
    </span>
  );
}

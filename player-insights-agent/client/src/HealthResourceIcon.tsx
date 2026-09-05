import { Box, TableProperties } from 'lucide-react';

import { BrandIcon } from './BrandIcon';
import { healthResourceIconSpec } from './health-resource-icon';

/**
 * A decorative row icon. The resource label beside it remains the accessible
 * name, so a screen reader does not announce the same resource twice.
 */
export function HealthResourceIcon({ kind, className = '' }: { kind: string; className?: string }) {
  const icon = healthResourceIconSpec(kind);
  const classes = ['ops-dependency-mark', className].filter(Boolean).join(' ');
  if (icon.type === 'brand') {
    return <BrandIcon product={icon.product} size={16} className={classes} />;
  }
  const Icon = icon.type === 'table' ? TableProperties : Box;
  return <Icon size={16} className={`${classes} ops-dependency-mark-generic`} aria-hidden="true" />;
}

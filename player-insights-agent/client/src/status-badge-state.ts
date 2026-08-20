import type { AstPillFamily } from './astrolabe-pill';
import type { StatusTone } from './StatusBadge';

export const BADGE_FAMILY: Record<StatusTone, AstPillFamily | 'plain'> = {
  reachable: 'pos',
  blocked: 'neg',
  drifted: 'warn',
  plain: 'plain',
};

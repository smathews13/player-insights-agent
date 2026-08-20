import type { AstPillFamily } from './astrolabe-pill';
import type { NodeReport } from './architecture';

export const NODE_FAMILY: Record<NodeReport['tone'], AstPillFamily> = {
  reachable: 'pos',
  blocked: 'neg',
  'not-checked': 'neutral-outline',
  'nothing-to-reach': 'neutral-outline',
  local: 'neutral-outline',
  unreadable: 'neutral-outline',
};

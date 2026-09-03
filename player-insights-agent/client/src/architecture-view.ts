import type { AstPillFamily } from './astrolabe-pill';
import type { NodeReport } from './architecture';

export const NODE_FAMILY: Record<NodeReport['tone'], AstPillFamily> = {
  connected: 'pos',
  'not-connected': 'neg',
  local: 'neutral-outline',
};

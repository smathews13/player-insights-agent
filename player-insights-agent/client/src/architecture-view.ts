import type { AstPillFamily } from './pia-pill';
import type { NodeReport } from './architecture';

export const NODE_FAMILY: Record<NodeReport['tone'], AstPillFamily> = {
  connected: 'pos',
  disconnected: 'neg',
  local: 'neutral-outline',
};

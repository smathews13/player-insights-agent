/**
 * How loudly a Keep in mind bullet should be drawn.
 *
 * Ranking (caveat-priority.ts) decides order. This file decides treatment:
 * a real failure is a dark-red warning, identity/grants are a secondary note,
 * and everything else stays an ordinary bullet. The Partial-vs-Complete
 * verdict is not decided here.
 */
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';
import { CAVEAT_RISK, caveatRisk } from './caveat-priority';

export type CaveatSurface = 'failure' | 'note' | 'ordinary';

/**
 * Endpoint / model failures the agent writes as a caveat rather than a banner.
 *
 * Phrases from live answers. APITimeoutError is the reported one: it sat in
 * Keep in mind as a quiet grey bullet next to the identity line.
 */
const FAILURE_DISCLOSURE =
  /APITimeoutError|Request timed out|reasoning endpoint failed|was not reachable|the model that writes the answer/i;

export function caveatSurface(caveat: string): CaveatSurface {
  const text = caveat.trim();
  if (!text) return 'ordinary';
  if (text.startsWith(DEGRADED_ANSWER_MARKER) || FAILURE_DISCLOSURE.test(text)) return 'failure';
  if (caveatRisk(text) === CAVEAT_RISK.identity) return 'note';
  return 'ordinary';
}

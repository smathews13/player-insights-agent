/**
 * What the access gate established, in the words the banner says it in.
 */

/** How the gate concluded. Not, any longer, a claim about who executes. */
export type ExecutionMode = 'service-principal' | 'user-verified' | 'skipped';

/**
 * Whether the status reads as settled or as wanting attention.
 *
 * Only 'ok' is produced today. It exists because the moment execution can take
 * more than one route, "which route" becomes a thing a reader may need to be
 * drawn to rather than merely told.
 */
export type ExecutionTone = 'ok' | 'attention';

export interface ExecutionStatus {
  /**
   * What happened at the gate, in one line. The whole banner, so it is a
   * sentence a reader can take at a glance and nothing more.
   *
   * Carries no identifier (the principal is rendered beside it, once), and no
   * claim about what the app cannot do. "Operating in X mode" states a route
   * and leaves room for the others; a sentence saying this is the only way the
   * app can work would have to be unwritten the day that stops being true, and
   * that day has now come and gone once.
   */
  label: string;
  tone: ExecutionTone;
}

const SERVICE_PRINCIPAL_MODE = 'Operating in service principal mode';

/**
 * One entry per mode. One line each.
 */
const EXECUTION_STATUS: Record<ExecutionMode, ExecutionStatus> = {
  'service-principal': { label: SERVICE_PRINCIPAL_MODE, tone: 'ok' },
  // Replaced a headline plus a paragraph naming every grant checked, the
  // executing principal in full, the Genie space count and the row-filter
  // caveat: all of it true, none of it readable in a strip above every page.
  // The paragraph is on the Connections page, which is somewhere a reader goes
  // and asks rather than somewhere they are told.
  'user-verified': { label: 'Your access was verified and confirmed', tone: 'ok' },
  'skipped': { label: 'Access check skipped', tone: 'ok' },
};

/**
 * The status for a mode, degrading to the plain one rather than throwing.
 *
 * A mode this build does not know about is a newer server talking to an older
 * client, which happens on every rolling deploy. Falling back to the mode this
 * app has always had is the conservative read: it under-claims for a reader
 * whose questions are running under their own credentials, which is the safe
 * direction to be wrong in, and blanking the banner would tell them nothing.
 */
export function executionStatus(mode: string): ExecutionStatus {
  return EXECUTION_STATUS[mode as ExecutionMode] ?? { label: SERVICE_PRINCIPAL_MODE, tone: 'ok' };
}

/**
 * The verification detail with any repeat of the principal's id abbreviated.
 */
export function withoutRepeatedPrincipal(detail: string, principal: string | null | undefined): string {
  const id = principal?.trim();
  if (!id || !detail) return detail;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return detail.replace(new RegExp(escaped, 'gi'), principalLabel(id));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A run of hex long enough that nobody chose it.
 *
 * Tested in addition to the uuid shape rather than instead of it, because not
 * every opaque principal is well-formed: Model Serving has handed back ids that
 * are uuid-ish without being uuids, and treating one of those as a display name
 * would print almost all of it in a banner that stands over every screen. Eight
 * is the width of a uuid's first segment, short enough that no word reaches it,
 * long enough that a hyphenated name like `player-insights-serving-sp` does not.
 */
const HEX_RUN = /[0-9a-f]{8}/i;

/** Longest name shown in full. Past this it is truncated rather than wrapped. */
const NAME_LIMIT = 28;

/**
 * A principal, short enough to sit in a status line.
 */
export function principalLabel(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  if (isOpaqueId(trimmed)) return `${trimmed.slice(0, 8)}\u2026`;
  if (trimmed.length > NAME_LIMIT) return `${trimmed.slice(0, NAME_LIMIT - 1)}\u2026`;
  return trimmed;
}

/**
 * Whether a value is safe to print in full.
 */
export function isOpaqueId(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return UUID.test(trimmed) || HEX_RUN.test(trimmed);
}

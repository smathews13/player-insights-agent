import { NO_AGENT_MODEL, type AgentModelReference } from '../../shared/agent-model';

/**
 * Normalize the endpoint at the component boundary.
 *
 * Same reason as `environment-response.ts`: the Settings pane has to survive an
 * older server, an empty body, and a half-populated reference, and a type
 * assertion does not make a network value complete at runtime. A `url` that is
 * not a string is dropped rather than rendered, which is what keeps `href` from
 * being handed `undefined` and drawing a link to the current page.
 */
export function agentModelFromResponse(value: unknown): AgentModelReference {
  const payload = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const text = (candidate: unknown) => (typeof candidate === 'string' ? candidate.trim() : '');
  const model = text(payload.model);
  if (!model) return NO_AGENT_MODEL;
  const url = text(payload.url);
  return {
    model,
    version: text(payload.version),
    url,
    // Never trusted from the wire on its own. The flag decides what the row
    // CLAIMS the link opens, so it is only true when there is a link and the
    // server said it addresses a version.
    versioned: payload.versioned === true && url.length > 0,
  };
}

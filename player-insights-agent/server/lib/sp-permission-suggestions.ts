import {
  SP_GRANT_MATRIX,
  SpPermissionSuggestionsSchema,
  spGrantKey,
  type SpGrantResource,
  type SpPermissionSuggestionRequest,
  type SpPermissionSuggestions,
} from '../../shared/sp-identity';
import { extractJudgeContent } from './mlflow-judges';

export type PermissionSuggestionInvoker = (payload: Record<string, unknown>) => Promise<unknown>;

function suggestionPrompt(request: SpPermissionSuggestionRequest, resources: readonly SpGrantResource[]): string {
  const inventory = resources.map(({ type, id, label }) => ({ type, id, label }));
  const matrix = Object.fromEntries(
    Object.entries(SP_GRANT_MATRIX).map(([type, definition]) => [
      type,
      definition.options.map(({ action, privilege, label }) => ({ action, privilege, label })),
    ])
  );
  return [
    'Suggest 2 to 4 conservative Databricks permission plans for this service-principal persona.',
    'Use only exact resources and exact action/privilege pairs from the supplied JSON.',
    'Prefer least privilege. Return JSON only: {"plans":[{"name":"...","rationale":"...","grants":[...]}]}.',
    JSON.stringify({
      persona: { name: request.displayName, purpose: request.purpose },
      allowlisted_resources: inventory,
      canonical_privilege_matrix: matrix,
    }),
  ].join('\n');
}

function jsonBody(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

/**
 * Validates the model twice: schema/matrix first, then the server-owned resource
 * allowlist. No model-proposed identifier is accepted merely because it is
 * syntactically valid.
 */
export async function suggestSpPermissions(input: {
  request: SpPermissionSuggestionRequest;
  resources: readonly SpGrantResource[];
  invoke: PermissionSuggestionInvoker;
}): Promise<SpPermissionSuggestions> {
  if (input.resources.length === 0) throw new Error('No configured resources are available for suggestions.');
  const raw = await input.invoke({
    messages: [{ role: 'user', content: suggestionPrompt(input.request, input.resources) }],
    temperature: 0,
    max_tokens: 2400,
  });
  const content = extractJudgeContent(raw);
  if (!content) throw new Error('The model returned no permission suggestions.');
  const parsed = SpPermissionSuggestionsSchema.safeParse(jsonBody(content));
  if (!parsed.success) throw new Error('The model returned an invalid permission-plan shape.');

  const allowed = new Set(
    input.resources.map((resource) => `${resource.type}\u0000${resource.id.toLocaleLowerCase()}`)
  );
  for (const plan of parsed.data.plans) {
    if (new Set(plan.grants.map(spGrantKey)).size !== plan.grants.length) {
      throw new Error('The model returned a plan with duplicate permissions.');
    }
    for (const grant of plan.grants) {
      if (!allowed.has(`${grant.resourceType}\u0000${grant.resource.toLocaleLowerCase()}`)) {
        throw new Error('The model suggested a resource outside the configured allowlist.');
      }
    }
  }
  return parsed.data;
}

import { declaredUserApiScopes } from '../../shared/declared-scopes';
import { OPTIONAL_USER_API_SCOPES } from '../../shared/optional-user-api-scopes';
import { REQUIRED_USER_API_SCOPES } from '../../shared/required-user-api-scopes';

/** Needed on the user's token so Model Serving can pass them to the agent. */
const MODEL_ROUTE_SCOPES = ['genie', 'ai-gateway'] as const;

const KNOWN = new Set<string>([...REQUIRED_USER_API_SCOPES, ...OPTIONAL_USER_API_SCOPES, ...MODEL_ROUTE_SCOPES]);

/**
 * One startup line naming the user scopes this deployment requests: scope names
 * only, never a token. Anything beyond what PIA uses is called out, because a
 * broader consent than the app needs is a finding, not a convenience.
 */
export function describeUserApiScopes(env: NodeJS.ProcessEnv = process.env): string {
  const declared = declaredUserApiScopes(env);
  if (!declared) return '[scopes] This deployment was not told which user scopes it requests.';
  const missing = REQUIRED_USER_API_SCOPES.filter((scope) => !declared.includes(scope));
  const unexpected = declared.filter((scope) => !KNOWN.has(scope));
  return [
    `[scopes] User scopes requested: ${declared.join(', ')}.`,
    missing.length ? `Missing for questions: ${missing.join(', ')}.` : '',
    unexpected.length ? `Not used by PIA, remove from app_user_api_scopes: ${unexpected.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

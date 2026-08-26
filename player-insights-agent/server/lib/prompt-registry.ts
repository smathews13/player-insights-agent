import {
  PRODUCTION_PROMPT_ALIAS,
  promptRegistryUri,
  type PromotedPrompt,
} from '../../shared/eval-flywheel';

/**
 * Databricks Prompt Registry over the workspace REST API.
 *
 * Apps often lack the catalog scopes this needs. Every call reports that
 * honestly. A cached template is how the next Ask still picks up a promote
 * when the alias itself could not be moved.
 */

export const PROMPT_REGISTER_PATHS = [
  '/api/2.0/mlflow/unity-catalog/prompts',
  '/api/2.0/mlflow/prompts',
] as const;

export interface PromptRegistryClient {
  request(input: { method: string; path: string; payload?: Record<string, unknown> }): Promise<unknown>;
}

export function promptTemplateFromPromote(input: { side: string; endpoint: string; guidelines: string }): string {
  const guidelines = input.guidelines.trim();
  const winner = input.endpoint.trim() || input.side.trim() || 'the promoted agent';
  return [
    `Operating guidance for the promoted Ask path (${winner}).`,
    guidelines || 'Stay accurate, professional, and within the governed data the question asked about.',
  ].join('\n');
}

export function parsePromptVersion(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const version = record.version ?? record.prompt_version ?? (record.prompt as { version?: unknown } | undefined)?.version;
  return version !== undefined && version !== null ? String(version) : '';
}

export function parsePromptTemplate(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const template =
    record.template ??
    record.prompt_template ??
    (record.prompt as { template?: unknown } | undefined)?.template;
  return typeof template === 'string' ? template : '';
}

export async function tryFirstPath(
  client: PromptRegistryClient,
  method: string,
  paths: readonly string[],
  payload?: Record<string, unknown>
): Promise<{ path: string; body: unknown }> {
  let lastError: unknown = new Error('No Prompt Registry path answered.');
  for (const path of paths) {
    try {
      const body = await client.request({ method, path, payload });
      return { path, body };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function registerPromptVersion(
  client: PromptRegistryClient,
  name: string,
  template: string
): Promise<{ version: string; template: string }> {
  const created = await tryFirstPath(client, 'POST', PROMPT_REGISTER_PATHS, {
    name,
    template,
    commit_message: 'Promoted from Player Insights Benchmarking.',
  });
  return {
    version: parsePromptVersion(created.body),
    template: parsePromptTemplate(created.body) || template,
  };
}

export async function setProductionAlias(
  client: PromptRegistryClient,
  name: string,
  version: string
): Promise<void> {
  const encoded = encodeURIComponent(name);
  const alias = PRODUCTION_PROMPT_ALIAS;
  const paths = [
    `/api/2.0/mlflow/unity-catalog/prompts/${encoded}/aliases/${encodeURIComponent(alias)}`,
    `/api/2.0/mlflow/prompts/${encoded}/aliases/${encodeURIComponent(alias)}`,
  ];
  await tryFirstPath(client, 'PATCH', paths, { version });
}

export async function loadProductionPrompt(
  client: PromptRegistryClient,
  name: string
): Promise<{ version: string; template: string }> {
  const encoded = encodeURIComponent(name);
  const alias = PRODUCTION_PROMPT_ALIAS;
  const paths = [
    `/api/2.0/mlflow/unity-catalog/prompts/${encoded}/aliases/${encodeURIComponent(alias)}`,
    `/api/2.0/mlflow/prompts/${encoded}/aliases/${encodeURIComponent(alias)}`,
  ];
  const loaded = await tryFirstPath(client, 'GET', paths);
  return {
    version: parsePromptVersion(loaded.body),
    template: parsePromptTemplate(loaded.body),
  };
}

export async function promotePromptAlias(
  client: PromptRegistryClient,
  input: { name: string; template: string }
): Promise<PromotedPrompt> {
  const name = input.name.trim();
  const template = input.template.trim();
  if (!name) {
    return {
      name: '',
      alias: PRODUCTION_PROMPT_ALIAS,
      version: '',
      uri: '',
      template,
      status: 'skipped',
      note: 'No Prompt Registry name is set. Next Ask still uses the saved guidance from this promote. Type a catalog.schema.prompt name to move the production alias.',
    };
  }
  try {
    const registered = await registerPromptVersion(client, name, template);
    const version = registered.version;
    if (version) {
      await setProductionAlias(client, name, version);
    }
    const loaded = version ? { version, template: registered.template } : await loadProductionPrompt(client, name);
    return {
      name,
      alias: PRODUCTION_PROMPT_ALIAS,
      version: loaded.version || version,
      uri: promptRegistryUri(name),
      template: loaded.template || registered.template || template,
      status: 'moved',
      note: `Moved the ${PRODUCTION_PROMPT_ALIAS} alias${loaded.version ? ` to version ${loaded.version}` : ''}. The next Ask loads ${promptRegistryUri(name)} without a code change.`,
    };
  } catch (error) {
    return {
      name,
      alias: PRODUCTION_PROMPT_ALIAS,
      version: '',
      uri: promptRegistryUri(name),
      template,
      status: 'blocked',
      note: `The production alias was not moved: ${(error as Error).message} Apps often cannot write Prompt Registry. The next Ask still uses the guidance saved from this promote.`,
    };
  }
}

/**
 * Which registered model version is answering, so its code can be opened.
 *
 * READ FROM THE LIVE ENDPOINT, NOT FROM CONFIGURATION. The app container is
 * never told the model's name: `app.yaml` binds the serving endpoint resource
 * and nothing else, so `PLAYER_INSIGHTS_MODEL_NAME` is unset on every normal
 * deployment and the orchestrator's own configuration report does not carry the
 * name or the version either -- those are not settings it resolves, they are
 * what it IS. The endpoint's description is the one place both exist together,
 * and it is also the only source that stays right after a release: a link built
 * from anything else names the version somebody meant rather than the one that
 * answered.
 *
 * Read as the app's own service principal, deliberately, and for the same
 * reason `describeServedModel` in the benchmark route is: this is the app's own
 * deployment metadata rather than anybody's governed data, and a reader without
 * CAN VIEW on the endpoint would otherwise be shown "not set" for a model that
 * is plainly there.
 *
 * NOTHING HERE THROWS. It feeds a Settings row, and a Settings pane is what
 * somebody opens to find out why the rest of the app is misbehaving.
 */
import { NO_AGENT_MODEL, agentModelReference, type AgentModelReference } from '../../shared/agent-model';
import { parseServedModel } from './benchmark-runner';

/** How the endpoint is described, injected so the rules are testable offline. */
export type ServingEndpointReader = (name: string) => Promise<unknown>;

async function describeEndpoint(name: string): Promise<unknown> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  // A read of the endpoint's configuration, not an invocation of it, so this is
  // not the `servingEndpoints.query()` the lint rule forbids.
  return new WorkspaceClient({}).servingEndpoints.get({ name });
}

/**
 * The served model, or the honest empty reference.
 *
 * The endpoint's own report of its served entity is preferred over
 * `PLAYER_INSIGHTS_MODEL_NAME` in every case, including the case where the
 * endpoint answered but named no version: a name from the environment is what
 * a release script last wrote down, and this row's whole claim is about what is
 * running now. The environment is the fallback for a read that produced no name
 * at all, which is a bundle deployment that set the variable and an endpoint
 * this app cannot see.
 */
export async function readAgentModel(input: {
  endpointName?: string;
  workspaceHost?: string;
  configuredModel?: string;
  read?: ServingEndpointReader;
} = {}): Promise<AgentModelReference> {
  const endpointName = (input.endpointName ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim();
  const host = input.workspaceHost ?? process.env.DATABRICKS_HOST ?? '';
  const configuredModel = (input.configuredModel ?? process.env.PLAYER_INSIGHTS_MODEL_NAME ?? '').trim();

  let model = '';
  let version = '';
  if (endpointName) {
    try {
      const served = parseServedModel(endpointName, await (input.read ?? describeEndpoint)(endpointName));
      model = served.entityName ?? '';
      version = served.version ?? '';
    } catch (error) {
      console.warn(
        `[settings] The endpoint ${endpointName} could not be asked which model version it serves:`,
        (error as Error).message
      );
    }
  }

  // Traffic split across two versions leaves `parseServedModel` with a name and
  // no version, and that is the correct outcome here too: the registered model
  // is a true destination for a reader, and claiming one of the two versions
  // would attribute the running answers to whichever route happened to be
  // listed first.
  const resolved = model || configuredModel;
  if (!resolved) return NO_AGENT_MODEL;
  return agentModelReference({ host, model: resolved, version: model ? version : '' });
}

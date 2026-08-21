/**
 * Where the running agent's own code can be read, in the workspace.
 *
 * `agent.py` is not in the app container. It is an artifact of the registered
 * model version the serving endpoint is answering out of, and the only place a
 * reader can open the exact code that produced an answer is that version's
 * Artifacts tab in Catalog Explorer. Settings carries the link because Settings
 * is where the rest of "what is this deployment made of" already lives.
 *
 * EVERY FIELD IS ALLOWED TO BE EMPTY, and empty is a fact rather than an error:
 * an app whose `DATABRICKS_HOST` is unset, or whose endpoint would not describe
 * itself, knows no address for its own code, and the row says so instead of
 * offering a link to somewhere. Nothing here names a workspace, a catalog or a
 * version -- the whole reference is read from the live endpoint at request time,
 * which is what keeps one deployment's model out of every other deployment.
 */
import { databricksLink } from './databricks-links';

export interface AgentModelReference {
  /** Three-level Unity Catalog name of the registered model, or '' when unknown. */
  model: string;
  /** The version the endpoint reported serving, or '' when it named none. */
  version: string;
  /**
   * Absolute Catalog Explorer URL, or '' when no honest one can be built.
   *
   * Addresses the served version where {@link version} is known and the
   * registered model otherwise, which is the difference {@link versioned}
   * exists to let a reader be told about.
   */
  url: string;
  /** Whether {@link url} addresses the served version rather than the model. */
  versioned: boolean;
}

/** Nothing was established, which is not the same as nothing being there. */
export const NO_AGENT_MODEL: AgentModelReference = {
  model: '',
  version: '',
  url: '',
  versioned: false,
};

/**
 * The reference, from a host and whatever the endpoint said about itself.
 *
 * Pure and shared so the rule that a half-known name produces no link is
 * assertable without a workspace, and so the server that assembles it and the
 * pane that draws it cannot come to disagree about what "not set" means.
 *
 * A NAME THAT IS NOT THREE LEVELS PRODUCES NO LINK AT ALL. `databricksLink`
 * refuses it, because `catalog.schema` addresses the schema page -- a link that
 * works and is the wrong object, which is worse on this row than no link. The
 * name is still carried, so the pane can show what it knows without offering to
 * open it.
 */
export function agentModelReference(input: {
  host: string;
  model: string;
  version: string;
}): AgentModelReference {
  const model = input.model.trim();
  const version = input.version.trim();
  if (!model) return NO_AGENT_MODEL;
  const versioned = version.length > 0;
  const url =
    databricksLink(
      input.host,
      versioned ? { kind: 'model-version', model, version } : { kind: 'registered-model', model }
    ) ?? '';
  return {
    model,
    version,
    url,
    // Not merely "a version was reported": a version this app could not build a
    // link from must not leave the pane claiming it linked to one.
    versioned: versioned && url.length > 0,
  };
}

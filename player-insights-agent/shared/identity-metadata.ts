/**
 * Authoritative user and app metadata shown in Connections → Identity.
 *
 * Every value is safe deployment context or an identifier. Credentials,
 * request headers, tokens, and control-plane error bodies are deliberately not
 * represented by this contract, so they cannot accidentally cross the API.
 */
export type IdentityMetadataReadState = 'verified' | 'not_reported';

export interface WorkspaceUserMetadata {
  /** SCIM displayName, never derived from the email address. */
  displayName: string;
  /** SCIM object id, only when the workspace returned the matching user. */
  objectId: string;
  state: IdentityMetadataReadState;
  readAt: string;
}

export interface AppIdentityMetadata {
  /** Product-facing name, distinct from the deployment resource name. */
  displayName: 'Astrolabe';
  /** DATABRICKS_APP_NAME, which Databricks Apps injects at runtime. */
  resourceName: string;
  /** Non-secret deployment context. */
  workspaceHost: string;
  /** Only populated from a Databricks control-plane response. */
  workspaceId: string;
}

export interface ControlPlaneIdentityMetadata {
  user: WorkspaceUserMetadata;
  app: AppIdentityMetadata;
}

export const NO_CONTROL_PLANE_IDENTITY_METADATA: ControlPlaneIdentityMetadata = {
  user: { displayName: '', objectId: '', state: 'not_reported', readAt: '' },
  app: { displayName: 'Astrolabe', resourceName: '', workspaceHost: '', workspaceId: '' },
};

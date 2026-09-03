/**
 * Authoritative user, app, and app service-principal metadata shown in Connections → Identity.
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

/** One credential-free Databricks Apps resource binding attached to the app. */
export interface AppAttachedResourceMetadata {
  /** Manifest binding name, retained even when this client does not know the resource kind. */
  resourceKey: string;
  /** Control-plane resource kind, such as postgres, serving_endpoint, or sql_warehouse. */
  resourceType: string;
  /** Concrete database, endpoint, or warehouse identifier shown to the operator. */
  displayIdentifier: string;
  /** Databricks Apps permission reported for this binding, when present. */
  permission: string;
  /** Full safe identifier context for tooltips when the visible label is shortened. */
  title?: string;
}

/** Sanitized fields returned by the Databricks Apps record for this app. */
export interface AppServicePrincipalMetadata {
  displayName: string;
  applicationId: string;
  objectId: string;
  authenticationType: string;
  attachedResources: AppAttachedResourceMetadata[];
  state: IdentityMetadataReadState;
}

export interface ControlPlaneIdentityMetadata {
  user: WorkspaceUserMetadata;
  app: AppIdentityMetadata;
  servicePrincipal: AppServicePrincipalMetadata;
}

export const NO_CONTROL_PLANE_IDENTITY_METADATA: ControlPlaneIdentityMetadata = {
  user: { displayName: '', objectId: '', state: 'not_reported', readAt: '' },
  app: { displayName: 'Astrolabe', resourceName: '', workspaceHost: '', workspaceId: '' },
  servicePrincipal: {
    displayName: '',
    applicationId: '',
    objectId: '',
    authenticationType: '',
    attachedResources: [],
    state: 'not_reported',
  },
};

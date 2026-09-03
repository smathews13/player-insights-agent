export type OpsScopeAssetType = 'Catalog' | 'Schema' | 'Table';
export type OpsScopeStatus = 'in' | 'out';

export interface OpsScopeAsset {
  asset: string;
  type: OpsScopeAssetType;
  userScope: OpsScopeStatus;
  appScope: OpsScopeStatus;
}

export interface OpsScopePrincipal {
  label: string;
  provenance: 'obo' | 'app-service-principal';
}

export interface OpsScopePayload {
  checkedAt: string;
  assets: OpsScopeAsset[];
  user: OpsScopePrincipal;
  app: OpsScopePrincipal;
}

export type OpsScopeAssetType = 'Catalog' | 'Schema' | 'Table';
export type OpsScopeStatus = 'in' | 'out' | 'unavailable';
export type OpsScopeFilter = 'all' | 'catalog' | 'schema' | 'table';

export interface OpsScopeAsset {
  asset: string;
  type: OpsScopeAssetType;
  userScope: OpsScopeStatus;
  appScope: OpsScopeStatus;
}

export interface OpsScopePrincipal {
  label: string;
  provenance: 'obo' | 'app-service-principal';
  availability: 'available' | 'unavailable';
}

export interface OpsScopePage {
  checkedAt: string;
  assets: OpsScopeAsset[];
  user: OpsScopePrincipal;
  app: OpsScopePrincipal;
  nextCursor: string | null;
  moreResults: boolean;
  capped: boolean;
}

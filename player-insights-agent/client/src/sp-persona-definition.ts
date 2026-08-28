import {
  SP_GRANT_MATRIX,
  spGrantIdentifierFault,
  spGrantKey,
  spGrantOption,
  type SpGrant,
  type SpGrantResource,
  type SpGrantResourceType,
  type SpPersonaDefinitionWrite,
} from '../../shared/sp-identity';

export function isSpPersonaDefinitionComplete(write: SpPersonaDefinitionWrite): boolean {
  const legacy = write.legacyCapabilities.map((capability) => capability.trim());
  const grantsComplete = write.grants.every(
    (grant) =>
      !spGrantIdentifierFault(grant.resourceType, grant.resource) &&
      spGrantOption(grant.resourceType, grant.action)?.privilege === grant.privilege
  );
  return (
    write.displayName.trim().length > 0 &&
    write.grants.length + legacy.length > 0 &&
    grantsComplete &&
    legacy.every(Boolean) &&
    new Set(legacy.map((capability) => capability.toLocaleLowerCase())).size === legacy.length &&
    new Set(write.grants.map(spGrantKey)).size === write.grants.length
  );
}

export function newSpGrant(
  resources: readonly SpGrantResource[],
  resourceType: SpGrantResourceType = 'TABLE'
): SpGrant {
  const option = SP_GRANT_MATRIX[resourceType].options[0];
  return {
    resourceType,
    resource: resources.find((resource) => resource.type === resourceType)?.id ?? '',
    action: option.action,
    privilege: option.privilege,
  };
}

export function changeSpGrantType(resourceType: SpGrantResourceType, resources: readonly SpGrantResource[]): SpGrant {
  return {
    ...newSpGrant(resources, resourceType),
    resource: resources.find((resource) => resource.type === resourceType)?.id ?? '',
  };
}

export function changeSpGrantAction(grant: SpGrant, action: SpGrant['action']): SpGrant {
  const option = spGrantOption(grant.resourceType, action);
  return option ? { ...grant, action, privilege: option.privilege } : grant;
}

/**
 * Converts recognizable legacy labels without pretending they named a scope.
 * The structured replacement therefore remains incomplete until the operator
 * chooses a configured resource or enters a validated identifier.
 */
export function grantsFromLegacy(text: string): SpGrant[] {
  const upper = text.toUpperCase();
  if (upper.includes('SQL WAREHOUSE')) return [newSpGrant([], 'SQL_WAREHOUSE')];
  if (upper.includes('GENIE')) return [newSpGrant([], 'GENIE_SPACE')];
  if (upper.includes('VECTOR SEARCH ENDPOINT')) return [newSpGrant([], 'VECTOR_SEARCH_ENDPOINT')];
  if (upper.includes('VECTOR SEARCH')) return [newSpGrant([], 'VECTOR_SEARCH_INDEX')];
  if (upper.includes('SERVING') || upper.includes('MODEL ENDPOINT')) return [newSpGrant([], 'SERVING_ENDPOINT')];
  if (upper.includes('GOVERNED TABLE') || upper.includes('USE CATALOG')) {
    return [newSpGrant([], 'CATALOG'), newSpGrant([], 'SCHEMA'), newSpGrant([], 'TABLE')];
  }
  return [newSpGrant([], 'TABLE')];
}

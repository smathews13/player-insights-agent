import type { SpPersonaDefinitionWrite } from '../../shared/sp-identity';

export function isSpPersonaDefinitionComplete(write: SpPersonaDefinitionWrite): boolean {
  const capabilities = write.capabilities.map((capability) => capability.trim());
  return (
    write.displayName.trim().length > 0 &&
    capabilities.length > 0 &&
    capabilities.every(Boolean) &&
    new Set(capabilities.map((capability) => capability.toLocaleLowerCase())).size === capabilities.length
  );
}

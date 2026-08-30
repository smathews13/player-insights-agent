import {
  SP_GRANT_MATRIX,
  SP_PERSONA_GRANT_COUNT_MAX,
  spGrantIdentifierFault,
  spGrantKey,
  spGrantOption,
  type SpGrant,
  type SpGrantResource,
  type SpGrantResourceType,
  type SpPersonaDefinitionWrite,
} from '../../shared/sp-identity';
import type {
  ResolvedSpPersonaTemplate,
  SpPersonaResourceSelector,
  SpPersonaTemplateVariant,
  SpPersonaTemplateUnresolved,
} from '../../shared/sp-persona-templates';

export const DELETE_PERMISSIONS_CONFIRMATION =
  'Delete this unsaved permissions draft? The persona name, purpose, and permission rows will be cleared.';

export function confirmDeletePermissionsDraft(confirm: (message: string) => boolean): boolean {
  return confirm(DELETE_PERMISSIONS_CONFIRMATION);
}

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
    write.grants.length <= SP_PERSONA_GRANT_COUNT_MAX &&
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

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function labelSegments(value: string): string[] {
  return normalized(value)
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean);
}

export function resourceMatchesSpPersonaSelector(
  resource: SpGrantResource,
  selector: SpPersonaResourceSelector
): boolean {
  if (selector.sources && !selector.sources.includes(resource.source)) return false;
  const label = normalized(resource.label);
  const id = normalized(resource.id);
  if (selector.labels && !selector.labels.some((candidate) => normalized(candidate) === label)) return false;
  if (selector.ids && !selector.ids.some((candidate) => normalized(candidate) === id)) return false;
  if (
    selector.idSuffixes &&
    !selector.idSuffixes.some((suffix) => id === normalized(suffix) || id.endsWith(`.${normalized(suffix)}`))
  ) {
    return false;
  }
  const actualSegments = new Set(labelSegments(label));
  if (selector.labelSegments && !selector.labelSegments.every((segment) => actualSegments.has(normalized(segment)))) {
    return false;
  }
  return true;
}

/**
 * Resolves profile intent only against this deployment's discovered inventory.
 * A single selector with zero or multiple matches remains blank for explicit
 * administrator binding; an all selector expands only the matching resources.
 */
export function resolveSpPersonaTemplateVariant(
  variant: SpPersonaTemplateVariant,
  resources: readonly SpGrantResource[]
): ResolvedSpPersonaTemplate {
  const grants: SpGrant[] = [];
  const rowIds: string[] = [];
  const unresolved: ResolvedSpPersonaTemplate['unresolved'] = [];
  const overflow: ResolvedSpPersonaTemplate['overflow'] = [];
  const keys = new Set<string>();
  const append = (rowId: string, grant: SpGrant): string => {
    if (!grant.resource.trim()) {
      grants.push(grant);
      rowIds.push(rowId);
      return rowId;
    }
    const key = spGrantKey(grant);
    if (keys.has(key)) return rowIds[grants.findIndex((candidate) => spGrantKey(candidate) === key)];
    keys.add(key);
    grants.push(grant);
    rowIds.push(rowId);
    return rowId;
  };
  const matchesFor = (intent: SpPersonaTemplateVariant['grants'][number]) =>
    resources.filter(
      (resource) => resource.type === intent.resourceType && resourceMatchesSpPersonaSelector(resource, intent.selector)
    );
  const expanded = variant.grants
    .map((intent, intentIndex) => ({ intent, intentIndex, matches: matchesFor(intent) }))
    .filter(({ intent }) => intent.selector.match === 'all');

  // Resolve every fixed intent first so a broad expansion can never displace a
  // later semantic grant such as Genie or Vector Search.
  variant.grants.forEach((intent, intentIndex) => {
    if (intent.selector.match === 'all') return;
    const matches = matchesFor(intent);
    const rowId = `intent-${intentIndex}`;
    if (matches.length === 1) {
      append(rowId, {
        resourceType: intent.resourceType,
        resource: matches[0].id,
        action: intent.action,
        privilege: intent.privilege,
      });
      return;
    }
    if (intent.optional) {
      unresolved.push({
        rowId: `optional-intent-${intentIndex}`,
        resourceType: intent.resourceType,
        choiceLabel: intent.selector.choiceLabel,
        candidateCount: matches.length,
        reason: 'selection',
        optional: true,
      });
      return;
    }
    const actualRowId = append(rowId, {
      resourceType: intent.resourceType,
      resource: '',
      action: intent.action,
      privilege: intent.privilege,
    });
    unresolved.push({
      rowId: actualRowId,
      resourceType: intent.resourceType,
      choiceLabel: intent.selector.choiceLabel,
      candidateCount: matches.length,
      reason: 'selection',
    });
  });

  const expandedKeys = new Set(keys);
  let expandedGrantCount = 0;
  for (const { intent, matches } of expanded) {
    for (const resource of matches) {
      const key = spGrantKey({
        resourceType: intent.resourceType,
        resource: resource.id,
        privilege: intent.privilege,
      });
      if (!expandedKeys.has(key)) {
        expandedKeys.add(key);
        expandedGrantCount += 1;
      }
    }
  }
  const requiredGrantCount = grants.length + expandedGrantCount;
  const expansionOverflows = requiredGrantCount > SP_PERSONA_GRANT_COUNT_MAX;

  for (const { intent, intentIndex, matches } of expanded) {
    if (!expansionOverflows && matches.length > 0) {
      matches.forEach((resource, matchIndex) => {
        append(`intent-${intentIndex}-match-${matchIndex}`, {
          resourceType: intent.resourceType,
          resource: resource.id,
          action: intent.action,
          privilege: intent.privilege,
        });
      });
      continue;
    }
    if (intent.optional && matches.length === 0) {
      unresolved.push({
        rowId: `optional-intent-${intentIndex}`,
        resourceType: intent.resourceType,
        choiceLabel: intent.selector.choiceLabel,
        candidateCount: 0,
        reason: 'selection',
        optional: true,
      });
      continue;
    }
    const rowId = append(`intent-${intentIndex}`, {
      resourceType: intent.resourceType,
      resource: '',
      action: intent.action,
      privilege: intent.privilege,
    });
    const selectableCount = Math.max(0, SP_PERSONA_GRANT_COUNT_MAX - grants.length + 1);
    unresolved.push({
      rowId,
      resourceType: intent.resourceType,
      choiceLabel: intent.selector.choiceLabel,
      candidateCount: matches.length,
      reason: expansionOverflows ? 'overflow' : 'selection',
      ...(expansionOverflows ? { selectableCount } : {}),
    });
    if (expansionOverflows) {
      overflow.push({
        rowId,
        choiceLabel: intent.selector.choiceLabel,
        candidateCount: matches.length,
        selectableCount,
        requiredGrantCount,
        grantLimit: SP_PERSONA_GRANT_COUNT_MAX,
        overflowCount: requiredGrantCount - SP_PERSONA_GRANT_COUNT_MAX,
      });
    }
  }
  return { grants, rowIds, unresolved, overflow };
}

export function duplicateSpPersonaGrantRow(
  rowIds: readonly string[],
  unresolved: readonly SpPersonaTemplateUnresolved[],
  index: number,
  newRowId: string
): { rowIds: string[]; unresolved: SpPersonaTemplateUnresolved[] } {
  const sourceRowId = rowIds[index];
  const sourceUnresolved = unresolved.find((selection) => selection.rowId === sourceRowId);
  return {
    rowIds: [...rowIds.slice(0, index + 1), newRowId, ...rowIds.slice(index + 1)],
    unresolved: sourceUnresolved ? [...unresolved, { ...sourceUnresolved, rowId: newRowId }] : [...unresolved],
  };
}

export function removeSpPersonaGrantRow(
  rowIds: readonly string[],
  unresolved: readonly SpPersonaTemplateUnresolved[],
  index: number
): { rowIds: string[]; unresolved: SpPersonaTemplateUnresolved[] } {
  const removedRowId = rowIds[index];
  return {
    rowIds: rowIds.filter((_, item) => item !== index),
    unresolved: unresolved.filter((selection) => selection.rowId !== removedRowId),
  };
}

export function activeSpPersonaUnresolved(
  grants: readonly SpGrant[],
  rowIds: readonly string[],
  unresolved: readonly SpPersonaTemplateUnresolved[]
): SpPersonaTemplateUnresolved[] {
  return unresolved
    .filter((selection) => !selection.optional)
    .filter((selection) => {
      const index = rowIds.indexOf(selection.rowId);
      return index >= 0 && !grants[index]?.resource.trim();
    })
    .sort((left, right) => rowIds.indexOf(left.rowId) - rowIds.indexOf(right.rowId));
}

export function isSpPersonaDraftDirty(write: SpPersonaDefinitionWrite): boolean {
  return Boolean(
    write.displayName.trim() ||
      write.description.trim() ||
      write.grants.length ||
      write.legacyCapabilities.some((capability) => capability.trim())
  );
}

export function spPersonaTemplateUseBlock(editingId: string | null, dirty: boolean): string | null {
  if (editingId) return 'Finish or cancel the current edit first.';
  if (dirty) return 'Delete the current permissions draft before using an example profile.';
  return null;
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

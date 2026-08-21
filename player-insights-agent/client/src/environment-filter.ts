import type { EnvironmentPackage, EnvironmentVariable } from '../../shared/environment-info';

type EnvironmentRow = EnvironmentVariable | EnvironmentPackage;

function searchableValues(row: EnvironmentRow): string[] {
  return 'key' in row ? [row.key, row.value] : [row.name, row.version];
}

export function filterEnvironmentItems<T extends EnvironmentRow>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    searchableValues(item).some((value) => value.toLocaleLowerCase().includes(needle))
  );
}

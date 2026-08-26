/**
 * Which source tables belong on which answer table or chart.
 *
 * A Markdown table does not declare its origin. The prose that introduces it
 * does — "source: silver_player_profiles" — and the answer's `sources` list is
 * the governed set. This module zips those mentions onto the tables in document
 * order so the renderer can put the Databricks link in the table header instead
 * of repeating it in a Sources stack under the grid.
 *
 * Definition-only sources stay off the table: they are not where the numbers
 * came from, and pinning one would be this surface guessing.
 */
import { inlinePlainText, parseAnswerMarkdown, type Block } from './answer-markdown';
import { stripToolCallDumps } from './reader-facing-answer';
import { linkifyEntities } from './data-entities';
import { sourceRows, type SourceRow } from './source-rows';
import type { SourceRef } from './answer-shape';

function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return inlinePlainText(block.children);
    case 'list':
      return block.items.map((item) => inlinePlainText(item.children)).join('\n');
    case 'code':
      return block.text;
    case 'table':
    case 'rule':
      return '';
  }
}

function mentionedNames(text: string, rows: readonly SourceRow[]): string[] {
  if (!text.trim() || rows.length === 0) return [];
  const names = rows.map((row) => row.name);
  const found: string[] = [];
  for (const segment of linkifyEntities(text, names, names)) {
    if (segment.entity && !found.includes(segment.entity)) found.push(segment.entity);
  }
  return found;
}

/** Queried figures, or a source whose role was never recorded. Not definitions. */
function pinable(rows: readonly SourceRow[]): SourceRow[] {
  return rows.filter((row) => row.tone === 'queried' || row.chip === 'Role not recorded');
}

function byName(rows: readonly SourceRow[], name: string): SourceRow | undefined {
  const wanted = name.trim().toLowerCase();
  return rows.find((row) => row.name.toLowerCase() === wanted);
}

function parseBodies(bodies: readonly (string | null | undefined)[]): Block[] {
  return bodies.flatMap((body) => (body ? parseAnswerMarkdown(stripToolCallDumps(body)) : []));
}

function rowsToRefs(rows: readonly SourceRow[], sources: readonly SourceRef[]): SourceRef[] {
  return rows.map((row) => {
    const match = sources.find((source) => source.name.trim().toLowerCase() === row.name.toLowerCase());
    return match ?? { name: row.name, freshness: row.freshness };
  });
}

function originsFromBlocks(blocks: readonly Block[], pin: readonly SourceRow[]): SourceRow[][] {
  const tables = blocks.filter((block) => block.kind === 'table');
  if (tables.length === 0 || pin.length === 0) return tables.map(() => []);

  const mentions: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'table') continue;
    for (const name of mentionedNames(blockText(block), pin)) {
      if (!mentions.includes(name)) mentions.push(name);
    }
  }

  const assigned = new Set<string>();
  const origins: SourceRow[][] = tables.map(() => []);

  const take = (name: string): SourceRow | undefined => {
    const row = byName(pin, name);
    if (!row || assigned.has(row.name.toLowerCase())) return undefined;
    assigned.add(row.name.toLowerCase());
    return row;
  };

  const pinOn = (row: SourceRow): SourceRow => {
    assigned.add(row.name.toLowerCase());
    return row;
  };

  if (tables.length === 1) {
    const names = mentions.length > 0 ? mentions : pin.map((row) => row.name);
    origins[0] = names.map((name) => take(name)).filter((row): row is SourceRow => !!row);
    return origins;
  }

  // Two grids from the same queried table both need the header Open link.
  // Mentions still zip onto tables in order, and a spare pinable still fills
  // a table that has no mention of its own — but a source is not consumed so
  // later tables are origin-less. Sources can drop the duplicate Open once
  // every table that used that object already has it on the header.
  tables.forEach((_, index) => {
    const named = mentions[index] ? byName(pin, mentions[index]) : undefined;
    if (named) {
      origins[index] = [pinOn(named)];
      return;
    }
    const next = pin.find((row) => !assigned.has(row.name.toLowerCase()));
    if (next) {
      origins[index] = [pinOn(next)];
      return;
    }
    const shared =
      (mentions.length > 0 ? byName(pin, mentions[mentions.length - 1]) : undefined) ??
      origins.find((group) => group.length > 0)?.[0] ??
      pin[0];
    origins[index] = [shared];
  });
  return origins;
}

/**
 * One source-row list per Markdown table, in the order the tables appear across
 * the given bodies (narrative then content).
 */
export function tableOriginLists(
  bodies: readonly (string | null | undefined)[],
  sources: readonly SourceRef[]
): SourceRow[][] {
  return originsFromBlocks(parseBodies(bodies), pinable(sourceRows(sources)));
}

/**
 * Table start offset → sources to draw in that table's header, for one parsed
 * body (the answer card's `AnswerProse` tree).
 */
export function tableOriginSources(
  blocks: readonly Block[],
  sources: readonly SourceRef[]
): Map<number, SourceRef[]> {
  const pin = pinable(sourceRows(sources));
  const lists = originsFromBlocks(blocks, pin);
  const map = new Map<number, SourceRef[]>();
  const tables = blocks.filter((block) => block.kind === 'table');
  tables.forEach((table, index) => {
    map.set(table.start, rowsToRefs(lists[index] ?? [], sources));
  });
  return map;
}

/**
 * One origin map per body, zipped from mentions across all of them so a table
 * in `content` still finds the source named in the narrative.
 */
export function tableOriginMaps(
  bodies: readonly (string | null | undefined)[],
  sources: readonly SourceRef[]
): ReadonlyMap<number, SourceRef[]>[] {
  const lists = tableOriginLists(bodies, sources);
  let offset = 0;
  return bodies.map((body) => {
    const tables = body ? parseAnswerMarkdown(stripToolCallDumps(body)).filter((block) => block.kind === 'table') : [];
    const map = new Map<number, SourceRef[]>();
    tables.forEach((table, index) => {
      map.set(table.start, rowsToRefs(lists[offset + index] ?? [], sources));
    });
    offset += tables.length;
    return map;
  });
}

/** Figure sources drawn on a chart group so a plotted answer is not origin-less. */
export function figureSources(sources: readonly SourceRef[]): SourceRef[] {
  return rowsToRefs(pinable(sourceRows(sources)), sources);
}

/**
 * Names that already carry an Open-in-workspace control on a visible table or
 * chart, so the leftover Sources line does not repeat those links.
 */
export function evidenceLinkedSourceNames(
  narrative: string,
  content: string | null | undefined,
  charts: readonly unknown[] | null | undefined,
  sources: readonly SourceRef[]
): string[] {
  const names: string[] = [];
  const hasCharts = Array.isArray(charts) && charts.length > 0;
  const hasTables = parseBodies([narrative, content]).some((block) => block.kind === 'table');
  if (hasTables) {
    for (const group of tableOriginLists([narrative, content], sources)) {
      for (const row of group) {
        if (!names.includes(row.name)) names.push(row.name);
      }
    }
  }
  if (hasCharts) {
    for (const source of figureSources(sources)) {
      if (!names.includes(source.name)) names.push(source.name);
    }
  }
  return names;
}

/** Sources that still belong in the leftover stack. */
export function leftoverSources(sources: readonly SourceRef[], linkedNames: readonly string[]): SourceRef[] {
  const pinned = new Set(linkedNames.map((name) => name.trim().toLowerCase()));
  if (pinned.size === 0) return [...sources];
  return sources.filter((source) => !pinned.has(source.name.trim().toLowerCase()));
}

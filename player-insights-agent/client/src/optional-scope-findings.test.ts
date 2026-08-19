import { describe, expect, it } from 'vitest';

import {
  OPTIONAL_SCOPES_CHIP,
  isOptionalScopeShortfall,
  optionalScopeNote,
  splitOptionalScopeFindings,
} from './optional-scope-findings';
import { OPTIONAL_USER_API_SCOPES } from '../../shared/optional-user-api-scopes';
import type { PreflightCheck } from './preflight';

/**
 * WHICH BLOCKED CHECKS THE "WHAT TO FIX" PANEL IS ALLOWED TO HOLD.
 *
 * The live example screen carried four blocks under that heading and three of them
 * were the catalog, the schema and twelve tables, all refused over the three
 * catalog reads `shared/optional-user-api-scopes.ts` records as OPTIONAL. The
 * login gate and the Identity card already draw those neutrally. This page was
 * still telling a reader to go and repair them.
 *
 * Asserted here rather than only through the markup because the interesting
 * claims are about which population a check belongs to, and the two that would
 * cost the most to get wrong are silent: a real finding hidden as optional, and a
 * refusal counted as a failure.
 */

function check(id: string, over: Partial<PreflightCheck> = {}): PreflightCheck {
  return {
    id,
    kind: 'dependency',
    name: '',
    label: id,
    status: 'unverified',
    stopped: 'refused',
    detail: '',
    checked_with: '',
    duration_ms: 0,
    error: 'HTTP 403',
    remedy: null,
    ...over,
  };
}

const CATALOG = check('catalog', { label: 'Catalog', scope: 'catalog.catalogs:read' });
const SCHEMA = check('schema', { label: 'Schema', scope: 'catalog.schemas:read' });
const TABLES = Array.from({ length: 12 }, (_unused, index) =>
  check(`table:t${index}`, { kind: 'table', scope: 'catalog.tables:read' })
);
/**
 * Vector Search browse joined the optional set on Sam's 2026-08-18 call, so its
 * refusal is now a neutral shortfall like catalog rather than a finding.
 */
const SEMANTIC_INDEX = check('semantic-index', {
  label: 'Vector Search index',
  scope: 'vectorsearch.vector-search-indexes:read',
});
/** An ask-path scope that is still required, so its refusal stays a finding. */
const WAREHOUSE = check('warehouse', { label: 'SQL warehouse', scope: 'sql' });

describe('which refusals are a reader’s to fix', () => {
  it('treats every optional scope read as a shortfall rather than a finding', () => {
    for (const scope of OPTIONAL_USER_API_SCOPES) {
      expect(isOptionalScopeShortfall(check('c', { scope }))).toBe(true);
    }
  });

  /**
   * A refusal over a scope the app genuinely needs for asks -- `sql`,
   * `dashboards.genie`, serving -- is not optional and stays a finding. This is
   * the reason the check is set membership against the optional list rather than
   * "anything with a scope": it must not sweep out a permission somebody has to
   * act on.
   */
  it('keeps a refusal over a required ask-path permission as a finding', () => {
    expect(isOptionalScopeShortfall(WAREHOUSE)).toBe(false);
  });

  /**
   * Vector Search browse is now optional (Sam's call): it browses VS from the
   * app's forwarded token, and ask-time semantic retrieval runs on the model's
   * own token, so an app-side VS refusal is a neutral shortfall.
   */
  it('treats a Vector Search browse refusal as an optional shortfall', () => {
    expect(isOptionalScopeShortfall(SEMANTIC_INDEX)).toBe(true);
  });

  /**
   * D6 AND D8, AS A FILTER. A failure was established ABOUT THE OBJECT: the call
   * reached it and the workspace refused this identity on it. No optional
   * permission explains that away, so the verdict is part of the test and not
   * only the scope name.
   */
  it('never moves a failure out of the panel, whatever permission it names', () => {
    const failed = check('table', {
      status: 'failed',
      stopped: undefined,
      scope: 'catalog.tables:read',
    });
    expect(isOptionalScopeShortfall(failed)).toBe(false);
    expect(splitOptionalScopeFindings([failed]).required).toHaveLength(1);
  });

  /**
   * A check that never got as far as a refusal names no permission, and reading
   * that silence as "an optional one, probably" is how a real finding disappears.
   */
  it('keeps a check that named no permission in the panel', () => {
    const unasked = check('vs-endpoint', { stopped: 'unasked', error: '' });
    expect(isOptionalScopeShortfall(unasked)).toBe(false);
    expect(isOptionalScopeShortfall(check('x', { scope: '' }))).toBe(false);
    expect(isOptionalScopeShortfall(check('y', { scope: '   ' }))).toBe(false);
    expect(splitOptionalScopeFindings([unasked]).required).toHaveLength(1);
  });
});

describe('the split the panel is drawn from', () => {
  /**
   * The live screen, as it arrived, plus a genuinely-required warehouse refusal:
   * fifteen optional shortfalls (catalog, schema, twelve tables, VS index) and
   * one finding (the warehouse). VS is optional now, so it is a shortfall.
   */
  const split = splitOptionalScopeFindings([CATALOG, SCHEMA, ...TABLES, SEMANTIC_INDEX, WAREHOUSE]);

  it('leaves the panel holding only what somebody has to act on', () => {
    expect(split.required).toEqual([WAREHOUSE]);
  });

  it('names each optional permission once, in the order it was met', () => {
    expect(split.optional.scopes).toEqual([
      'catalog.catalogs:read',
      'catalog.schemas:read',
      'catalog.tables:read',
      'vectorsearch.vector-search-indexes:read',
    ]);
    expect(split.optional.checks).toHaveLength(15);
  });

  /**
   * ONE POPULATION, NEVER A SUM. The refused checks are counted alone. A line
   * that added the failures in would be reporting a number a reader can disprove
   * by counting the screen, and would be calling a refusal a failure to do it.
   */
  it('counts the refusals without the failures beside them', () => {
    const mixed = splitOptionalScopeFindings([
      ...TABLES,
      check('t-failed', { status: 'failed', stopped: undefined, scope: 'catalog.tables:read' }),
    ]);
    expect(mixed.optional.checks).toHaveLength(12);
    expect(mixed.required).toHaveLength(1);
  });

  it('keeps both halves in the order the report produced them', () => {
    const ordered = splitOptionalScopeFindings([WAREHOUSE, CATALOG, SCHEMA, SEMANTIC_INDEX]);
    expect(ordered.required.map((entry) => entry.id)).toEqual(['warehouse']);
    expect(ordered.optional.checks.map((entry) => entry.id)).toEqual([
      'catalog',
      'schema',
      'semantic-index',
    ]);
  });
});

describe('what the neutral line is allowed to say', () => {
  const note = optionalScopeNote(14);

  /**
   * NO CAUSE. Three different things produce these refusals, they are fixed by
   * three different people, and one line covering all three may not name any of
   * them. This is the rule `shared/stated-cause.ts` exists for, applied to copy
   * this file owns.
   */
  it('asserts nothing about why the permissions were refused', () => {
    expect(note).not.toMatch(/because|older than|not been (restarted|declared)/i);
    expect(note).not.toMatch(/you have not|you did not|sign in again/i);
  });

  /**
   * The distinction the whole panel is careful about, kept in the short version.
   * A reader who takes this line for "you cannot see those tables" has been told
   * something nothing on this page established.
   */
  it('says the checks stopped short of the object rather than that access failed', () => {
    expect(note).toContain('before reaching the object');
    expect(note).not.toMatch(/failed|no access|cannot (read|reach|see)/i);
  });

  it('names the population its count is over', () => {
    expect(optionalScopeNote(14)).toContain('14 checks on this page');
    expect(optionalScopeNote(1)).toContain('one check on this page');
    expect(optionalScopeNote(1)).not.toContain('1 checks');
  });

  /** DECISIONS.md D9, on copy a reader reaches. */
  it('uses no em dash', () => {
    expect(note).not.toContain('\u2014');
    expect(OPTIONAL_SCOPES_CHIP).not.toContain('\u2014');
  });

  /**
   * The word on the chip is this page's verdict, not the gate's grant state. The
   * gate compares the token's own scope list and has earned "Not granted"; a
   * refusal establishes only that the workspace stopped the call over the
   * permission, so borrowing that word here would claim more than was read.
   */
  it('reports the refusal rather than a grant nobody read', () => {
    expect(OPTIONAL_SCOPES_CHIP).toBe('Refused');
  });
});

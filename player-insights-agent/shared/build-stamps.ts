/**
 * Whether two build stamps name the same commit, an ancestor on the same
 * lineage, or a genuine divergence.
 *
 * The app and the orchestrator are released separately, so a deployment can
 * run an app from one commit against a model logged from an ancestor of that
 * commit. That is ordinary freshness drift, not an error. Two hashes that
 * share no ancestry (or where ancestry cannot be proved) are the alarming case.
 *
 * Ancestry is only claimed when the app build stamped a list of commits
 * reachable from its HEAD (`PLAYER_INSIGHTS_BUILD_ANCESTORS`). Without that
 * list every mismatch stays `different` — never assumed same-lineage.
 */

/** The suffix `scripts/bundle-server.mjs` stamps on a build from a dirty tree. */
export const DIRTY_SUFFIX = '+dirty';

/** How much of a hash the page prints. The rest is copy and `title` content. */
export const SHORT_SHA_LENGTH = 8;

/**
 * The shortest stamp this module will compare, in characters.
 *
 * Seven, which is git's own default abbreviation length.
 */
export const MIN_ABBREV = 7;

/** The commit, without the build's opinion of the working tree. */
export function commitOf(sha: string): string {
  const trimmed = sha.trim();
  return trimmed.endsWith(DIRTY_SUFFIX) ? trimmed.slice(0, -DIRTY_SUFFIX.length) : trimmed;
}

/** Whether this artifact was built from a tree with uncommitted changes. */
export function builtDirty(sha: string): boolean {
  return sha.trim().endsWith(DIRTY_SUFFIX);
}

/**
 * What the two stamps establish about each other.
 *
 * `ancestor` means one stamp identifies a commit in the other's known lineage
 * (the app's baked ancestor list). It is informational freshness, not an error.
 */
export type CommitAgreement = 'same' | 'ancestor' | 'different' | 'unidentifiable' | 'uncompared';

/**
 * Whether `stamp` identifies the same commit as `candidate` under git's
 * abbreviation rule (prefix, case-folded, at or above {@link MIN_ABBREV}).
 */
export function stampsAgree(stamp: string, candidate: string): boolean {
  const a = commitOf(stamp).toLowerCase();
  const b = commitOf(candidate).toLowerCase();
  if (!a || !b) return false;
  if (a.length < MIN_ABBREV || b.length < MIN_ABBREV) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter);
}

/**
 * Whether two build stamps name the same commit, a known ancestor, or diverge.
 *
 * `ancestors` is the list of commits reachable from the APP build's HEAD
 * (including HEAD), stamped at bundle time. When the model stamp matches one of
 * those commits and is not the app stamp itself, the result is `ancestor`.
 */
export function compareCommits(appSha: string, modelSha: string, ancestors: readonly string[] = []): CommitAgreement {
  const app = commitOf(appSha).toLowerCase();
  const model = commitOf(modelSha).toLowerCase();
  if (!app || !model) return 'uncompared';
  if (app.length < MIN_ABBREV || model.length < MIN_ABBREV) return 'unidentifiable';
  if (stampsAgree(app, model)) return 'same';

  // Only claim same-lineage when the app actually stamped ancestors. Without
  // that list, a mismatch cannot be demoted to freshness — it stays different.
  if (ancestors.length === 0) return 'different';

  const modelIsKnownAncestor = ancestors.some((entry) => stampsAgree(model, entry));
  if (modelIsKnownAncestor) return 'ancestor';

  return 'different';
}

/** Parse the space-separated ancestor env stamped by bundle-server.mjs. */
export function parseAncestorList(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return [];
  return raw
    .trim()
    .split(/[\s,]+/)
    .map((entry) => commitOf(entry))
    .filter((entry) => entry.length >= MIN_ABBREV);
}

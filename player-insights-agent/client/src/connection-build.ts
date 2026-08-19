/**
 * What was built, and whether the two halves were built from the same thing.
 *
 * The app and the orchestrator are released separately, so a deployment can be
 * running an app from one commit against a model logged from another. That is
 * the single most expensive fact to be wrong about on this page: every value
 * below it is read back from one half or the other, and two halves from
 * different commits can disagree about the deployment while both report
 * honestly.
 *
 * Same-lineage ancestor drift (model behind app on the stamped ancestor list)
 * is informational freshness, not an error. Genuine divergence stays red.
 *
 * `+dirty` NEVER LEAVES THIS MODULE. `scripts/bundle-server.mjs` stamps the
 * suffix onto a build made from a working tree with uncommitted changes.
 */

import {
  builtDirty,
  commitOf,
  compareCommits,
  SHORT_SHA_LENGTH,
  type CommitAgreement,
} from '../../shared/build-stamps';

export {
  builtDirty,
  commitOf,
  compareCommits,
  MIN_ABBREV,
  SHORT_SHA_LENGTH,
  type CommitAgreement,
} from '../../shared/build-stamps';

/**
 * One artifact's row in the Build card.
 *
 * `full` is what the copy button puts on the clipboard and what the `title`
 * carries; `short` is the only part that renders. `tone` is `plain` where there
 * is no commit at all, because an unset value is not a failing one -- the row
 * says `not set` and stays quiet, which is the page's rule everywhere else.
 */
export interface BuildArtifact {
  key: string;
  label: string;
  short: string;
  full: string;
  tone: 'reachable' | 'blocked' | 'plain' | 'drifted';
}

export interface BuildFacts {
  artifacts: BuildArtifact[];
  /**
   * Why the rows are tinted, one short line per condition that holds. Empty on a
   * clean matched build, so nothing renders.
   */
  notes: string[];
  /** Whether the two artifacts name divergent histories (not ancestor drift). */
  differ: boolean;
  agreement: CommitAgreement;
}

/**
 * The card's whole content, from the two hashes the settings payload carries.
 *
 * Green is the narrow claim: this artifact was built from a committed tree AND
 * the other artifact was built from the same commit. Ancestor drift is untinted
 * (or amber for dirty) with an informational note. Genuine divergence is red.
 */
export function buildFacts(input: {
  appBuildSha: string;
  modelBuildSha: string;
  /** Commits reachable from the app build's HEAD, including HEAD. */
  appBuildAncestors?: readonly string[];
}): BuildFacts {
  const app = input.appBuildSha.trim();
  const model = input.modelBuildSha.trim();
  const ancestors = input.appBuildAncestors ?? [];
  const agreement = compareCommits(app, model, ancestors);
  const differ = agreement === 'different';
  const dirty = builtDirty(app) || builtDirty(model);

  const artifact = (key: string, label: string, sha: string): BuildArtifact => {
    const commit = commitOf(sha);
    if (!commit) return { key, label, short: '', full: '', tone: 'plain' };
    let tone: BuildArtifact['tone'] = 'reachable';
    if (builtDirty(sha) || differ) tone = 'blocked';
    else if (agreement === 'unidentifiable') tone = 'plain';
    else if (agreement === 'ancestor') tone = 'plain';
    return {
      key,
      label,
      short: commit.slice(0, SHORT_SHA_LENGTH),
      full: commit,
      tone,
    };
  };

  return {
    artifacts: [artifact('app', 'App', app), artifact('orchestrator', 'Orchestrator', model)],
    notes: [
      differ
        ? 'Different commits: the app and the orchestrator were not built from the same one, and ancestry could not be confirmed.'
        : '',
      agreement === 'ancestor'
        ? 'Same lineage, different commits: the orchestrator was logged from an ancestor of this app build. That is normal between separate deploys.'
        : '',
      agreement === 'unidentifiable'
        ? `Not comparable: a stamp shorter than 7 characters does not identify a commit, so whether these two agree is unknown.`
        : '',
      dirty ? 'Uncommitted changes: one half was built from a tree with edits that were never committed.' : '',
    ].filter(Boolean),
    differ,
    agreement,
  };
}

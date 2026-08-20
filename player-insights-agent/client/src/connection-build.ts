/** The real build stamps shown for the app and orchestrator. */
import { commitOf, SHORT_SHA_LENGTH } from '../../shared/build-stamps';

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
}

/**
 * The card identifies each artifact without judging the relationship between
 * them. App and orchestrator releases are independent, so mismatch colouring
 * and drift banners created noise without giving the reader an action.
 */
export function buildFacts(input: {
  appBuildSha: string;
  modelBuildSha: string;
  /** Commits reachable from the app build's HEAD, including HEAD. */
  appBuildAncestors?: readonly string[];
}): BuildFacts {
  const app = input.appBuildSha.trim();
  const model = input.modelBuildSha.trim();

  const artifact = (key: string, label: string, sha: string): BuildArtifact => {
    const commit = commitOf(sha);
    if (!commit) return { key, label, short: '', full: '', tone: 'plain' };
    return {
      key,
      label,
      short: commit.slice(0, SHORT_SHA_LENGTH),
      full: commit,
      tone: 'plain',
    };
  };

  return {
    artifacts: [artifact('app', 'App', app), artifact('orchestrator', 'Orchestrator', model)],
  };
}

/** The real build stamps shown for the app and orchestrator. */
import { commitOf, SHORT_SHA_LENGTH } from '../../shared/build-stamps';
import { endpointTone } from './build-card';
import type { AstPillFamily } from './astrolabe-pill';
import type { ConnectionStatus } from './connection-status';
import type { AppFacts } from '../../shared/app-facts';
import type { StatusTone } from './StatusBadge';

export {
  builtDirty,
  commitOf,
  compareCommits,
  MIN_ABBREV,
  SHORT_SHA_LENGTH,
  type CommitAgreement,
} from '../../shared/build-stamps';

/**
 * Whether the half of the deployment this row names is working.
 *
 * THE ROW USED TO BE A VERSION STAMP AND NOTHING ELSE. Two eight-character
 * hashes in grey, one labelled App and one Orchestrator, on the tab whose whole
 * job is to say what this deployment can reach. The commit answers "which build
 * am I looking at" and the reader of these two rows is also asking "and is it
 * up", which nothing on the row answered: a crashed app and a healthy one drew
 * the same grey hash.
 *
 * FOUR STATES, NOT TWO, AND THE FOURTH DRAWS NOTHING. `working` and
 * `not-working` are the green and the red, and they are the point. `unclear` is
 * the reading that ran and settled nothing -- a workspace call the permission
 * layer refused never reached the endpoint, so it is not evidence the
 * orchestrator is down and must not be painted as though it were. `unknown` is
 * no reading at all, and it gets no pill: this page's oldest rule is that an
 * absence reads as a fact nobody established rather than as a fault, and a badge
 * asserting health nothing measured is the defect the endpoint tone and the
 * exporter tone were both fixed for.
 */
export type HealthState = 'working' | 'not-working' | 'unclear' | 'unknown';

/**
 * A health reading as the row draws it.
 *
 * `label` is a word because a colour is not a fact a screen reader can read, and
 * `note` is why it says that, carried in the pill's `title` so a reader who
 * wants the evidence does not have to go looking for the section that holds it.
 * Both are '' on `unknown`, where nothing renders.
 */
export interface ArtifactHealth {
  state: HealthState;
  label: string;
  note: string;
}

/** Green, red, amber, and nothing -- in the page's own tone vocabulary. */
export const HEALTH_TONE: Record<HealthState, StatusTone> = {
  working: 'reachable',
  'not-working': 'blocked',
  unclear: 'drifted',
  unknown: 'plain',
};

/**
 * Which pill family the word takes.
 *
 * `unknown` is deliberately not a key: there is no family for it because there is
 * no pill, and a `Record` over every state would let a caller draw one.
 */
export const HEALTH_FAMILY: Record<Exclude<HealthState, 'unknown'>, AstPillFamily> = {
  working: 'pos',
  'not-working': 'neg',
  unclear: 'warn',
};

/**
 * One artifact's row in the Build card.
 *
 * `full` is what the copy button puts on the clipboard and what the `title`
 * carries; `short` is the only part that renders. `tone` is the HEALTH reading's
 * tone, so the identifier is itself green or red, and `plain` where nothing
 * measured this half -- including on a row with no commit at all, because an
 * unset value is not a failing one.
 */
export interface BuildArtifact {
  key: string;
  label: string;
  short: string;
  full: string;
  tone: StatusTone;
  health: ArtifactHealth;
}

export interface BuildFacts {
  artifacts: BuildArtifact[];
}

const UNKNOWN_HEALTH: ArtifactHealth = { state: 'unknown', label: '', note: '' };

/**
 * Whether the app itself is up.
 *
 * TWO READINGS, AND THE PLATFORM'S GOES FIRST WHERE IT IS DEFINITE. `serving`
 * is what the workspace says about the application and the container it runs in,
 * read through `endpointTone` so this row and the App endpoint row above it
 * cannot disagree about one app: both halves good is the only green there, and a
 * crashed or unavailable app is the only red.
 *
 * THE FALLBACK IS THE READ THAT PRODUCED THIS PAGE. Where the workspace reported
 * a transitional state, or reported nothing -- a laptop with no Apps API in
 * front of it reports nothing at all -- the app having answered `/api/settings`
 * is direct evidence it is serving, because that answer is what drew the row.
 * It is stated as `Answering` rather than as `Running`: the platform's word is a
 * claim about the deployment and this is a claim about one request, and the two
 * are not the same fact.
 */
export function appHealth(input: {
  serving?: AppFacts['serving'];
  /** Whether the app answered this page's own read of its settings. */
  answered?: boolean;
}): ArtifactHealth {
  const serving = input.serving;
  const tone = serving ? endpointTone(serving) : 'plain';
  if (tone === 'blocked') {
    const state = [serving?.app, serving?.compute].filter(Boolean).join(' \u00b7 ');
    return {
      state: 'not-working',
      label: 'Not running',
      note: state
        ? `The workspace reports the app as ${state}.`
        : 'The workspace reports the app as not running.',
    };
  }
  if (tone === 'reachable') {
    return { state: 'working', label: 'Running', note: 'The workspace reports the app running on active compute.' };
  }
  if (input.answered) {
    return {
      state: 'working',
      label: 'Answering',
      note: 'This app answered the read that drew this page.',
    };
  }
  return UNKNOWN_HEALTH;
}

/**
 * Whether the orchestrator -- the serving endpoint a question is actually run
 * against -- is reachable.
 *
 * THE PROBE OUTRANKS THE SELF-REPORT, and the order matters. `status` is the
 * verdict of the check made against the endpoint on this pass, in the words the
 * rest of this page uses for the same metadata call; `reported` is the served
 * model version having answered with its own configuration, which is real
 * positive evidence and is the only evidence on a deployment where no check ran.
 * A live call that came back refused or broken is the fresher fact, so it wins.
 *
 * A REFUSAL IS NOT A RED. The call stopped at the permission layer and never
 * reached the endpoint, so it establishes nothing about whether the orchestrator
 * is up; painting it red sends a reader after a service that is fine. That is
 * the rule `connection-status.ts` states for the row-level badge, and this is
 * the same reading.
 */
export function orchestratorHealth(input: {
  status?: ConnectionStatus;
  /** Whether the served model version reported its own configuration. */
  reported?: boolean;
}): ArtifactHealth {
  if (input.status === 'reachable') {
    return { state: 'working', label: 'Reachable', note: 'The serving endpoint was reached and it answered.' };
  }
  if (input.status === 'blocked') {
    return {
      state: 'not-working',
      label: 'Blocked',
      note: 'Something tried to reach the serving endpoint and could not.',
    };
  }
  if (input.status === 'unreachable') {
    return {
      state: 'not-working',
      label: 'Unreachable',
      note: 'The call to the serving endpoint did not complete.',
    };
  }
  if (input.status === 'refused') {
    return {
      state: 'unclear',
      label: 'Refused',
      note:
        'The workspace refused this call, so nothing was established about the endpoint itself. A refusal is ' +
        'answered by a permission rather than by trying again.',
    };
  }
  if (input.reported) {
    return {
      state: 'working',
      label: 'Answered',
      note: 'The served model version reported its own configuration on this pass.',
    };
  }
  return UNKNOWN_HEALTH;
}

/**
 * The card identifies each artifact and says whether that half is working.
 *
 * It still does not judge the RELATIONSHIP between the two commits. App and
 * orchestrator releases are independent, so mismatch colouring and drift banners
 * created noise without giving the reader an action -- the colour here is a
 * health reading of each half on its own, which is a different claim.
 */
export function buildFacts(input: {
  appBuildSha: string;
  modelBuildSha: string;
  /** Commits reachable from the app build's HEAD, including HEAD. */
  appBuildAncestors?: readonly string[];
  /** What the workspace said about the app, for the App row's badge. */
  appServing?: AppFacts['serving'];
  /** Whether the app answered this page's own read. */
  appAnswered?: boolean;
  /** The serving endpoint check's verdict, for the Orchestrator row's badge. */
  orchestratorStatus?: ConnectionStatus;
  /** Whether the served model version reported its own configuration. */
  orchestratorReported?: boolean;
}): BuildFacts {
  const app = input.appBuildSha.trim();
  const model = input.modelBuildSha.trim();

  const artifact = (key: string, label: string, sha: string, health: ArtifactHealth): BuildArtifact => {
    const commit = commitOf(sha);
    // A stamp nothing reported is never tinted, whatever the health reading says:
    // the badge would then be a green or red `not set`, which reads as a verdict
    // about the absence rather than about the half of the deployment it names.
    // The health pill beside it still draws, because whether the app is up is a
    // separate fact from whether it stamped its build.
    if (!commit) return { key, label, short: '', full: '', tone: 'plain', health };
    return {
      key,
      label,
      short: commit.slice(0, SHORT_SHA_LENGTH),
      full: commit,
      tone: HEALTH_TONE[health.state],
      health,
    };
  };

  return {
    artifacts: [
      artifact('app', 'App', app, appHealth({ serving: input.appServing, answered: input.appAnswered })),
      artifact(
        'orchestrator',
        'Orchestrator',
        model,
        orchestratorHealth({ status: input.orchestratorStatus, reported: input.orchestratorReported })
      ),
    ],
  };
}

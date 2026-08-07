/**
 * What the app-wide storage banner says, decided apart from how it is drawn.
 *
 * WHY THIS IS NOT JUST JSX IN `App.tsx`. The banner is the only place a
 * deployer is told that the figures on screen are invented, and it has to say
 * three different things for three states that look identical from the outside.
 * Getting the wrong one is not a cosmetic bug: telling somebody their database
 * is unreachable when it is answering and refusing sends them to the Lakebase
 * console for an afternoon, and the correct remedy (one script, run once), is
 * never reached. That decision is worth testing, and a decision buried in a
 * component's render is not testable without a browser.
 */
import {
  GRANT_SCRIPT_COMMAND,
  GRANT_SCRIPT_ENV_VARS,
  GRANT_SCRIPT_PATH,
  GRANT_SCRIPT_WHY,
} from '../../shared/setup-remedies';

/** What `GET /api/storage` reports about the app's own Postgres store. */
export interface StorageHealth {
  state: 'unknown' | 'ok' | 'unavailable';
  since: string;
  last_ok_at: string | null;
  last_error: { message: string; code: string; route: string; at: string } | null;
  /** Whether reads that succeeded found anything. Independent of `state`. */
  content: 'unknown' | 'populated' | 'empty';
  /**
   * Whether Postgres is refusing the app rather than failing to answer it.
   *
   * Optional because the browser and the server are deployed as one artefact
   * but cached separately, and a page held from before this field existed must
   * not read `undefined` as `denied`. Absent falls through to the outage
   * wording, which is what it said before and is never a fabrication, only
   * less specific than it could be.
   */
  access?: 'unknown' | 'ok' | 'denied';
}

export type BannerTone = 'blocking' | 'neutral';

export interface BannerNotice {
  tone: BannerTone;
  /** The bolded clause. Says what is being shown, before why. */
  heading: string;
  /** The explanation, one paragraph, no line breaks. */
  detail: string;
  /** The literal thing to run or do, or `null` when there is nothing to fix. */
  remedy: string | null;
  /** Sentence under the remedy explaining why it is manual. */
  remedyNote: string | null;
}

/**
 * The three states worth interrupting a reader for, and nothing else.
 *
 * Returns `null` for a healthy populated store: a correctly configured
 * deployment shows no banner at all, which is the property that keeps the other
 * three readable. A warning that is always on is furniture.
 */
export function storageBannerNotice(health: StorageHealth | null): BannerNotice | null {
  if (!health) return null;

  // Checked before `state`, because a denied store is also an unavailable one
  // and the generic branch would otherwise swallow it. This is the ordering the
  // server uses in `lakebaseStorageCheck` too: the specific diagnosis wins
  // wherever both apply, in both places, so the two cannot disagree.
  if (health.access === 'denied') {
    return {
      tone: 'blocking',
      heading: 'Showing representative data. The app has not been granted access to its own database.',
      detail:
        'Postgres is answering and refusing the reads: the app service principal has no privileges on the ' +
        'player_insights schema, so conversations, runs and benchmark results below are seeded demo values ' +
        'rather than stored records, and nothing you do here is being saved. This is not an outage and it ' +
        'will not clear on its own. It is the state a deployment is in until the grant script has been run ' +
        `once${health.last_ok_at ? ', or since the grant was removed' : ''}.`,
      remedy: GRANT_SCRIPT_COMMAND,
      remedyNote:
        `All ${GRANT_SCRIPT_ENV_VARS.length} variables are required and none has a default ` +
        `(${GRANT_SCRIPT_ENV_VARS.join(', ')}). ${GRANT_SCRIPT_WHY} Redeploying does not perform it. ` +
        `See ${GRANT_SCRIPT_PATH}.`,
    };
  }

  if (health.state === 'unavailable') {
    return {
      tone: 'blocking',
      heading: 'Showing representative data: Lakebase is unreachable.',
      detail:
        `The app has not been able to read Lakebase since ${health.since}` +
        (health.last_ok_at ? ` (last successful read ${health.last_ok_at})` : '') +
        ', so conversations, runs and benchmark results below are seeded demo values. This is a broken ' +
        'connection, not an empty database.',
      remedy: null,
      remedyNote: null,
    };
  }

  // Neutral, not a warning. An empty store is a healthy database with nothing
  // in it yet (the ordinary state of a deployment on the day it is handed over
  //), and styling it as a fault teaches a deployer to dismiss the banner, which
  // is the one thing the branches above cannot survive.
  if (health.content === 'empty') {
    return {
      tone: 'neutral',
      heading: 'Showing representative data. Nothing stored yet.',
      detail:
        'Lakebase is connected and answering; it simply holds no conversations, runs or benchmark results, ' +
        'so the figures below are seeded examples. Ask a question and your own history replaces them.',
      remedy: null,
      remedyNote: null,
    };
  }

  return null;
}

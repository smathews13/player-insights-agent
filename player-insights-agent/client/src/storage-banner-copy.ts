/**
 * What the app-wide storage banner says, decided apart from how it is drawn.
 *
 * WHY THIS IS NOT JUST JSX IN `App.tsx`. The banner has to say three different
 * things for three states that look identical from the outside: a store that
 * refused the read, one that could not be reached, and one that answered and
 * holds nothing.
 * Getting the wrong one is not a cosmetic bug: telling somebody their database
 * is unreachable when it is answering and refusing sends them to the Lakebase
 * console for an afternoon, and the correct release hook is
 * never reached. That decision is worth testing, and a decision buried in a
 * component's render is not testable without a browser.
 */
import {
  GIT_GRANT_COMMAND,
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
  /**
   * The visible line under the heading: what this means for the reader, and
   * whether waiting helps. At most two short sentences.
   *
   * IT USED TO BE THE WHOLE EXPLANATION. This banner sits under the header on
   * every page in the app, so its paragraph was the most-read copy here, and it
   * ran to four or five lines of why-a-blank-list-is-not-a-zero before it got to
   * anything the reader could act on. The distinctions were right; their place
   * on screen was not. They are in `reasoning` now.
   */
  detail: string;
  /**
   * The distinctions behind the line above, for the reader who wants them.
   *
   * Kept rather than cut. Each of these sentences exists because somebody read
   * the state wrongly once: a denial mistaken for an outage sends a deployer to
   * the Lakebase console, and an unreadable list mistaken for an empty one reads
   * as data loss. Drawn behind a collapsed disclosure, so it is one click away
   * instead of in front of the status.
   */
  reasoning: string | null;
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
      heading: 'The app has not been granted access to its own database.',
      // The two facts that change what the reader does next: nothing is being
      // kept, and waiting is not a plan. Everything else is below.
      detail: 'Nothing below was read and nothing you do here is being saved. This will not clear on its own.',
      reasoning:
        'Postgres is answering and refusing the reads: the app service principal has no privileges on the ' +
        'app-owned schema, so the conversations, runs and benchmark results below are blank because ' +
        'they could not be read, not because there are none. This is not an outage. It is the state a ' +
        'deployment is in until database CREATE has been granted ' +
        `once${health.last_ok_at ? ', or since the grant was removed' : ''}.`,
      remedy: GIT_GRANT_COMMAND,
      remedyNote: GRANT_SCRIPT_WHY,
    };
  }

  if (health.state === 'unavailable') {
    return {
      tone: 'blocking',
      heading: 'Lakebase is unreachable, so nothing below is your stored history.',
      detail:
        `The app has not been able to read Lakebase since ${health.since}` +
        (health.last_ok_at ? ` (last successful read ${health.last_ok_at})` : '') +
        '.',
      reasoning:
        'The lists below are blank because they could not be read. A blank list here is not a count of ' +
        'zero and your history has not been lost. This is a broken connection, not an empty database.',
      remedy: null,
      remedyNote: null,
    };
  }

  // Neutral, not a warning. An empty store is a healthy database with nothing in
  // it yet, which is the ordinary state of a deployment on the day it is handed
  // over, and styling it as a fault teaches a deployer to dismiss the banner,
  // which is the one thing the branches above cannot survive.
  if (health.content === 'empty') {
    return {
      tone: 'neutral',
      heading: 'Nothing stored yet.',
      detail: 'Lakebase is connected and answering, and holds no conversations, runs or benchmark results yet.',
      reasoning: null,
      remedy: null,
      remedyNote: null,
    };
  }

  return null;
}

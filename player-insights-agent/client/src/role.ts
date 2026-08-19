/**
 * What the reader may open, and how the header says so.
 *
 * NOTHING IN THIS FILE IS A PERMISSION. The server refuses a consumer at every
 * admin route with 403, whatever this module decides, and that refusal is the
 * permission model. What is here is layout: which entries the navigation
 * advertises, whether the gear is drawn, and what the badge says. A reader who
 * types `/monitoring` reaches a registered route and a panel telling them so,
 * because hiding an entry point and breaking a URL are different decisions and
 * only the first one was asked for.
 *
 * BEING AN ADMIN GRANTS NO DATA. Every question runs under the asker's own Unity
 * Catalog grants, admin or not, and nothing here changes that. If you are
 * reading this file because an admin needs to see a table a consumer cannot,
 * that is a Unity Catalog grant and not a line of code.
 *
 * All the wording and all four badge states are decided here rather than in the
 * components, so they can be tested without a browser. RoleBadge.tsx and
 * GatePanel.tsx are markup and ARIA.
 */
import { useOutletContext } from 'react-router';
import type { ExperimentalFeatures } from './experimental-features';
import { BENCHMARK_LAB_ENABLED, SHOW_EVERY_TAB_TO_EVERYONE } from './nav-reveal';
import { IDENTITY_RESOLVING } from './user-initials';
import { isRole, ROLE_WORD, type Role } from '../../shared/user-roster-contract';

export type { Role };

/**
 * The five things the badge can be, and they are five rather than three.
 *
 * `resolving` and `failed` are not roles and must never be rendered as one:
 * showing Consumer to an administrator is confusing, and showing Admin to a
 * consumer is a false claim of privilege. The badge never guesses.
 */
export type RoleState = 'resolving' | 'super_admin' | 'admin' | 'consumer' | 'failed';

/**
 * What the app knows about the caller's role, as the header holds it.
 *
 * `addedAdminsReadable` is false when the stored half of the admin list could
 * not be read. That is NOT the failed state: an unreadable list means no added
 * administrators, which is a decision the server makes and not a guess, so the
 * role beside it is real. It is carried because the Settings editor has to say
 * the list could not be read rather than drawing zero rows.
 */
export interface RoleResolution {
  state: RoleState;
  addedAdminsReadable: boolean;
}

export const ROLE_RESOLVING: RoleResolution = { state: 'resolving', addedAdminsReadable: true };

/**
 * The role, from the identity the header already fetched.
 *
 * DERIVED FROM THAT ONE READ RATHER THAN FETCHED AGAIN. `/api/identity` returns
 * the role beside the address, so a second request for it would be a second
 * chance to disagree about who is reading, and the two answers would race.
 *
 * Anything that is not one of the three roles resolves to `failed`, and both ways
 * of getting there mean the same thing: a request that did not land, and a
 * server old enough to answer without a role, are both "we do not know". Failed
 * draws the consumer layout, so not knowing costs a reader some tabs rather than
 * offering them tabs the server will refuse.
 */
export function roleFrom(identity: { signedInAs: string; role?: string; addedAdminsReadable?: boolean }): RoleResolution {
  const addedAdminsReadable = identity.addedAdminsReadable !== false;
  if (identity.signedInAs === IDENTITY_RESOLVING) return ROLE_RESOLVING;
  if (isRole(identity.role)) return { state: identity.role, addedAdminsReadable };
  return { state: 'failed', addedAdminsReadable };
}

/**
 * Whether the reader gets the admin layout.
 *
 * Both administrator ranks do. `failed` gets the consumer set deliberately: the
 * server is refusing admin data either way, so advertising tabs that will 403
 * would be a worse outcome than under-offering. That is not the badge claiming a
 * role, and the badge says "Role unknown" beside it so the two do not disagree.
 */
export function showsAdminSurfaces(state: RoleState): boolean {
  return state === 'admin' || state === 'super_admin';
}

/**
 * Whether the roster panel is drawn.
 *
 * SUPER ADMIN ONLY, AND THIS IS NOT THE PERMISSION. `/api/users` refuses a plain
 * administrator with 403 whatever this returns, and that refusal is the permission
 * model. What is here is whether an administrator is shown a panel every control on
 * which the server would refuse.
 */
export function showsUserRoster(state: RoleState): boolean {
  return state === 'super_admin';
}

/* ── The badge ───────────────────────────────────────────────────────────── */

/**
 * The word in the chip, or '' while the role is resolving.
 *
 * NEVER ABBREVIATED TO ONE LETTER. "A" and "C" are indistinguishable from
 * initials and the header renders initials elsewhere.
 */
export function badgeLabel(state: RoleState): string {
  if (state === 'failed') return 'Role unknown';
  if (state === 'resolving') return '';
  return ROLE_WORD[state];
}

/**
 * The `title`, the same way the identity chip beside it carries the full address.
 *
 * The Admin line names Monitoring, Ops and Settings and NOT Benchmark Lab.
 * Benchmark Lab is not an admin tab: it is behind the experimental toggle, which
 * happens to live in the admin-only gear, and it is hidden from consumers
 * because it is not ready for them rather than because it is privileged. A
 * tooltip promising a tab that is not in the navigation is a tooltip that sends
 * somebody looking for it.
 */
export function badgeTitle(state: RoleState): string {
  // Names the one thing this rank has that Admin does not, rather than repeating
  // the Admin line with a word added. A reader who holds it needs to know where the
  // extra control is, and the Admin line already covers the rest.
  if (state === 'super_admin') return 'You can open Monitoring, Ops and Settings, and set who else can.';
  if (state === 'admin') return 'You can open Monitoring, Ops and Settings.';
  if (state === 'consumer') return 'You can ask questions and see your own runs.';
  if (state === 'failed') return 'Could not read your role. Reload the page.';
  return '';
}

/**
 * What a screen reader calls the chip.
 *
 * Prefixed, so it is not read out as a bare word floating after an email
 * address. Empty while resolving, because there is nothing to name yet and
 * "Role:" on its own is worse than silence.
 */
export function badgeAccessibleName(state: RoleState): string {
  const label = badgeLabel(state);
  return label ? `Role: ${label}` : '';
}

/**
 * What the live region says when the role changes during a session.
 *
 * ONLY CHANGES, AND NEVER THE FIRST RESOLVE. Announcing the first resolve would
 * speak on every page load and train people to ignore the region, which is the
 * opposite of what it is for. The change worth speaking is losing the role,
 * where four things vanish from the page at once.
 *
 * Gaining the role announces nothing. New controls appearing is
 * self-explanatory, and a spoken notification about gaining privilege is noise.
 */
export function badgeAnnouncement(previous: RoleState, next: RoleState): string {
  if (previous === next) return '';
  // The first resolve. Nothing was claimed before it, so nothing changed.
  if (previous === 'resolving') return '';
  if (next === 'consumer') return 'Your role changed. You are now a consumer.';
  if (next === 'failed') return 'Your role could not be read.';
  // Losing the super rank while keeping Admin. Spoken for the same reason as the
  // line above rather than because the rank is important: a control has just left
  // the settings page, and an unexplained absence reads as a fault.
  if (next === 'admin' && previous === 'super_admin') return 'Your role changed. You are now an admin.';
  // Any rise, from anywhere. Silent by design; see above.
  return '';
}

/* ── The navigation ──────────────────────────────────────────────────────── */

/**
 * One navigation entry, as the header draws it.
 *
 * `to` is the route and `label` is the word. The icon stays in the component,
 * because an icon is not a decision this module makes.
 */
export interface NavEntry {
  to: string;
  label: string;
}

/**
 * The consumer set, which is what this app has always shown.
 *
 * ABSENT, NOT DISABLED. No greyed entries, no locks, and no tooltips explaining
 * a privilege that cannot be requested from inside the app. A disabled control a
 * reader can never enable is a permanent invitation to file a support request.
 */
const CONSUMER_NAV: readonly NavEntry[] = [
  { to: '/', label: 'Ask' },
  { to: '/runs', label: 'Run Explorer' },
  // One entry, not two. Sources & Capabilities asked "can the agent reach its
  // dependencies" and Connections asked "are they the right ones, and what
  // would change them" off the same evidence, and nobody reading the nav could
  // tell which question they were picking.
  { to: '/connections', label: 'Connections' },
  // Next to Connections rather than anywhere else, because it is the same
  // evidence drawn a second way: both read one derivation, so a node there and
  // a row here cannot disagree about whether something answers.
  { to: '/architecture', label: 'Architecture' },
];

/**
 * The admin set. Monitoring and Ops sit third and fourth because they are the
 * reason an admin opens the app.
 *
 * BENCHMARK LAB IS NOT IN EITHER LIST. When `BENCHMARK_LAB_ENABLED` is on,
 * `navEntries` appends it to whichever base list applies rather than either
 * list carrying it. While that flag is off, nobody sees it.
 */
const ADMIN_NAV: readonly NavEntry[] = [
  { to: '/', label: 'Ask' },
  { to: '/runs', label: 'Run Explorer' },
  // Third and fourth, between the two pages everybody has and the two that
  // explain the deployment. An admin opens this app to read these.
  { to: '/monitoring', label: 'Monitoring' },
  { to: '/ops', label: 'Ops' },
  { to: '/connections', label: 'Connections' },
  { to: '/architecture', label: 'Architecture' },
];

/** The Benchmark Lab entry, appended for every signed-in role when enabled. */
export const BENCHMARK_NAV_ENTRY: NavEntry = { to: '/benchmarks', label: 'Benchmark Lab' };

/**
 * The whole navigation, in order, for one role.
 *
 * The single answer for the header row and the mobile sheet both. They used to
 * be two lists, and an entry added to one was an entry missing from the other
 * for however long it took somebody to open a narrow window. Benchmark Lab is
 * gated by `BENCHMARK_LAB_ENABLED` only: when that flag is on it is a normal
 * tab for every role, and when it is off it is absent for everyone.
 */
export function navEntries(state: RoleState, _features: ExperimentalFeatures): NavEntry[] {
  const base = showsAdminSurfaces(state) || SHOW_EVERY_TAB_TO_EVERYONE ? ADMIN_NAV : CONSUMER_NAV;
  if (!BENCHMARK_LAB_ENABLED) return [...base];
  return [...base, BENCHMARK_NAV_ENTRY];
}

/**
 * Whether the gear is drawn. Admin only, and the endpoints behind it refuse a
 * consumer -- except while `SHOW_EVERY_TAB_TO_EVERYONE` is on, which draws it
 * for everybody so that App settings can be reviewed alongside the rest.
 *
 * The gear is included deliberately. App settings is one of `ADMIN_PAGE_NAMES`,
 * so leaving it hidden while Monitoring and Ops are visible would make the flag
 * mean "every tab except one" and leave the Benchmark Lab toggle unreachable for
 * the reader most likely to be asked about it. `AdminOnly` still guards the
 * route either way.
 */
export function showsSettingsGear(state: RoleState): boolean {
  return showsAdminSurfaces(state) || SHOW_EVERY_TAB_TO_EVERYONE;
}

/* ── The header's right-hand cluster ─────────────────────────────────────── */

/**
 * The order of the header's right-hand cluster, stated once so it cannot be
 * flipped back by accident.
 *
 * ROLE, THEN WHO, THEN WHAT THEY CAN OPEN, THEN WHO BUILT IT. This is
 * `astrolabe-rebuild-spec.md` §1's cluster, with the signed-in chip restored in
 * place of the initials avatar: "role chip · identity chip · gear · divider ·
 * Built on Databricks". The first pair is the one that has already been
 * corrected once -- the design handoff puts the role badge to the RIGHT of the
 * identity and this app puts it to the LEFT, which was decided directly and is
 * the order the product specification records in sections 4.1 and 10.3. The
 * badge qualifies the reader it precedes. DO NOT REARRANGE THOSE TWO.
 *
 * THE GEAR IS NOW INSIDE THE CLUSTER RATHER THAN AFTER IT, and that is the whole
 * of what moved: it used to close the header from the far right, past the
 * attribution, which put a control belonging to the reader on the other side of
 * the divider that exists to separate the reader from who built the app. It now
 * sits directly after the identity chip, so the divider has identity on one side of it
 * and Databricks on the other, which is what §1 says the divider is for.
 *
 * Gaps between Super admin, the identity chip, and the gear are the row's single
 * 12px gap. Do not add margin on the gear or chip.
 *
 * It is drawn as a member of `IdentityChips` for that reason, but only in the
 * header copy: the mobile sheet's copy of the cluster is handed no gear, so
 * there is exactly one "App settings" control on the page at any width. Below
 * 800px responsive.css hides the cluster's informational members and keeps the
 * gear, which is what stops a narrow window losing the only way into the page.
 *
 * THE OAUTH BADGE USED TO LEAD THIS ROW AND HAS MOVED RATHER THAN GONE. §1 does
 * not have it in the chrome, and the two surfaces that are actually about the
 * sign-in still state it: the login gate on the way in (`login-gate.md`,
 * Identity block) and the Connections identity card beside the address
 * (`design-spec-master.md` §8). In the header it answered a question nobody had
 * asked, in the row that has to hold the navigation.
 *
 * The mobile sheet keeps the same order, so the two widths cannot disagree.
 */
export const HEADER_CLUSTER_ORDER: readonly [
  'role-badge',
  'identity-chip',
  'settings-gear',
  'built-on-databricks',
] = ['role-badge', 'identity-chip', 'settings-gear', 'built-on-databricks'];

/* ── The gate ────────────────────────────────────────────────────────────── */

/** The admin routes, and the page name the gate panel says for each. */
export const ADMIN_PAGE_NAMES: Readonly<Record<string, string>> = {
  '/monitoring': 'Monitoring',
  '/ops': 'Ops',
  '/settings': 'App settings',
};

/** Whether standing on this path needs the admin role. */
export function isAdminPath(pathname: string): boolean {
  return Object.hasOwn(ADMIN_PAGE_NAMES, pathname);
}

/**
 * The four things an admin route can do, decided here rather than in the
 * wrapper that does them.
 *
 * A pure function because this repository has no browser to test a mounted
 * component's state transition in, and the transition is the interesting case:
 * a reader who HELD the role on this page and has just lost it is moved and told
 * why, while a reader who never held it is shown the panel. Those are different
 * events and it would be easy to serve one sentence for both.
 *
 * `wait` is not a fallback. Drawing the page while the role resolves flashes an
 * admin frame at a consumer and fires requests that will 403; drawing the panel
 * flashes "not available on your account" at an administrator. Neither is worth
 * saving a blank body on a cold load, and the badge is already saying an answer
 * is coming.
 */
export type GateOutcome = 'page' | 'gate' | 'move' | 'wait';

export function gateOutcome(state: RoleState, heldRoleHere: boolean): GateOutcome {
  if (showsAdminSurfaces(state)) return 'page';
  if (state === 'resolving') return 'wait';
  // Failed lands here with consumer, deliberately. The server refuses the data
  // either way, so a reader whose role could not be read gets the sentence
  // rather than a page of refusals.
  return heldRoleHere ? 'move' : 'gate';
}

/** The heading on the gate panel, which is the same for every page. */
export const GATE_HEADING = 'Not available on your account';

/**
 * The one line under the heading.
 *
 * NO GUIDANCE ON WHO TO ASK. The app does not know who administers the
 * deployment a reader is looking at, and guessing sends people to the wrong
 * person.
 */
export function gateLine(page: string): string {
  return `${page} is for deployment administrators.`;
}

/** The one action, and it goes to the page every reader can use. */
export const GATE_ACTION = 'Back to Ask';

/**
 * What a reader standing on an admin page is told when the role is taken away.
 *
 * They are moved to Ask PIA with this sentence, because four things have just
 * vanished from the page they were reading and an unexplained empty screen reads
 * as a fault.
 */
export function roleLostSentence(page: string): string {
  return `Your access changed. ${page} is no longer available on your account.`;
}

/* ── Reading the role ────────────────────────────────────────────────────── */

/**
 * What the router outlet carries to every page.
 *
 * The role travels through the outlet rather than being fetched again by each
 * page that wants it, for the reason the experiment flags do: the header and the
 * page are then looking at one object, and a second read of `/api/identity` is a
 * second chance to disagree about who is reading.
 */
export interface AppOutletContext {
  features: ExperimentalFeatures;
  setFeature: (name: keyof ExperimentalFeatures, enabled: boolean) => void;
  role: RoleResolution;
}

/**
 * The reader's role, for a page inside the layout.
 *
 * This is the hook Monitoring and Ops use to decide whether to draw the page or
 * the gate panel. It is not a permission check: their data comes from endpoints
 * that refuse a consumer on the server, and this decides which of two things to
 * put on screen.
 */
export function useRole(): RoleResolution {
  return useOutletContext<AppOutletContext>().role;
}

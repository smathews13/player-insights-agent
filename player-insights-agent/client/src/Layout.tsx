/**
 * The frame every page is drawn inside: the header, the navigation at both
 * widths, the identity chips and the storage banner.
 *
 * Split out of App.tsx so each page could become its own module. What is left in
 * App.tsx is the router, and this is the element it wraps every route in.
 */
import { NavLink, Outlet, Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useCallback, useState } from 'react';
import { storageBannerNotice } from './storage-banner-copy';
import {
  persistExperimentalFeatures,
  readExperimentalFeatures,
  type ExperimentalFeatures,
} from './experimental-features';
import { Alert, AlertDescription, Button, Sheet, SheetContent, SheetHeader, SheetTitle } from './ui';
import {
  Activity,
  CircleAlert,
  FlaskConical,
  Gauge,
  Info,
  Menu,
  MessageSquareText,
  Network,
  PlugZap,
  Settings,
  Workflow,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { useFirstOpen } from './FirstOpenGate';
import { LANDED_ANNOUNCEMENT, drawsAppShell, isArriving } from './login-transition';
import { Disclosure } from './page-chrome';
import { formatCheckedAt } from './preflight';
import { useDeployment, useIdentity, useStorageHealth } from './app-state';
import type { Identity } from './app-types';
import { AstrolabeLockup } from './AstrolabeMark';
import { BuiltOnDatabricks } from './BuiltOnDatabricks';
import { DeploymentTimeChip } from './DeploymentTimeChip';
import { RoleBadge } from './RoleBadge';
import { AdminOnly, RoleLostNotice } from './GatePanel';
import { SettingsPage } from './SettingsPage';
import { UserIdentityChip } from './UserIdentityChip';
import { AccountMenu } from './AccountMenu';
import { AppSky } from './AppSky';
import { mobileNavLinkClass } from './layout-view';
import { settingsOriginPath } from './settings-origin';
import { navEntries, roleFrom, showsSettingsGear, type AppOutletContext, type RoleResolution } from './role';

/**
 * The app-wide statement that stored data is not what is being shown.
 */
function StorageBanner() {
  const health = useStorageHealth();
  // Which of the three things to say, and in which words, is decided in
  // storage-banner-copy.ts so that it can be tested without a browser. The
  // three states put identical-looking seeded figures on screen and have
  // different remedies, and a reader who cannot tell them apart goes looking
  // for the wrong fault. That is not hypothetical, it is how this banner came
  // to be written, and it is why the choice is now something a test pins.
  const notice = storageBannerNotice(
    health && {
      ...health,
      since: formatCheckedAt(health.since),
      last_ok_at: health.last_ok_at ? formatCheckedAt(health.last_ok_at) : null,
    }
  );
  if (!notice) return null;

  // Two tones, and the tone is the whole of the difference: a refusing or
  // unreachable store is the danger alert, an answering-but-empty one is the
  // neutral information strip. Deliberately never amber -- the stylesheet
  // records amber being removed from here, because sitting near the evaluation
  // card it read as a dimmer version of it and blurred the rule that amber
  // means evaluation and nothing else.
  //
  // Neither tone is stated in classes here any more. `variant="destructive"`
  // is enough for alerts.css to give the alert the red line and wash, and the
  // neutral one comes from the app's own `[data-slot='alert']` rule, so the two
  // are painted where every other alert in the app is painted.
  const blocking = notice.tone === 'blocking';
  return (
    <div className={`storage-banner ${blocking ? 'blocking' : 'neutral'}`}>
      <Alert variant={blocking ? 'destructive' : 'default'}>
        {blocking ? <CircleAlert /> : <Info />}
        {/* Four blocks, and the description slot stacks them, because AppKit
            lays it out as a grid again: the app-wide `display: block` pin that
            used to fight that is gone. The heading and the detail are wrapped in
            one child of the grid rather than being two of them, because they are
            one statement, and separated from each other in shell.css. */}
        <AlertDescription>
          <div className="storage-banner-say">
            <strong>{notice.heading}</strong>
            <span>{notice.detail}</span>
          </div>
          {/* THE ERROR STAYS IN FRONT OF THE READER. It is the one line here
              that is specific to this deployment at this moment, it is what
              gets pasted into a ticket, and it is not reasoning. */}
          {health?.last_error ? (
            <span className="storage-banner-note">
              {health.last_error.route} failed: {health.last_error.message}
            </span>
          ) : null}
          {/* Why a blank list is not an empty one, and why waiting cannot fix a
              refusal. All true, none of it what a reader wants before the
              status -- this banner is under the header on every page in the
              app, so its paragraph was the most-read copy in it. */}
          {notice.reasoning ? (
            <Disclosure summary="Why">
              <p>{notice.reasoning}</p>
            </Disclosure>
          ) : null}
          {/* The command itself, on screen, in a shape that can be copied. A
              banner that says "run the grant script" without saying which
              variables it needs sends the reader to the docs to find out, and
              the docs are the thing they already did not read. */}
          {notice.remedy ? <pre className="storage-banner-command">{notice.remedy}</pre> : null}
          {/* Which variables it needs and why no redeploy does it for them.
              Behind the command rather than under it: somebody who has the
              command has what they came for, and the note is three sentences. */}
          {notice.remedyNote ? (
            <Disclosure summary="Why this is manual">
              <p>{notice.remedyNote}</p>
            </Disclosure>
          ) : null}
          <p className="storage-banner-note">
            <Link to="/connections">Open Connections</Link>
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}

// The header nav is a tab row now rather than a row of pills: full-height items
// whose active state is a 2px blue rule along the header's bottom edge, which is
// the treatment the design gives every tab row in the app. It takes no argument
// because the state is read off `aria-current`, which NavLink sets itself -- so
// what a screen reader is told and what is painted are one fact read twice
// rather than two facts that can drift. See .app-nav-tab in shell.css.
const navLinkClass = () => 'app-nav-tab';

type NavLinkClassFn = (props: { isActive: boolean }) => string;

/**
 * The icon for each entry, keyed by its route.
 *
 * Here rather than in role.ts because an icon is presentation and that module
 * decides permissions and wording. Keyed by `to` rather than carried in the
 * entry so a route with no icon is a missing key this file can see, instead of
 * an optional field every consumer has to handle.
 *
 * Monitoring takes the pulse line and Ops the dial, which is the split the two
 * pages already make: Monitoring is what happened over time, Ops is what the
 * deployment is doing and costing right now.
 */
const NAV_ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  '/': MessageSquareText,
  '/runs': Workflow,
  '/monitoring': Activity,
  '/ops': Gauge,
  '/connections': PlugZap,
  '/architecture': Network,
  '/benchmarks': FlaskConical,
};

/**
 * The whole navigation, rendered twice: as the header row above 1180px and
 * inside the mobile sheet below it.
 *
 * One component on purpose, and the reason is worth keeping. The two used to be
 * separate lists, and a link added to one was a link missing from the other for
 * however long it took somebody to open a narrow window. `role` and `features`
 * arrive as props for the same reason: whatever is hidden here is hidden at both
 * widths, because there is one decision rather than one per rendering. That is
 * what makes "a consumer sees no Monitoring entry" true of the sheet as well as
 * of the header row.
 *
 * WHICH ENTRIES, AND IN WHAT ORDER, IS role.ts's ANSWER AND NOT THIS FILE'S.
 * The two sets are absent-not-disabled: a consumer gets a shorter list rather
 * than a greyed one, because a disabled control a reader can never enable is a
 * permanent invitation to file a support request. Hiding an entry is also not a
 * permission: the server refuses every admin route with 403 whatever this draws.
 */
export function NavLinks({
  className,
  linkClass,
  role,
  features,
  onClick,
}: {
  className?: string;
  linkClass: NavLinkClassFn;
  role: RoleResolution;
  features: ExperimentalFeatures;
  onClick?: () => void;
}) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Carry the open conversation from Ask PIA into Run Explorer. Clicking through
  // used to drop it, so the Explorer opened on whoever's run was newest instead
  // of the conversation the reader was just looking at. Only while on Ask PIA
  // ('/'): the conversation id lives in its `?c=` and means nothing on the
  // other pages, whose own query strings must not be read as one.
  const openConversation = location.pathname === '/' ? searchParams.get('c') : null;
  const runsTo = openConversation ? `/runs?conversation=${encodeURIComponent(openConversation)}` : '/runs';
  return (
    <nav className={className}>
      {navEntries(role.state, features).map((entry) => {
        const Icon = NAV_ICONS[entry.to];
        return (
          <NavLink
            key={entry.to}
            to={entry.to === '/runs' ? runsTo : entry.to}
            // Ask PIA only. Without it the root path matches every route and the
            // first tab is drawn active on all of them.
            end={entry.to === '/'}
            className={linkClass}
            onClick={onClick}
          >
            {Icon ? <Icon className="size-4" /> : null} {entry.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

/**
 * Who is reading: person icon, "Signed in", and the email local part.
 *
 * Restored from the pre-avatar treatment. The navy initials circle saved header
 * width but hid the name behind a puzzle ("SM") that only `title` and a screen
 * reader could expand. The chip shows the local part again; the full address
 * stays on `title` for hover and for when the chip truncates.
 *
 * ORDER IS role.ts's HEADER_CLUSTER_ORDER: role badge, this chip, deployment
 * time, gear, then the Built on Databricks attribution past the chrome rule.
 */
export function IdentityChip({ identity }: { identity: Identity }) {
  return <UserIdentityChip identity={identity.signedInAs} label="Signed in" testId="identity-chip" />;
}

/**
 * The header's first column: the lockup, the release date beside it, and the
 * divider that separates the column from the tab row.
 *
 * THE RELEASE CHIP IS SEATED HERE RATHER THAN AT THE FAR RIGHT, and the move is
 * the point of this component existing. It used to be the second-to-last member
 * of the right-hand cluster, which is the part of the header that gives when the
 * row is tight, so on an ordinary window it truncated mid-timestamp -- and the
 * clause it lost was the precise one. Beside the wordmark it is reading the
 * app's own identity rather than the reader's badges, which is what it is: the
 * date names the build somebody is looking at.
 *
 * IT FITS INSIDE THE COLUMN THE TABS ARE ALIGNED TO, and that is a constraint
 * rather than a coincidence. `.brand-lockup`'s width is what lands the first tab
 * clear of the conversation rail's hairline, so the chip goes in the slack that
 * column already holds between the wordmark and the divider. It must stay small
 * enough to live there: widen it and the wordmark truncates, or the column grows
 * and the tab row comes unstuck from the rail below it.
 */
export function HeaderBrand({
  deployedAt,
  deployedBy,
  buildSha,
  arriving,
}: {
  deployedAt?: string;
  deployedBy?: string;
  buildSha?: string;
  arriving?: boolean;
}) {
  return (
    <div className="brand-lockup">
      {/* The lockup pops in at the exact point the stars converged on
          (`login-transition.md` phase 5). The class is on the lockup rather than
          on the column so neither the chip nor the divider beside it pops with
          it, and it is only ever carried for the 1.2s of the transition -- an app
          identity that animates every time the header re-renders is an identity
          in motion, which is the opposite of what an identity is for. */}
      <AstrolabeLockup as="h1" seat="bar" className={arriving ? 'ast-anim-x-mark' : undefined} />
      {deployedAt ? <DeploymentTimeChip deployedAt={deployedAt} deployedBy={deployedBy} buildSha={buildSha} /> : null}
      <span className="app-chrome-rule" aria-hidden="true" />
    </div>
  );
}

/**
 * The header's right-hand cluster: the role chip, the identity chip, the gear,
 * a divider, and the Databricks attribution.
 *
 * ORDER IS role.ts's, as HEADER_CLUSTER_ORDER, rather than this file's.
 *
 * Spacing is the row's single 12px gap for Super admin → identity → gear. The
 * chrome rule and Built on Databricks sit after that cluster so attribution
 * stays visually separated from the reader's badges.
 *
 * THE GEAR ARRIVES AS A SLOT RATHER THAN BEING DRAWN HERE, and it is the one
 * member of the cluster that does. Whether it is drawn at all is a role
 * decision; the mobile sheet's copy must not carry it -- two elements labelled
 * "App settings" on one page is an ambiguous locator. Passing nothing is how the
 * sheet says so.
 *
 * THE OAUTH BADGE IS NO LONGER HERE, and that is a move rather than a deletion.
 * The login gate and the Connections identity card still state it.
 *
 * THE RELEASE CHIP IS ONLY EVER THE SHEET'S NOW. In the header it is seated in
 * the lockup column by `HeaderBrand`, so the header's copy of this cluster is
 * handed no `deployedAt` -- passing one would draw the chip twice on one page.
 * The sheet keeps it because the lockup truncates at those widths and the column
 * has no room for it there, and a phone still has to be able to see which build
 * it is on.
 */
export function IdentityChips({
  identity,
  role,
  deployedAt,
  deployedBy,
  buildSha,
  className,
  gear,
}: {
  identity: Identity;
  role: RoleResolution;
  deployedAt?: string;
  deployedBy?: string;
  buildSha?: string;
  className?: string;
  gear?: ReactNode;
}) {
  return (
    <div className={`identity-chips ${className ?? ''}`}>
      <RoleBadge state={role.state} />
      <AccountMenu identity={identity} role={role.state} />
      {deployedAt ? <DeploymentTimeChip deployedAt={deployedAt} deployedBy={deployedBy} buildSha={buildSha} /> : null}
      {gear}
      <span className="app-chrome-rule" aria-hidden="true" />
      <BuiltOnDatabricks />
    </div>
  );
}

export function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const identity = useIdentity();
  const deployment = useDeployment();
  /*
   * The gate, and whether this frame is allowed to draw the app at all.
   *
   * THE FLICKER WAS HERE, in what this file did with an answer it did not have
   * yet. `/api/identity` takes about a second on a cold open, the gate drew nothing
   * while it was in flight, and everything below drew as usual -- so the reader got
   * the header, the tabs and the Ask tab, and then a full-viewport login gate
   * landed on top of them. It was not a timing problem to be nudged with a delay;
   * the app was painting a screen it had not yet earned the right to paint.
   *
   * `drawsAppShell` is the permission, and `pending` is the one stage that
   * withholds it. Once the gate is up the shell mounts behind it, which the
   * transition depends on: `login-transition.md`'s landing is explicit that the Ask
   * tab is already fully rendered under the crossfade, with no skeleton and no
   * second load.
   */
  const firstOpen = useFirstOpen(identity);
  const arriving = isArriving(firstOpen.stage);
  // Derived from the identity read that already happened rather than fetched
  // again. `/api/identity` carries the role beside the address, so a second
  // request would be a second answer to the same question and the two could
  // race. While it is resolving, and if it cannot be read at all, the consumer
  // layout is what is drawn: under-offering costs a reader some tabs, and
  // over-offering sends them to a page the server refuses.
  const role = roleFrom(identity);
  const settingsDeepLink = location.pathname === '/settings';
  const settingsVisible = settingsOpen || settingsDeepLink;
  /**
   * Closing settings returns the reader to the page that sent them, when a page
   * did.
   *
   * `/settings` is a route as well as a gear, so closing it has to navigate
   * somewhere, and it went to Ask unconditionally. That is right for a reader who
   * typed the address and wrong for one who followed a link out of a page they
   * were reading: Architecture links the Optional badges on the answer contract
   * to the switches that set them, and being dropped on Ask afterwards loses the
   * diagram they were looking at.
   *
   * The origin travels in the link's own router state rather than in a store,
   * because it belongs to one arrival -- the same reason `RoleLostNotice` reads
   * its sentence from there. A reader who reaches `/settings` any other way has
   * no state and still lands on Ask.
   */
  const settingsOrigin = settingsOriginPath(location.state);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (settingsDeepLink) void navigate(settingsOrigin, { replace: true });
  }, [navigate, settingsDeepLink, settingsOrigin]);
  // Read once, when the app opens, and held here. `useState(fn)` rather than
  // `useState(readExperimentalFeatures())` so the read happens on mount instead
  // of on every render of the header.
  const [features, setFeatures] = useState<ExperimentalFeatures>(readExperimentalFeatures);
  // Written on the change rather than from an effect watching `features`: an
  // effect also runs on first mount, which would turn opening the app into a
  // write of the defaults over whatever is stored. A store that refuses the
  // write is not surfaced, because the toggle still moves and the preference
  // simply does not outlive the tab.
  const setFeature = useCallback(
    (name: keyof ExperimentalFeatures, enabled: boolean) => {
      const next = { ...features, [name]: enabled };
      persistExperimentalFeatures(next);
      setFeatures(next);
    },
    [features]
  );

  /*
   * The gate alone, on the one stage where the app may not draw.
   *
   * An early return rather than a conditional around the shell, because the point
   * is that NONE of it renders: no header, no navigation, no outlet, and so none of
   * the requests a page fires on mount either.
   */
  if (!drawsAppShell(firstOpen.stage)) return <>{firstOpen.gate}</>;

  return (
    <div className={`min-h-screen flex flex-col app-frame${arriving ? ' ast-anim-x-app' : ''}`}>
      {/* Mounted in both themes, painted in dark only, and the reason it is not
          conditional on the theme is in AppSky.tsx: nothing in React holds
          `data-theme`, so a conditional mount would follow no state change and
          would leave the sky up over a daylight page after an Appearance preview.
          The two `display` rules -- dark-mode.css's opt-in, base.css's ban outside
          dark -- are the whole of it. */}
      <AppSky />
      {/* The page is white. It was `bg-muted/30`, a 30% wash under every card in
          the app, which is the soft-ground treatment DuBois replaces with
          hairlines on a solid surface.

          The header's height is --app-header-h and is set in shell.css rather
          than derived from what happens to be inside it. §1 gives the bar as
          52px, every sticky offset in the app subtracts that token, and a header
          measured by its tallest child is a header that changes height the next
          time somebody adjusts a font size. */}
      <header className="app-header border-b bg-background flex items-center sticky top-0 z-30">
        {/* The lockup, the release date, and then the divider §1 puts between
            the column and the tabs. The column's width is what aligns the first
            tab with the conversation rail below it, so the divider sits inside
            the column rather than after it -- placed after, it would land on the
            rail's own hairline and read as one crooked line rather than as two.
            The wordmark IS the app's name, so it is the page's h1. The partner
            plate and the "Player Intelligence" kicker that used to be here are
            gone: the app has its own identity now, and the plate reserved a
            position for a trademark this repository must not carry. */}
        <HeaderBrand
          deployedAt={deployment.deployedAt}
          deployedBy={deployment.deployedBy}
          buildSha={deployment.buildSha}
          arriving={arriving}
        />
        {/* Four links for a consumer, six for an admin, and one more than either
            with the Benchmark Lab experiment on -- seven for everybody while
            `SHOW_EVERY_TAB_TO_EVERYONE` is on. The breakpoint stays whatever
            the count is: below it the nav and the brand alone over-subscribe the
            header, which squeezed the identity chips to zero width and pushed
            the gear off the right edge. The sheet below carries the same links,
            from the same component, at those widths. Tying the breakpoint to the
            count would mean the header collapsed at a different width for two
            people looking at the same deployment.

            Six tabs do not over-subscribe it, but they leave the chips much less
            room than four did, so responsive.css takes 4px off each side of every
            tab in the 1180-1365 band -- the same band where the chip already
            sheds its label because the header is tight. The first tab keeps its
            zero left padding there, which is what holds the rail alignment.

            Which width that is now lives in responsive.css with the other three,
            rather than in a `xl:` utility here. The two systems disagreed: the nav
            collapsed at Tailwind's 1280 while the trace inspector had already gone
            at the hand-written 1180, so there was a 100px band in which the header
            was full and the page had lost a column. One set of breakpoints now --
            480, 800, 1180, 1366 -- and the nav goes at 1180 with the inspector. */}
        <NavLinks
          className="app-nav"
          linkClass={navLinkClass}
          role={role}
          features={features}
          onClick={() => setSettingsOpen(false)}
        />
        {/* The way into settings, and now into settings rather than towards them.
            
            This pointed at `/connections` for as long as the gear existed, on
            the argument that Connections was already the settings surface: it
            reads and writes `/api/settings`, and nobody looking for settings
            looks for "Connections". The argument was wrong about what a gear
            promises. A gear says "your preferences", and landing on a page of
            catalogs, warehouses and endpoint ids reads as a mis-click, which is
            the complaint this control kept attracting.

            So there are two surfaces, split by whose they are. `/settings` holds
            what belongs to the person reading and lives in their browser.
            Connections holds what the DEPLOYMENT is -- resources, deployment
            reporting, the identity and permission record -- which is shared,
            server-side, and consequential for everybody using the app. Those are
            different things to change and different things to be careful about,
            and one page for both is what made a gear land on a warehouse id.

            Neutral by construction. `ghost` and `text-muted-foreground` are
            tokens rather than hues, so it comes through a repaint of the
            palette without a second edit.

            Named "App settings" rather than "Settings" so it is not a substring
            of anything nearby: "the button called Settings" would otherwise be
            an ambiguous locator the moment a settings word appears in the nav,
            which is how the delete control broke four tests this morning. The
            page it opens is titled "App settings" for the same reason, and
            settings is deliberately still not a nav entry.

            ADMIN ONLY, AND ABSENT RATHER THAN DISABLED. The page behind it is
            the admin-list editor, whose endpoints refuse a consumer with 403, so
            a drawn-but-dead gear would be an invitation to press something that
            cannot work. A consumer's own preferences are not lost with it: the
            only one this app has is the Benchmark Lab toggle, which is an
            experiment rather than a preference.

            IT IS HANDED TO THE CLUSTER RATHER THAN PLACED AFTER IT. It used to be
            the header's last child, which drew it past the attribution at the far
            right -- so a control belonging to the reader sat on the far side of the
            divider whose job is to separate the reader from who built the app. It
            now goes between the identity chip and that divider, which is where
            HEADER_CLUSTER_ORDER records it, and only the header's copy of the
            cluster is given one: the mobile sheet's copy is passed nothing, so
            "App settings" names exactly one element at any width. */}
        <IdentityChips
          identity={identity}
          role={role}
          gear={
            showsSettingsGear(role.state) ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="header-settings text-muted-foreground hover:text-foreground"
                aria-label="App settings"
                title="App settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings className="size-5" />
              </Button>
            ) : null
          }
        />
        {/* Mobile nav, drawn only below the width at which the desktop nav is
            hidden. Both sides of that switch are in responsive.css, so they cannot
            be read off two different breakpoint systems and leave the header with
            either both or neither. */}
        <div className="mobile-nav">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button variant="outline" size="icon" onClick={() => setMobileNavOpen(true)}>
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open navigation</span>
            </Button>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <NavLinks
                className="flex flex-col gap-1 px-4"
                linkClass={mobileNavLinkClass}
                role={role}
                features={features}
                onClick={() => setMobileNavOpen(false)}
              />
              {/* The release chip's only seat below 800px. The lockup column is
                  what gives at those widths -- the wordmark truncates so the menu
                  button stays on screen -- so there is no slack beside the
                  wordmark to seat it in, and responsive.css hides the header's
                  copy there. */}
              <IdentityChips
                identity={identity}
                role={role}
                deployedAt={deployment.deployedAt}
                deployedBy={deployment.deployedBy}
                buildSha={deployment.buildSha}
                className="mobile-identity"
              />
            </SheetContent>
          </Sheet>
        </div>
        {/* The 2px line under the top bar, and the only loading signal in the
            transition (`login-transition.md` phase 6). It removes itself with the
            rest of the arriving state, and it is decorative: what a screen reader
            gets is the one status string below. */}
        {arriving ? <span className="ast-anim-x-bar fo-x-bar" aria-hidden="true" /> : null}
      </header>

      {/* Once per session, above everything, and handed the identity this frame
          has already read rather than fetching a second one. In the layout rather
          than around the router in App.tsx for exactly that reason: App.tsx has no
          identity, so a gate mounted there would have to ask for one, and two
          reads of `/api/identity` are two answers that can disagree. Being
          re-rendered on every navigation costs nothing -- the panel's own latch is
          what makes it once per session rather than once per page. */}
      {firstOpen.gate}

      {/* The ONE thing the transition says out loud (spec, Keyframes). Every layer
          of the animation is aria-hidden, so without this a reader on a screen
          reader gets a second of silence and then a different page. */}
      {arriving ? (
        <p className="sr-only" role="status" aria-live="polite">
          {LANDED_ANNOUNCEMENT}
        </p>
      ) : null}

      <StorageBanner />

      {/* Empty except on the one arrival that carries it: a reader who was
          standing on an admin page when the role was taken away has just been
          moved here, and four things vanished from the header on the way. An
          unexplained move reads as a fault. */}
      <RoleLostNotice />

      <main className="flex-1">
        {/* The flags travel to the settings page through the outlet rather than
            through a second read of storage there, so the page and the nav above
            it are looking at the same object and a toggle moves the header in the
            same render. The role travels the same way and for the same reason:
            a page that fetched it again could disagree with the header about
            which set of tabs the reader is entitled to. */}
        <Outlet context={{ features, setFeature, role } satisfies AppOutletContext} />
      </main>
      {/* THE ROLE IS HANDED DOWN RATHER THAN READ FROM THE OUTLET HERE. This is
          a sibling of `<Outlet />`, not a descendant of it, so the outlet
          context does not reach it and `AdminOnly`'s hook answers null. It used
          to read the hook regardless, which made every click of the gear a
          TypeError in the layout itself -- above the per-pane boundary inside
          Settings, so the route boundary replaced the whole app with "This view
          could not be displayed" instead of a Settings pane. */}
      {settingsVisible ? (
        <AdminOnly role={role}>
          <SettingsPage onClose={closeSettings} features={features} setFeature={setFeature} role={role} />
        </AdminOnly>
      ) : null}
    </div>
  );
}

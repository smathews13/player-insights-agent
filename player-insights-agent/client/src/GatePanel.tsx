/**
 * What a consumer sees when they follow an administrator's link.
 *
 * MARKUP AND ARIA ONLY, for the reason RoleBadge.tsx is: every word here comes
 * from role.ts, which already held the heading, the per-page line, the action
 * and the role-loss sentence. This file adds no wording of its own.
 *
 * WHY IT DID NOT EXIST UNTIL NOW, which is the useful part. role.ts has held
 * `GATE_HEADING`, `gateLine`, `GATE_ACTION`, `ADMIN_PAGE_NAMES`, `isAdminPath`
 * and `roleLostSentence` since the permission work landed, with tests over all
 * of them, and NOTHING IN THE APP CALLED ANY OF IT. App.tsx even says so at the
 * /monitoring route: "the gate panel replaces the body once the role hook it
 * needs is published". The hook was published; the panel was not written. That
 * is the second time this exact shape of hole has been found in this surface --
 * the role badge was the first -- so the tests for this file render the PAGES
 * and fail when a consumer is served an admin page, rather than testing the
 * words a module returns.
 *
 * What a consumer met instead: the whole admin page frame, and then whichever
 * failure each block makes of a 403. Ops drew three "could not be read" panels
 * with a retry button that could never work. The permission was never in doubt;
 * the server refuses every admin route whatever this draws. What was missing was
 * a sentence saying so.
 */
import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { Button } from './ui';
import {
  GATE_ACTION,
  GATE_HEADING,
  gateLine,
  gateOutcome,
  roleLostSentence,
  showsAdminSurfaces,
  useOptionalRole,
  ROLE_RESOLVING,
  type RoleResolution,
} from './role';
import { adminPageName, roleLostNotice } from './gate-panel-state';

/**
 * The panel itself: a heading, one line, and the way back.
 *
 * NO GUIDANCE ON WHO TO ASK, which is role.ts's rule and worth restating where
 * somebody might add it: the app does not know who administers the deployment
 * being read, and a guess sends people to the wrong person.
 */
export function GatePanel({ page }: { page: string }) {
  return (<div className="page-shell">
      {/*
        `status` rather than `alert`. Being told a page is not yours is not an
        error condition and does not deserve an assertive interruption; it is
        the outcome of the navigation the reader just made.
      */}
      <section className="role-gate" role="status">
        <h2 className="role-gate-heading">{GATE_HEADING}</h2>
        <p className="role-gate-line">{gateLine(page)}</p>
        {/* Primary, because it is the only thing to do here and the reader has
            arrived at a dead end. */}
        <Button asChild className="role-gate-action">
          <Link to="/">{GATE_ACTION}</Link>
        </Button>
      </section>
    </div>
  );
}

/**
 * The wrapper the three admin pages open with.
 *
 * Three outcomes, and the third is the one that is easy to leave out:
 *
 *  1. An administrator gets the page.
 *  2. A consumer, or a reader whose role could not be read, gets the panel.
 *     Failed is deliberately gated: the server is refusing the data either way,
 *     so drawing the page would produce a screen of refusals instead of a
 *     sentence.
 *  3. A reader who WAS an administrator a moment ago is moved to Ask PIA and
 *     told why. Standing on a page while four things vanish from the header is
 *     not the same event as arriving somewhere you were never allowed, and the
 *     specification gives it its own sentence.
 *
 * While the role is resolving this renders nothing at all. The alternatives are
 * both worse: drawing the page would flash an admin frame at a consumer and fire
 * requests that 403, and drawing the panel would flash "not available on your
 * account" at an administrator. The header is already on screen with the badge
 * saying an answer is coming, and the role is read once for the whole app, so
 * this is a blank body on a cold load and nothing at all on a click through.
 */
/**
 * @param role The reader's role, for a caller that already holds one.
 *
 * REQUIRED WHEN THIS IS MOUNTED OUTSIDE THE OUTLET, and the Settings modal is
 * the case that proves it: the layout draws it as a sibling of `<Outlet />`, so
 * there is no outlet context to read there and the hook answers null. Passing
 * the role the layout has already derived is also the cheaper answer -- it is
 * the same object the header is using, so the gate and the badge cannot
 * disagree about who is reading.
 */
export function AdminOnly({ children, role: provided }: { children: React.ReactNode; role?: RoleResolution }) {
  // Both branches every render: the hook is unconditional because hooks must be,
  // and `provided` wins because a caller that has the role is a better source
  // than a context that may not exist where this is mounted.
  const contextRole = useOptionalRole();
  const role = provided ?? contextRole ?? ROLE_RESOLVING;
  const location = useLocation();
  /**
   * Which page this is, from the path.
   *
   * Taken from `ADMIN_PAGE_NAMES` rather than passed in by each route, so the
   * name in the sentence cannot drift from the name in the module that decides
   * which paths are admin paths at all. `admin-gate.test.tsx` asserts that every
   * key of that record is wrapped here, so a fourth admin page cannot be added
   * to the map and left ungated.
   */
  const page = adminPageName(location.pathname);
  /**
   * Whether this reader held the role at any point on this page.
   *
   * State, adjusted during render, which is React's own answer for a value
   * derived from what previous renders saw (react.dev, "You might not need an
   * effect" § adjusting state when a prop changes). This WAS a ref written
   * during render, which reads the same and is not the same: a ref is not part
   * of a render's input, so under a re-render React discards nothing and the
   * write is simply lost or kept at random. Setting state here is not the extra
   * render pass the old comment feared either -- React re-runs this component
   * immediately and throws the first pass away without touching the DOM.
   *
   * Reset is not needed -- the wrapper unmounts when the reader leaves the page,
   * which is exactly the scope "mid-session, on this page" means.
   */
  const [heldRoleHere, setHeldRoleHere] = useState(false);
  if (!heldRoleHere && showsAdminSurfaces(role.state)) setHeldRoleHere(true);

  // WHICH OF THE FOUR IT IS, IS role.ts's ANSWER. There is no browser in this
  // repository's test environment, so a decision made inline here could only be
  // asserted by rendering a mounted component through a state change, which
  // nothing here can do. As a function it is a truth table.
  switch (gateOutcome(role.state, heldRoleHere)) {
    case 'page':
      return <>{children}</>;
    case 'wait':
      return null;
    case 'move':
      return <Navigate to="/" replace state={{ roleLost: roleLostSentence(page) }} />;
    default:
      return <GatePanel page={page} />;
  }
}

/**
 * The sentence carried to Ask PIA by the move above, or ''.
 *
 * Read out of the router's location state rather than out of a store, because
 * it belongs to ONE arrival: a reader who navigates on and comes back should not
 * be told again that their access changed at some point earlier.
 */
/**
 * The notice on the page the reader was moved to.
 *
 * In the layout rather than in Ask PIA so that it is drawn wherever the move
 * lands, and so that Ask PIA -- which is the largest file in this client -- does
 * not grow a second reason to know about roles.
 *
 * Assertive, unlike the panel above. This one appears without the reader doing
 * anything, on a page they did not ask to be on, and it is the only explanation
 * of why the page they were reading is gone.
 */
export function RoleLostNotice() {
  const location = useLocation();
  const said = roleLostNotice(location.state);
  if (!said) return null;
  return (<div className="role-lost-notice" role="alert">
      <p>{said}</p>
    </div>
  );
}

/** The page name for a path, for the pages that pass their own. */

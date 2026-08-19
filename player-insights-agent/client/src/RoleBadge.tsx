/**
 * The pill in the header that says what the reader is.
 *
 * A PILL AND NOT A CHIP, which is the one visual decision in it worth stating
 * here as well as in shell.css: every button in this app is 4px with a border,
 * so a 999px pill with no border cannot be read as one. There is nothing to
 * press. See `docs/design-handoff-pia-dubois-revamp/role-badge.md`.
 *
 * MARKUP AND ARIA ONLY. Every word, and the decision about which of the four
 * states is in play, is role.ts's -- see the note at the top of that file. This
 * file adds no wording of its own and reads no identity: it is handed a
 * `RoleState` and draws it. A second opinion about the role formed here is
 * exactly the drift that module exists to prevent.
 *
 * WHY IT DID NOT EXIST UNTIL NOW, which is the more useful thing to record.
 * role.ts has computed all four states, both tooltips, the accessible names and
 * the live-region wording since the permission work landed, and every test of
 * it passed, while nothing in the app ever called any of it. A fully specified,
 * fully tested module shipped with no caller and the header simply had no badge.
 * That is the same failure the nav row had -- see nav-role.test.tsx, which was
 * written for it -- and the fix is the same: a test that renders the HEADER and
 * fails when there is no badge in it, rather than one more test of the module.
 */
import { useEffect, useRef, useState } from 'react';
import { Shield, ShieldPlus } from 'lucide-react';
import type { ComponentType } from 'react';
import { badgeAccessibleName, badgeAnnouncement, badgeLabel, badgeTitle, type RoleState } from './role';

/**
 * The mark each state carries, and the three that carry none.
 *
 * ONLY THE TWO ADMINISTRATOR RANKS GET ONE, and the handoff is explicit that
 * Consumer has no icon. A mark here means "something extra is on the page",
 * which is true of both ranks and of neither of the other three states.
 *
 * A map rather than a chain of ternaries in the markup, because the two ranks
 * differ by one glyph and a reader of that markup should be able to see both
 * choices at once. A state missing from it draws no icon, which is the right
 * default: a role added later is unmarked until somebody decides what it means.
 *
 * The super rank takes the shield with a plus on it: Admin's mark, and more,
 * which is what the rank is -- everything Admin can open plus setting who else
 * may administer the deployment. `badgeTitle` says the same thing in words, and
 * the two have to agree, because the glyph is the part a reader sees without
 * hovering.
 *
 * `shield-user`, which is the more literal drawing of "administers people", was
 * tried first and is the wrong glyph AT THIS SIZE. It is a shield containing a
 * head and a pair of shoulders, and 11px of it is three strokes inside an
 * outline: the head lands at under two pixels across and the whole mark reads as
 * a smudge rather than as a figure. A plus is two strokes and survives the
 * reduction, which is the only thing that matters for a mark this small.
 */
const BADGE_ICON: Partial<Record<RoleState, ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>>> = {
  super_admin: ShieldPlus,
  admin: Shield,
};

/**
 * The chip, and the live region that speaks when the role changes under a
 * reader.
 *
 * The two are one component because the announcement is a function of the
 * TRANSITION rather than of the state, so something has to remember the previous
 * value, and the badge is the only thing on the page that needs to.
 */
export function RoleBadge({ state }: { state: RoleState }) {
  const label = badgeLabel(state);
  const title = badgeTitle(state);
  const accessibleName = badgeAccessibleName(state);
  const Icon = BADGE_ICON[state];
  // Resolving is the only state with nothing to say, and role.ts says so by
  // returning ''. Read that rather than re-testing the state here, so the two
  // cannot come apart if a fifth state is ever added.
  const resolving = label === '';

  const [announcement, setAnnouncement] = useState('');
  const previous = useRef<RoleState>(state);
  useEffect(() => {
    const said = badgeAnnouncement(previous.current, state);
    previous.current = state;
    // Only assign when there is something to say. Writing '' on every render
    // would clear a message a screen reader may still be part-way through.
    if (said) setAnnouncement(said);
  }, [state]);

  return (
    <>
      {/*
        `data-role-state` rather than a class per state, so shell.css can select
        on it and a test can read which state is drawn without parsing a class
        list. The empty resolving chip holds its width there, which is what stops
        the header's right-hand cluster jumping sideways when the role lands.

        Titled and named only when there is something to title and name it with:
        `title=""` is a tooltip that flashes empty, and `aria-label=""` is worse
        than no label because it is an element announced with no name. While it
        is resolving the chip is decoration with a width, and `aria-hidden` says
        so; `aria-busy` on the wrapper is what tells a reader something is coming.
      */}
      <span
        className="role-badge"
        data-role-state={state}
        data-testid="role-badge"
        aria-busy={resolving || undefined}
        aria-hidden={resolving || undefined}
        {...(title ? { title } : {})}
        {...(accessibleName ? { 'aria-label': accessibleName } : {})}
      >
        {/*
          THE ADMINISTRATOR RANKS ONLY, from BADGE_ICON above, and the handoff is
          explicit that Consumer has no icon. A shield is there because those are
          the states that mean something extra is on the page, and they earn a
          mark the other three do not.

          Hidden from the accessibility tree because the pill already carries its
          whole meaning as a name: a shield announced beside "Role: Admin" is a
          second, wordless copy of the word next to it. Sized in px rather than
          with a utility class because 11px is not on the app's spacing scale --
          it is the handoff's number, chosen against a 12px label.
        */}
        {Icon ? <Icon size={11} strokeWidth={2.5} aria-hidden="true" /> : null}
        {label}
      </span>
      {/*
        Polite, and empty until a role is LOST or downgraded. role.ts holds the
        rule that the first resolve says nothing: announcing on every page load
        trains people to ignore the region, and the change actually worth
        speaking is the one where four tabs and the gear disappear at once.
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

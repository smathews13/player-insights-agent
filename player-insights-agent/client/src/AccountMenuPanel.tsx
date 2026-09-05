/* eslint-disable react-refresh/only-export-components -- the lazy panel owns its coordinated sign-out action */
import { ChevronRight, Github, LogOut, ShieldPlus, Slack } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Identity } from './app-types';
import { organizationForEmail } from '../../shared/organization-mapping';
import { accountFeedbackTargets, type AccountFeedbackTargets } from '../../shared/account-feedback';
import { nextFeedbackItem } from './account-feedback-menu';
import { readAccountFeedbackTargets } from './account-feedback-targets';
import {
  APP_SESSION_END_PATH,
  NATIVE_APP_SIGN_OUT_PATH,
  clearSensitiveClientState,
  type AppSessionFetch,
} from './app-session';
import { BrandIcon } from './BrandIcon';
import { browserAcknowledgementStore, type AcknowledgementStore } from './first-open';
import { OrganizationAvatar } from './OrganizationAvatar';
import { RoleBadgePill } from './RoleBadge';
import type { RoleState } from './role';
import { Popover, PopoverContent, PopoverTrigger } from './ui';
import { canonicalIdentityEmail, identityDisplayName } from './user-identity';

type FeedbackItem = HTMLAnchorElement;
const SIGN_OUT_END_WAIT_MS = 1_500;

export function AccountMenuContent({
  menuId,
  identity,
  role,
  onClose,
}: {
  menuId: string;
  identity: Identity;
  role: RoleState;
  onClose: () => void;
}) {
  return (
    <PopoverContent
      id={menuId}
      className="account-menu-portal app-action-menu-content"
      align="end"
      side="bottom"
      sideOffset={8}
      avoidCollisions
      collisionPadding={12}
      sticky="always"
      hideWhenDetached
      updatePositionStrategy="always"
    >
      <AccountMenuPanel identity={identity} role={role} onClose={onClose} />
    </PopoverContent>
  );
}

export async function signOutAndEndAppSession(
  options: {
    fetchImpl?: AppSessionFetch;
    navigate?: (path: string) => void;
    store?: AcknowledgementStore | null;
  } = {}
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const navigate = options.navigate ?? ((path: string) => window.location.assign(path));
  clearSensitiveClientState(options.store === undefined ? browserAcknowledgementStore() : options.store);
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SIGN_OUT_END_WAIT_MS);
      void fetchImpl(APP_SESSION_END_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: {
          'content-type': 'application/json',
          'x-astrolabe-session-action': 'end',
        },
        body: '{}',
      }).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        }
      );
    });
  } finally {
    // Relative and same-origin by construction. Databricks clears its native app
    // cookie here; no workspace host is guessed or embedded.
    navigate(NATIVE_APP_SIGN_OUT_PATH);
  }
}

export function AccountFeedbackChoices({
  targets,
  onItemRef = () => undefined,
  onChoose = () => undefined,
}: {
  targets: AccountFeedbackTargets;
  onItemRef?: (index: number, element: FeedbackItem | null) => void;
  onChoose?: () => void;
}) {
  return (
    <>
      <a
        ref={(element) => onItemRef(0, element)}
        role="menuitem"
        tabIndex={-1}
        href={targets.github.url}
        target="_blank"
        rel="noopener noreferrer"
        className="app-action-menu-item"
        onClick={onChoose}
      >
        <Github aria-hidden="true" />
        <span>{targets.github.label}</span>
      </a>
      {targets.slack ? (
        <a
          ref={(element) => onItemRef(1, element)}
          role="menuitem"
          tabIndex={-1}
          href={targets.slack.url}
          target="_blank"
          rel="noopener noreferrer"
          className="app-action-menu-item"
          onClick={onChoose}
        >
          <Slack aria-hidden="true" />
          <span>{targets.slack.label}</span>
        </a>
      ) : null}
    </>
  );
}

export function AccountEscalationChoice({ target }: { target: AccountFeedbackTargets['escalation'] }) {
  if (!target) return null;
  return (
    <a href={target.url} target="_blank" rel="noopener noreferrer" aria-label={target.label} title={target.label}>
      <span>Escalate to Super Admin</span>
      <ShieldPlus aria-hidden="true" />
    </a>
  );
}

export function AccountMenuPanel({
  identity,
  role,
  onClose = () => undefined,
}: {
  identity: Identity;
  role: RoleState;
  onClose?: () => void;
}) {
  const canonicalEmail = canonicalIdentityEmail(identity);
  const name = identityDisplayName(identity);
  const organization = identity.organization ?? organizationForEmail(canonicalEmail, identity.organizations ?? []);
  const feedbackMenuId = useId();
  const feedbackTriggerRef = useRef<HTMLButtonElement>(null);
  const feedbackItemRefs = useRef<Array<FeedbackItem | null>>([]);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const focusIndexRef = useRef(0);
  const focusOnOpenRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackTargets, setFeedbackTargets] = useState(() => accountFeedbackTargets());

  const cancelHoverClose = () => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };

  const openFeedback = (moveFocus: boolean, index = 0) => {
    cancelHoverClose();
    focusIndexRef.current = index;
    focusOnOpenRef.current = moveFocus;
    restoreFocusRef.current = true;
    setFeedbackOpen(true);
  };

  const scheduleFeedbackClose = () => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setFeedbackOpen(false);
      hoverCloseTimerRef.current = null;
    }, 160);
  };

  useEffect(() => {
    const controller = new AbortController();
    void readAccountFeedbackTargets(controller.signal)
      .then(setFeedbackTargets)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current);
    },
    []
  );

  const handleFeedbackMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      restoreFocusRef.current = true;
      setFeedbackOpen(false);
      return;
    }
    if (event.key === 'Tab') {
      restoreFocusRef.current = false;
      setFeedbackOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const current = feedbackItemRefs.current.indexOf(document.activeElement as FeedbackItem);
    const next = nextFeedbackItem(current < 0 ? 0 : current, event.key, feedbackTargets.slack ? 2 : 1);
    focusIndexRef.current = next;
    feedbackItemRefs.current[next]?.focus();
  };

  return (
    <div className="account-menu" aria-label="Account controls">
      <div className="account-menu-identity">
        {/*
          `RoleBadgePill` and not `RoleBadge` -- the second live region would
          announce a lost role twice. See the note on the pill. It is deliberately
          separate from the principal below: the organization mark identifies the
          named person, not their permission level.
        */}
        <RoleBadgePill state={role} />
        <div className="account-menu-principal">
          <OrganizationAvatar organization={organization} />
          <span className="account-menu-identity-copy">
            <strong className="account-menu-name">{name}</strong>
            <span className="account-menu-address">{canonicalEmail}</span>
          </span>
        </div>
      </div>
      <div className="account-menu-group">
        <Popover
          open={feedbackOpen}
          onOpenChange={(open) => {
            cancelHoverClose();
            setFeedbackOpen(open);
          }}
        >
          <PopoverTrigger asChild>
            <button
              ref={feedbackTriggerRef}
              type="button"
              className="account-feedback-trigger app-action-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={feedbackOpen}
              aria-controls={feedbackMenuId}
              onMouseEnter={() => openFeedback(false)}
              onMouseLeave={scheduleFeedbackClose}
              onClick={() => {
                focusOnOpenRef.current = true;
                restoreFocusRef.current = true;
              }}
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'ArrowRight'].includes(event.key)) return;
                event.preventDefault();
                openFeedback(true, event.key === 'ArrowUp' && feedbackTargets.slack ? 1 : 0);
              }}
            >
              <span>Report feedback</span>
              <ChevronRight aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            id={feedbackMenuId}
            data-account-feedback-menu
            className="account-feedback-menu app-menu-content app-action-menu-content ast-surface-menu"
            role="menu"
            aria-label="Feedback destinations"
            align="start"
            side="left"
            sideOffset={8}
            collisionPadding={8}
            onMouseEnter={cancelHoverClose}
            onMouseLeave={scheduleFeedbackClose}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              if (focusOnOpenRef.current) feedbackItemRefs.current[focusIndexRef.current]?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (restoreFocusRef.current) feedbackTriggerRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              restoreFocusRef.current = true;
              setFeedbackOpen(false);
            }}
            onInteractOutside={() => {
              restoreFocusRef.current = false;
            }}
            onKeyDown={handleFeedbackMenuKey}
          >
            <AccountFeedbackChoices
              targets={feedbackTargets}
              onItemRef={(index, element) => {
                feedbackItemRefs.current[index] = element;
              }}
              onChoose={() => {
                restoreFocusRef.current = true;
                setFeedbackOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <AccountEscalationChoice target={feedbackTargets.escalation} />
      </div>
      <div className="account-menu-group account-menu-leave">
        <a href="/api/account/apps">
          <BrandIcon product="apps" size={14} />
          <span>Back to Databricks Apps</span>
        </a>
        <button
          type="button"
          onClick={() => {
            onClose();
            void signOutAndEndAppSession();
          }}
        >
          <LogOut aria-hidden="true" />
          <span className="account-menu-signout-label">Sign out of Player Insights Agent</span>
        </button>
      </div>
    </div>
  );
}

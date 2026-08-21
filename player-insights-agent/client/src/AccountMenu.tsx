import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link2, LogOut, Send, ShieldPlus, UserRound, X } from 'lucide-react';
import type { Identity } from './app-types';
import { AstrolabeMark } from './AstrolabeMark';
import { BrandIcon } from './BrandIcon';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { signOutOfAstrolabe } from './first-open';
import { identityName } from './user-identity';

function DatabricksSymbol({ className }: { className?: string }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: DATABRICKS_SYMBOL }}
    />
  );
}

export type SlackAction = 'feedback' | 'escalation';

const COMPOSER = {
  feedback: {
    title: 'Report feedback',
    recipient: 'Databricks',
    placeholder: 'What should we fix or improve?',
  },
  escalation: {
    title: 'Escalate to Super Admin',
    recipient: 'Super Admin',
    placeholder: 'What do you need from the Super Admin?',
  },
} as const;

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute('hidden'));
}

function useDialogFocus(
  dialog: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null>,
  onClose: () => void
) {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocus.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const elements = focusableElements(dialog.current);
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [dialog, initialFocus, onClose]);
}

export function SlackComposer({
  action,
  identity,
  onClose,
}: {
  action: SlackAction;
  identity: Identity;
  onClose: () => void;
}) {
  const copy = COMPOSER[action];
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  useDialogFocus(dialog, textarea, onClose);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    const slackWindow = window.open('about:blank', 'astrolabe-slack-message');
    if (slackWindow) slackWindow.opener = null;
    try {
      const response = await fetch('/api/account/slack-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: action,
          message: text,
          pageUrl: window.location.href,
          user: identity.signedInAs,
        }),
      });
      const payload = (await response.json()) as { permalink?: string; detail?: string };
      if (!response.ok || !payload.permalink) {
        throw new Error(payload.detail ?? 'Slack did not accept the message.');
      }
      if (slackWindow) slackWindow.location.replace(payload.permalink);
      else window.open(payload.permalink, '_blank', 'noopener,noreferrer');
      onClose();
    } catch (caught) {
      slackWindow?.close();
      setError(caught instanceof Error ? caught.message : 'Slack did not accept the message.');
      setSending(false);
    }
  };

  return (
    <div
      className="account-composer-overlay"
      data-testid="account-composer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={dialog} className="account-composer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="account-composer-header">
          <h2 id={titleId}>{copy.title}</h2>
          <button type="button" onClick={onClose} aria-label={`Close ${copy.title}`}>
            <X aria-hidden="true" />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="account-composer-body">
            <label>To</label>
            <div className="account-composer-recipient" aria-readonly="true">
              {action === 'feedback' ? (
                <DatabricksSymbol className="account-menu-databricks" />
              ) : (
                <ShieldPlus aria-hidden="true" />
              )}
              <strong>{copy.recipient}</strong>
              <span>Slack</span>
            </div>
            <label htmlFor={`${titleId}-message`}>Message</label>
            <textarea
              ref={textarea}
              id={`${titleId}-message`}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={copy.placeholder}
              maxLength={4_000}
              required
            />
            <p className="account-composer-context">
              <Link2 aria-hidden="true" />
              Sends your name and a link to this page.
            </p>
            {error ? (
              <p className="account-composer-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <footer className="account-composer-footer">
            <button className="account-composer-cancel" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="account-composer-send" type="submit" disabled={sending || !message.trim()}>
              <Send aria-hidden="true" />
              {sending ? 'Sending…' : 'Send on Slack'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function AccountMenuPanel({
  identity,
  onCompose,
  onSignOut,
}: {
  identity: Identity;
  onCompose: (action: SlackAction) => void;
  onSignOut: () => void;
}) {
  const name = identityName(identity.signedInAs);
  return (
    <div className="account-menu" role="menu" aria-label="Account menu">
      <div className="account-menu-identity">
        <strong>{name}</strong>
        <span>{identity.signedInAs}</span>
      </div>
      <div className="account-menu-group">
        <button type="button" role="menuitem" onClick={() => onCompose('feedback')}>
          <span>Report feedback</span>
          <DatabricksSymbol className="account-menu-databricks" />
        </button>
        <button type="button" role="menuitem" onClick={() => onCompose('escalation')}>
          <span>Escalate to Super Admin</span>
          <ShieldPlus aria-hidden="true" />
        </button>
      </div>
      <div className="account-menu-group account-menu-leave">
        <a href="/api/account/apps" role="menuitem">
          <BrandIcon product="apps" size={14} />
          <span>Back to Databricks Apps</span>
        </a>
        <button type="button" role="menuitem" onClick={onSignOut}>
          <LogOut aria-hidden="true" />
          <span>Sign out of</span>
          <AstrolabeMark size={13} className="account-menu-astrolabe" />
          <span>astrolabe</span>
        </button>
      </div>
    </div>
  );
}

export function AccountMenu({ identity }: { identity: Identity }) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [composer, setComposer] = useState<SlackAction | null>(null);
  const name = identityName(identity.signedInAs);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const compose = (action: SlackAction) => {
    setOpen(false);
    setComposer(action);
  };
  const signOut = () => {
    signOutOfAstrolabe();
    window.location.reload();
  };

  return (
    <>
      <div ref={root} className="account-menu-root">
        <button
          ref={trigger}
          className="identity-chip account-menu-trigger"
          data-testid="identity-chip"
          type="button"
          title={identity.signedInAs}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <UserRound aria-hidden="true" />
          <span className="identity-chip-text">
            <span className="identity-chip-label">Signed in </span>
            <strong className="identity-chip-name">{name}</strong>
          </span>
        </button>
        {open ? (
          <div id={menuId}>
            <AccountMenuPanel identity={identity} onCompose={compose} onSignOut={signOut} />
          </div>
        ) : null}
      </div>
      {composer ? <SlackComposer action={composer} identity={identity} onClose={() => setComposer(null)} /> : null}
    </>
  );
}

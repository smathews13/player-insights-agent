import {
  createElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { DIALOG_FOCUSABLE, dialogKeyIntent, dialogTabTarget } from './dialog-state';
import { PortalContainerProvider } from './ui';

export type DialogDismissReason = 'escape' | 'backdrop';

let scrollLocks = 0;
let savedBodyOverflow = '';
let savedBodyPaddingRight = '';
let savedScrollX = 0;
let savedScrollY = 0;

function lockDocumentScroll(): () => boolean {
  if (scrollLocks === 0) {
    savedBodyOverflow = document.body.style.overflow;
    savedBodyPaddingRight = document.body.style.paddingRight;
    savedScrollX = window.scrollX;
    savedScrollY = window.scrollY;
    const widthBeforeLock = document.documentElement.clientWidth;
    const currentPadding = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
    document.body.style.overflow = 'hidden';
    /*
     * The root reserves its document scrollbar with `scrollbar-gutter: stable`,
     * so modern browsers report no width change here and need no body padding.
     * The measured fallback covers engines that ignore the gutter: compensate
     * only for width that the lock actually released, never for the pre-lock
     * scrollbar width (which would reserve the same strip twice).
     */
    const releasedWidth = Math.max(0, document.documentElement.clientWidth - widthBeforeLock);
    if (releasedWidth > 0) document.body.style.paddingRight = `${currentPadding + releasedWidth}px`;
    document.documentElement.dataset.astScrollLocked = '';
  }
  scrollLocks += 1;
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) {
      document.body.style.overflow = savedBodyOverflow;
      document.body.style.paddingRight = savedBodyPaddingRight;
      delete document.documentElement.dataset.astScrollLocked;
      return true;
    }
    return false;
  };
}

interface HiddenElement {
  element: HTMLElement;
  ariaHidden: string | null;
  inert: boolean;
}

/**
 * Hide every branch outside the dialog's branch.
 *
 * Walking ancestors works whether the dialog is mounted beside the app shell or
 * nested inside another dialog. Each instance records what it found, so a nested
 * dialog restores the outer dialog's inert state rather than clearing it.
 */
function hideBackground(overlay: HTMLElement): () => void {
  const hidden: HiddenElement[] = [];
  let branch: HTMLElement = overlay;
  while (branch.parentElement && branch !== document.body) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      hidden.push({
        element: sibling,
        ariaHidden: sibling.getAttribute('aria-hidden'),
        inert: sibling.inert,
      });
      sibling.setAttribute('aria-hidden', 'true');
      sibling.inert = true;
    }
    branch = parent;
  }
  return () => {
    for (const { element, ariaHidden, inert } of hidden.reverse()) {
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
      element.inert = inert;
    }
  };
}

interface DialogProps {
  children: ReactNode;
  labelledBy: string;
  describedBy?: string;
  overlayClassName: string;
  contentClassName: string;
  contentStyle?: CSSProperties;
  contentAs?: 'div' | 'section' | 'aside';
  overlayTestId?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  ariaBusy?: boolean;
  onDismiss?: (reason: DialogDismissReason) => void;
  dismissOnEscape?: boolean;
  dismissOnBackdrop?: boolean;
  onEscape?: () => void;
}

function isDialogFloatingPortal(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        "[data-radix-popper-content-wrapper], [data-slot='select-content'], [data-slot='dropdown-menu-content'], [data-slot='popover-content']"
      )
    )
  );
}

/**
 * Internal modal foundation shared by every app-owned dialog.
 *
 * It uses only React and browser APIs: focus starts inside, Tab wraps, Escape
 * and backdrop presses follow the caller's policy, outside branches are inert
 * and hidden from assistive technology, body scrolling is locked, and focus is
 * restored on close. The per-instance cleanup makes nesting safe.
 */
export function Dialog({
  children,
  labelledBy,
  describedBy,
  overlayClassName,
  contentClassName,
  contentStyle,
  contentAs = 'div',
  overlayTestId,
  initialFocusRef,
  ariaBusy,
  onDismiss,
  dismissOnEscape = Boolean(onDismiss),
  dismissOnBackdrop = Boolean(onDismiss),
  onEscape,
}: DialogProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!portalContainer || !content) return;
    const restoreTo = document.activeElement;
    const showOnlyDialog = hideBackground(portalContainer);
    const unlockScroll = lockDocumentScroll();
    (initialFocusRef?.current ?? content).focus();
    return () => {
      showOnlyDialog();
      const finalDialog = unlockScroll();
      /*
       * React may replace one dialog with another in the same commit. Deferring
       * restoration lets the replacement acquire the shared lock first, which
       * avoids a transient scrollbar, a route scroll, and a focus bounce.
       */
      queueMicrotask(() => {
        if (!finalDialog || scrollLocks !== 0) return;
        if (window.scrollX !== savedScrollX || window.scrollY !== savedScrollY) {
          window.scrollTo(savedScrollX, savedScrollY);
        }
        if (restoreTo instanceof HTMLElement && restoreTo.isConnected) restoreTo.focus();
      });
    };
  }, [initialFocusRef, portalContainer]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // AppKit menus are portal children of this overlay and logical children
      // of the dialog in React. Let the menu own Escape, Tab, arrows and focus
      // restoration; trapping those here closes or refocuses the modal instead.
      if (isDialogFloatingPortal(event.target)) return;
      const intent = dialogKeyIntent(event);
      if (intent === 'escape') {
        event.preventDefault();
        event.stopPropagation();
        if (dismissOnEscape) onDismiss?.('escape');
        else onEscape?.();
        return;
      }
      if (!intent) return;
      event.stopPropagation();
      const content = contentRef.current;
      if (!content) return;
      const focusable = [...content.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)].filter(
        (element) => element.getAttribute('aria-hidden') !== 'true'
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const target = dialogTabTarget(
        focusable,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
        intent
      );
      if (!target) return;
      event.preventDefault();
      target.focus();
    },
    [dismissOnEscape, onDismiss, onEscape]
  );

  const overlay = (
    <div
      ref={setPortalContainer}
      className={`${overlayClassName} ast-dialog-overlay`}
      data-ast-dialog-overlay=""
      data-testid={overlayTestId}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (dismissOnBackdrop) onDismiss?.('backdrop');
      }}
    >
      <PortalContainerProvider container={portalContainer}>
        {createElement(
          contentAs,
          {
            ref: contentRef,
            className: `${contentClassName} ast-dialog-panel`,
            'data-ast-dialog-panel': '',
            style: contentStyle,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': labelledBy,
            'aria-describedby': describedBy,
            'aria-busy': ariaBusy,
            tabIndex: -1,
            onKeyDown,
          },
          children
        )}
      </PortalContainerProvider>
    </div>
  );
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}

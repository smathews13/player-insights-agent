/**
 * The client's single door onto AppKit's UI components.
 *
 * It exists so that `Input` and `Textarea` can opt out of password managers
 * once, here, rather than at every call site. A fix applied per call site only
 * holds until someone adds the next field, and this app ships to a customer who
 * is expected to extend it. `no-restricted-imports` in eslint.config.js keeps
 * the rest of the client importing from here rather than around it.
 *
 * Only the components this app uses pass through. An export-star makes every
 * future AppKit surface reachable from the shell barrel, including chart and
 * Arrow code that no app import asked for.
 */

import { createElement } from 'react';
import type { ComponentProps } from 'react';
import {
  Input as AppKitInput,
  Select as AppKitSelect,
  SelectContent as AppKitSelectContent,
  Textarea as AppKitTextarea,
} from '@databricks/appkit-ui/react';
import { withPasswordManagerOptOut } from './password-manager-optout';
import type { PasswordManagerOptOutProps } from './password-manager-optout';

export {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PortalContainerProvider,
  Progress,
  SelectItem,
  SelectTrigger,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@databricks/appkit-ui/react';
export { PASSWORD_MANAGER_OPT_OUT } from './password-manager-optout';
export type { PasswordManagerOptOutProps } from './password-manager-optout';

// Written with createElement rather than JSX so this module stays a .ts file:
// the vitest config runs without the React plugin, and the test that guards
// these attributes renders both components.

/** Text input field for single-line user input. Ignored by password managers. */
export function Input(props: ComponentProps<'input'> & PasswordManagerOptOutProps) {
  return createElement(AppKitInput, withPasswordManagerOptOut(props));
}

/** Multi-line text input field. Ignored by password managers. */
export function Textarea(props: ComponentProps<'textarea'> & PasswordManagerOptOutProps) {
  return createElement(AppKitTextarea, withPasswordManagerOptOut(props));
}

/**
 * Dropdown root.
 *
 * Radix Select 2.2 always RemoveScrolls while the menu is open and no longer
 * exposes `modal`, so this wrapper cannot turn the lock off. Overlay behaviour
 * is the popper default on `SelectContent` plus `scrollbar-gutter: stable` on
 * `html`, which already reserves the bar the lock would otherwise invent.
 */
export function Select(props: ComponentProps<typeof AppKitSelect>) {
  return createElement(AppKitSelect, props);
}

/**
 * Dropdown menu. Popper overlay, so opening it cannot widen the trigger's column.
 *
 * `item-aligned` (Radix's other mode) sizes the trigger to the longest option
 * and is what made Recent runs shove the detail pane when All conversations
 * opened.
 */
export function SelectContent(props: ComponentProps<typeof AppKitSelectContent>) {
  return createElement(AppKitSelectContent, { position: 'popper', ...props });
}

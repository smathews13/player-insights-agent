import type { ReactNode } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { Button, Sheet, SheetContent, SheetHeader, SheetTitle } from './ui';

type MobileContextDrawerProps = {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

/**
 * Phone access to Ask's right-hand context panel.
 *
 * Desktop can keep its collapsible inspector while this product-neutral shell
 * makes the same context reachable from a narrow viewport.
 */
export function MobileContextDrawer({ label, open, onOpenChange, children }: MobileContextDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="context-sheet-trigger"
        onClick={() => onOpenChange(true)}
      >
        <PanelRightOpen aria-hidden="true" />
        {label}
      </Button>
      <SheetContent side="right" className="context-sheet">
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
        </SheetHeader>
        <div className="context-sheet-body">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

import { useRef, type ReactElement, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@solcreek/ui/components/alert-dialog";
import { Button } from "@solcreek/ui/components/button";

/**
 * A button that asks before running a destructive action. `onConfirm` runs
 * only from the dialog's destructive button; Cancel has focus when the dialog
 * opens, so Enter or a stray tap backs out.
 */
export function ConfirmAction({
  trigger,
  children,
  disabled,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  /** The element that opens the dialog, without children, e.g. `<Button variant="ghost" size="sm" />`. */
  trigger: ReactElement;
  /** The trigger's label. */
  children: ReactNode;
  disabled?: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog>
      <AlertDialogTrigger disabled={disabled} render={trigger}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogPopup initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose ref={cancelRef} render={<Button variant="ghost" />}>
            Cancel
          </AlertDialogClose>
          <AlertDialogClose render={<Button variant="destructive" />} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

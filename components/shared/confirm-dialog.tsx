"use client";

/**
 * The confirmation gate for an action that destroys or charges something.
 *
 * It is a dialog rather than a `window.confirm` because the destructive case
 * needs to say WHAT is happening and WHAT cannot be undone, and a native
 * confirm gives room for neither. That text is why `description` is required
 * rather than optional.
 *
 * COLOUR. Destructive styling is opt-in and is the *only* place this
 * component spends the destructive token, matching the brief's rule that
 * destructive is reserved for destructive actions. The default is the
 * brand-primary `Button`; `tone="destructive"` switches to the generated
 * destructive variant, which is a tinted background with destructive text —
 * not a solid red block, which would be an alarming use of the colour on a
 * button the user still has to aim at. Nothing here names a colour value.
 *
 * `onConfirm` may be async. While it is in flight the dialog stays open and
 * the confirm button is disabled, so a slow mutation cannot be double-submitted
 * and the user is not left staring at a dialog that closed on a failure.
 */
import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmDialogTone = "default" | "destructive";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is being confirmed. Say what, not "are you sure?". */
  title: React.ReactNode;
  /** Required. What happens, and what cannot be undone. */
  description: React.ReactNode;
  onConfirm: () => void | Promise<void>;
  confirmLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** `destructive` for anything irreversible. */
  tone?: ConfirmDialogTone;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (cause) {
      // Swallowing this would strand the user: the dialog stays open with an
      // unexplained failure. Reporting it in place keeps the dialog usable and
      // keeps the rejection from escaping as an unhandled promise rejection.
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      // Reset even if onConfirm throws: leaving `pending` stuck true would
      // disable the button for the rest of the session with no way out.
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={pending ? () => {} : onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive-ink">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={tone === "destructive" ? "destructive" : "default"}
            disabled={pending}
            onClick={(event) => {
              // Keep the dialog mounted while onConfirm runs so a failure can
              // be reported inside it; a throw otherwise escapes the handler.
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {pending ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

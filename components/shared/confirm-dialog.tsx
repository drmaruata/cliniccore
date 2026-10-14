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
 * brand-primary `Button`.
 *
 * `tone="destructive"` switches to the generated destructive variant, which
 * renders as a SOLID `--destructive` fill under `--destructive-foreground` —
 * a red block, in both modes. That is not an alarming use of the colour on a
 * button the user still has to aim at; it is the point of the tone. An earlier
 * version of this comment said the variant was "a tinted background with
 * destructive text — not a solid red block", which described how `shadcn`
 * *generates* it and what the variant painted before
 * `app/globals.css`'s compensating rule existed. The generated tint measures
 * 1.19:1 against the page at its light-mode `/10` opacity and 1.34:1 at the
 * `/20` one dark mode selects: WCAG 1.4.11 wants 3:1 for a control's boundary,
 * so the tinted control had no perceivable edge at all. The solid fill now
 * matches the light `default` Button's shape. Nothing here names a colour value.
 *
 * `onConfirm` may be async. While it is in flight the dialog stays open and
 * the confirm button is disabled, so a slow mutation cannot be double-submitted
 * and the user is not left staring at a dialog that closed on a failure.
 *
 * CONTRACT — WHO CLOSES THE DIALOG. This component never closes itself. The
 * confirm button calls `event.preventDefault()` on every press, so neither
 * `AlertDialogAction`'s own close-on-click nor `onOpenChange(false)` fires, and
 * `open` stays exactly as the caller passed it. The caller MUST close the
 * dialog from inside `onConfirm` once the mutation has succeeded:
 *
 * ```tsx
 * const [open, setOpen] = useState(false);
 * <ConfirmDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title="Delete Ada Okafor?"
 *   description="This cannot be undone."
 *   onConfirm={async () => {
 *     await deletePatient(id);
 *     setOpen(false); // <-- the caller closes it
 *   }}
 * />
 * ```
 *
 * The reason is that the alternative is worse. Closing first and closing only
 * on success are the same two lines of code here, but closing on failure would
 * throw the error away: the user would see the dialog vanish and no indication
 * that the patient still exists. Holding the dialog open until the caller says
 * so means `onConfirm` rejecting is the single failure path, and that is the
 * one this component reports.
 *
 * A caller that forgets `setOpen(false)` gets a dialog that never closes. That
 * is a visible bug, not a silent one — which is the trade this contract makes.
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
  /**
   * The action being confirmed — usually the mutation itself. Called on confirm
   * and nowhere else, and it may be async.
   *
   * **This component does not close itself.** The confirm button calls
   * `preventDefault()` on every press, so the dialog stays open whatever
   * `onConfirm` does, and `onOpenChange(false)` is yours to call from inside the
   * callback once the mutation has succeeded. See the file header for the full
   * contract and a worked example.
   *
   * A rejection is caught and rendered in the dialog as an alert; nothing
   * propagates to an unhandled rejection and the dialog stays usable.
   */
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

  /*
   * Drop a stale failure when the dialog is reopened.
   *
   * `handleConfirm` clears `error` on the *next* press, which is too late: a
   * dialog closed on failure and reopened for an unrelated action would greet
   * the user with the previous action's error message still on screen. Clearing
   * on the closed -> open edge is the only moment the old error is provably
   * about something that is no longer happening.
   */
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (open && !wasOpen.current) setError(null);
    wasOpen.current = open;
  }, [open]);

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

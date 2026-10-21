"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { acceptInvitation } from "./actions";

/**
 * The accept button on the invitation page.
 *
 * WHY THE TOKEN IS A PROP AND NOT READ HERE. The token is in the URL, and the page
 * that owns the URL passes it down; a client component that read the URL itself would
 * need the browser's history API for no gain.
 */
export function AcceptInvitationButton({ token }: { token: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <Button
        type="button"
        disabled={isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await acceptInvitation(token);
            if (result) setError(result.body.error);
          });
        }}
      >
        {isPending ? "Accepting..." : "Accept invitation"}
      </Button>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

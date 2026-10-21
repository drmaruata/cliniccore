"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ChangeEvent } from "react";

import { switchOrganization } from "@/app/app/actions";

/**
 * The organization switcher: the list of organizations the signed-in user belongs to.
 *
 * WHY THE LIST IS NEVER HELD BY THE CLIENT. The list is a MEMBERSHIP lookup, answered
 * by the database under RLS, and it is passed in as a prop from the server. A
 * client-held list of organizations would be a list the user could edit, and the first
 * thing an attacker edits is the one that names another tenant.
 *
 * WHY SWITCHING IS A SERVER ACTION. The action re-checks that the user is a member of
 * the organization they asked for, and only then writes the cookie. The cookie is a
 * hint - every read re-validates it - but the hint should never name a tenant the user
 * cannot act in, and the check belongs where the membership is known.
 */

export interface OrgOption {
  id: string;
  name: string;
  slug: string;
}

export function OrgSwitcher({
  organizations,
  activeOrgId,
}: {
  organizations: OrgOption[];
  /** The active organization, or null when the user has not chosen one yet. */
  activeOrgId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onChange(event: ChangeEvent<HTMLSelectElement>) {
    const orgId = event.target.value;
    if (orgId === "") return;
    setError(null);
    startTransition(async () => {
      const result = await switchOrganization(orgId);
      if (result) {
        setError(result.body.error);
        return;
      }
      // The cookie changed on the server; the shell has to be re-rendered from it.
      router.refresh();
    });
  }

  return (
    <div className="space-y-1">
      <label htmlFor="cc-org-switcher" className="text-xs font-medium text-muted-foreground">
        Organization
      </label>
      <select
        id="cc-org-switcher"
        value={activeOrgId ?? ""}
        onChange={onChange}
        disabled={isPending}
        className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
      >
        {activeOrgId === null && <option value="">Choose an organization…</option>}
        {organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

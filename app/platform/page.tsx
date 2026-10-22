import { notFound } from "next/navigation";

import { DataTable } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge, type StatusTone } from "@/components/shared/status-badge";
import { readTenantDirectory } from "@/lib/auth/platform";

/**
 * The tenant directory: every organization, its status, and how many members it has.
 *
 * WHY THE PAGE CHECKS AGAIN. The layout's `notFound()` produces the 404 response, but a
 * layout is not a data boundary: Next.js's authentication guide is explicit that a layout
 * does not control whether the rest of the route renders. So the page asks the data layer
 * - and the data layer refuses to read the directory for a caller who is not a platform
 * administrator.
 *
 * WHY THESE THREE COLUMNS AND NO OTHERS. The brief names them, and the query behind them
 * can return nothing else: `public.tenant_directory()` returns a name, a status and a
 * count, so no identifier, no slug and no clinical row is reachable from this route. The
 * count is an aggregate - it says how many people a tenant has, and never who they are.
 */
const STATUS_TONES: Record<string, StatusTone> = {
  active: "success",
  suspended: "pending",
  archived: "neutral",
};

export default async function PlatformPage() {
  const tenants = await readTenantDirectory();
  if (tenants === null) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenants"
        description="Every organization on the platform, with its status and its member count."
      />

      <DataTable
        caption="Organizations on the platform"
        rows={tenants}
        getRowKey={(tenant, index) => `${tenant.name}-${index}`}
        emptyTitle="No tenants yet"
        emptyDescription="No organization has been created on this platform."
        columns={[
          {
            key: "name",
            header: "Organization",
            cell: (tenant) => <span className="font-medium text-foreground">{tenant.name}</span>,
          },
          {
            key: "status",
            header: "Status",
            cell: (tenant) => (
              <StatusBadge
                label={tenant.status.charAt(0).toUpperCase() + tenant.status.slice(1)}
                tone={STATUS_TONES[tenant.status] ?? "neutral"}
              />
            ),
          },
          {
            key: "members",
            header: "Members",
            align: "right",
            cell: (tenant) => tenant.memberCount,
          },
        ]}
      />
    </div>
  );
}

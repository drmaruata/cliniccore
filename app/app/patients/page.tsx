import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getActiveOrg, userCan } from "@/lib/auth/active-org";
import { listPatients } from "@/lib/patients/queries";
import { ArchivePatientButton } from "./new/patient-form";

/**
 * The patient list: the active organization's records, a name/MRN search and the
 * archive control.
 *
 * WHY THE LIST COMES FROM `listPatients` AND NOT FROM THIS PAGE. The Task 4 query owns
 * the tenant filter, the archived filter and the PostgREST search sanitisation. A page
 * that repeated them would be a second place for the `or` grammar to leak a filter.
 *
 * WHY THE ARCHIVE FORM IS ONLY RENDERED FOR A HOLDER OF `patients.update`. `userCan` is
 * advisory and RLS is the boundary; hiding the control keeps a viewer from being offered
 * an action the database will refuse. The action re-checks the same permission and
 * returns a message instead of throwing.
 *
 * WHY A SEARCH SUBMIT AND A LINK ARE THE ONLY BUTTONS. The shell's sign-out is also a
 * submit button, so every submit here carries a name a test - and a screen reader - can
 * tell apart: "Search" and "Archive {mrn}".
 */
interface PatientsPageProps {
  searchParams: Promise<{ q?: string | string[]; archived?: string | string[] }>;
}

export default async function PatientsPage({ searchParams }: PatientsPageProps) {
  const org = await getActiveOrg();
  if (!org) return null;

  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q : "";
  const includeArchived = params.archived === "1";

  const [patients, canUpdate] = await Promise.all([
    listPatients({ search, includeArchived }),
    userCan("patients.update"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Patients"
        description={`The people registered in ${org.name}.`}
        actions={
          <Button asChild>
            <Link href="/app/patients/new">Register patient</Link>
          </Button>
        }
      />

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-sm space-y-2">
          <Label htmlFor="patient-search">Search</Label>
          <Input
            id="patient-search"
            name="q"
            type="search"
            defaultValue={search}
            placeholder="Name or record number"
          />
        </div>
        {includeArchived && <input type="hidden" name="archived" value="1" />}
        <Button type="submit">Search</Button>
        <Button asChild variant="outline">
          <Link href={includeArchived ? "/app/patients" : "/app/patients?archived=1"}>
            {includeArchived ? "Show active" : "Show archived"}
          </Link>
        </Button>
      </form>

      {patients.length === 0 ? (
        <EmptyState
          title={includeArchived ? "No archived patients" : "No patients yet"}
          description={
            search
              ? `No patient matches "${search}".`
              : includeArchived
                ? "Archived records appear here, and only here."
                : "Register the first patient to start a clinical record."
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Record number</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Date of birth</TableHead>
              <TableHead>Phone</TableHead>
              {canUpdate && <TableHead>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {patients.map((patient) => {
              const name =
                [patient.first_name, patient.last_name].filter(Boolean).join(" ") ||
                "Unnamed patient";
              return (
                <TableRow key={patient.id}>
                  <TableCell className="font-mono text-xs">{patient.mrn}</TableCell>
                  <TableCell>
                    <Link
                      href={`/app/patients/${patient.id}`}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {name}
                    </Link>
                  </TableCell>
                  <TableCell>{patient.date_of_birth ?? "—"}</TableCell>
                  <TableCell>{patient.phone ?? "—"}</TableCell>
                  {canUpdate && (
                    <TableCell>
                      <ArchivePatientButton patientId={patient.id} mrn={patient.mrn} />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

import { randomUUID } from "node:crypto";
import type { DbSession } from "./database";

export interface Fixture {
  organizationId: string;
  clinicId: string;
  patientId: string;
}

/** One tenant, one clinic and one patient, created inside the caller's transaction. */
export async function seedFixture(session: DbSession): Promise<Fixture> {
  const [organization] = await session.query<{ id: string }>(
    `insert into public.organizations (name, slug) values ('Clinical schema', $1) returning id`,
    // organizations_slug_length_check caps the slug at 48 characters.
    [`clinical-${randomUUID().slice(0, 8)}`],
  );
  if (organization === undefined) throw new Error("could not create the fixture organization");

  // clinics.timezone is filled from the organization by a BEFORE INSERT trigger.
  const [clinic] = await session.query<{ id: string }>(
    `insert into public.clinics (organization_id, name) values ($1, 'Main clinic') returning id`,
    [organization.id],
  );
  if (clinic === undefined) throw new Error("could not create the fixture clinic");

  const [patient] = await session.query<{ id: string }>(
    `insert into public.patients (organization_id, clinic_id, mrn) values ($1, $2, $3) returning id`,
    [organization.id, clinic.id, `MRN-${randomUUID()}`],
  );
  if (patient === undefined) throw new Error("could not create the fixture patient");

  return { organizationId: organization.id, clinicId: clinic.id, patientId: patient.id };
}

/** Create a role with specific permissions in an organization. Returns role id. */
export async function createRole(
  session: DbSession,
  organizationId: string,
  key: string,
  permissions: string[],
): Promise<string> {
  const [role] = await session.query<{ id: string }>(
    `insert into public.roles (organization_id, key, name, is_system)
     values ($1, $2, $3, false) returning id`,
    [organizationId, key, key],
  );
  const id = role?.id;
  if (!id) throw new Error(`could not create the role ${key}`);
  for (const permission of permissions) {
    await session.query(
      `insert into public.role_permissions (role_id, permission_key) values ($1, $2)`,
      [id, permission],
    );
  }
  return id;
}

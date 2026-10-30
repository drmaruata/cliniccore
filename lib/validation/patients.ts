/**
 * Validation schemas for patient management.
 */
import { z } from "zod";

/** Valid reason codes for archiving a patient record. */
export const PATIENT_ARCHIVE_REASON_CODES = [
  "DECEASED",
  "MOVED",
  "WITHDRAWN",
  "DUPLICATE",
  "OTHER",
] as const;

export type PatientArchiveReasonCode = (typeof PATIENT_ARCHIVE_REASON_CODES)[number];

/**
 * Schema for creating or updating a patient.
 */
export const patientInputSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(120, "First name too long"),
  lastName: z.string().trim().min(1, "Last name is required").max(120, "Last name too long"),
  dateOfBirth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD")
    .nullable()
    .refine((date) => {
      if (!date) return true;
      return new Date(date) <= new Date();
    }, "Date of birth cannot be in the future"),
  sex: z.enum(["female", "male", "other", "unknown"]).nullable(),
  phone: z.string().trim().nullable(),
  email: z.string().trim().toLowerCase().email("Invalid email format").nullable(),
  clinicId: z.string().uuid("Invalid clinic ID"),
  identifiers: z
    .array(
      z.object({
        kind: z
          .string()
          .trim()
          .min(1, "Identifier kind is required")
          .max(40, "Identifier kind too long"),
        value: z
          .string()
          .trim()
          .min(1, "Identifier value is required")
          .max(120, "Identifier value too long"),
      }),
    )
    .default([]),
});

/**
 * Schema for scheduling a patient appointment.
 */
export const appointmentInputSchema = z.object({
  patientId: z.string().uuid("Invalid patient ID"),
  clinicId: z.string().uuid("Invalid clinic ID"),
  clinicianUserId: z.string().uuid("Invalid clinician user ID"),
  startsAt: z
    .string()
    .trim()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      "StartsAt must be an ISO 8601 datetime with zone offset",
    ),
  durationMinutes: z
    .number()
    .int()
    .min(5, "Duration must be at least 5 minutes")
    .max(240, "Duration cannot exceed 240 minutes"),
  reason: z.string().trim().nullable(),
});

/**
 * Schema for adding a patient to the clinic queue.
 */
export const queueInputSchema = z.object({
  patientId: z.string().uuid("Invalid patient ID"),
  clinicId: z.string().uuid("Invalid clinic ID"),
  appointmentId: z.string().uuid("Invalid appointment ID").nullable(),
});

/**
 * Schema for archiving a patient record.
 */
export const archiveInputSchema = z.object({
  patientId: z.string().uuid("Invalid patient ID"),
  reasonCode: z.enum(PATIENT_ARCHIVE_REASON_CODES, {
    error: `Reason code must be one of: ${PATIENT_ARCHIVE_REASON_CODES.join(", ")}`,
  }),
});

/**
 * Schema for adding a patient identifier (MRN, etc).
 */
export const identifierInputSchema = z.object({
  patientId: z.string().uuid("Invalid patient ID"),
  kind: z.string().trim().min(1, "Identifier kind is required").max(40, "Identifier kind too long"),
  value: z
    .string()
    .trim()
    .min(1, "Identifier value is required")
    .max(120, "Identifier value too long"),
});

export type PatientInput = z.infer<typeof patientInputSchema>;
export type AppointmentInput = z.infer<typeof appointmentInputSchema>;
export type QueueInput = z.infer<typeof queueInputSchema>;
export type ArchiveInput = z.infer<typeof archiveInputSchema>;
export type IdentifierInput = z.infer<typeof identifierInputSchema>;

/**
 * The clinic queue status graph, kept in sync with the SQL CHECK on
 * `queue_entries.status`. The database is the authority: a direct UPDATE that
 * bypasses this action must not move a completed entry back to waiting. The
 * action labels a refused move with the current and target status rather than
 * echoing a constraint name.
 */
export const QUEUE_STATUSES = [
  "waiting",
  "called",
  "in_consultation",
  "completed",
  "skipped",
] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const QUEUE_STATUS_TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  waiting: ["called", "skipped"],
  called: ["in_consultation", "skipped"],
  in_consultation: ["completed"],
  completed: [],
  skipped: [],
};

export const queueStatusInputSchema = z.object({
  entryId: z.string().uuid("Invalid queue entry ID"),
  status: z.enum(QUEUE_STATUSES),
});

/**
 * The appointment status graph, duplicated here so the booking action can refuse a
 * transition before it reaches the database. The SQL trigger `guard_appointment_status_transition`
 * is the authority: an UPDATE that bypasses this action must not move a completed appointment
 * back to booked. The two graphs are kept in sync deliberately, and the action labels a refused
 * move with the current and target status rather than echoing a constraint name.
 */
export const APPOINTMENT_STATUSES = [
  "booked",
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_TRANSITIONS: Record<
  AppointmentStatus,
  readonly AppointmentStatus[]
> = {
  booked: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "cancelled", "no_show"],
  checked_in: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export const appointmentStatusInputSchema = z.object({
  appointmentId: z.string().uuid("Invalid appointment ID"),
  status: z.enum(APPOINTMENT_STATUSES),
});

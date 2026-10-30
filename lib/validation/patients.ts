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

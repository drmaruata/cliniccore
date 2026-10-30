/**
 * Unit tests for patient validation schemas.
 */
import { describe, it, expect } from "vitest";
import {
  patientInputSchema,
  appointmentInputSchema,
  queueInputSchema,
  archiveInputSchema,
  identifierInputSchema,
  PATIENT_ARCHIVE_REASON_CODES,
} from "@/lib/validation/patients";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const VALID_UUID_3 = "ad649163-4a9b-432c-87f8-838970c60c7c";

describe("patientInputSchema", () => {
  const validPatient = {
    firstName: "John",
    lastName: "Doe",
    dateOfBirth: "1990-01-01",
    sex: "male",
    phone: "+1234567890",
    email: "john.doe@example.com",
    clinicId: VALID_UUID,
    identifiers: [{ kind: "MRN", value: "MRN123" }],
  };

  it("parses a valid payload", () => {
    const result = patientInputSchema.safeParse(validPatient);
    expect(result.success).toBe(true);
  });

  it("parses when optional fields are null", () => {
    const result = patientInputSchema.safeParse({
      ...validPatient,
      dateOfBirth: null,
      sex: null,
      phone: null,
      email: null,
    });
    expect(result.success).toBe(true);
  });

  it("refuses empty first name", () => {
    const result = patientInputSchema.safeParse({ ...validPatient, firstName: " " });
    expect(result.success).toBe(false);
  });

  it("refuses empty last name", () => {
    const result = patientInputSchema.safeParse({ ...validPatient, lastName: " " });
    expect(result.success).toBe(false);
  });

  it("refuses excessively long first name", () => {
    const result = patientInputSchema.safeParse({
      ...validPatient,
      firstName: "a".repeat(121),
    });
    expect(result.success).toBe(false);
  });

  it("refuses excessively long last name", () => {
    const result = patientInputSchema.safeParse({
      ...validPatient,
      lastName: "a".repeat(121),
    });
    expect(result.success).toBe(false);
  });

  it("refuses future date of birth", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const dateStr = futureDate.toISOString().split("T")[0];

    const result = patientInputSchema.safeParse({ ...validPatient, dateOfBirth: dateStr });
    expect(result.success).toBe(false);
  });

  it("refuses invalid date format for date of birth", () => {
    const result = patientInputSchema.safeParse({ ...validPatient, dateOfBirth: "01-01-1990" });
    expect(result.success).toBe(false);
  });

  it("refuses invalid sex", () => {
    const result = patientInputSchema.safeParse({ ...validPatient, sex: "invalid" });
    expect(result.success).toBe(false);
  });

  it("refuses invalid email format", () => {
    const result = patientInputSchema.safeParse({ ...validPatient, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("refuses invalid clinicId", () => {
    const result = patientInputSchema.safeParse({ ...validPatient, clinicId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("refuses invalid identifiers", () => {
    const result = patientInputSchema.safeParse({
      ...validPatient,
      identifiers: [{ kind: " ", value: "VAL" }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses excessively long identifier kind", () => {
    const result = patientInputSchema.safeParse({
      ...validPatient,
      identifiers: [{ kind: "a".repeat(41), value: "VAL" }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses excessively long identifier value", () => {
    const result = patientInputSchema.safeParse({
      ...validPatient,
      identifiers: [{ kind: "KIND", value: "a".repeat(121) }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults identifiers to empty array", () => {
    const { identifiers: _identifiers, ...patientWithoutIds } = validPatient;
    const result = patientInputSchema.safeParse(patientWithoutIds);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.identifiers).toEqual([]);
    }
  });
});

describe("appointmentInputSchema", () => {
  const validAppointment = {
    patientId: VALID_UUID,
    clinicId: VALID_UUID_2,
    clinicianUserId: VALID_UUID_3,
    startsAt: "2026-10-30T10:00:00Z",
    durationMinutes: 30,
    reason: "Checkup",
  };

  it("parses a valid payload", () => {
    const result = appointmentInputSchema.safeParse(validAppointment);
    expect(result.success).toBe(true);
  });

  it("parses with zone offset", () => {
    const result = appointmentInputSchema.safeParse({
      ...validAppointment,
      startsAt: "2026-10-30T10:00:00+05:30",
    });
    expect(result.success).toBe(true);
  });

  it("refuses ISO string without zone offset", () => {
    const result = appointmentInputSchema.safeParse({
      ...validAppointment,
      startsAt: "2026-10-30T10:00:00",
    });
    expect(result.success).toBe(false);
  });

  it("refuses duration below 5 minutes", () => {
    const result = appointmentInputSchema.safeParse({
      ...validAppointment,
      durationMinutes: 4,
    });
    expect(result.success).toBe(false);
  });

  it("refuses duration above 240 minutes", () => {
    const result = appointmentInputSchema.safeParse({
      ...validAppointment,
      durationMinutes: 241,
    });
    expect(result.success).toBe(false);
  });

  it("refuses invalid UUIDs", () => {
    expect(
      appointmentInputSchema.safeParse({ ...validAppointment, patientId: "invalid" }).success,
    ).toBe(false);
    expect(
      appointmentInputSchema.safeParse({ ...validAppointment, clinicId: "invalid" }).success,
    ).toBe(false);
    expect(
      appointmentInputSchema.safeParse({ ...validAppointment, clinicianUserId: "invalid" }).success,
    ).toBe(false);
  });
});

describe("queueInputSchema", () => {
  const validQueue = {
    patientId: VALID_UUID,
    clinicId: VALID_UUID_2,
    appointmentId: VALID_UUID_3,
  };

  it("parses a valid payload", () => {
    const result = queueInputSchema.safeParse(validQueue);
    expect(result.success).toBe(true);
  });

  it("parses when appointmentId is null", () => {
    const result = queueInputSchema.safeParse({ ...validQueue, appointmentId: null });
    expect(result.success).toBe(true);
  });

  it("refuses invalid UUIDs", () => {
    expect(queueInputSchema.safeParse({ ...validQueue, patientId: "invalid" }).success).toBe(false);
    expect(queueInputSchema.safeParse({ ...validQueue, clinicId: "invalid" }).success).toBe(false);
    expect(queueInputSchema.safeParse({ ...validQueue, appointmentId: "invalid" }).success).toBe(
      false,
    );
  });
});

describe("archiveInputSchema", () => {
  const validArchive = {
    patientId: VALID_UUID,
    reasonCode: PATIENT_ARCHIVE_REASON_CODES[0],
  };

  it("parses a valid payload", () => {
    const result = archiveInputSchema.safeParse(validArchive);
    expect(result.success).toBe(true);
  });

  it("refuses invalid reason code", () => {
    const result = archiveInputSchema.safeParse({
      ...validArchive,
      reasonCode: "INVALID_CODE",
    });
    expect(result.success).toBe(false);
  });

  it("refuses invalid patientId", () => {
    const result = archiveInputSchema.safeParse({ ...validArchive, patientId: "invalid" });
    expect(result.success).toBe(false);
  });
});

describe("identifierInputSchema", () => {
  const validId = {
    patientId: VALID_UUID,
    kind: "MRN",
    value: "MRN123",
  };

  it("parses a valid payload", () => {
    const result = identifierInputSchema.safeParse(validId);
    expect(result.success).toBe(true);
  });

  it("refuses empty kind", () => {
    const result = identifierInputSchema.safeParse({ ...validId, kind: " " });
    expect(result.success).toBe(false);
  });

  it("refuses excessively long kind", () => {
    const result = identifierInputSchema.safeParse({
      ...validId,
      kind: "a".repeat(41),
    });
    expect(result.success).toBe(false);
  });

  it("refuses empty value", () => {
    const result = identifierInputSchema.safeParse({ ...validId, value: " " });
    expect(result.success).toBe(false);
  });

  it("refuses excessively long value", () => {
    const result = identifierInputSchema.safeParse({
      ...validId,
      value: "a".repeat(121),
    });
    expect(result.success).toBe(false);
  });

  it("refuses invalid patientId", () => {
    const result = identifierInputSchema.safeParse({ ...validId, patientId: "invalid" });
    expect(result.success).toBe(false);
  });
});

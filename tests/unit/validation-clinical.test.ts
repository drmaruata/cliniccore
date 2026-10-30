import { expect, it } from "vitest";
import { encounterDraftSchema } from "@/lib/validation/clinical";

it("refuses 8001-character field", () => {
  const data = { chiefComplaint: "a".repeat(8001) };
  expect(encounterDraftSchema.safeParse(data).success).toBe(false);
});

it("accepts valid data", () => {
  const data = {
    chiefComplaint: "Valid",
    history: null,
    examination: null,
    assessment: null,
    plan: null,
  };
  expect(encounterDraftSchema.safeParse(data).success).toBe(true);
});

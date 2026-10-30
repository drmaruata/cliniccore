import { z } from "zod";

export const encounterDraftSchema = z.object({
  chiefComplaint: z.string().max(8000).nullable().optional(),
  history: z.string().max(8000).nullable().optional(),
  examination: z.string().max(8000).nullable().optional(),
  assessment: z.string().max(8000).nullable().optional(),
  plan: z.string().max(8000).nullable().optional(),
});

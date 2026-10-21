/**
 * The shapes a server action receives, and the message a validation failure produces.
 *
 * WHY A SERVER ACTION ACCEPTS TWO SHAPES. A client component that calls an action
 * directly passes a plain object. A NATIVE form submit - which is what happens when
 * JavaScript is unavailable, and what makes a form work without it - posts FormData
 * and puts every field, INCLUDING THE PASSWORD, in the query string. That is history,
 * an access log and a Referer header, so the forms carry a real `action` and the
 * action accepts both shapes.
 *
 * WHY THE VALIDATION MESSAGE IS HERE. Every action needs the same thing: the first
 * field error, flattened to a sentence. Four copies of that loop is four places for it
 * to be wrong.
 */

import type { ZodError } from "zod";

/** A form's fields, whether they arrived as FormData or as an object. */
export function toActionInput(data: unknown): Record<string, unknown> {
  if (data instanceof FormData) {
    return Object.fromEntries(data.entries());
  }
  if (typeof data === "object" && data !== null) {
    return data as Record<string, unknown>;
  }
  return {};
}

/** The field errors of a failed parse, as one sentence. */
export function fieldErrorMessage(error: ZodError): string {
  const messages = Object.values(error.flatten().fieldErrors).flat();
  return messages.length > 0 ? messages.join(", ") : "That input is not valid.";
}

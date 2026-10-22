import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names, letting later conflicting utilities win. Every component
 * task in this repo uses this helper instead of ad-hoc string concatenation, so that
 * conditional classes stay de-duplicated.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

import { twMerge } from "tailwind-merge";

type ClassValue = string | false | null | undefined;

/**
 * Join class names and resolve Tailwind utility conflicts so caller-supplied
 * classes (later arguments) reliably override component defaults.
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(values.filter(Boolean).join(" "));
}

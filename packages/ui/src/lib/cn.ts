import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import type { ClassValue } from "clsx";

/**
 * `clsx` for conditionals, `tailwind-merge` so the last conflicting utility wins.
 * Every component takes `className`, so a caller can always override.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import type { ClassValue } from "clsx";

/**
 * shadcn/ui's class helper: `clsx` for conditionals, `tailwind-merge` to make the
 * last conflicting Tailwind utility win, so a caller can always override a
 * component's own classes.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

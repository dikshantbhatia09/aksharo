import { randomInt } from "node:crypto";

import {
  LICENSE_KEY_ALPHABET,
  LICENSE_KEY_GROUP_LENGTH,
  LICENSE_KEY_GROUPS,
  LICENSE_KEY_PREFIX,
} from "./licensing.constants.js";

/** `AK-XXXX-XXXX-XXXX` -- `randomInt` is rejection-sampled, so the draw is uniform. */
export function generateLicenseKey(): string {
  const groups: string[] = [];
  for (let g = 0; g < LICENSE_KEY_GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < LICENSE_KEY_GROUP_LENGTH; i += 1) {
      group += LICENSE_KEY_ALPHABET[randomInt(LICENSE_KEY_ALPHABET.length)];
    }
    groups.push(group);
  }
  return `${LICENSE_KEY_PREFIX}-${groups.join("-")}`;
}

/** Upper-cases and trims what a person typed; does not validate the alphabet. */
export function normaliseLicenseKey(input: string): string {
  return input.trim().toUpperCase();
}

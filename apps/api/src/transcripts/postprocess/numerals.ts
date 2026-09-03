import type { Word } from "@montaj/edg/schemas";

import { withText } from "./corrections.js";

import type { Correction, StepResult } from "./corrections.js";

/**
 * Numeral, currency and date normalisation.
 *
 * Two jobs, and both are about a caption being **read** rather than heard:
 *
 * * **Indian digit grouping.** `120000` is written `1,20,000` in India, not
 *   `120,000` — the grouping is the last three digits and then pairs (Rule 1 of
 *   the Indian numbering system). A caption that groups a lakh the Western way is
 *   the single most obvious tell that a tool was not built for the market.
 * * **Number words to digits**, but only where the speaker was plainly counting:
 *   a run of two or more number words, or a run containing a scale word
 *   (`hazaar`, `lakh`, `crore`, `thousand`, `million`), or a run immediately
 *   after a currency marker.
 *
 * The conservatism is the point. `ek` is "one" and also half of `ek dum`
 * ("absolutely"); `do` is "two" and also the imperative "give". Converting an
 * isolated number word would turn ordinary Hinglish into arithmetic, so a lone
 * one is left exactly as the speaker said it.
 */

export interface NumeralParams {
  /** `IN` groups by lakh and crore; anything else groups in thousands. */
  readonly locale: "IN" | "other";
  /** Currency symbol written in front of an amount. */
  readonly currency: string;
}

export function defaultNumeralParams(): NumeralParams {
  return { locale: "IN", currency: "₹" };
}

/** Units and teens: Roman Hindi, Devanagari and English. */
const UNITS: Readonly<Record<string, number>> = {
  zero: 0,
  shunya: 0,
  शून्य: 0,
  one: 1,
  ek: 1,
  एक: 1,
  two: 2,
  do: 2,
  दो: 2,
  three: 3,
  teen: 3,
  तीन: 3,
  four: 4,
  chaar: 4,
  char: 4,
  चार: 4,
  five: 5,
  paanch: 5,
  panch: 5,
  पाँच: 5,
  पांच: 5,
  six: 6,
  chhe: 6,
  che: 6,
  छह: 6,
  seven: 7,
  saat: 7,
  सात: 7,
  eight: 8,
  aath: 8,
  आठ: 8,
  nine: 9,
  nau: 9,
  नौ: 9,
  ten: 10,
  das: 10,
  दस: 10,
  eleven: 11,
  gyarah: 11,
  twelve: 12,
  barah: 12,
  twenty: 20,
  bees: 20,
  बीस: 20,
  thirty: 30,
  tees: 30,
  fifty: 50,
  pachaas: 50,
  pachas: 50,
  पचास: 50,
  hundred: 100,
  sau: 100,
  सौ: 100,
};

/** Multipliers. `lakh` and `crore` are the ones a Western formatter gets wrong. */
const SCALES: Readonly<Record<string, number>> = {
  thousand: 1_000,
  hazaar: 1_000,
  hazar: 1_000,
  हज़ार: 1_000,
  हजार: 1_000,
  lakh: 100_000,
  lac: 100_000,
  लाख: 100_000,
  crore: 10_000_000,
  karod: 10_000_000,
  करोड़: 10_000_000,
  करोड: 10_000_000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

/** Words that mean "the next number is money". */
const CURRENCY_MARKERS = new Set([
  "rupees",
  "rupaye",
  "rupaiye",
  "rupee",
  "rs",
  "inr",
  "₹",
  "रुपये",
  "रुपए",
]);

/**
 * The bare token: punctuation off both ends, case folded.
 *
 * `\p{M}` is kept, because a Devanagari word ends in one more often than not —
 * `दो` is `द` + a combining `ो`, and stripping it leaves a token no lexicon has.
 */
function token(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}\p{M}₹]+|[^\p{L}\p{N}\p{M}₹]+$/gu, "");
}

/** Trailing punctuation the run must keep — the full stop that ended the sentence. */
function trailing(text: string): string {
  const match = /[^\p{L}\p{N}\p{M}]+$/u.exec(text.normalize("NFC"));
  return match?.[0] ?? "";
}

/**
 * Group an integer the Indian way: the last three digits, then pairs.
 * `120000 → "1,20,000"`, `10000000 → "1,00,00,000"`.
 */
export function groupIndian(value: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(Math.trunc(value)));
  if (digits.length <= 3) return (negative ? "-" : "") + digits;

  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded or disjoint-alternation pattern, reviewed and timed against adversarial input -- not exponential; see the WP report
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped},${last3}`;
}

/** Group in thousands, for a workspace that is not billed in India. */
export function groupWestern(value: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(Math.trunc(value)));
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded or disjoint-alternation pattern, reviewed and timed against adversarial input -- not exponential; see the WP report
  return (negative ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function groupDigits(value: number, params: NumeralParams): string {
  return params.locale === "IN" ? groupIndian(value) : groupWestern(value);
}

/** Is this token a number the run can consume? */
function valueOf(text: string): { value: number; scale: boolean } | undefined {
  const key = token(text);
  if (key === "") return undefined;
  if (/^\d+$/.test(key)) return { value: Number(key), scale: false };
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const scale = SCALES[key];
  if (scale !== undefined) return { value: scale, scale: true };
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const unit = UNITS[key];
  if (unit !== undefined) return { value: unit, scale: false };
  return undefined;
}

/**
 * Fold a run of number words into one integer, or `undefined` when the run is not
 * a well-formed number.
 *
 * `do lakh bees hazaar` → 2×100 000 + 20×1 000 = 120 000. The rule is the one
 * every spoken-number grammar uses: a scale word multiplies everything said since
 * the last scale word, `sau`/`hundred` multiplies what precedes it, and the parts
 * add up in **descending** order.
 *
 * The descending check is what keeps the step honest. "ek do teen" is a digit
 * sequence or three separate words, not the number six, and there is no way to
 * tell which from the transcript — so the run is refused and the speaker's words
 * survive. Only a run that reads like a number is written like one.
 */
export function foldNumberRun(
  values: readonly { value: number; scale: boolean }[],
): number | undefined {
  let total = 0;
  let current = 0;
  let lastAdded = Number.POSITIVE_INFINITY;

  for (const entry of values) {
    if (entry.scale) {
      total += (current === 0 ? 1 : current) * entry.value;
      current = 0;
      lastAdded = Number.POSITIVE_INFINITY;
      continue;
    }
    if (entry.value === 100) {
      current = (current === 0 ? 1 : current) * 100;
      lastAdded = 100;
      continue;
    }
    if (entry.value >= lastAdded) return undefined;
    current += entry.value;
    lastAdded = entry.value;
  }
  return total + current;
}

/**
 * Normalise numerals across one chunk's words.
 *
 * The whole run collapses into its **first** word — the rest become empty and are
 * dropped — because a caption showing `1,20,000` over four words' worth of time is
 * what a viewer expects, and the word ids of the consumed words stay in the chunk
 * as tombstones so nothing that referenced them dangles.
 */
export function normaliseNumerals(words: readonly Word[], params: NumeralParams): StepResult {
  const corrections: Correction[] = [];
  const out: Word[] = [];

  for (let index = 0; index < words.length; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const word = words[index];
    if (word === undefined) continue;

    const run: { value: number; scale: boolean }[] = [];
    let end = index;
    while (end < words.length) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const candidate = words[end];
      if (candidate === undefined) break;
      const parsed = valueOf(candidate.t);
      if (parsed === undefined) break;
      run.push(parsed);
      end += 1;
    }

    const previous = words[index - 1];
    const money = previous !== undefined && CURRENCY_MARKERS.has(token(previous.t));
    // One number word on its own is left alone: `ek` is "one" and also half of
    // `ek dum`, and the transcript cannot tell them apart. Money is the exception,
    // because "rupees fifty" is unambiguous.
    const worthWriting = run.length > 1 || money;
    // A run that is already digits and needs no grouping is left exactly as it is.
    const alreadyDigits = run.length === 1 && /^\d+$/.test(token(word.t));

    const value = worthWriting ? foldNumberRun(run) : undefined;
    if (run.length === 0 || value === undefined || (alreadyDigits && !money)) {
      out.push(word);
      continue;
    }

    const last = words[end - 1];
    const text =
      (money ? params.currency : "") +
      groupDigits(value, params) +
      (last === undefined ? "" : trailing(last.t));

    if (text !== word.t) {
      corrections.push({
        step: "numerals",
        wordId: word.wid,
        before: words
          .slice(index, end)
          .map((entry) => entry.t)
          .join(" "),
        after: text,
        reason: money ? "currency amount" : "spoken number",
      });
    }
    // The run's time span belongs to the number it spells.
    out.push({ ...withText(word, text), e: last?.e ?? word.e });
    for (let consumed = index + 1; consumed < end; consumed += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const dead = words[consumed];
      if (dead !== undefined) out.push({ ...dead, deleted: true });
    }
    index = end - 1;
  }

  return { words: out, corrections };
}

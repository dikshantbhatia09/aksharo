import { BRAND } from "@montaj/config";

/**
 * A local, bounded "commonly used or compromised" check.
 *
 * NIST SP 800-63B-4 requires a password to be compared against a list of
 * commonly used, expected or compromised values. {@link BreachedPasswordService}
 * does that against Have I Been Pwned's k-anonymity range API, which is the
 * larger and better list — but it is someone else's network service, it is
 * deliberately time-limited to 2 s, and it fails open. That means the check the
 * policy depends on disappears exactly when an attacker is hammering sign-up
 * hard enough to make outbound requests slow (launch-readiness P0-06).
 *
 * This list never leaves the process. It is small on purpose: the top passwords
 * plus the structural shapes that dominate real credential dumps, which between
 * them cover most of what an online guesser tries first. It is the floor under
 * the remote check, not a replacement for it.
 *
 * Deliberately *not* a composition rule. Nothing here says "must contain a
 * digit"; every rule rejects a specific weak value or shape, which is what
 * SP 800-63B-4 asks for and what leaves long passphrases alone.
 */

/**
 * Passwords that appear at the top of essentially every public breach corpus,
 * plus the ones this product invites by name.
 *
 * Stored lowercase and compared after {@link normalise}, so `P@ssw0rd!` and
 * `password123` both reduce to an entry here.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "passwort",
  "passw",
  "pass",
  "secret",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "root",
  "login",
  "user",
  "guest",
  "test",
  "demo",
  "changeme",
  "default",
  "temp",
  "temporary",
  "qwerty",
  "qwertyuiop",
  "qwertz",
  "azerty",
  "asdf",
  "asdfgh",
  "asdfghjkl",
  "zxcvbn",
  "zxcvbnm",
  "iloveyou",
  "princess",
  "sunshine",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "superman",
  "batman",
  "master",
  "shadow",
  "michael",
  "jennifer",
  "jordan",
  "hunter",
  "trustno",
  "freedom",
  "whatever",
  "starwars",
  "computer",
  "internet",
  "samsung",
  "google",
  "facebook",
  "chocolate",
  "cookie",
  "flower",
  "summer",
  "winter",
  "spring",
  "autumn",
  "india",
  "bharat",
  "mumbai",
  "delhi",
  "chennai",
  "bangalore",
  "hyderabad",
  "kolkata",
  "krishna",
  "ganesh",
  "shiva",
  "namaste",
  "abcd",
  "abcdef",
  "abcdefg",
  "abcdefgh",
  "abc",
  "aaaa",
  "iloveu",
  "lovely",
  "naruto",
  "pokemon",
  "minecraft",
  "liverpool",
  "arsenal",
  "chelsea",
  "barcelona",
  "realmadrid",
  "manchester",
  "cricket",
  "sachin",
  "virat",
  "dhoni",
]);

/** `a`→`a`, `@`→`a`, `0`→`o`, … so leetspeak does not buy a weak word a pass. */
const LEET: ReadonlyMap<string, string> = new Map([
  ["@", "a"],
  ["4", "a"],
  ["8", "b"],
  ["(", "c"],
  ["3", "e"],
  ["6", "g"],
  ["1", "i"],
  ["!", "i"],
  ["|", "i"],
  ["0", "o"],
  ["5", "s"],
  ["$", "s"],
  ["7", "t"],
  ["+", "t"],
  ["2", "z"],
]);

function undoLeet(value: string): string {
  let undone = "";
  for (const character of value) undone += LEET.get(character) ?? character;
  return undone;
}

/**
 * Every stem an attacker's rule engine could have grown this password from.
 *
 * One canonical form is not enough, because the transformations fight each
 * other. Undoing leetspeak first turns the `2024` in `P@ssw0rd!2024` into
 * letters; stripping symbols first throws away the `@` that was standing in for
 * an `a`. So the decorations are trimmed off the *ends* before leetspeak is
 * undone on what is left, and the plain alphanumeric core is kept alongside it.
 * Matching any stem is enough.
 *
 * `P@ssw0rd!2024` → `password`; `Qwerty123!` → `qwerty`; `2024letmein` →
 * `letmein`.
 */
export function normalisations(password: string): readonly string[] {
  const lowered = password.toLowerCase();
  const stems = new Set<string>();
  const add = (value: string): void => {
    if (value !== "") stems.add(value);
  };

  // The alphanumeric core, and the same without the leading/trailing digit runs
  // that years and counters produce.
  const core = lowered.replace(/[^a-z0-9]/g, "");
  add(core);
  add(core.replace(/[0-9]+$/, ""));
  add(core.replace(/^[0-9]+/, ""));

  // Decorations live at the ends; substitutions live inside. Trim the former,
  // then undo the latter on the word that remains.
  const trimmed = lowered.replace(/^[^a-z]+/, "").replace(/[^a-z]+$/, "");
  add(trimmed.replace(/[^a-z]/g, ""));
  add(undoLeet(trimmed).replace(/[^a-z]/g, ""));

  return [...stems];
}

/** The primary stem, for callers (and tests) that want one string. */
export function normalise(password: string): string {
  return normalisations(password)[0] ?? "";
}

/** Is every character the same? `aaaaaaaaaaaaaaa`. */
function isRepeatedCharacter(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character === value[0]);
}

/**
 * Is this a run along the keyboard or the alphabet, in either direction?
 * `123456789012345`, `abcdefghijklmno`, `987654321`.
 */
function isSequential(value: string): boolean {
  if (value.length < 4) return false;
  const codes = [...value].map((character) => character.codePointAt(0) ?? 0);
  const ascending = codes.every((code, index) => index === 0 || code === (codes[index - 1] ?? 0) + 1);
  const descending = codes.every(
    (code, index) => index === 0 || code === (codes[index - 1] ?? 0) - 1,
  );
  return ascending || descending;
}

/**
 * A short repeated unit padded out to length: `abcabcabcabcabc`, `1212121212`.
 * Length alone must not make a five-character password acceptable.
 */
function isShortRepeatingUnit(value: string): boolean {
  for (let unit = 1; unit <= Math.floor(value.length / 3); unit += 1) {
    if (value.length % unit !== 0) continue;
    const head = value.slice(0, unit);
    if (value === head.repeat(value.length / unit)) return true;
  }
  return false;
}

export type CommonPasswordReason =
  | "common_password"
  | "repeated_characters"
  | "sequential_characters"
  | "contains_product_name";

/**
 * Why this password is unacceptable, or `undefined` if the local list has no
 * objection. Says nothing about length — {@link PasswordService.check} owns that.
 */
export function commonPasswordReason(password: string): CommonPasswordReason | undefined {
  const stems = normalisations(password);
  const lowered = password.toLowerCase();
  const stripped = lowered.replace(/[^a-z0-9]/g, "");

  if (stems.some((stem) => COMMON_PASSWORDS.has(stem))) return "common_password";

  // The brand and its domain are the words a user of *this* product is most
  // likely to reach for, and the ones an attacker targeting it will try first.
  const brandWords = [BRAND.name.toLowerCase(), BRAND.domain.split(".")[0]?.toLowerCase() ?? ""];
  for (const word of brandWords) {
    if (word.length >= 4 && stems.some((stem) => stem.includes(word))) {
      return "contains_product_name";
    }
  }

  // Padding checks run on the lowered string as well as the alphanumeric core,
  // so a password made entirely of one punctuation mark is caught too.
  if (isRepeatedCharacter(stripped) || isRepeatedCharacter(lowered)) return "repeated_characters";
  if (isSequential(stripped) || isShortRepeatingUnit(stripped)) {
    return "sequential_characters";
  }

  return undefined;
}

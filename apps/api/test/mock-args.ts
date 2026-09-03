import type { Mock } from "vitest";

/**
 * Read an argument out of a Vitest mock, typed.
 *
 * `vi.fn(async () => row)` has no declared parameters, so Vitest types its
 * `mock.calls` as `[]` and `calls[0]?.[0]` is a compile error under
 * `noUncheckedIndexedAccess` — even though the code under test very much passed
 * an argument. Declaring every fake's full parameter list would be pages of
 * Prisma types that prove nothing; this reads the call the way the assertion
 * means to and names the type it expects.
 */
export function callArg<T = Record<string, unknown>>(mock: unknown, call = 0, index = 0): T {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return calls[call]?.[index] as T;
}

/**
 * A fake's method as the mock it is.
 *
 * A fake declared as `{...} as unknown as ObjectStore & Record<string, Mock>`
 * reads back through the *interface* member type, which has no
 * `mockRejectedValueOnce` on it. This is the cast, in one place and named.
 */
export function asMock(fn: unknown): Mock {
  return fn as Mock;
}

/**
 * A rendezvous between two Vitest worker processes.
 *
 * `test/isolation-alpha.e2e-spec.ts` and `test/isolation-beta.e2e-spec.ts` prove
 * that two suites running at the same instant cannot see each other's data. That
 * only proves anything if they really do overlap: an assertion made after the
 * sibling has finished would pass just as well on a shared database. So each side
 * drops a marker file and waits for the other's before it asserts.
 *
 * Files rather than a socket or a port, because the two sides are separate
 * processes with no channel between them and this has to work identically on
 * Windows and Linux. The directory is keyed on the run id, so two runs on one
 * machine never meet.
 *
 * A timeout is not a failure: running one of the pair on its own is a legitimate
 * thing to do, and every assertion in the probe still holds when the sibling never
 * arrives — it just proves less.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER = ".marker";
const POLL_MS = 100;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RendezvousResult {
  /** Party name -> the note it published. Always includes this caller. */
  readonly parties: Readonly<Record<string, string>>;
  /** `false` when the wait timed out with fewer parties than expected. */
  readonly met: boolean;
}

/**
 * Publish `note` under `party`, then wait until `expected` parties have done the
 * same at the same barrier.
 */
export async function rendezvous(
  runId: string,
  barrier: string,
  party: string,
  note = "",
  expected = 2,
  timeoutMs = 30_000,
): Promise<RendezvousResult> {
  const dir = join(tmpdir(), "montaj-a23a", runId, barrier);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  writeFileSync(join(dir, `${party}${MARKER}`), note, "utf8");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const parties: Record<string, string> = {};
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(MARKER)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      parties[file.slice(0, -MARKER.length)] = readFileSync(join(dir, file), "utf8");
    }
    if (Object.keys(parties).length >= expected) return { parties, met: true };
    if (Date.now() > deadline) {
      console.warn(
        `[isolation] barrier "${barrier}": only ${String(Object.keys(parties).length)} of ` +
          `${String(expected)} parties arrived within ${String(timeoutMs)}ms — ` +
          "the cross-suite assertions below prove less than they could.",
      );
      return { parties, met: false };
    }
    await sleep(POLL_MS);
  }
}

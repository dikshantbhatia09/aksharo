/**
 * One half of the A23a collision test; `test/isolation-probe.ts` holds the body
 * and `test/isolation-beta.e2e-spec.ts` is the other half. Two files, because the
 * claim under test is that two SUITES cannot see each other — and Vitest's unit of
 * parallelism is the file.
 */
import { isolationProbe } from "./isolation-probe.js";

isolationProbe("alpha");

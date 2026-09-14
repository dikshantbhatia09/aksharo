/**
 * Process roles this image actually implements.
 *
 * There is exactly one. The Helm chart used to start the same image with
 * `--role=realtime` and `--role=scheduler`, and nothing ever parsed the flag:
 * all three "roles" booted the identical full `AppModule`, on whichever port
 * `API_PORT`/`API_ORIGIN` named rather than the port the chart declared. The
 * deployment therefore claimed an isolation — separate secrets, separate
 * scaling, separate blast radius — that did not exist, and the realtime Service
 * pointed at a port nothing listened on (launch-readiness P0-03).
 *
 * Refusing an unimplemented role is the honest failure: a pod that will not
 * start is a deploy that stops, where a pod that silently starts the wrong
 * process is an outage found by customers. When real per-role module graphs
 * exist, add the role here and to the chart in the same change.
 *
 * Neither missing role is a correctness gap today:
 *   * realtime is the same process listening on `/realtime` (the WebSocket
 *     upgrade path, `realtime/realtime.protocol.ts`), so it needs no second
 *     Deployment to work — only to scale separately;
 *   * scheduled work is dispatched through BullMQ repeatable jobs
 *     (`common/scheduler/scheduled-tasks.service.ts`), so a tick becomes exactly
 *     one job and exactly one replica runs it, however many replicas exist.
 */

export const IMPLEMENTED_ROLES = ["api"] as const;

export type Role = (typeof IMPLEMENTED_ROLES)[number];

export class UnimplementedRoleError extends Error {
  constructor(role: string) {
    super(
      `--role=${role} is not implemented by this image. It runs one coherent API ` +
        `process (--role=${IMPLEMENTED_ROLES.join("|")}): the realtime gateway is ` +
        "served by that same process on the /realtime path, and scheduled tasks " +
        "are dispatched through Redis so every replica may run them safely. " +
        "Remove the flag from the chart, or implement the role before declaring it.",
    );
    this.name = "UnimplementedRoleError";
  }
}

/** Read `--role=<name>` from argv. Defaults to `api`; throws on anything else. */
export function parseRole(argv: readonly string[]): Role {
  const flag = argv.find((argument) => argument.startsWith("--role="));
  if (flag === undefined) return "api";

  const value = flag.slice("--role=".length);
  if ((IMPLEMENTED_ROLES as readonly string[]).includes(value)) return value as Role;

  throw new UnimplementedRoleError(value);
}

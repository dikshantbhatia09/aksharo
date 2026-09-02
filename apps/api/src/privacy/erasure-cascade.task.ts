import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ErasureCascadeService } from "./erasure-cascade.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";

export const ERASURE_CASCADE_TASK = "privacy.erasure-cascade";

/** Daily; the cascade has up to 30 days (DPDP Rule 14), so a day's latency is fine. */
const ERASURE_CASCADE_CRON = "0 3 * * *";
const BATCH = 100;

/**
 * Wires `ErasureCascadeService` into the scheduler. Every `dsr_requests` row
 * of kind `erasure` still `received` (`ProfileService.requestErasure`, A05,
 * creates them) gets the cascade run once; `ErasureCascadeService.run` itself
 * moves a request to `in_progress` and then `completed`, so a request this
 * task has already started is not picked up again on the same tick, and a
 * request a previous tick could not finish (a crash mid-cascade) is retried —
 * it is still `in_progress`, not `received`, in that case, so this simple
 * `WHERE status = 'received'` deliberately does not retry an interrupted one
 * automatically; an operator's manual trigger
 * (`POST /admin/privacy/erasure/{dsrRequestId}/run`, B13) is how a stuck
 * `in_progress` row is resumed. `ErasureCascadeService.run` is itself
 * idempotent to call twice, so that manual retry is always safe.
 */
@Injectable()
export class ErasureCascadeTask implements OnModuleInit {
  private readonly logger = new Logger(ErasureCascadeTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cascade: ErasureCascadeService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: ERASURE_CASCADE_TASK,
      cron: ERASURE_CASCADE_CRON,
      run: async () => {
        const processed = await this.sweep();
        if (processed > 0) this.logger.log({ processed }, "erasure cascade sweep");
      },
    });
  }

  async sweep(): Promise<number> {
    const due = await this.prisma.dsrRequest.findMany({
      where: { kind: "erasure", status: "received" },
      select: { id: true },
      take: BATCH,
    });
    for (const request of due) {
      await this.cascade.run(request.id);
    }
    return due.length;
  }
}

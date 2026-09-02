import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const MEMORY_ENTRY_EXPIRY_TASK = "scheduler.memory-entry-expiry";

/** Daily (06-data-model.md §Retention jobs: "memory-entry expiry (12-month rolling)"). */
const MEMORY_ENTRY_EXPIRY_CRON = "30 2 * * *";
const BATCH = 2_000;

/**
 * Deletes `memory_entries` past `expiresAt` — the 12-month rolling window every
 * row already carries for itself (D61's "remembering your preferences" purpose,
 * `privacy-notice.ts`), refreshed to `now + 12mo` on every use by the module
 * that writes memory entries. This task only ever reads the column; it does not
 * compute the window.
 */
@Injectable()
export class MemoryEntryExpiryTask implements OnModuleInit {
  private readonly logger = new Logger(MemoryEntryExpiryTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: MEMORY_ENTRY_EXPIRY_TASK,
      cron: MEMORY_ENTRY_EXPIRY_CRON,
      run: async ({ at }) => {
        const deleted = await this.sweep(at);
        if (deleted > 0) this.logger.log({ deleted }, "memory entries expired");
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<number> {
    let deleted = 0;
    for (;;) {
      const due = await this.prisma.memoryEntry.findMany({
        where: { expiresAt: { lte: now } },
        select: { id: true },
        take: BATCH,
      });
      if (due.length === 0) break;
      const { count } = await this.prisma.memoryEntry.deleteMany({
        where: { id: { in: due.map((row) => row.id) } },
      });
      deleted += count;
      if (due.length < BATCH) break;
    }
    return deleted;
  }
}

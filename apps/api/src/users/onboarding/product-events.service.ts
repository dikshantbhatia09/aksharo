import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../../common/index.js";

import type { Prisma } from "@prisma/client";

/**
 * Launch-metrics instrumentation (B17 brief §2, `13-launch-plan.md`).
 *
 * `product_events` is append-only and deliberately has no foreign keys to
 * `users`/`workspaces` (see the model's comment in `schema.prisma`): recording
 * an event must never fail, or be blocked, by an unrelated write. A failure to
 * record is logged and swallowed — losing one metrics row is a rounding error;
 * failing the onboarding save it rides along with is not.
 */
export interface RecordProductEventInput {
  readonly kind: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly source?: string;
  readonly codeType?: "affiliate" | "referral" | "invalid";
  readonly props?: Record<string, unknown>;
}

@Injectable()
export class ProductEventsService {
  private readonly logger = new Logger(ProductEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordProductEventInput): Promise<void> {
    try {
      await this.prisma.productEvent.create({
        data: {
          id: ulid(),
          kind: input.kind,
          workspaceId: input.workspaceId ?? null,
          userId: input.userId ?? null,
          source: input.source ?? null,
          codeType: input.codeType ?? null,
          props: (input.props ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.warn({ error, kind: input.kind }, "failed to record product event");
    }
  }
}

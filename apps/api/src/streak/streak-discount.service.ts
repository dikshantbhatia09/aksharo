import { Injectable } from "@nestjs/common";

import { StreakService } from "./streak.service.js";

import type { StreakDiscountProvider } from "./streak-discount.port.js";

/** Thin adapter: {@link StreakDiscountProvider} over {@link StreakService}. */
@Injectable()
export class StreakDiscountService implements StreakDiscountProvider {
  constructor(private readonly streak: StreakService) {}

  async getDiscountPercent(workspaceId: string): Promise<number> {
    return this.streak.getDiscountPercent(workspaceId);
  }
}

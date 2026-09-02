import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { FircService } from "./firc.service.js";
import { AdminGuard } from "../../admin/admin.guard.js";
import { PrismaService } from "../../common/index.js";

import type { Response } from "express";

/**
 * `/admin/firc-records` (brief §5): FIRC records from USD settlements, plus
 * the monthly export-filing CSV report (EDF regime placeholder, RR-05 E4).
 * Platform staff only, same posture as `/admin/tax-registrations`.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@UseGuards(AdminGuard)
@Controller("admin/firc-records")
export class FircController {
  constructor(
    private readonly firc: FircService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List FIRC records, most recent settlement first." })
  @ApiOkResponse()
  async list() {
    return this.prisma.fircRecord.findMany({ orderBy: { remittanceDate: "desc" }, take: 500 });
  }

  @Get("csv")
  @ApiOperation({ summary: "Monthly export-filing CSV for a given `month` (YYYY-MM)." })
  @ApiOkResponse()
  async csv(@Query("month") month: string, @Res() res: Response) {
    const body = await this.firc.monthlyCsv(month);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="firc-${month}.csv"`);
    res.send(body);
  }
}

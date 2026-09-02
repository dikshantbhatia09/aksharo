import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import {
  boardNoticeHoursRemaining,
  renderBoardReport,
  renderUserNotice,
} from "./breach-templates.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { $Enums, BreachIncident, Prisma } from "@prisma/client";

export interface CreateBreachIncidentInput {
  readonly scope: Prisma.InputJsonValue;
  readonly affectedCount?: number;
  readonly detectedAt?: Date;
}

export interface UpdateBreachIncidentInput {
  readonly status?: $Enums.BreachStatus;
  readonly affectedCount?: number;
  readonly boardNotifiedAt?: Date;
  readonly usersNotifiedAt?: Date;
  readonly postmortemKey?: string;
}

export interface BreachIncidentView extends BreachIncident {
  readonly boardNoticeHoursRemaining: number;
}

/**
 * `breach_incidents` for platform staff (D61, THREAT-MODEL, the 72-hour Data
 * Protection Board clock `docs/runbooks/breach-first-hour.md`'s "Afterwards"
 * step points at).
 */
@Injectable()
export class BreachIncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
  ) {}

  async create(
    input: CreateBreachIncidentInput,
    actorId: string,
    ip?: string,
  ): Promise<BreachIncidentView> {
    const row = await this.prisma.breachIncident.create({
      data: {
        id: ulid(),
        detectedAt: input.detectedAt ?? new Date(),
        scope: input.scope,
        affectedCount: input.affectedCount ?? 0,
        status: "detected",
      },
    });
    await this.audit.record({
      action: "admin.breach_incident.created",
      resource: "breach_incident",
      resourceId: row.id,
      actorId,
      actorKind: "admin",
      ...(ip === undefined ? {} : { ip }),
      data: { affectedCount: row.affectedCount },
    });
    return toView(row);
  }

  async list(): Promise<readonly BreachIncidentView[]> {
    const rows = await this.prisma.breachIncident.findMany({ orderBy: { detectedAt: "desc" } });
    return rows.map(toView);
  }

  async get(id: string): Promise<BreachIncidentView | null> {
    const row = await this.prisma.breachIncident.findUnique({ where: { id } });
    return row === null ? null : toView(row);
  }

  async update(
    id: string,
    input: UpdateBreachIncidentInput,
    actorId: string,
    ip?: string,
  ): Promise<BreachIncidentView | null> {
    const existing = await this.prisma.breachIncident.findUnique({ where: { id } });
    if (existing === null) return null;

    const row = await this.prisma.breachIncident.update({
      where: { id },
      data: {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.affectedCount === undefined ? {} : { affectedCount: input.affectedCount }),
        ...(input.boardNotifiedAt === undefined ? {} : { boardNotifiedAt: input.boardNotifiedAt }),
        ...(input.usersNotifiedAt === undefined ? {} : { usersNotifiedAt: input.usersNotifiedAt }),
        ...(input.postmortemKey === undefined ? {} : { postmortemKey: input.postmortemKey }),
      },
    });
    await this.audit.record({
      action: "admin.breach_incident.updated",
      resource: "breach_incident",
      resourceId: id,
      actorId,
      actorKind: "admin",
      ...(ip === undefined ? {} : { ip }),
      data: {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.affectedCount === undefined ? {} : { affectedCount: input.affectedCount }),
        ...(input.boardNotifiedAt === undefined
          ? {}
          : { boardNotifiedAt: input.boardNotifiedAt.toISOString() }),
        ...(input.usersNotifiedAt === undefined
          ? {}
          : { usersNotifiedAt: input.usersNotifiedAt.toISOString() }),
        ...(input.postmortemKey === undefined ? {} : { postmortemKey: input.postmortemKey }),
      } satisfies Prisma.InputJsonValue,
    });
    return toView(row);
  }

  /** The two draft documents, rendered from `breach-templates.ts` — no LLM. */
  async templates(id: string): Promise<{ boardReport: string; userNotice: string } | null> {
    const row = await this.prisma.breachIncident.findUnique({ where: { id } });
    if (row === null) return null;
    const input = {
      id: row.id,
      detectedAt: row.detectedAt,
      scope: row.scope,
      affectedCount: row.affectedCount,
      status: row.status,
    };
    return { boardReport: renderBoardReport(input), userNotice: renderUserNotice(input) };
  }
}

function toView(row: BreachIncident): BreachIncidentView {
  return { ...row, boardNoticeHoursRemaining: boardNoticeHoursRemaining(row.detectedAt) };
}

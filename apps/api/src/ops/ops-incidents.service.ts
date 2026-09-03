import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { CommonAuditService } from "../common/audit/audit.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { StatusIncident } from "./status-snapshot.js";
import type { $Enums, OpsIncident } from "@prisma/client";

export interface CreateOpsIncidentInput {
  readonly title: string;
  readonly body: string;
  readonly component: string;
  readonly severity?: $Enums.OpsIncidentSeverity;
  readonly startedAt?: Date;
}

export interface UpdateOpsIncidentInput {
  readonly title?: string;
  readonly body?: string;
  readonly severity?: $Enums.OpsIncidentSeverity;
  readonly status?: $Enums.OpsIncidentStatus;
  readonly resolvedAt?: Date | null;
}

/**
 * `ops_incidents` — the public status-page incident list (X04 §1), admin-
 * managed via B13's console. Distinct from `BreachIncident` (`privacy/`),
 * which is the confidential DPDP breach record with its own 72-hour Board
 * clock: an ops incident is "the render queue was slow for 40 minutes",
 * never anything about personal data.
 */
@Injectable()
export class OpsIncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
  ) {}

  async create(input: CreateOpsIncidentInput, actorId: string, ip?: string): Promise<OpsIncident> {
    const row = await this.prisma.opsIncident.create({
      data: {
        id: ulid(),
        title: input.title,
        body: input.body,
        component: input.component,
        severity: input.severity ?? "minor",
        status: "investigating",
        startedAt: input.startedAt ?? new Date(),
      },
    });
    await this.audit.record({
      action: "admin.ops_incident.created",
      resource: "ops_incident",
      resourceId: row.id,
      actorId,
      actorKind: "admin",
      ...(ip === undefined ? {} : { ip }),
      data: { component: row.component, severity: row.severity },
    });
    return row;
  }

  /** Newest first, capped — the admin console's list view. */
  async list(): Promise<readonly OpsIncident[]> {
    return this.prisma.opsIncident.findMany({ orderBy: { startedAt: "desc" }, take: 200 });
  }

  /** Open (not `resolved`) incidents from the last 90 days — what the public snapshot embeds. */
  async openForStatusPage(now: Date = new Date()): Promise<readonly OpsIncident[]> {
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    return this.prisma.opsIncident.findMany({
      where: { OR: [{ status: { not: "resolved" } }, { startedAt: { gte: since } }] },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  }

  async update(
    id: string,
    input: UpdateOpsIncidentInput,
    actorId: string,
    ip?: string,
  ): Promise<OpsIncident | null> {
    const existing = await this.prisma.opsIncident.findUnique({ where: { id } });
    if (existing === null) return null;

    const row = await this.prisma.opsIncident.update({
      where: { id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt }),
      },
    });
    await this.audit.record({
      action: "admin.ops_incident.updated",
      resource: "ops_incident",
      resourceId: id,
      actorId,
      actorKind: "admin",
      ...(ip === undefined ? {} : { ip }),
      data: {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
      },
    });
    return row;
  }
}

/** `OpsIncident` -> the public `StatusIncident` shape, dropping nothing sensitive (there is nothing sensitive here). */
export function toStatusIncident(row: OpsIncident): StatusIncident {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    component: row.component,
    severity: row.severity,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
  };
}

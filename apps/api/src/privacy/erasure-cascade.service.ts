import { Inject, Injectable, Logger } from "@nestjs/common";

import { CommonAuditService } from "../common/audit/audit.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE, RAW_STORE } from "../common/storage/index.js";
import { TELEMETRY_EVENT_KINDS } from "../telemetry/telemetry.dto.js";

import type { ObjectStore } from "../common/storage/index.js";

export interface ErasureCascadeReport {
  readonly dsrRequestId: string;
  readonly userId: string;
  readonly workspacesErased: number;
  readonly projectsDeleted: number;
  readonly rawObjectsDeleted: number;
  readonly derivedObjectsDeleted: number;
  readonly exportObjectsDeleted: number;
  readonly providerDeletionsRequested: number;
  readonly membershipsRemoved: number;
  readonly commentsAnonymised: number;
  readonly invoicesMinimised: number;
}

/**
 * The erasure cascade `DELETE /me` starts and `dsr_requests` (kind `erasure`)
 * records (D70, DPDP Rule 14, THREAT-MODEL T18/T20). Runs from
 * `ErasureCascadeTask` (daily) against every request still `received` —
 * `ProfileService.requestErasure` (A05) already did the part that has to be
 * synchronous (revoke sessions, anonymise the user row, refuse a sole owner of
 * a team/agency workspace with 409 `me/owner_of_workspaces`); this is the part
 * that has up to 30 days, "deleting the media, the transcripts and the derived
 * objects" A05's own doc comment names as B16's job.
 *
 * **Order** (each step idempotent — a rerun after a partial failure finds less
 * to do, never more):
 *
 * 1. Re-revoke any session opened since the request landed (belt and braces).
 * 2. For every workspace this user owns (by construction, `personal` only —
 *    `team`/`agency` ownership was refused before the request could exist):
 *    a. delete every raw and derived media object (S3/R2), object-first then
 *       row, same crash-safety order `RetentionService.purgeDueMedia` uses;
 *    b. delete every export object (R2);
 *    c. stamp `provider_submissions.deleteRequestedAt` — the actual vendor
 *       call is `ProviderDeletionFollowupTask`'s, on its own daily sweep;
 *    d. delete every `projects` row. Postgres does the rest: every child table
 *       the brief names (media, transcripts, transcript chunks, the EDG
 *       document/segments/passes/items/revisions/snapshots, share links,
 *       share reports, comments, exports, export manifests, job events, the
 *       project-scoped half of provider submissions) has `onDelete: Cascade`
 *       to `projects`, so one `deleteMany` here is the one place that has to
 *       stay in sync with the schema, not one call per table;
 *    e. delete the workspace-scoped rows `projects` cascade does not reach:
 *       `memory_entries`, `folders`, `devices`, `api_keys`, `license_keys`,
 *       `bridge_pairings`, `streak_experiments`, `brand_assets`,
 *       `style_presets`, `brand_kits`, `fonts`, `webhook_endpoints`,
 *       `notifications`, `asset_clearance_grants`;
 *    f. **soft-delete** the workspace (`deletedAt`), never hard-delete it.
 *       `invoices.workspace_id` is `onDelete: Cascade` in this schema (B01/B05
 *       own that FK), so a hard `DELETE FROM workspaces` would take the
 *       72-month-retained billing documents with it — exactly the row the
 *       addendum says must survive. This is flagged in the final report as a
 *       seam for a future ADR (B01/B05's FK, not B16's to change), and a
 *       soft-deleted, inaccessible, unbillable workspace satisfies "the
 *       personal workspace is deleted inside the cascade" without the schema
 *       change.
 * 3. Financial rows are never touched: `subscriptions`, `mandates`,
 *    `pass_purchases`, `payments`, `billing_events`, `firc_records`,
 *    `tax_registrations`, `credit_accounts`/`credit_lots`/`credit_holds`/
 *    `credit_ledger`, `commissions`/`referrals`/`payouts`. `invoices` are kept
 *    for the statutory 72 months (Rule 46) with `recipientEmail` blanked —
 *    the one field on that row that is a live contact channel rather than
 *    part of the legal/tax record GST filing needs intact.
 * 4. `consent_records` and `audit_log` need no action: both already point at
 *    the anonymised `users` row `ProfileService.requestErasure` wrote, which
 *    **is** the tombstone the addendum asks for — an evidence row does not
 *    stop being evidence by continuing to exist next to an anonymised actor.
 * 5. For workspaces this user does **not** own (a team/agency member seat),
 *    only their own traces are removed: the `memberships` row, and
 *    `authorId` on any `comments` they left elsewhere (`SetNull`) — never the
 *    workspace's projects, which hold other members' work too.
 * 6. `dsr_requests` is marked `completed`.
 */
@Injectable()
export class ErasureCascadeService {
  private readonly logger = new Logger(ErasureCascadeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    private readonly audit: CommonAuditService,
  ) {}

  /** Run the cascade for one `dsr_requests` row. No-op if it is not `received`. */
  async run(dsrRequestId: string, now: Date = new Date()): Promise<ErasureCascadeReport | null> {
    const request = await this.prisma.dsrRequest.findUnique({
      where: { id: dsrRequestId },
      select: { id: true, userId: true, kind: true, status: true },
    });
    if (request === null || request.kind !== "erasure" || request.status !== "received") {
      return null;
    }

    await this.prisma.dsrRequest.update({
      where: { id: dsrRequestId },
      data: { status: "in_progress" },
    });

    const userId = request.userId;
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });

    const ownedWorkspaces = await this.prisma.workspace.findMany({
      where: { ownerId: userId, deletedAt: null },
      select: { id: true },
    });

    let projectsDeleted = 0;
    let rawObjectsDeleted = 0;
    let derivedObjectsDeleted = 0;
    let exportObjectsDeleted = 0;
    let providerDeletionsRequested = 0;
    let invoicesMinimised = 0;

    for (const workspace of ownedWorkspaces) {
      const result = await this.eraseOwnedWorkspace(workspace.id, now);
      projectsDeleted += result.projectsDeleted;
      rawObjectsDeleted += result.rawObjectsDeleted;
      derivedObjectsDeleted += result.derivedObjectsDeleted;
      exportObjectsDeleted += result.exportObjectsDeleted;
      providerDeletionsRequested += result.providerDeletionsRequested;
      invoicesMinimised += result.invoicesMinimised;
    }

    const memberships = await this.prisma.membership.deleteMany({ where: { userId } });
    const comments = await this.prisma.comment.updateMany({
      where: { authorId: userId },
      data: { authorId: null },
    });
    await this.prisma.memoryEntry.deleteMany({ where: { userId } });

    // C12: telemetry rows are keyed on plain `userId`/`workspaceId` (no FK, by
    // design — see `CrashReport`'s and `ProductEvent`'s own schema comments),
    // so a workspace erased above does not remove a user's crash reports or
    // telemetry events filed against a workspace this user does *not* own
    // (a team/agency seat). Removed here, independent of ownership.
    await this.prisma.crashReport.deleteMany({ where: { userId } });
    await this.prisma.productEvent.deleteMany({
      where: { userId, kind: { in: [...TELEMETRY_EVENT_KINDS] } },
    });

    await this.prisma.dsrRequest.update({
      where: { id: dsrRequestId },
      data: {
        status: "completed",
        completedAt: now,
        evidenceKey: `u/${userId}/erasure/${dsrRequestId}.json`,
      },
    });

    const report: ErasureCascadeReport = {
      dsrRequestId,
      userId,
      workspacesErased: ownedWorkspaces.length,
      projectsDeleted,
      rawObjectsDeleted,
      derivedObjectsDeleted,
      exportObjectsDeleted,
      providerDeletionsRequested,
      membershipsRemoved: memberships.count,
      commentsAnonymised: comments.count,
      invoicesMinimised,
    };

    await this.audit.record({
      action: "privacy.erasure.cascade_completed",
      resource: "dsr_request",
      resourceId: dsrRequestId,
      actorKind: "system",
      actorId: userId,
      data: report as unknown as Record<string, never>,
    });
    this.logger.log(report, "erasure cascade completed");
    return report;
  }

  private async eraseOwnedWorkspace(
    workspaceId: string,
    now: Date,
  ): Promise<{
    projectsDeleted: number;
    rawObjectsDeleted: number;
    derivedObjectsDeleted: number;
    exportObjectsDeleted: number;
    providerDeletionsRequested: number;
    invoicesMinimised: number;
  }> {
    const media = await this.prisma.mediaAsset.findMany({
      where: { project: { workspaceId } },
      select: {
        bucket: true,
        storageKey: true,
        proxyKey: true,
        audio16kKey: true,
        audio48kKey: true,
        waveformKey: true,
        facesKey: true,
        thumbKeys: true,
      },
    });
    let rawObjectsDeleted = 0;
    let derivedObjectsDeleted = 0;
    for (const asset of media) {
      if (asset.bucket === "s3") {
        try {
          await this.raw.delete(asset.storageKey);
          rawObjectsDeleted += 1;
        } catch (error) {
          this.logger.warn({ err: describe(error) }, "raw object not erased");
        }
      }
      const derivedKeys = [
        asset.proxyKey,
        asset.audio16kKey,
        asset.audio48kKey,
        asset.waveformKey,
        asset.facesKey,
        ...asset.thumbKeys,
        ...(asset.bucket === "r2" ? [asset.storageKey] : []),
      ].filter((key): key is string => key !== null && key !== "");
      if (derivedKeys.length > 0) {
        try {
          derivedObjectsDeleted += await this.derived.deleteMany(derivedKeys);
        } catch (error) {
          this.logger.warn({ err: describe(error) }, "derived objects not erased");
        }
      }
    }

    const exports = await this.prisma.export.findMany({
      where: { workspaceId, storageKey: { not: null } },
      select: { storageKey: true },
    });
    let exportObjectsDeleted = 0;
    for (const row of exports) {
      if (row.storageKey === null) continue;
      try {
        await this.derived.delete(row.storageKey);
        exportObjectsDeleted += 1;
      } catch (error) {
        this.logger.warn({ err: describe(error) }, "export object not erased");
      }
    }

    const providerDeletions = await this.prisma.providerSubmission.updateMany({
      where: { workspaceId, deleteRequestedAt: null },
      data: { deleteRequestedAt: now },
    });

    const { count: projectsDeleted } = await this.prisma.project.deleteMany({
      where: { workspaceId },
    });

    await Promise.all([
      this.prisma.memoryEntry.deleteMany({ where: { workspaceId } }),
      this.prisma.folder.deleteMany({ where: { workspaceId } }),
      this.prisma.device.deleteMany({ where: { workspaceId } }),
      this.prisma.apiKey.deleteMany({ where: { workspaceId } }),
      this.prisma.licenseKey.deleteMany({ where: { workspaceId } }),
      this.prisma.bridgePairing.deleteMany({ where: { workspaceId } }),
      this.prisma.streakExperiment.deleteMany({ where: { workspaceId } }),
      this.prisma.brandAsset.deleteMany({ where: { workspaceId } }),
      this.prisma.stylePreset.deleteMany({ where: { workspaceId } }),
      this.prisma.brandKit.deleteMany({ where: { workspaceId } }),
      this.prisma.font.deleteMany({ where: { workspaceId } }),
      this.prisma.webhookEndpoint.deleteMany({ where: { workspaceId } }),
      this.prisma.notification.deleteMany({ where: { workspaceId } }),
      this.prisma.assetClearanceGrant.deleteMany({ where: { workspaceId } }),
      // C12: crash reports and telemetry-kind product events are keyed on a
      // plain `workspaceId` too (no FK), so an owned workspace's own rows need
      // an explicit sweep the same as everything else in this list.
      this.prisma.crashReport.deleteMany({ where: { workspaceId } }),
      this.prisma.productEvent.deleteMany({
        where: { workspaceId, kind: { in: [...TELEMETRY_EVENT_KINDS] } },
      }),
    ]);

    // Billing documents are retained (Rule 46, 72 months) — minimised, not
    // deleted: the contact channel goes, the legal/tax record the GST filing
    // needs (legal name, GSTIN, amounts) does not.
    const { count: invoicesMinimised } = await this.prisma.invoice.updateMany({
      where: { workspaceId, recipientEmail: { not: null } },
      data: { recipientEmail: null },
    });

    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { deletedAt: now },
    });

    return {
      projectsDeleted,
      rawObjectsDeleted,
      derivedObjectsDeleted,
      exportObjectsDeleted,
      providerDeletionsRequested: providerDeletions.count,
      invoicesMinimised,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

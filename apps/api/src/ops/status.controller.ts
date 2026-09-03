import { Controller, Get, Header } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { StatusSnapshotSchema, type StatusSnapshotPayload } from "./status-snapshot.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { Public } from "../common/guards/index.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

const EMPTY_SNAPSHOT: StatusSnapshotPayload = {
  generatedAt: new Date(0).toISOString(),
  overall: "operational",
  components: [],
  incidents: [],
};

/**
 * The public status surface (X04 §1) — `status.json` and its RSS mirror.
 *
 * Both routes only ever read the latest `ops_status_snapshots` row
 * `StatusPublishTask` wrote; neither recomputes anything, so the public page
 * never pays for a slow health probe. Public because a status page a person
 * must sign in to read during an outage is not a status page.
 */
@ApiTags("ops")
@Controller("ops")
export class StatusController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("status.json")
  @Public()
  @ApiOperation({
    summary: "The latest published status snapshot",
    description:
      "Written every 5 minutes by the `status-publish` scheduler task. Before the first " +
      "tick (a brand-new environment) this returns an empty, all-operational snapshot " +
      "dated the Unix epoch, never a 404 — a status page must never itself be the outage.",
    operationId: "getStatusSnapshot",
  })
  @ApiOkResponse(zodResponse(StatusSnapshotSchema, "The current status snapshot."))
  async statusJson(): Promise<StatusSnapshotPayload> {
    const latest = await this.prisma.opsStatusSnapshot.findFirst({
      orderBy: { publishedAt: "desc" },
    });
    return latest === null ? EMPTY_SNAPSHOT : (latest.payload as StatusSnapshotPayload);
  }

  @Get("status/rss.xml")
  @Public()
  @Header("Content-Type", "application/rss+xml; charset=utf-8")
  @ApiOperation({
    summary: "Incident history as RSS",
    description: "The same incidents `status.json` embeds, as an RSS 2.0 feed.",
    operationId: "getStatusRss",
  })
  async statusRss(): Promise<string> {
    const latest = await this.prisma.opsStatusSnapshot.findFirst({
      orderBy: { publishedAt: "desc" },
    });
    const snapshot = latest === null ? EMPTY_SNAPSHOT : (latest.payload as StatusSnapshotPayload);
    return renderRss(snapshot);
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRss(snapshot: StatusSnapshotPayload): string {
  const items = snapshot.incidents
    .map(
      (incident) => `    <item>
      <title>${xmlEscape(incident.title)}</title>
      <description>${xmlEscape(incident.body)}</description>
      <guid isPermaLink="false">${xmlEscape(incident.id)}</guid>
      <pubDate>${new Date(incident.startedAt).toUTCString()}</pubDate>
      <category>${xmlEscape(incident.component)}</category>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Aksharo status</title>
    <description>Incident history for api, worker, render and the job queue.</description>
    <link>https://aksharo.ai/status</link>
    <lastBuildDate>${new Date(snapshot.generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

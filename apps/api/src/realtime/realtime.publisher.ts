import { Inject, Injectable, Logger } from "@nestjs/common";

import { REALTIME_BUS } from "./realtime.bus.js";
import { projectRoom, roomChannel, workspaceRoom } from "./realtime.protocol.js";
import { queuePrefix } from "../jobs/jobs.config.js";

import type { RealtimeBus } from "./realtime.bus.js";
import type {
  CommentAddedEvent,
  EdgOpsEvent,
  JobCompletedEvent,
  JobProgressEvent,
  NotificationCreatedEvent,
  RealtimeEvent,
  RealtimeEventPayloads,
  RoomMessage,
} from "./realtime.protocol.js";

/**
 * How the rest of the API emits realtime events (CONTRACTS §7).
 *
 * Everything goes onto the bus, including events for sockets held by this very
 * instance: one delivery path is worth more than the round trip it saves, because
 * a local shortcut is a second code path that only fails under a load balancer.
 *
 * Publishing is **fire-and-forget**. A realtime event is a courtesy — the truth is
 * `GET /jobs/{id}` — so a Redis hiccup must never fail the request that produced
 * it. Failures are logged, not thrown.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);
  private readonly prefix = queuePrefix();

  constructor(@Inject(REALTIME_BUS) private readonly bus: RealtimeBus) {}

  async publish<E extends RealtimeEvent>(
    room: string,
    event: E,
    data: RealtimeEventPayloads[E],
  ): Promise<void> {
    const message: RoomMessage = { event, data, at: new Date().toISOString() };
    try {
      await this.bus.publish(roomChannel(this.prefix, room), JSON.stringify(message));
    } catch (error) {
      this.logger.warn(
        { room, event, err: error instanceof Error ? error.message : String(error) },
        "realtime publish failed",
      );
    }
  }

  /**
   * A job event reaches both rooms it can belong to: the project's editor needs it,
   * and so does a workspace-level activity view for a job with no project.
   */
  async publishJobEvent<E extends "job.progress" | "job.completed">(
    scope: { readonly workspaceId: string; readonly projectId?: string | null },
    event: E,
    data: RealtimeEventPayloads[E],
  ): Promise<void> {
    await this.publish(workspaceRoom(scope.workspaceId), event, data);
    if (scope.projectId !== undefined && scope.projectId !== null) {
      await this.publish(projectRoom(scope.projectId), event, data);
    }
  }

  async jobProgress(
    scope: { readonly workspaceId: string; readonly projectId?: string | null },
    data: JobProgressEvent,
  ): Promise<void> {
    await this.publishJobEvent(scope, "job.progress", data);
  }

  async jobCompleted(
    scope: { readonly workspaceId: string; readonly projectId?: string | null },
    data: JobCompletedEvent,
  ): Promise<void> {
    await this.publishJobEvent(scope, "job.completed", data);
  }

  /** Emitted by A12 when an op batch is applied. */
  async edgOps(projectId: string, data: EdgOpsEvent): Promise<void> {
    await this.publish(projectRoom(projectId), "edg.ops", data);
  }

  /** Emitted by B15 when a review comment lands. */
  async commentAdded(data: CommentAddedEvent): Promise<void> {
    await this.publish(projectRoom(data.projectId), "comment.added", data);
  }

  /**
   * Emitted by A25 when an in-app notification is written.
   *
   * It goes to the **workspace** room because those are the only rooms this
   * server has (CONTRACTS §7: `project:` and `workspace:`). Every socket in the
   * workspace therefore sees that *a* notification happened, which is why the
   * payload carries an id and a kind and no content: the bell then calls
   * `GET /me/notifications`, which is scoped to the caller. A notification with
   * no workspace — the ones sent before a user has joined anything — has no room
   * to go to and is not published at all.
   */
  async notificationCreated(workspaceId: string, data: NotificationCreatedEvent): Promise<void> {
    await this.publish(workspaceRoom(workspaceId), "notification.created", data);
  }
}

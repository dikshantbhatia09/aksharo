import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { NOTIFICATIONS_MAX_PAGE_SIZE } from "./notify.constants.js";
import { NOTIFY_KINDS } from "./notify.kinds.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";

const ListNotificationsQuery = z.object({
  /** `true` returns only what is still unread; the badge count is always both. */
  unreadOnly: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : value === true || value === "true" || value === "1",
    ),
  /** Id of the last item on the previous page. */
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(NOTIFICATIONS_MAX_PAGE_SIZE).optional(),
});

export class ListNotificationsQueryDto extends zodDto(ListNotificationsQuery) {}

/** One in-app notification, as the API returns it. */
export class NotificationDto {
  @ApiProperty({ example: "01JBZ0Q4T7R8N4H1V0J9K2M3P5", description: "ULID." })
  id!: string;

  @ApiProperty({
    enum: NOTIFY_KINDS,
    description:
      "What happened. The client renders its own wording per locale, so the row " +
      "carries no text of its own.",
  })
  kind!: string;

  @ApiPropertyOptional({ nullable: true, description: "Workspace this belongs to, if any." })
  workspaceId!: string | null;

  @ApiProperty({
    type: Object,
    description: "Template variables: project name, minutes remaining, a deep link.",
  })
  data!: unknown;

  @ApiPropertyOptional({ nullable: true, format: "date-time" })
  readAt!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] })
  items!: NotificationDto[];

  @ApiPropertyOptional({ nullable: true, description: "Pass as `cursor` for the next page." })
  nextCursor!: string | null;

  @ApiProperty({ description: "Unread rows for this user across every page — the bell's badge." })
  unread!: number;
}

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { ListNotificationsQueryDto, NotificationDto, NotificationPageDto } from "./notify.dto.js";
import { NotifyService, toNotificationView } from "./notify.service.js";
import { CurrentUser, JwtAuthGuard } from "../common/index.js";

/**
 * The bell in the app shell (A13 reads both of these).
 *
 * Scoped to the **user**, not the workspace: a notification belongs to the person
 * it is about, and someone who is a member of three workspaces wants one list.
 * The user id comes from the access token via `@CurrentUser` and from nowhere
 * else, so there is no path by which one account reads another's bell
 * (THREAT-MODEL T4).
 */
@ApiTags("notifications")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard)
@Controller("me/notifications")
export class NotifyController {
  constructor(private readonly notify: NotifyService) {}

  @Get()
  @ApiOperation({
    summary: "List your notifications, newest first",
    description:
      "Cursor pagination: pass the previous page's `nextCursor` as `cursor`. " +
      "`unread` is the badge count and covers every page, not just this one.",
    operationId: "listMyNotifications",
  })
  @ApiOkResponse({ type: NotificationPageDto })
  async list(
    @CurrentUser("userId") userId: string,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationPageDto> {
    const page = await this.notify.list({ userId, ...query });
    return {
      items: page.items.map(toNotificationView) as NotificationDto[],
      nextCursor: page.nextCursor,
      unread: page.unread,
    };
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Mark one notification read",
    description: "Idempotent: a second call keeps the first `readAt`.",
    operationId: "markNotificationRead",
  })
  @ApiOkResponse({ type: NotificationDto })
  @ApiNotFoundResponse({ description: "`notify/not_found`." })
  async markRead(
    @CurrentUser("userId") userId: string,
    @Param("id") id: string,
  ): Promise<NotificationDto> {
    return toNotificationView(await this.notify.markRead(id, userId)) as NotificationDto;
  }
}

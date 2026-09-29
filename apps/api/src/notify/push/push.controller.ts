import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { PushSubscriptionsService } from "./push-subscriptions.service.js";
import { WebPushChannel } from "./push.channel.js";
import {
  DeletePushSubscriptionDto,
  PUSH_SUBSCRIBE_RATE_LIMIT,
  SavePushSubscriptionDto,
  deletePushSubscriptionSchema,
  pushKeyResponseSchema,
  pushSubscriptionResponseSchema,
  savePushSubscriptionSchema,
} from "./push.dto.js";
import { zodBody, zodResponse } from "../../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, RateLimit, RateLimitGuard } from "../../common/guards/index.js";
import { AppException } from "../../common/index.js";
import { NOTIFY_ERRORS } from "../notify.constants.js";

/**
 * "Notify me on this device" (2026-09-29): the browsers a person gets device
 * notifications in.
 *
 * Scoped to the user, like the bell (`notify.controller.ts`): a notification
 * belongs to the person, whichever workspace it is about, and the user id comes
 * only from the access token. The page asks for the key first, subscribes the
 * browser with it, then posts the subscription here; turning it off deletes it
 * here and unsubscribes the browser.
 */
@ApiTags("notifications")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard)
@Controller("me/push-subscriptions")
export class PushController {
  constructor(
    private readonly subscriptions: PushSubscriptionsService,
    private readonly push: WebPushChannel,
  ) {}

  @Get("key")
  @ApiOperation({
    summary: "The key a browser subscribes to device notifications with",
    description: "`publicKey` is null when this deployment does not send device notifications.",
    operationId: "getPushPublicKey",
  })
  @ApiOkResponse(zodResponse(pushKeyResponseSchema, "The VAPID public key, base64url."))
  key(): { readonly publicKey: string | null } {
    return { publicKey: this.push.publicKey };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(PUSH_SUBSCRIBE_RATE_LIMIT)
  @ApiOperation({
    summary: "Turn on device notifications in this browser",
    description:
      "Takes `PushSubscription.toJSON()` as the browser gives it. Idempotent on the " +
      "endpoint. 400 when the endpoint is not a supported browser push service or the " +
      "keys cannot be used; 409 `notify/push_unavailable` when device notifications are off.",
    operationId: "savePushSubscription",
  })
  @ApiBody(zodBody(savePushSubscriptionSchema))
  @ApiOkResponse(zodResponse(pushSubscriptionResponseSchema, "The saved subscription."))
  async save(
    @CurrentUser("userId") userId: string,
    @Body() body: SavePushSubscriptionDto,
  ): Promise<{ readonly id: string; readonly createdAt: string }> {
    if (this.push.publicKey === null) {
      throw new AppException(
        NOTIFY_ERRORS.pushUnavailable,
        "Notifications on this device are not available right now.",
        HttpStatus.CONFLICT,
      );
    }
    const saved = await this.subscriptions.save(userId, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    });
    return { id: saved.id, createdAt: saved.createdAt.toISOString() };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Turn off device notifications in this browser",
    description: "Idempotent: an endpoint that is not yours, or is already gone, is still a 204.",
    operationId: "deletePushSubscription",
  })
  @ApiBody(zodBody(deletePushSubscriptionSchema))
  @ApiNoContentResponse({ description: "Forgotten." })
  async remove(
    @CurrentUser("userId") userId: string,
    @Body() body: DeletePushSubscriptionDto,
  ): Promise<void> {
    await this.subscriptions.remove(userId, body.endpoint);
  }
}

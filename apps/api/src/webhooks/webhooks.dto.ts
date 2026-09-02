import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { WEBHOOK_EVENTS } from "./webhooks.constants.js";
import { zodDto } from "../common/index.js";

const CreateWebhookRequest = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});
export class CreateWebhookRequestDto extends zodDto(CreateWebhookRequest) {}

const UpdateWebhookRequest = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).optional(),
  active: z.boolean().optional(),
});
export class UpdateWebhookRequestDto extends zodDto(UpdateWebhookRequest) {}

export class WebhookEndpointDto {
  @ApiProperty() id!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: [String] }) events!: string[];
  @ApiProperty() active!: boolean;
  @ApiProperty() failures!: number;
  @ApiPropertyOptional({ nullable: true }) disabledAt?: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreatedWebhookEndpointDto extends WebhookEndpointDto {
  @ApiProperty({ description: "The signing secret. Shown once — store it now." })
  secret!: string;
}

export class WebhookTestResultDto {
  @ApiProperty() deliveryId!: string;
}

export class WebhookRedeliverResultDto {
  @ApiProperty() id!: string;
}

export class WebhookDeliveryDto {
  @ApiProperty() id!: string;
  @ApiProperty() event!: string;
  @ApiProperty({ enum: ["pending", "delivered", "failed", "dead"] }) status!: string;
  @ApiProperty() attempt!: number;
  @ApiPropertyOptional({ nullable: true }) responseCode?: number | null;
  @ApiPropertyOptional({ nullable: true }) error?: string | null;
  @ApiPropertyOptional({ nullable: true }) nextRetryAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) deliveredAt?: string | null;
  @ApiProperty() createdAt!: string;
}

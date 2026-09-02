import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { AVAILABLE_API_KEY_SCOPES } from "./api-keys.service.js";
import { zodDto } from "../../common/index.js";

const CreateApiKeyRequest = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(AVAILABLE_API_KEY_SCOPES as [string, ...string[]])).min(1),
  /** ISO datetime. Omitted means no expiry (until revoked or rotated). */
  expiresAt: z.string().datetime().optional(),
});
export class CreateApiKeyRequestDto extends zodDto(CreateApiKeyRequest) {}

export class ApiKeyDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() prefix!: string;
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiProperty() rateLimit!: number;
  @ApiProperty() burstLimit!: number;
  @ApiPropertyOptional({ nullable: true }) lastUsedAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) revokedAt?: string | null;
  @ApiProperty() createdAt!: string;
}

export class MintedApiKeyDto extends ApiKeyDto {
  @ApiProperty({ description: "`ak_live_<prefix>.<secret>` — shown once. Store it now." })
  key!: string;
}

import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const TotpCodeBody = z.object({
  code: z.string().regex(/^\d{6}$/, "A 6-digit TOTP code."),
});
export class TotpCodeDto extends zodDto(TotpCodeBody) {}

export class TotpEnrollResponseDto {
  @ApiProperty({ description: "Base32 TOTP secret; also encoded in `otpauthUrl`." })
  secret!: string;
  @ApiProperty({ description: "otpauth:// URI for a QR code in an authenticator app." })
  otpauthUrl!: string;
}

export class AdminStepUpResponseDto {
  @ApiProperty({ description: 'A `kind: "admin"` access token (CONTRACTS §5).' })
  accessToken!: string;
  @ApiProperty({ description: "Seconds until the admin token expires (1800)." })
  expiresIn!: number;
  @ApiProperty({ type: [String] })
  adminRoles!: string[];
}

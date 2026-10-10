import { z } from "zod";
import { zodDto } from "../common/index.js";

export const logoPositionEnum = z.enum(["TOP_LEFT", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_RIGHT"]);
export type LogoPosition = z.infer<typeof logoPositionEnum>;

const mediaUrlSchema = z
  .string()
  .trim()
  .refine(
    (val) =>
      val === "" ||
      val.startsWith("http://") ||
      val.startsWith("https://") ||
      val.startsWith("s3://") ||
      val.startsWith("ws/") ||
      val.startsWith("/"),
    {
      message: "Must be a valid HTTP(S) URL, S3 URI, or relative storage key.",
    },
  )
  .transform((val) => (val === "" ? null : val))
  .nullable()
  .optional();

export const workspaceBrandKitSchema = z.object({
  id: z.string().optional(),
  workspaceId: z.string(),
  logoUrl: mediaUrlSchema,
  logoPosition: logoPositionEnum.default("TOP_LEFT"),
  logoScalePct: z.number().int().min(5).max(50).default(15),
  logoOpacity: z.number().min(0.1).max(1.0).default(0.85),
  socialHandle: z.string().trim().max(100).nullable().optional(),
  introVideoUrl: mediaUrlSchema,
  outroVideoUrl: mediaUrlSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const updateWorkspaceBrandKitSchema = z.object({
  logoUrl: mediaUrlSchema,
  logoPosition: logoPositionEnum.optional(),
  logoScalePct: z.number().int().min(5).max(50).optional(),
  logoOpacity: z.number().min(0.1).max(1.0).optional(),
  socialHandle: z.string().trim().max(100).nullable().optional(),
  introVideoUrl: mediaUrlSchema,
  outroVideoUrl: mediaUrlSchema,
});

export class UpdateWorkspaceBrandKitDto extends zodDto(updateWorkspaceBrandKitSchema) {}
export class WorkspaceBrandKitResponseDto extends zodDto(workspaceBrandKitSchema) {}

export type WorkspaceBrandKitView = z.infer<typeof workspaceBrandKitSchema>;
export type UpdateWorkspaceBrandKitInput = z.infer<typeof updateWorkspaceBrandKitSchema>;

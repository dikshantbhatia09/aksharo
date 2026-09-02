import { z } from "zod";

import { zodDto } from "../../common/index.js";

export const transferOwnershipSchema = z.object({
  toMembershipId: z.string().min(1),
  /** Omit on the first call; the response asks for it, echoed by mail. */
  confirmToken: z.string().min(1).optional(),
});
export class TransferOwnershipDto extends zodDto(transferOwnershipSchema) {}

export const transferOwnershipResponseSchema = z.object({
  status: z.enum(["confirmation_sent", "transferred"]),
  workspaceId: z.string().optional(),
  newOwnerMembershipId: z.string().optional(),
});

export const setClientTagSchema = z.object({
  clientTag: z.string().trim().min(1).max(80).nullable(),
});
export class SetClientTagDto extends zodDto(setClientTagSchema) {}

export const clientTagViewSchema = z.object({
  tag: z.string(),
  projectCount: z.number(),
  folderCount: z.number(),
});

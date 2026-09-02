import { z } from "zod";

import { zodDto } from "../common/index.js";

const hostAppSchema = z.enum(["web", "desktop", "premiere", "ae", "resolve"]);

export const registerDeviceSchema = z.object({
  fingerprint: z.string().trim().min(8).max(256),
  name: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(60),
  host: hostAppSchema,
  hostVersion: z.string().trim().max(60).optional(),
  appVersion: z.string().trim().max(60).optional(),
});
export class RegisterDeviceDto extends zodDto(registerDeviceSchema) {}

export const renameDeviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export class RenameDeviceDto extends zodDto(renameDeviceSchema) {}

export const deviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  host: hostAppSchema,
  hostVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  leaseUntil: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  isCurrentSession: z.boolean(),
});

export const deviceLimitReachedSchema = z.object({
  limit: z.number(),
  active: z.number(),
  devices: z.array(deviceViewSchema),
});

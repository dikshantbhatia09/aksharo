import { z } from "zod";

import { zodDto } from "../common/index.js";

export const createLicenseKeySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  maxActivations: z.number().int().positive().max(1000).default(1),
});
export class CreateLicenseKeyDto extends zodDto(createLicenseKeySchema) {}

export const licenseKeyViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string().nullable(),
  maxActivations: z.number(),
  activationCount: z.number(),
  offlineUntil: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revocationSerial: z.number(),
  createdAt: z.string(),
});

const deviceInputSchema = z.object({
  fingerprint: z.string().trim().min(8).max(256),
  name: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(60),
  host: z.enum(["web", "desktop", "premiere", "ae", "resolve"]),
  hostVersion: z.string().trim().max(60).optional(),
  appVersion: z.string().trim().max(60).optional(),
});

export const activateSchema = z
  .object({
    licenseKey: z.string().trim().min(1).optional(),
    deviceCode: z.string().trim().min(1).optional(),
    device: deviceInputSchema,
  })
  .refine((body) => (body.licenseKey === undefined) !== (body.deviceCode === undefined), {
    message: "Exactly one of licenseKey or deviceCode is required.",
  });
export class ActivateDto extends zodDto(activateSchema) {}

export const heartbeatSchema = z.object({
  nonce: z.string().trim().min(1),
  deviceId: z.string().min(1),
  licenseKey: z.string().trim().min(1).optional(),
});
export class HeartbeatDto extends zodDto(heartbeatSchema) {}

/** `GET /plugins/manifest` (07 §Plugins, D65): per-host channel manifest. */
export const pluginManifestChannelSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  minHostVersion: z.string().nullable(),
  maxHostVersion: z.string().nullable(),
  downloadUrl: z.string().nullable(),
});
export type PluginManifestChannel = z.infer<typeof pluginManifestChannelSchema>;

export const pluginManifestSchema = z.object({
  channels: z.object({
    "premiere-uxp": pluginManifestChannelSchema,
    "ae-cep": pluginManifestChannelSchema,
    "resolve-script": pluginManifestChannelSchema,
  }),
});
export type PluginManifestResponse = z.infer<typeof pluginManifestSchema>;

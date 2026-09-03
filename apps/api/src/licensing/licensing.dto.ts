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

/**
 * `GET /plugins/manifest` (07 §Plugins, D65 "`/plugins/manifest` publishes min/max API per
 * host"): per-host channel manifest. `minHostVersion`/`maxHostVersion` are this route's
 * original field names (C11 stub, already consumed by C05a/C08's `manifestCheck.ts` shape
 * and by `plugins-view.tsx`) — kept verbatim rather than renamed to the brief's "minApi/maxApi"
 * wording, since both describe the same min/max host-version gate and a rename with no
 * behaviour change would be a needless frozen-shape churn for two WPs that already coded
 * against this one. `channel` and `notes` are additive (C10): which release channel
 * (`alpha`/`beta`/`stable`) the reported version was published from, and a short human note
 * (e.g. "unsigned dry-run build" until real code-signing lands, C00 §0/§7).
 */
export const pluginManifestChannelSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  minHostVersion: z.string().nullable(),
  maxHostVersion: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  channel: z.enum(["alpha", "beta", "stable"]).nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type PluginManifestChannel = z.infer<typeof pluginManifestChannelSchema>;

/**
 * `desktop` (C10): the Aksharo Desktop app itself is not a plugin hosted inside another
 * app, so it has no single `minHostVersion`/`maxHostVersion` gate and its download is
 * per-OS rather than a single `downloadUrl` — kept as its own field next to `channels`
 * instead of forcing it into the three-key `channels` shape C05a/C08 already consume.
 */
export const pluginManifestDesktopSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  channel: z.enum(["alpha", "beta", "stable"]).nullable(),
  notes: z.string().nullable(),
  downloadUrl: z.object({
    win: z.string().nullable(),
    mac: z.string().nullable(),
    linux: z.string().nullable(),
  }),
});
export type PluginManifestDesktop = z.infer<typeof pluginManifestDesktopSchema>;

export const pluginManifestSchema = z.object({
  channels: z.object({
    "premiere-uxp": pluginManifestChannelSchema,
    "ae-cep": pluginManifestChannelSchema,
    "resolve-script": pluginManifestChannelSchema,
  }),
  desktop: pluginManifestDesktopSchema,
});
export type PluginManifestResponse = z.infer<typeof pluginManifestSchema>;

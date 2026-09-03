import { z } from "zod";

import { BRAND } from "@montaj/config/brand";

import type {
  PluginManifestChannel,
  PluginManifestDesktop,
  PluginManifestResponse,
} from "./licensing.dto.js";

/**
 * The manifest `tools/release`'s `publish` command writes to
 * `releases/<channel>/plugins-manifest.json` (C10, `tools/release/src/lib/pluginManifest.ts`)
 * -- this is the raw published shape, distinct from the API's response shape below (a
 * `PluginManifestResponse` is a *view* over it: `available` is derived, not published, since
 * a channel with no entry published yet simply omits the key rather than publishing `false`).
 */
const rawChannelEntrySchema = z.object({
  version: z.string(),
  minHostVersion: z.string().nullable().default(null),
  maxHostVersion: z.string().nullable().default(null),
  downloadUrl: z.string(),
  notes: z.string().nullable().default(null),
});
export type RawPluginManifestChannelEntry = z.infer<typeof rawChannelEntrySchema>;

const rawDesktopEntrySchema = z.object({
  version: z.string(),
  notes: z.string().nullable().default(null),
  downloadUrl: z.object({
    win: z.string().nullable().default(null),
    mac: z.string().nullable().default(null),
    linux: z.string().nullable().default(null),
  }),
});

export const rawPluginManifestSchema = z.object({
  channel: z.enum(["alpha", "beta", "stable"]),
  channels: z.object({
    "premiere-uxp": rawChannelEntrySchema.optional(),
    "ae-cep": rawChannelEntrySchema.optional(),
    "resolve-script": rawChannelEntrySchema.optional(),
  }),
  desktop: rawDesktopEntrySchema.optional(),
});
export type RawPluginManifest = z.infer<typeof rawPluginManifestSchema>;

/** Public URL of the channel manifest `publish` writes (matches `apps/desktop/src/updater/feed.ts`'s `feedUrl`). */
export function pluginManifestUrl(channel: RawPluginManifest["channel"]): string {
  return `https://releases.${BRAND.domain}/releases/${channel}/plugins-manifest.json`;
}

const UNAVAILABLE_CHANNEL: PluginManifestChannel = {
  available: false,
  version: null,
  minHostVersion: null,
  maxHostVersion: null,
  downloadUrl: null,
  channel: null,
  notes: null,
};

const UNAVAILABLE_DESKTOP: PluginManifestDesktop = {
  available: false,
  version: null,
  channel: null,
  notes: null,
  downloadUrl: { win: null, mac: null, linux: null },
};

/** Every channel/host reported unavailable -- used both as the initial C11 stub behaviour
 * and as the fail-safe fallback when the published manifest can't be fetched or parsed. */
export function unavailableManifest(): PluginManifestResponse {
  return {
    channels: {
      "premiere-uxp": { ...UNAVAILABLE_CHANNEL },
      "ae-cep": { ...UNAVAILABLE_CHANNEL },
      "resolve-script": { ...UNAVAILABLE_CHANNEL },
    },
    desktop: { ...UNAVAILABLE_DESKTOP },
  };
}

function toChannel(
  channel: RawPluginManifest["channel"],
  entry: RawPluginManifestChannelEntry | undefined,
): PluginManifestChannel {
  if (entry === undefined) return { ...UNAVAILABLE_CHANNEL };
  return {
    available: true,
    version: entry.version,
    minHostVersion: entry.minHostVersion,
    maxHostVersion: entry.maxHostVersion,
    downloadUrl: entry.downloadUrl,
    channel,
    notes: entry.notes,
  };
}

/** Maps the raw published manifest onto the API response shape (extending the C11 stub). */
export function toPluginManifestResponse(raw: RawPluginManifest): PluginManifestResponse {
  const desktop = raw.desktop;
  return {
    channels: {
      "premiere-uxp": toChannel(raw.channel, raw.channels["premiere-uxp"]),
      "ae-cep": toChannel(raw.channel, raw.channels["ae-cep"]),
      "resolve-script": toChannel(raw.channel, raw.channels["resolve-script"]),
    },
    desktop:
      desktop === undefined
        ? { ...UNAVAILABLE_DESKTOP }
        : {
            available: true,
            version: desktop.version,
            channel: raw.channel,
            notes: desktop.notes,
            downloadUrl: desktop.downloadUrl,
          },
  };
}

/**
 * Fetches and parses the published channel manifest. Never throws: any network error,
 * non-2xx status or schema mismatch resolves to `undefined`, and the caller (`PluginsService
 * .manifest`) falls back to `unavailableManifest()` -- the same "unavailable until published"
 * convention the C11 stub used, now driven by a real fetch instead of a hardcoded constant.
 */
export async function fetchPluginManifest(
  channel: RawPluginManifest["channel"] = "stable",
): Promise<RawPluginManifest | undefined> {
  try {
    const response = await fetch(pluginManifestUrl(channel), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const parsed = rawPluginManifestSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

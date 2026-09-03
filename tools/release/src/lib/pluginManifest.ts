import path from "node:path";

import { writeJson } from "./fsUtil.js";

import type { Channel } from "../types.js";

/**
 * `plugins-manifest.json` (C10): the file `publish` writes to
 * `releases/<channel>/plugins-manifest.json` and `GET /plugins/manifest`
 * (`apps/api/src/licensing/plugin-manifest-source.ts`) fetches. Only channels/hosts that were
 * actually published this run are included — the API treats a missing key as "not available
 * yet", never as a broken link.
 */
export interface PluginManifestChannelEntry {
  version: string;
  minHostVersion?: string | null;
  maxHostVersion?: string | null;
  downloadUrl: string;
  notes?: string | null;
}

export interface PluginManifestDesktopEntry {
  version: string;
  notes?: string | null;
  downloadUrl: { win: string | null; mac: string | null; linux: string | null };
}

export interface PluginManifestInput {
  channel: Channel;
  channels: {
    "premiere-uxp"?: PluginManifestChannelEntry;
    "ae-cep"?: PluginManifestChannelEntry;
    "resolve-script"?: PluginManifestChannelEntry;
  };
  desktop?: PluginManifestDesktopEntry;
}

/** Public URL an artifact gets once published to `releases/<channel>/<fileName>` (matches
 * `apps/desktop/src/updater/feed.ts`'s `feedUrl`). */
export function publishedArtifactUrl(domain: string, channel: Channel, fileName: string): string {
  return `https://releases.${domain}/releases/${channel}/${fileName}`;
}

export async function writePluginManifest(
  destDir: string,
  manifest: PluginManifestInput,
): Promise<string> {
  const file = path.join(destDir, "plugins-manifest.json");
  await writeJson(file, manifest);
  return file;
}

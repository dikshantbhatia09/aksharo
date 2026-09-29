import type { HighlightsPayload } from "@montaj/repurpose-contracts";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RepurposeRun } from "@prisma/client";

/**
 * What `ai.highlights` asks of the language model, beyond the heuristic's own
 * options (2026-09-29): the run's topic, the language and script to write each
 * clip's copy in, and the workspace's region, which decides the providers
 * allowed to read the words (Sarvam serves Indian workspaces only).
 *
 * Read defensively from the run's stored config: the steering form writes
 * `discovery.topic`, and a run from before any of this has neither a topic
 * nor anything else here but the caption settings every run has.
 */
export type DiscoveryModelOptions = Pick<HighlightsPayload["options"], "topic" | "copy" | "region">;

type ScriptMode = "auto" | "roman" | "native" | "bilingual";
const SCRIPT_MODES: ReadonlySet<string> = new Set(["auto", "roman", "native", "bilingual"]);
const REGIONS: ReadonlySet<string> = new Set(["in", "eu", "us"]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A language tag the copy can be written in: a real one, never "same" or "auto". */
function usableTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim();
  const lower = tag.toLowerCase();
  return tag.length >= 2 && tag.length <= 64 && lower !== "same" && lower !== "auto" ? tag : null;
}

/**
 * The options for a run whose words discovery reasons in `sourceLanguage`
 * (the transcript's language: Hinglish is `hi-Latn`).
 *
 * The copy is written in the captions' output language when the run
 * translates its captions, and in the spoken language otherwise, in the
 * captions' script mode; `hi` with `roman` is Hinglish in Roman letters.
 */
export function discoveryModelOptions(
  config: unknown,
  sourceLanguage: string,
  workspaceRegion: string | null | undefined,
): DiscoveryModelOptions {
  const settings = record(config);
  const caption = record(settings["caption"]);
  const discovery = record(settings["discovery"]);

  const topicRaw = discovery["topic"];
  const topic = typeof topicRaw === "string" ? topicRaw.trim() : "";
  const mode = caption["scriptMode"];
  const scriptMode: ScriptMode =
    typeof mode === "string" && SCRIPT_MODES.has(mode) ? (mode as ScriptMode) : "auto";
  const language = usableTag(caption["outputLanguage"]) ?? usableTag(sourceLanguage) ?? "en";
  const region =
    typeof workspaceRegion === "string" && REGIONS.has(workspaceRegion)
      ? (workspaceRegion as "in" | "eu" | "us")
      : "in";

  return {
    ...(topic.length >= 2 ? { topic: topic.slice(0, 200).trim() } : {}),
    copy: { language, scriptMode },
    region,
  };
}

/** {@link discoveryModelOptions} for `run`, reading its workspace's region. */
export async function discoveryModelOptionsFor(
  prisma: Pick<PrismaService, "workspace">,
  run: Pick<RepurposeRun, "workspaceId" | "config">,
  sourceLanguage: string,
): Promise<DiscoveryModelOptions> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: run.workspaceId },
    select: { region: true },
  });
  return discoveryModelOptions(run.config, sourceLanguage, workspace?.region);
}

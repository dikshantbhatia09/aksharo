import { z } from "zod";

/**
 * The stored shape of a run's episode text (2026-09-29, `episode-pack.service.ts`),
 * on its own so a reader of the stored pack (the guest page, 2026-10-05) needs
 * nothing else of the service that writes it.
 */
export const EPISODE_PACK_KIND = "episode-pack";

export const EpisodePackSchema = z.object({
  chapters: z
    .array(z.object({ startMs: z.number().int().nonnegative(), title: z.string() }))
    .max(50),
  youtubeDescription: z.string(),
  showNotes: z.string(),
  linkedinPost: z.string(),
  xThread: z.array(z.string()).max(20),
  newsletter: z.string(),
  locale: z.string().default(""),
  source: z.enum(["model", "heuristic", "mixed"]).default("heuristic"),
});

export type EpisodePack = z.infer<typeof EpisodePackSchema>;

/** A stored `llm_outputs.output`, read as a pack; null when it does not parse. */
export function parseEpisodePack(output: unknown): EpisodePack | null {
  const parsed = EpisodePackSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

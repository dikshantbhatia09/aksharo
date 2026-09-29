import { z } from "zod";

/**
 * What Postiz's Public API answers, validated before anything reads it
 * (master plan §12.2: "Zod validation for every response").
 *
 * Deliberately `z.object` (unknown keys dropped), not strict: Postiz adds fields
 * between releases, and a new field must not turn every answer into a
 * failure. What IS required is what this module reads. Shapes are from
 * https://docs.postiz.com/public-api (integrations/list, uploads/upload-file,
 * posts/create, posts/list) and checked against the Postiz v1.47 source.
 */

const Id = z.string().trim().min(1).max(200);

/** `GET /public/v1/integrations`: one connected channel. */
export const PostizIntegrationSchema = z.object({
  id: Id,
  name: z.string().max(500).nullish(),
  /** Postiz's provider name: `instagram`, `instagram-standalone`, `linkedin-page`, `x`, ... */
  identifier: z.string().trim().min(1).max(100),
  picture: z.string().max(4_000).nullish(),
  /** Disabled in Postiz (by hand, or over a plan's channel limit). */
  disabled: z.boolean().nullish(),
  /** The account's handle, where the provider has one. */
  profile: z.string().max(500).nullish(),
  customer: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
});
export type PostizIntegration = z.infer<typeof PostizIntegrationSchema>;

export const PostizIntegrationListSchema = z.array(PostizIntegrationSchema).max(1_000);

/** `POST /public/v1/upload`: the stored file. `id` and `path` go into a post. */
export const PostizMediaSchema = z.object({
  id: Id,
  path: z.string().trim().min(1).max(4_000),
});
export type PostizMedia = z.infer<typeof PostizMediaSchema>;

/** `POST /public/v1/posts`: one entry per channel posted to. */
export const PostizCreatedSchema = z
  .array(z.object({ postId: Id, integration: z.string().max(200).nullish() }))
  .min(1)
  .max(50);

/** `GET /public/v1/posts`: one post in the asked-for window. */
export const PostizPostSchema = z.object({
  id: Id,
  content: z.string().max(200_000).nullish(),
  publishDate: z.string().min(1).max(64),
  /** The public URL, once the platform has it. */
  releaseURL: z.string().max(4_000).nullish(),
  releaseId: z.string().max(500).nullish(),
  /** `QUEUE` | `PUBLISHED` | `ERROR` | `DRAFT`; read as a string so a new state is not a parse failure. */
  state: z.string().min(1).max(40),
  group: z.string().max(200).nullish(),
  integration: z
    .object({
      id: z.string().max(200),
      providerIdentifier: z.string().max(100).nullish(),
      name: z.string().max(500).nullish(),
    })
    .nullish(),
});
export type PostizPost = z.infer<typeof PostizPostSchema>;

export const PostizPostListSchema = z.object({ posts: z.array(PostizPostSchema).max(10_000) });

/** The body of `POST /public/v1/posts`, as this module sends it. */
export interface PostizCreatePostInput {
  /** `now` publishes straight away; `schedule` at `date`. */
  readonly type: "now" | "schedule";
  readonly date: Date;
  readonly integrationId: string;
  /** Postiz's own provider name, sent as `settings.__type`. */
  readonly identifier: string;
  /** Already HTML (`<p>` per line), the way Postiz's own composer sends it. */
  readonly contentHtml: string;
  readonly media: PostizMedia;
  readonly settings: Readonly<Record<string, unknown>>;
}

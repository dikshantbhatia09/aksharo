/**
 * Shared types for the `/docs` surface's generators (X03 brief §2:
 * "build-time generators: OpenAPI -> MDX pages, plugin READMEs -> guide
 * pages"). Nothing here reads the filesystem — that split keeps this module
 * safe to import from both server and client code, the same reason
 * `lib/content/search.ts` takes `articles` as an argument instead of calling
 * the (`server-only`) loader itself.
 */

export interface DocsNavLeaf {
  readonly label: string;
  readonly href: string;
}

export interface DocsNavSection {
  readonly id: "guides" | "plugins" | "developers" | "legal";
  readonly label: string;
  readonly href: string;
  readonly items: readonly DocsNavLeaf[];
}

export interface PluginGuide {
  readonly slug: string;
  readonly title: string;
  /** Repo-relative path used for the page's "edit this page" link. */
  readonly sourcePath: string;
  readonly body: string;
}

export interface ApiParameter {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly type: string;
}

export interface ApiEndpoint {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly parameters: readonly ApiParameter[];
  readonly hasRequestBody: boolean;
  readonly responseStatuses: readonly string[];
}

export interface ApiGroup {
  /** Derived from the path's first `/v1/<segment>` — the OpenAPI `tags` on
   * the public paths are uniformly `"public"` and would collapse every
   * endpoint onto one meaningless group (see `openapi.ts`'s header). */
  readonly tag: string;
  readonly label: string;
  readonly endpoints: readonly ApiEndpoint[];
}

/** Only version published so far — the switcher (brief §1) is wired for more. */
export const API_VERSIONS = ["v1"] as const;
export type ApiVersion = (typeof API_VERSIONS)[number];

export interface DocsSearchDoc {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly section: DocsNavSection["id"];
  readonly href: string;
}

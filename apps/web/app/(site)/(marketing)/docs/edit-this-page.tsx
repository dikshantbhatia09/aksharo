/** "Edit this page" (brief §1): a plain GitHub blob link to the repo path
 * that produced the current page's content — the OpenAPI document for a
 * developers page, the README for a plugin guide, the MDX file for a guide.
 * The org/repo below is the internal codename repo (`docs/CONTRACTS.md` §0:
 * `montaj` is the folder/package-scope name, never brand copy) — this link
 * only ever points a contributor at a source file, never rendered as brand
 * text. */
export function EditThisPage({ repoPath }: { readonly repoPath: string }): React.JSX.Element {
  const href = `https://github.com/aksharo/montaj/blob/main/${repoPath}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-fg-2 hover:text-fg-0 text-xs underline"
      data-testid="docs-edit-this-page"
    >
      Edit this page
    </a>
  );
}

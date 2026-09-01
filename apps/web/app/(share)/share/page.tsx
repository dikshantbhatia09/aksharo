/**
 * Public review/share surface — placeholder. B15 builds review links, comments
 * and approvals. Pages in this group are reachable without a session, so they
 * must never render workspace-scoped data beyond the shared project.
 */
export default function SharePage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="share-heading">
        Shared review
      </h1>
      <p className="text-muted-foreground text-sm">
        Public review link surface — route group <code>(share)</code>. Built in B15.
      </p>
    </main>
  );
}

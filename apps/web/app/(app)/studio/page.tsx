/**
 * Studio shell — placeholder. A13 builds the real app shell (auth pages, layout,
 * sidebar, CreditMeter, command palette); A15 and A17 add the editor and timeline.
 */
export default function StudioPage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="studio-heading">
        Studio
      </h1>
      <p className="text-muted-foreground text-sm">
        Authenticated app surface — route group <code>(app)</code>. Built in A13.
      </p>
    </main>
  );
}

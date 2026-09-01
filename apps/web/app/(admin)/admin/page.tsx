/**
 * Admin console — placeholder. B13 builds it behind a separate guard with MFA,
 * an audit log and least-privilege roles (THREAT-MODEL T20).
 */
export default function AdminPage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="admin-heading">
        Admin
      </h1>
      <p className="text-muted-foreground text-sm">
        Staff-only surface — route group <code>(admin)</code>. Built in B13.
      </p>
    </main>
  );
}

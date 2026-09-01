/**
 * Database seed. A03 owns the real implementation (workspaces, plans, system
 * caption styles, a sample project); A01 ships the entry point so `pnpm db:seed`
 * exists and is wired into turbo from day one.
 *
 * Run with: pnpm --filter @montaj/api db:seed
 */

async function main(): Promise<void> {
  console.warn("[db:seed] no seed data yet — implemented in A03 (see docs/PLAN.md).");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

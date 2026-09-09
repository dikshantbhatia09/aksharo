# Wave 7 verification — 2026-09-03

Fresh-clone verification gate (`docs/PLAN.md`'s "Verification gate procedure"), run by `scripts/verify-wave.mjs`.

Clone directory: `C:\Users\diksh\AppData\Local\Temp\montaj-verify-wave-8uNaEB`
Screenshots: `C:\Dikshant\Crest Mond\Product 2\05-build\_worktrees\M17\docs\verification\2026-09-03-wave7-screenshots`

| Step | Status | Duration | Detail |
|---|---|---|---|
| fresh clone | PASS | 2.4s | - |
| pnpm install | PASS | 38.3s | - |
| pnpm build | PASS | 137.0s | - |
| docker compose up | PASS | 703.6s | - |
| db:migrate | PASS | 17.6s | - |
| db:seed | PASS | 1.7s | - |
| db:seed:sample | PASS | 1.1s | - |
| unit tests | FAIL | 10183.5s | exit 1 |
| e2e | FAIL | 0.5s | exit 1 |
| parity gate | FAIL | 0.5s | exit 1 |
| docker compose down | FAIL | 0.1s | exit 1 |
| collect screenshots | SKIPPED | 0.0s | 0 file(s) -> C:\Dikshant\Crest Mond\Product 2\05-build\_worktrees\M17\docs\verification\2026-09-03-wave7-screenshots |

**Overall: FAIL** (total 11086.4s)

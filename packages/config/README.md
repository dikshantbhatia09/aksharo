# @montaj/config

Shared build configuration plus the three cross-cutting constants every surface needs:
brand strings, credit burn rates and the environment schema.

**Status:** implemented (A01).

## Exports

| Subpath                              | Contents                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `@montaj/config`                     | `BRAND`, `PLUGIN_IDS`, `BURN_RATES`, `creditCostTenths`, `loadEnv`, `envSchema` |
| `@montaj/config/brand`               | brand strings only                                                              |
| `@montaj/config/credits`             | burn-rate table and credit maths                                                |
| `@montaj/config/env`                 | Zod env schema and `loadEnv()`                                                  |
| `@montaj/config/eslint`              | `montajEslintConfig()` flat-config factory                                      |
| `@montaj/config/prettier`            | Prettier config                                                                 |
| `@montaj/config/vitest`              | `vitestBaseConfig`, `coverageThresholds()`                                      |
| `@montaj/config/tsconfig.base.json`  | strict base (ES2022)                                                            |
| `@montaj/config/tsconfig.node.json`  | base + NodeNext resolution + Node types                                         |
| `@montaj/config/tsconfig.react.json` | base + DOM libs + `jsx: preserve` + bundler resolution                          |

## Brand strings

`src/brand.ts` is the **only** file allowed to contain brand strings (CONTRACTS §0). `montaj`
is the engineering codename — repo folder, `@montaj/*` scope, BullMQ queue names — and must
never appear in UI copy, domains, bundle ids, installer names or marketing. The brand is
**Aksharo**; a rename after the legal review touches this file plus DNS.

## Credits

Credits are integer **tenths** (`*Tenths`), billed on time rounded up to 0.1 minute. The table
in `src/credits.ts` mirrors `03-architecture/04-pricing-and-monetization.md` §Credits and is the
source `CreditsFacade` implementations read (CONTRACTS §4).

```ts
import { creditCostTenths, worstCaseHoldTenths } from "@montaj/config";

worstCaseHoldTenths({ operation: "promptedEdit", sourceDurationMs: 20 * 60_000 }); // 600 -> reserve
creditCostTenths({ operation: "promptedEdit", durationMs: 2 * 60_000 }); //  60 -> settle
```

## Environment

`loadEnv()` validates every variable in CONTRACTS §1 and throws `EnvValidationError` naming each
offending variable — values are never echoed, so the message is safe to log.

```ts
import { loadEnv } from "@montaj/config";

const env = loadEnv(); // throws before the server binds a port
```

`src/env.test.ts` asserts that `.env.example` and the schema cover exactly the contract list, so
adding a variable to CONTRACTS §1 without adding it to both fails CI.

## Adding a shared lint rule

Edit `eslint.config.base.mjs`. Every package consumes it through `montajEslintConfig()`, so a rule
added here applies repo-wide on the next `pnpm lint`.

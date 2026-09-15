# ADR 0003 — The imported reference trees live in this repository

- **Status:** Accepted
- **Date:** 2026-09-15
- **Work package:** —
- **Deciders:** Repository/product owner (instruction), Claude (implementation record)
- **Supersedes:** ADR 0002 §2 and §3, in part — see "What changed" below

## Context

ADR 0002 decided that `opensource-clipping-main/` and `postiz-app-main/` would
stay isolated: present on disk as read-only references, absent from
`pnpm-workspace.yaml`, and never committed. The Wave 0 register recorded their
declared licences — MIT for the clipping tree, **AGPL-3.0** for Postiz — and
`BLOCK-0003` recorded that the protected commercial evidence behind
`DEC-004`'s "the required licences have been secured" is not locatable from
this repository.

The owner has since decided that the product should be one repository rather
than three trees sitting beside each other, and instructed that the imported
sources be merged in.

## Decision

Both trees are committed to this repository.

They remain **outside the pnpm workspace**: `pnpm-workspace.yaml` still globs
only `apps/*` and `packages/*`, so nothing in Aksharo builds against them, no
dependency resolves into them, and no code path imports them. What changes is
where the bytes live, not what runs.

Everything else ADR 0002 decided still holds:

- Aksharo remains the system of record.
- The clipping tree's FastAPI store, in-process task runner and caption
  renderer do not enter production; algorithms are ported behind versioned
  Aksharo contracts with attribution and parity tests.
- Postiz remains a separately deployed publishing service behind a narrow
  adapter, with provider tokens outside Aksharo.
- Every rollout flag stays off until its checkpoint gate passes.

## What changed, precisely

| ADR 0002 said | Now |
|---|---|
| "Keep both imported trees isolated; do not add either to the Aksharo pnpm workspace" | Committed to the repository; still absent from the pnpm workspace |
| "No code from the two imported roots has been copied into production modules" | Unchanged — still true, and still the rule |

## The licensing consequence, stated plainly

**Postiz is AGPL-3.0.** Aksharo's root package is private and `UNLICENSED`, and
the product is served to users over a network. AGPL-3.0 §13 requires an operator
who runs a modified version of the covered work, and lets users interact with it
remotely, to offer those users the corresponding source of that work. Holding
AGPL source in the same repository as a proprietary, network-served product is
the situation that obligation is written for.

Two things keep that from being automatic, and both are assertions rather than
artefacts in this repository:

1. **Mere aggregation.** The trees are not built, imported, linked or deployed
   with Aksharo — `pnpm-workspace.yaml` excludes them and no module references
   them. Storing separate works on one volume is aggregation, not a combined
   work, under GPL-family reasoning. That argument survives only for as long as
   the separation does: the day something in `apps/` or `packages/` imports from
   `postiz-app-main/`, this is a combined work and the analysis changes.
2. **A commercial grant.** `DEC-004` records the product owner's confirmation
   that the required licences have been secured. `BLOCK-0003` records that the
   evidence is not in this repository and has not been reviewed.

This ADR does not resolve either question; it records that the decision was
taken with them open, at the owner's instruction, and that `BLOCK-0003` stays
open until the protected evidence exists.

## Consequences

**Good**

- One repository, one history. The reference material a reviewer needs is beside
  the code that cites it, and the ported-algorithm attribution trail is checkable
  without a second checkout.
- The trees can no longer drift or be lost: their fingerprints in
  `WAVE-0-FOUNDATION.md` are now backed by committed content.

**Costs and risks**

- The repository grows by roughly 97 MB, most of it the clipping tree's bundled
  background-music assets.
- The AGPL question above moves from hypothetical to present, and is answered by
  evidence nobody in this repository can see.
- `git log` and blame across the imported trees now carry no upstream history —
  they arrive as one commit, so their provenance is the tree fingerprints in the
  Wave 0 register rather than their own history.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep them out (ADR 0002 as written) | The owner asked for one repository |
| Add them to the pnpm workspace | Would make them a combined work in the licensing sense and couple Aksharo's build to code that is explicitly not production-ready |
| Vendor only the files actually ported | Nothing has been ported yet, and the value asked for is the complete reference |
| Git submodules | Neither tree has usable upstream Git metadata in this workspace (Wave 0 register), so there is nothing to point a submodule at |

## Follow-ups

- `BLOCK-0003` stays open: record the protected licence evidence for both trees.
- If any Aksharo module ever imports from either tree, this ADR must be revisited
  before that change merges — that is the line between aggregation and a
  combined work.

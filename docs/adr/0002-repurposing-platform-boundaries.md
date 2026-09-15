# ADR 0002 — Repurposing platform boundaries and staged provider rollout

- **Status:** Accepted
- **Date:** 2026-09-15
- **Work package:** REP-000
- **Deciders:** Product owner (scope and license confirmation), Codex (implementation record)
- **Supersedes / superseded by:** —

## Context

Aksharo already owns projects, media, transcription, captions, the editable EDG,
rendering, reviews, credits, jobs, storage, and tenancy. Two source trees were
provided as capability references:

- `opensource-clipping-main` contains useful highlight and framing ideas, but its
  prototype orchestration is not tenant-aware or durable.
- `postiz-app-main` contains provider integrations, OAuth, scheduling, and posting
  behavior, but has its own database, Redis, Temporal, token, and release
  lifecycle.

The product needs one beginner-facing workflow without turning those three
systems into one coupled deployment or exposing provider failures to editing.

## Decision

1. **Aksharo remains the product and system of record.** Repurposing runs,
   candidates, editable variants, reviews, publish intent, and safe external
   references live in Aksharo.
2. **The clipping tree is a read-only algorithm reference.** Reviewed concepts
   may be ported behind versioned Aksharo contracts with attribution and parity
   tests. Its FastAPI store, in-process task runner, caption renderer, and global
   orchestration do not enter production.
3. **Postiz remains a bounded publishing service.** It receives approved,
   platform-valid artifacts through a narrow Aksharo adapter. Provider tokens
   stay in Postiz; Aksharo stores only external integration identifiers and safe
   display/capability metadata.
4. **All new behavior is disabled by default.** The server-side flags
   `repurpose_flow`, `source_youtube_acquire`, `highlight_discovery`,
   `publishing_postiz`, and `publishing_tiktok` gate the rollout. Provider access
   never follows merely from source-code availability.
5. **The intended first cohort is Meta (Instagram/Facebook), YouTube, LinkedIn,
   and TikTok only if its review is ready.** Every provider remains disabled
   until its credentials, scopes, redirect URI, test account, review state, and
   fallback are recorded. X is the documented alternative if TikTok is not
   approved.
6. **Publishing cannot block creation.** Editing, review, export, and download
   remain available during publishing-service outages. Retries reconcile an
   uncertain external outcome before resubmission and never include a successful
   target.
7. **External acquisition is a bounded media-worker capability.** Wave 3 will
   package the official standalone `yt-dlp` release pinned to `2026.08.19` with a
   checked checksum and a recorded health version. Updates happen through a
   reviewed dependency PR and acquisition/security suite, not at container boot.

## Consequences

**Good**

- Editing and rendering retain their existing availability and trust boundaries.
- A provider outage or breaking API change is contained behind one adapter.
- The launch surface can truthfully fall back to handoff or download.
- Imported prototype code cannot silently bypass tenancy, jobs, credits, or
  storage isolation.

**Costs and risks**

- Postiz needs a separately operated staging and production lifecycle.
- Aksharo needs reconciliation state in addition to the external scheduler.
- Provider capability data and app-review evidence require ongoing ownership.
- The imported archives have no Git metadata, so Wave 0 records deterministic
  tree fingerprints in addition to their declared versions.

## Alternatives considered

| Option                                  | Why not                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Deploy the clipping FastAPI service     | It has no Aksharo tenancy, durable job ledger, idempotency, credits, or storage boundary.                 |
| Merge Postiz's UI/database into Aksharo | It couples provider churn and token operations to the editing pipeline and duplicates product navigation. |
| Implement every provider before launch  | It delays the core workflow and encourages unsupported claims where app review is incomplete.             |
| Auto-update `yt-dlp` at runtime         | It makes builds non-reproducible and lets an unreviewed executable change enter acquisition.              |
| Auto-publish after rendering            | It violates the required explicit review and confirmation boundary.                                       |

## Follow-ups

- REP-001 freezes repurposing contracts and examples.
- REP-002 turns the Wave 0 capability draft into validated package data.
- REP-003 and REP-004 add the Aksharo persistence model.
- Wave 9 records the separately pinned Postiz deployment and token-boundary
  evidence before any post can be sent.

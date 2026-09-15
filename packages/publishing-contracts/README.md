# Aksharo publishing contracts

`@montaj/publishing-contracts` is the schema-only half of REP-005: the versioned
shapes Aksharo uses to talk about connected accounts, confirmed publish batches,
individual destinations, provider errors, and the two publishing queues
(`publish.dispatch@1`, `publish.reconcile@1`).

It contains no client, no adapter, no OAuth code and no provider credential. No
runtime imports it yet, and every rollout flag (`publishing_postiz`,
`publishing_tiktok`) is seeded off. Nothing here is permission to post.

## The two rules the schemas exist to enforce

**A provider secret never reaches Aksharo.** Tokens live in the licensed
publishing deployment (ADR 0002 §3). `ChannelConnectionViewSchema` runs
`findSecretFields` over the whole payload, so a response spread into a connection
object with one extra `accessToken` key fails to parse instead of being stored.

**A publish is at-most-once per attempt, plus reconciliation.**
`PublishDispatchPayloadSchema` carries a target id and an attempt number and
nothing else: copy, settings, integration id and media URL are read from the
frozen row at dispatch time, so a job that waited an hour in Redis cannot post
stale text to an account that has since been disconnected. `publishing/uncertain_outcome`
is classified `reconcile_first` — the only legal next step after an ambiguous
response is asking the provider what happened, never resubmitting.

## Fixtures

`fixtures/*.v1.json` are the documented examples the tests parse: a connected
Instagram account with a live capability snapshot, a mixed now/scheduled batch, a
signed status callback, and the dispatch payload and result. They are also the
examples an adapter should be written against before any provider is contacted.

## Before this is used

The shapes are provisional until the cross-owner review CP-020 requires, and no
profile may be enabled until the Wave 0 provider evidence in
`docs/repurposing-platform-master-plan/WAVE-0-FOUNDATION.md` exists. A
`ProviderSettings` branch describes what a provider's documentation says, not
what a given account is approved to do; `ConnectionCapabilities` is the live check
that decides that, and it is read per account, per publish.

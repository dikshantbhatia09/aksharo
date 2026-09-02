# `apps/web/lib/passes`

B20's data layer for the Passes tab (`apps/web/components/editor/passes/**`):
building `DecideItems` ops, the credits estimate shown before an autocut run,
realtime progress for a running pass job, and B19's keyframe decoder,
re-exported.

```
decisions.ts    pure DecideItems-op builder + review-row filter/group/bulk-accept
                predicates (itemsAtOrAbove, proposedItemIdsOfKind, decidedItemIds,
                summaryDurations over @montaj/timemap)
client.ts       the startAutocutPass endpoint descriptor (apps/web/lib/edg/client.ts's
                defineEndpoint pattern)
quote.ts        client-side credits estimate for the "quote + confirm" dialog,
                mirroring apps/api/src/passes/passes.quote.ts's formula
realtime.ts     usePassRunProgress — a job.progress/job.completed subscription
keyframes.ts    re-exports @montaj/edg's real decodeKeyframes/encodeKeyframes
                ("MKF2") — B20 was written against a self-invented interim shape
                here before B19 landed; see the B20 final report for the full
                account of what differed
```

Decisions flow through the transcript editor's existing `EditorStore`
(`apps/web/lib/edg/store.ts`) — the same debounced batching, optimistic apply
and rebase-on-conflict handling every other editor op uses, unmodified by
this work package.

## The manifest-side keyframe curve

The actual "sample the crop window at this output instant" logic used by
exports does **not** live here — it lives in `@montaj/render-core`'s
`frame/crop-window.ts`/`frame/keyframe-track.ts`, shared with the cloud
renderer (`apps/render`). See that package's README and
`apps/web/lib/export/keyframe-adapter.ts`.

## Scripts

`pnpm --filter @montaj/web test -- lib/passes`,
`pnpm --filter @montaj/web lint`, `pnpm --filter @montaj/web typecheck`.

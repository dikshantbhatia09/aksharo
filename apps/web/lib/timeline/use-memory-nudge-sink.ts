"use client";

/**
 * The React wiring `Timeline.tsx` reaches for: `createMemoryNudgeSink`
 * (`memory-nudge-sink.ts`) bound to `useRecordTimingNudgeMemory`
 * (`@montaj/api-client`) and the browser's `PrivacySnapshot` mirror
 * (`lib/privacy/consent.ts`) — the same consent source `settings/memory`
 * reads. Kept out of `Timeline.tsx` itself so the component only ever calls
 * `.record()` on whatever sink it is given, exactly as it always has.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useRecordTimingNudgeMemory } from "@montaj/api-client";

import { createMemoryNudgeSink } from "./memory-nudge-sink";

import type { TimingNudgeSink } from "./nudge";

import { readPrivacy, subscribePrivacy } from "@/lib/privacy/consent";

/** A stable sink instance for the component's lifetime; consent and the mutation are read fresh via refs. */
export function useMemoryNudgeSink(): TimingNudgeSink {
  const [privacy, setPrivacy] = useState(() => readPrivacy());
  useEffect(() => {
    setPrivacy(readPrivacy());
    return subscribePrivacy(setPrivacy);
  }, []);

  const mutation = useRecordTimingNudgeMemory();

  const privacyRef = useRef(privacy);
  privacyRef.current = privacy;
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;

  return useMemo(
    () =>
      createMemoryNudgeSink({
        consented: () => privacyRef.current.memory,
        record: (deltaMs) => mutateRef.current({ deltaMs }),
      }),
    [],
  );
}

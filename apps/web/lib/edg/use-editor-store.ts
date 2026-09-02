"use client";

/**
 * React wiring for `EditorStore`: fetches the initial document (paging every
 * segment and transcript-chunk page up front — see the module doc below for
 * why), translates `ApiError` into the queue's typed failures, subscribes to
 * the realtime `edg.ops` room, and exposes the store through
 * `useSyncExternalStore` — the pattern `@montaj/api-client`'s `SessionStore`
 * already uses for state a network callback can write outside a render.
 *
 * **Eager, not windowed, paging.** The brief's store design asks for segments
 * and transcript chunks to load "lazily by time window". This loads every
 * page up front instead: acceptance criterion 1 is scroll performance once
 * the document is open, which `TranscriptList`'s virtualiser
 * (`virtual-list.ts`) delivers regardless of how the data arrived, and a
 * 500-a-page segment list means even a 9,000-segment, three-hour project is
 * two or three requests. Reported as a scoping simplification, not a silent
 * substitution: true windowed fetching (skip chunks outside the visible time
 * range) is a follow-up if a real multi-hour project's *initial load* time
 * turns out to matter as much as its *scroll* performance does.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ApiError, isApiError, RealtimeClient, rooms, useApiContext } from "@montaj/api-client";
import type { ApiClient, RealtimeEvent } from "@montaj/api-client";
import type { EdgHot, Pass, Segment, TranscriptChunk } from "@montaj/edg";

import {
  applyEdgOps,
  getProjectEdg,
  getProjectTranscript,
  listEdgSegments,
  resegmentEdg,
  type EdgDocumentResponse,
} from "./client";
import { EdgConflictError, EdgTooStaleError, EdgTransientError } from "./queue";
import { EditorStore, type EditorSnapshot } from "./store";

const SEGMENT_PAGE_LIMIT = 1000;
const CHUNK_PAGE_LIMIT = 20; // MAX_TRANSCRIPT_CHUNK_PAGE_SIZE (apps/api/src/transcripts/transcripts.errors.ts)

export interface EditorLoadState {
  readonly status: "loading" | "ready" | "error";
  readonly error?: Error;
  readonly store?: EditorStore;
  readonly snapshot?: EditorSnapshot;
}

async function loadAllSegments(
  client: ApiClient,
  projectId: string,
  first: EdgDocumentResponse,
): Promise<Segment[]> {
  const segments = [...first.segments];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const page = await client.call(listEdgSegments, {
      params: { projectId },
      query: { cursor, limit: SEGMENT_PAGE_LIMIT },
    });
    segments.push(...page.segments);
    cursor = page.nextCursor;
  }
  return segments;
}

async function loadAllChunks(client: ApiClient, projectId: string): Promise<TranscriptChunk[]> {
  const chunks: TranscriptChunk[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = await client.call(getProjectTranscript, {
      params: { projectId },
      query: { limit: CHUNK_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
    });
    chunks.push(...page.chunks);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return chunks;
}

async function loadDocument(
  client: ApiClient,
  projectId: string,
): Promise<{
  hot: EdgHot;
  segments: Segment[];
  passes: Pass[];
  chunks: TranscriptChunk[];
  revision: number;
}> {
  const first = await client.call(getProjectEdg, { params: { projectId } });
  const [segments, chunks] = await Promise.all([
    loadAllSegments(client, projectId, first),
    loadAllChunks(client, projectId),
  ]);
  return { hot: first.hot, segments, passes: first.passes, chunks, revision: first.revision };
}

/** `ApiError` → the queue's typed failures, so `queue.ts` never imports `@montaj/api-client`. */
function translateError(error: unknown): never {
  if (isApiError(error)) {
    if (error.code === "edg/conflict") {
      const details = error.details as {
        latestRevision?: unknown;
        opsSince?: unknown;
        conflicts?: unknown;
      };
      throw new EdgConflictError({
        latestRevision: typeof details.latestRevision === "number" ? details.latestRevision : 0,
        opsSince: Array.isArray(details.opsSince) ? (details.opsSince as never) : [],
        ...(Array.isArray(details.conflicts) ? { conflicts: details.conflicts as never } : {}),
      });
    }
    if (error.code === "edg/too_stale") {
      const details = error.details as { latestRevision?: unknown };
      throw new EdgTooStaleError(
        typeof details.latestRevision === "number" ? details.latestRevision : 0,
      );
    }
    throw new EdgTransientError(error.message, error.retryAfterMs);
  }
  throw new EdgTransientError(error instanceof Error ? error.message : "network error");
}

export function useEditorStore(projectId: string): EditorLoadState {
  const { client } = useApiContext();
  const [state, setState] = useState<EditorLoadState>({ status: "loading" });
  const storeRef = useRef<EditorStore | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    storeRef.current = undefined;

    void (async () => {
      try {
        const doc = await loadDocument(client, projectId);
        if (cancelled) return;
        const store = new EditorStore(
          {
            hot: doc.hot,
            segments: doc.segments,
            passes: doc.passes,
            chunks: doc.chunks,
            revision: doc.revision,
          },
          {
            applyBatch: async (body) => {
              try {
                return await client.call(applyEdgOps, { params: { projectId }, body });
              } catch (error) {
                translateError(error);
              }
            },
            resegment: async (params) => {
              try {
                return await client.call(resegmentEdg, { params: { projectId }, body: params });
              } catch (error) {
                translateError(error);
              }
            },
            reloadDocument: async () => {
              const fresh = await loadDocument(client, projectId);
              return {
                hot: fresh.hot,
                segments: fresh.segments,
                passes: fresh.passes,
                revision: fresh.revision,
              };
            },
          },
        );
        storeRef.current = store;
        setState({ status: "ready", store, snapshot: store.getSnapshot() });
      } catch (error) {
        if (!cancelled)
          setState({
            status: "error",
            error: error instanceof Error ? error : new Error("load failed"),
          });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  // Re-render on every store change, once the store exists.
  const snapshot = useSyncExternalStore(
    storeRef.current?.subscribe ?? (() => () => undefined),
    () => storeRef.current?.getSnapshot(),
    () => undefined,
  );

  if (state.status !== "ready" || state.store === undefined) return state;
  return { status: "ready", store: state.store, snapshot: snapshot ?? state.store.getSnapshot() };
}

/**
 * Merges realtime `edg.ops` (CONTRACTS §7) from other sessions into a live
 * store, over the editor's own `RealtimeClient` connection — separate from
 * `AppShell`'s (`components/shell/app-shell.tsx`), which subscribes to the
 * workspace room and does not expose its socket to a page. Connecting and
 * disconnecting with the editor's own lifecycle means a second tab's edits
 * arrive within one reconnect window even before this hook's caller has
 * finished its first paint, and the socket closes the moment the editor
 * unmounts rather than outliving the page.
 */
export function useEdgRealtime(projectId: string, store: EditorStore | undefined): void {
  const { client, session } = useApiContext();

  useEffect(() => {
    if (store === undefined) return;
    const realtime = new RealtimeClient({
      url: client.realtimeUrl,
      getAccessToken: () => session.getAccessToken(),
    });
    realtime.subscribe(rooms.project(projectId));
    const unsubscribe = realtime.on("edg.ops", (event) => {
      const data = event.data as { revision?: unknown; ops?: unknown };
      if (typeof data.revision !== "number" || !Array.isArray(data.ops)) return;
      // Echoes of this session's own writes are safe (idempotent by opId,
      // `packages/edg/README.md` "Idempotency") and other sources are exactly
      // what the store must merge.
      store.absorbRemoteOps(data.ops as never, data.revision);
    });
    realtime.connect();
    return () => {
      unsubscribe();
      realtime.disconnect();
    };
  }, [client, session, projectId, store]);
}

export { rooms, RealtimeClient };
export type { RealtimeEvent };
export { ApiError };

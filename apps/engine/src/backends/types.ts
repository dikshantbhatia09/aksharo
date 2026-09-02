import type {
  AlignRequest,
  AlignResponse,
  CleanRequest,
  CleanResponse,
  EngineBackendKind,
  RenderRequest,
  RenderResponse,
  TranscribeRequest,
  TranscribeResponse,
  TranscribeStreamMessage,
} from "@montaj/engine-client";

/**
 * The backend interface every route handler in `server.ts` dispatches to
 * (brief §4: "the FakeBackend produces deterministic transcripts/alignments
 * ... so all API/contract tests run here; the real backends are exercised by
 * C03b on real machines"). `FakeBackend` (this WP) and a future
 * `WhisperCppBackend`/`RealBackend` (C03b, spawning the supervised native
 * processes) both implement this so `server.ts` never branches on which one
 * is live.
 */
export interface EngineBackend {
  readonly kind: EngineBackendKind;
  transcribe(request: TranscribeRequest): Promise<TranscribeResponse>;
  /** Streaming counterpart of `transcribe`, used by the `/transcribe` WS route. */
  transcribeStream(request: TranscribeRequest): AsyncGenerator<TranscribeStreamMessage>;
  align(request: AlignRequest): Promise<AlignResponse>;
  clean(request: CleanRequest): Promise<CleanResponse>;
  render(request: RenderRequest): Promise<RenderResponse>;
  engineVersions(): Record<string, string>;
}

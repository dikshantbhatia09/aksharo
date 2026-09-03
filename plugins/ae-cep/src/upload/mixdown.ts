/**
 * Mixdown -> upload -> transcribe flow ("Caption this comp": mixdown -> upload -> transcribe,
 * brief item 2). Ties `AeHost.mixdownToWav`, `BridgeClient` (`media.uploadTicket`, CONTRACTS §5)
 * and a plain HTTP client (the presigned PUT, then `POST /transcribe`) together into one pure,
 * injectable pipeline, fully unit-testable without a network or a real After Effects install.
 * Same shape as `plugins/premiere-uxp/src/upload/mixdown.ts` (C05a), copied rather than imported
 * for this package's file boundary.
 *
 * OPEN QUESTION for the bridge/API team (same one C05a flagged, unresolved here too):
 * `media.uploadTicket`'s `handle` is documented alongside `fs.pickMedia`, i.e. a handle the
 * *bridge* minted for a file the user picked through it. This flow's temp WAV is produced by
 * After Effects itself (this plugin's own process), so there is no `fs.pickMedia` handle for it.
 * This module passes the mixdown's local temp path as the `handle` on the same assumption C05a
 * made; if that turns out not to hold, the bridge needs a third handle source before this flow
 * works against a real bridge.
 */
import type { BridgeClient } from "../bridge/client.js";
import type { AeHost, CompTimeRange, MixdownFormat } from "../host/ae.js";

export type MixdownStage = "mixing" | "uploading" | "creatingProject" | "done" | "error";

export interface MixdownStageEvent {
  readonly stage: MixdownStage;
  readonly fraction?: number;
  readonly message?: string;
}

export interface HttpClient {
  putBinary(url: string, body: Uint8Array, contentType: string): Promise<void>;
  postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T>;
}

export interface TranscribeProjectRequest {
  readonly compName: string;
  readonly languageHints: readonly string[];
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

export interface TranscribeProjectResult {
  readonly projectId: string;
  readonly webEditorUrl: string;
}

export interface MixdownAndTranscribeOptions {
  readonly host: Pick<AeHost, "mixdownToWav" | "readFile">;
  readonly bridge: BridgeClient;
  readonly http: HttpClient;
  readonly apiOrigin: string;
  readonly sessionToken: string;
  readonly compId: string;
  readonly range: CompTimeRange;
  readonly format: MixdownFormat;
  readonly project: TranscribeProjectRequest;
  readonly onStageChange?: (event: MixdownStageEvent) => void;
}

const AUDIO_CONTENT_TYPE: Record<MixdownFormat, string> = {
  mono16k: "audio/wav",
  stereo48k: "audio/wav",
};

/**
 * Runs the whole pipeline and returns the created cloud project. Throws (after reporting an
 * "error" stage) on any failure — the caller decides how to surface it.
 */
export async function mixdownAndTranscribe(
  options: MixdownAndTranscribeOptions,
): Promise<TranscribeProjectResult> {
  const { host, bridge, http, apiOrigin, sessionToken, onStageChange } = options;
  try {
    onStageChange?.({ stage: "mixing", fraction: 0 });
    const mixdown = await host.mixdownToWav(
      { compId: options.compId, range: options.range, format: options.format },
      (progress) => onStageChange?.({ stage: "mixing", fraction: progress.fraction }),
    );

    onStageChange?.({ stage: "uploading", fraction: 0 });
    const bytes = await host.readFile(mixdown.tempFilePath);
    const ticket = await bridge.call("media.uploadTicket", { handle: mixdown.tempFilePath });
    await http.putBinary(ticket.uploadUrl, bytes, AUDIO_CONTENT_TYPE[mixdown.format]);
    onStageChange?.({ stage: "uploading", fraction: 1 });

    onStageChange?.({ stage: "creatingProject" });
    const result = await http.postJson<TranscribeProjectResult>(
      `${apiOrigin}/transcribe`,
      {
        source: "ae-cep",
        compName: options.project.compName,
        languageHints: options.project.languageHints,
        fps: options.project.fps,
        width: options.project.width,
        height: options.project.height,
        durationMs: mixdown.durationMs,
        audioFormat: mixdown.format,
      },
      { Authorization: `Bearer ${sessionToken}` },
    );

    onStageChange?.({ stage: "done" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mixdown/transcribe failed";
    onStageChange?.({ stage: "error", message });
    throw error;
  }
}

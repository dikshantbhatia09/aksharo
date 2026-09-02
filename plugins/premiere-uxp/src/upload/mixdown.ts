/**
 * Mixdown -> upload -> transcribe flow (brief item 4). Ties `PremiereHost.requestMixdown`,
 * `BridgeClient` (`media.uploadTicket`, CONTRACTS §5 / `07-api-and-contracts.md` "Local
 * bridge protocol (v2)") and a plain HTTP client (the presigned PUT, then `POST /transcribe`
 * per A06/A11) together into one pure, injectable pipeline so it is fully unit-testable
 * without a network or a real Premiere install.
 *
 * OPEN QUESTION for the bridge/API team (flagged in the WP report, not resolved here):
 * `media.uploadTicket`'s `handle` (`MediaUploadTicketParamsSchema`) is documented alongside
 * `fs.pickMedia`, i.e. a handle the *bridge* minted for a file the user picked through it.
 * This flow's temp WAV is produced by Premiere itself (this plugin's own process), so there is
 * no `fs.pickMedia` handle for it. This module passes the mixdown's local temp path as the
 * `handle` on the assumption the bridge can resolve a same-machine UXP-produced path the same
 * way; if that turns out not to hold, the bridge needs a third handle source (e.g. a
 * `media.registerLocalFile` method) before this flow works against a real bridge.
 *
 * Realtime transcription progress after project creation (`job.progress`, CONTRACTS §7) rides
 * the API/relay realtime channel, not `bridge-core`'s `events.subscribe` (whose
 * `BridgeEventKind` union has no transcription-progress kind) — wiring that channel is out of
 * scope for this module; `onStageChange` below only covers the stages this flow itself drives.
 */
import type { BridgeClient } from "../bridge/client.js";
import type { FrameRange, MixdownFormat, PremiereHost } from "../host/premiere.js";

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
  readonly sequenceName: string;
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
  readonly host: Pick<PremiereHost, "requestMixdown" | "readFile">;
  readonly bridge: BridgeClient;
  readonly http: HttpClient;
  readonly apiOrigin: string;
  readonly sessionToken: string;
  readonly sequenceId: string;
  readonly range: FrameRange;
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
 * "error" stage) on any failure — the caller decides how to surface it (the panel shows
 * `t("status.error", { message })`).
 */
export async function mixdownAndTranscribe(
  options: MixdownAndTranscribeOptions,
): Promise<TranscribeProjectResult> {
  const { host, bridge, http, apiOrigin, sessionToken, onStageChange } = options;
  try {
    onStageChange?.({ stage: "mixing", fraction: 0 });
    const mixdown = await host.requestMixdown(
      { sequenceId: options.sequenceId, range: options.range, format: options.format },
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
        source: "premiere-uxp",
        sequenceName: options.project.sequenceName,
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

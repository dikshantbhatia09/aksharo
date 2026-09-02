/**
 * SRT to bin (C06 brief §Scope 4): a downloaded SRT (A21 subtitles export path) is imported
 * into the project bin next to the sequence — no captions-track write, no placement on any
 * track. Kept deliberately simple: one bin import call.
 */
import type { PremiereHost } from "../host/premiere.js";

export interface ImportSrtToBinInput {
  readonly localPath: string;
  readonly binName?: string;
}

export interface ImportSrtToBinResult {
  readonly binItemId: string;
}

export async function importSrtToBin(
  host: PremiereHost,
  input: ImportSrtToBinInput,
): Promise<ImportSrtToBinResult> {
  const { itemId } = await host.importMediaToBin({
    sourcePath: input.localPath,
    binName: input.binName ?? "Aksharo subtitles",
  });
  return { binItemId: itemId };
}

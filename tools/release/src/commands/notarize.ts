import { randomUUID } from "node:crypto";

import { APPLE_NOTARIZE_SECRETS, requireSecretsIfSigned } from "../env.js";
import { execCommand } from "../lib/exec.js";
import { recordNotarization } from "../lib/notarizeBuffer.js";

import type { NotarizationRecord, ReleaseContext } from "../types.js";

export interface NotarizeOptions {
  artifactPath: string;
  artifactName: string;
}

/**
 * `notarize`: `notarytool submit --wait` then `stapler staple`. Dry-run fabricates a
 * submission id and marks the ticket stapled so the 24h-buffer logic (`lib/notarizeBuffer.ts`)
 * can be exercised end to end without Apple credentials.
 */
export async function runNotarize(
  ctx: ReleaseContext,
  opts: NotarizeOptions,
): Promise<NotarizationRecord> {
  requireSecretsIfSigned(ctx.mode, APPLE_NOTARIZE_SECRETS);

  let submissionId: string;
  let stapled: boolean;

  if (ctx.mode === "signed") {
    const submit = await execCommand("xcrun", [
      "notarytool",
      "submit",
      opts.artifactPath,
      "--wait",
      "--output-format",
      "json",
    ]);
    submissionId = extractSubmissionId(submit.stdout) ?? randomUUID();
    const staple = await execCommand("xcrun", ["stapler", "staple", opts.artifactPath]);
    stapled = staple.code === 0;
  } else {
    submissionId = `dry-run-${randomUUID()}`;
    stapled = true;
  }

  const record: NotarizationRecord = {
    artifact: opts.artifactName,
    submissionId,
    notarizedAt: ctx.now(),
    stapled,
  };
  await recordNotarization(ctx.outDir, record);
  return record;
}

function extractSubmissionId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { id?: string };
    return parsed.id;
  } catch {
    return undefined;
  }
}

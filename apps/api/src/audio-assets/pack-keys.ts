/**
 * Object key for an ingested audio-pack asset's source WAV in the derived
 * bucket: `packs/{packId}/{assetId}.wav`.
 *
 * **Open question for the coordinator**: `docs/CONTRACTS.md` §6 enumerates
 * `ws/{workspaceId}/p/{projectId}/...`, `exports/...`, `fonts/...` and
 * `brand/...` prefixes, all workspace- or project-scoped. A Tier 0 audio pack
 * is neither — it is a shared, workspace-independent library object, so none
 * of the existing prefixes fit and this module does not force one to. This
 * key lives outside CONTRACTS §6 until the coordinator either adds a
 * `packs/{packId}/{assetId}.{ext}` line there or names a different prefix;
 * flagged in the D04a final report rather than silently amending the frozen
 * contract from a work package that doesn't own it.
 */

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

export class PackKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackKeyError";
  }
}

export function audioPackAssetKey(packId: string, assetId: string, extension = "wav"): string {
  if (!PACK_ID_PATTERN.test(packId)) {
    throw new PackKeyError(`packId is not a usable slug: ${JSON.stringify(packId)}`);
  }
  if (!ASSET_ID_PATTERN.test(assetId)) {
    throw new PackKeyError(`assetId is not a usable slug: ${JSON.stringify(assetId)}`);
  }
  const ext = extension.toLowerCase().replace(/^\.+/, "");
  if (!EXTENSION_PATTERN.test(ext)) {
    throw new PackKeyError(`extension is not usable: ${JSON.stringify(extension)}`);
  }
  return `packs/${packId}/${assetId}.${ext}`;
}

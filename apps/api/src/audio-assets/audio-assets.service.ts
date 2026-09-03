import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { assetAllowed } from "./asset-allowed.js";
import { AUDIO_ASSET_ERRORS, PACK_ASSET_URL_TTL_SECONDS } from "./audio-assets.constants.js";
import { AudioAssetsRepository } from "./audio-assets.repository.js";
import { AppException } from "../common/index.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE } from "../common/storage/object-store.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";

import type { PackAssetUrl } from "./audio-assets.dto.js";
import type { ObjectStore } from "../common/storage/object-store.js";
import type { AssetSurface, ClientKind } from "@prisma/client";

/**
 * `GET /audio-assets/{assetId}/url` (D04d): a signed URL onto one pack
 * asset's bytes for the `ProposalCard` preview player and for the browser
 * export mixer's per-asset cache, both of which fetch cue audio directly
 * from the derived bucket rather than through the API.
 *
 * The licence predicate is **re-checked here**, not trusted from whatever
 * produced the caller's `assetId` (the `ai.pass` catalogue snapshot, or a
 * stale `PassItem`): a workspace's plan can be downgraded, a partner term
 * can lapse, between the pass running and a user clicking preview, and this
 * is the one gate between "the caller has an id" and "bytes leave the
 * bucket". `assetAllowed` runs with the same three inputs `passes.service.ts`'s
 * `sfxCatalogueOf` uses (plan via `resolveWorkspacePlan`, territory `"WORLD"`
 * until a workspace-level territory signal exists — the same flagged
 * assumption), with `surface` read off the caller's own token `kind`
 * (`desktop` / `api` / `panel` — the enum's three non-`cloud_render` values,
 * `cloud_render` being the render service's own internal path, never an HTTP
 * caller's).
 */
@Injectable()
export class AudioAssetsService {
  constructor(
    private readonly repository: AudioAssetsRepository,
    private readonly prisma: PrismaService,
    @Inject(DERIVED_STORE) private readonly store: ObjectStore,
  ) {}

  async signedUrl(
    workspaceId: string,
    assetId: string,
    clientKind: ClientKind,
  ): Promise<PackAssetUrl> {
    const asset = await this.repository.findById(assetId);
    if (asset === null || asset.storageKey === null) {
      throw new AppException(
        AUDIO_ASSET_ERRORS.notFound,
        "No such audio asset.",
        HttpStatus.NOT_FOUND,
      );
    }

    const plan = await resolveWorkspacePlan(this.prisma, workspaceId);
    const surface = surfaceFor(clientKind);
    const decision = assetAllowed(asset, { surface, plan, territory: "WORLD" });
    if (!decision.allowed) {
      throw new AppException(
        AUDIO_ASSET_ERRORS.notAllowed,
        `This asset is not available: ${decision.reasons.join(", ")}.`,
        HttpStatus.FORBIDDEN,
        { reasons: decision.reasons },
      );
    }

    const url = await this.store.presignGet(asset.storageKey, PACK_ASSET_URL_TTL_SECONDS);
    return {
      assetId,
      url,
      expiresAt: new Date(Date.now() + PACK_ASSET_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }
}

/** Maps a token's `kind` to the `AssetSurface` value that predicate gates on
 * — `cloud_render` is the render service's own internal path (`passes.service
 * .ts`'s `sfxCatalogueOf`), never an HTTP caller's, so no `kind` maps to it
 * here. */
function surfaceFor(kind: ClientKind): AssetSurface {
  if (kind === "desktop") return "desktop";
  if (kind === "api") return "api";
  return "panel";
}

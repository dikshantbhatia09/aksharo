import { Inject, Injectable, Logger } from "@nestjs/common";

import { buildDefaultWatermarkPng } from "./default-watermark.js";
import { DEFAULT_WATERMARK_ASSET_ID } from "./manifest-builder.js";
import { brandAssetKey, DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";

/**
 * Provisions the bundled Free-tier watermark at a workspace's own brand key.
 *
 * `apps/render`'s `brandAssetKey` resolves every `watermark.assetId` per
 * workspace (`ws/{workspaceId}/brand/{assetId}.png`, A20) — there is no
 * bundled, workspace-independent object anywhere in the render path. A manifest
 * that names the platform default therefore only renders once that object
 * exists for the issuing workspace, so `ExportsService` calls {@link ensure}
 * before it signs one.
 */
@Injectable()
export class DefaultWatermarkService {
  private readonly logger = new Logger(DefaultWatermarkService.name);
  /** Workspaces confirmed provisioned this process's lifetime; `head()` is cheap but not free. */
  private readonly known = new Set<string>();

  constructor(@Inject(DERIVED_STORE) private readonly store: ObjectStore) {}

  async ensure(workspaceId: string): Promise<void> {
    if (this.known.has(workspaceId)) return;

    const key = brandAssetKey(workspaceId, DEFAULT_WATERMARK_ASSET_ID);
    const head = await this.store.head(key);
    if (head === null) {
      await this.store.put({ key, body: buildDefaultWatermarkPng(), contentType: "image/png" });
      this.logger.log(
        { workspaceId, key },
        "provisioned the default watermark for a new workspace",
      );
    }
    this.known.add(workspaceId);
  }
}

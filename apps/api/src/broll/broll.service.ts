import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import type { OverlayImage } from "@montaj/edg";

import { normaliseTags, type LibraryPicture } from "./broll-match.js";
import {
  BROLL_CONTENT_TYPE_LIST,
  BROLL_CONTENT_TYPES,
  BROLL_ERROR_CODES,
  BROLL_IMAGE_URL_TTL_SECONDS,
  BROLL_MAX_ASSETS,
  BROLL_MAX_BYTES,
  BROLL_MAX_SIDE,
  BROLL_MAX_TAGS,
  BROLL_MIN_SIDE,
  BROLL_TAG_MAX,
  BROLL_TITLE_MAX,
  BROLL_UPLOAD_LONG_SIDE,
  BROLL_UPLOAD_URL_TTL_SECONDS,
  STOCK_SAVE_LONG_SIDE,
  STOCK_SEARCH_PER_PAGE,
  type BrollContentType,
  type BrollFormat,
} from "./broll.constants.js";
import {
  PexelsClient,
  PexelsError,
  type PexelsOrientation,
  type PexelsPhoto,
  type PexelsPurpose,
} from "./pexels.client.js";
import { probeImage, type ImageFacts } from "../brand-kit/image-probe.js";
import { AppException, PrismaService } from "../common/index.js";
import { brollAssetKey, DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";

import type {
  BrollCompleteInput,
  BrollCredit,
  BrollItemView,
  BrollLibraryView,
  BrollUpdateInput,
  BrollUploadInput,
  BrollUploadTicket,
  StockSaveInput,
  StockSearchInput,
  StockSearchView,
} from "./broll.dto.js";
import type { BrollAsset, Prisma } from "@prisma/client";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `broll_assets.source` of a stock photo saved from Pexels. */
const PEXELS_SOURCE = "pexels";

/**
 * A workspace's B-roll library (2026-10-05): the pictures a B-roll cutaway
 * draws over the words that name them.
 *
 * **Uploads.** Bytes go straight to R2 through a presigned PUT, under
 * `ws/{workspaceId}/broll/{assetId}.{png|jpg|webp}` - the only folder a render
 * reads a cutaway's picture from. Then `complete` reads them back (at most
 * {@link BROLL_MAX_BYTES}) and keeps them only if they open as the PNG, JPEG or
 * WebP they were declared as, {@link BROLL_MIN_SIDE} to {@link BROLL_MAX_SIDE}
 * pixels a side, measuring the size for the renderers. A library keeps at most
 * {@link BROLL_MAX_ASSETS} pictures.
 *
 * **Tags** are what a picture is matched on (`broll-match.ts`): lower-cased,
 * trimmed and deduplicated here, at most {@link BROLL_MAX_TAGS} of them.
 *
 * **Stock** (only when `PEXELS_API_KEY` is set): a search, and a save that
 * reads the chosen photo from Pexels by its id - never an address a person
 * sent - at a long side of at most {@link STOCK_SAVE_LONG_SIDE}, checks it as
 * an upload is checked, and keeps it with its photographer's credit. The same
 * photo is saved into a library once (`(workspace, source, source_ref)` is
 * unique).
 *
 * **Deleting** a picture deletes its object and then its row. A clip that
 * showed it no longer does: the exports and previews leave out a cutaway whose
 * picture the workspace no longer keeps ({@link availableImages}), and a
 * captioned video made before keeps it. Workspace erasure deletes them all.
 */
@Injectable()
export class BrollLibraryService {
  private readonly logger = new Logger(BrollLibraryService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DERIVED_STORE) private readonly store: ObjectStore,
    private readonly pexels: PexelsClient,
  ) {}

  /** Whether stock photos can be searched and saved here. */
  get stockEnabled(): boolean {
    return this.pexels.enabled;
  }

  /** `GET /broll`: every picture, newest first, each signed for an hour. */
  async list(workspaceId: string): Promise<BrollLibraryView> {
    const rows = await this.prisma.brollAsset.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    const items: BrollItemView[] = [];
    for (const row of rows) {
      const item = await this.itemView(row);
      if (item !== undefined) items.push(item);
    }
    return {
      items,
      stock: {
        enabled: this.pexels.enabled,
        provider: this.pexels.enabled ? "pexels" : null,
      },
      limits: {
        maxBytes: BROLL_MAX_BYTES,
        contentTypes: [...BROLL_CONTENT_TYPE_LIST],
        minSide: BROLL_MIN_SIDE,
        maxSide: BROLL_MAX_SIDE,
        uploadLongSide: BROLL_UPLOAD_LONG_SIDE,
        maxAssets: BROLL_MAX_ASSETS,
        maxTags: BROLL_MAX_TAGS,
        tagMax: BROLL_TAG_MAX,
        titleMax: BROLL_TITLE_MAX,
      },
    };
  }

  /**
   * `POST /broll/uploads`: a presigned PUT for a new picture. Nothing is
   * recorded until `complete` has seen the bytes.
   *
   * @throws AppException 413 `broll/picture_too_large`, 409 `broll/library_full`.
   */
  async createUpload(workspaceId: string, input: BrollUploadInput): Promise<BrollUploadTicket> {
    if (input.sizeBytes > BROLL_MAX_BYTES) throw tooLarge(input.sizeBytes);
    await this.assertRoom(workspaceId);
    const assetId = ulid();
    const key = brollAssetKey(
      workspaceId,
      assetId,
      BROLL_CONTENT_TYPES[input.contentType].extension,
    );
    const uploadUrl = await this.store.presignPut(
      key,
      BROLL_UPLOAD_URL_TTL_SECONDS,
      input.contentType,
    );
    return {
      assetId,
      uploadUrl,
      contentType: input.contentType,
      expiresAt: new Date(Date.now() + BROLL_UPLOAD_URL_TTL_SECONDS * 1_000).toISOString(),
      maxBytes: BROLL_MAX_BYTES,
    };
  }

  /**
   * `POST /broll/{assetId}/complete`: checks the uploaded bytes and keeps them
   * as a picture of the library. A file that is not what it claims, too large,
   * or an unusable size is deleted and refused. Idempotent: completing the same
   * upload again answers the same picture.
   *
   * @returns the picture, and whether this call added it.
   */
  async complete(
    workspaceId: string,
    userId: string | null,
    assetId: string,
    input: BrollCompleteInput,
  ): Promise<{ readonly item: BrollItemView; readonly created: boolean }> {
    if (!ULID_PATTERN.test(assetId)) throw notFound();
    const existing = await this.prisma.brollAsset.findUnique({ where: { id: assetId } });
    if (existing !== null) {
      if (existing.workspaceId !== workspaceId) throw notFound();
      return { item: await this.requireView(existing), created: false };
    }

    const type = BROLL_CONTENT_TYPES[input.contentType];
    const key = brollAssetKey(workspaceId, assetId, type.extension);
    const head = await this.store.head(key);
    if (head === null) {
      throw new AppException(
        BROLL_ERROR_CODES.notUploaded,
        "The picture has not finished uploading. Try again in a moment.",
        HttpStatus.CONFLICT,
      );
    }
    if (head.sizeBytes > BROLL_MAX_BYTES) {
      await this.discard(key);
      throw tooLarge(head.sizeBytes);
    }
    const bytes = new Uint8Array(await this.store.get(key));
    const facts = await this.checkPicture(key, bytes, type.format);
    // Counted again: two uploads started with one place left both got a ticket.
    await this.assertRoom(workspaceId, async () => this.discard(key));

    const title = input.title?.trim();
    const row = await this.prisma.brollAsset.create({
      data: {
        id: assetId,
        workspaceId,
        storageKey: key,
        contentType: input.contentType,
        sizeBytes: bytes.byteLength,
        width: facts.width,
        height: facts.height,
        tags: normaliseTags(input.tags ?? [], BROLL_MAX_TAGS, BROLL_TAG_MAX),
        title: title === undefined || title === "" ? null : title,
        source: "upload",
        createdBy: userId,
      },
    });
    return { item: await this.requireView(row), created: true };
  }

  /**
   * `PATCH /broll/{assetId}`: new tags, a new title, or both.
   * @throws AppException 404 `broll/picture_not_found`.
   */
  async update(
    workspaceId: string,
    assetId: string,
    input: BrollUpdateInput,
  ): Promise<BrollItemView> {
    const row = await this.own(workspaceId, assetId);
    const title = input.title?.trim();
    const updated = await this.prisma.brollAsset.update({
      where: { id: row.id },
      data: {
        ...(input.tags === undefined
          ? {}
          : { tags: normaliseTags(input.tags, BROLL_MAX_TAGS, BROLL_TAG_MAX) }),
        ...(title === undefined ? {} : { title: title === "" ? null : title }),
      },
    });
    return this.requireView(updated);
  }

  /**
   * `DELETE /broll/{assetId}`: the object, then the row. Idempotent: a picture
   * already gone - or another workspace's, which is never touched - answers
   * `false`.
   */
  async remove(workspaceId: string, assetId: string): Promise<boolean> {
    if (!ULID_PATTERN.test(assetId)) return false;
    const row = await this.prisma.brollAsset.findFirst({ where: { id: assetId, workspaceId } });
    if (row === null) return false;
    await this.store.delete(row.storageKey);
    await this.prisma.brollAsset.deleteMany({ where: { id: row.id, workspaceId } });
    return true;
  }

  /**
   * `GET /broll/stock`: one page of stock photos for `query`.
   * @throws AppException 404 `broll/stock_disabled`, 429 `broll/stock_busy`,
   *   502 `broll/stock_unavailable`.
   */
  async searchStock(input: StockSearchInput): Promise<StockSearchView> {
    try {
      const photos = await this.pexels.search(
        input.query,
        {
          ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
          perPage: STOCK_SEARCH_PER_PAGE,
          page: input.page,
        },
        "person",
      );
      return {
        provider: "pexels",
        query: input.query,
        page: input.page,
        photos: photos.map((photo) => ({
          id: photo.id,
          width: photo.width,
          height: photo.height,
          alt: photo.alt,
          photographer: photo.photographer,
          photographerUrl: photo.photographerUrl,
          pageUrl: photo.pageUrl,
          previewUrl: photo.previewUrl,
        })),
      };
    } catch (error) {
      throw stockRefusal(error);
    }
  }

  /**
   * `POST /broll/stock`: keeps a stock photo in the library, with its
   * photographer's credit. The same photo again answers the picture already
   * kept, with any new tags added to its own.
   *
   * @returns the picture, and whether this call added it.
   * @throws AppException as {@link searchStock} does, 404 `broll/stock_not_found`,
   *   409 `broll/library_full`, and 422 when the photo service sent something
   *   that is not a usable picture.
   */
  async saveStock(
    workspaceId: string,
    userId: string | null,
    input: StockSaveInput,
    purpose: PexelsPurpose = "person",
  ): Promise<{ readonly item: BrollItemView; readonly created: boolean }> {
    const tags = normaliseTags(input.tags ?? [], BROLL_MAX_TAGS, BROLL_TAG_MAX);
    const kept = await this.prisma.brollAsset.findFirst({
      where: { workspaceId, source: PEXELS_SOURCE, sourceRef: String(input.photoId) },
    });
    if (kept !== null) {
      const merged = normaliseTags([...kept.tags, ...tags], BROLL_MAX_TAGS, BROLL_TAG_MAX);
      const row =
        merged.length === kept.tags.length
          ? kept
          : await this.prisma.brollAsset.update({ where: { id: kept.id }, data: { tags: merged } });
      return { item: await this.requireView(row), created: false };
    }
    await this.assertRoom(workspaceId);
    let photo: PexelsPhoto;
    let bytes: Uint8Array;
    try {
      photo = await this.pexels.photo(input.photoId, purpose);
      bytes = await this.pexels.download(photo, STOCK_SAVE_LONG_SIDE, BROLL_MAX_BYTES);
    } catch (error) {
      throw stockRefusal(error);
    }
    const row = await this.keepStockPhoto(workspaceId, userId, photo, bytes, tags);
    return { item: await this.requireView(row), created: true };
  }

  /**
   * Autopilot's stock photo for a moment: the first result for `phrase` shaped
   * like the clip, saved into the library tagged with the phrase (so the next
   * clip naming it finds it there first). `null` whenever stock photos cannot
   * help - off, the allowance spent, nothing found, the library full - never
   * an error: a cutaway is never worth failing a clip over.
   */
  async stockForMoment(
    workspaceId: string,
    phrase: string,
    orientation: PexelsOrientation,
  ): Promise<LibraryPicture | null> {
    if (!this.pexels.enabled) return null;
    try {
      const count = await this.prisma.brollAsset.count({ where: { workspaceId } });
      if (count >= BROLL_MAX_ASSETS) return null;
      const [photo] = await this.pexels.search(phrase, { orientation, perPage: 3 }, "autopilot");
      if (photo === undefined) return null;
      const { item } = await this.saveStock(
        workspaceId,
        null,
        { photoId: photo.id, tags: [phrase] },
        "autopilot",
      );
      return pictureOfView(item);
    } catch (error) {
      this.logger.warn(
        { workspaceId, err: error instanceof Error ? error.message : String(error) },
        "a stock photo for a clip's cutaway could not be had; the moment goes without one",
      );
      return null;
    }
  }

  /** Every picture of the workspace, as matching reads them (newest first). */
  async picturesFor(workspaceId: string): Promise<LibraryPicture[]> {
    const rows = await this.prisma.brollAsset.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: { id: true, tags: true, title: true, width: true, height: true, contentType: true },
    });
    return rows.flatMap((row) => {
      const format = formatOf(row.contentType);
      return format === undefined
        ? []
        : [
            {
              id: row.id,
              tags: row.tags,
              title: row.title,
              width: row.width,
              height: row.height,
              format,
            },
          ];
    });
  }

  /**
   * Which of `assetIds` the workspace still keeps as pictures. A render payload
   * and a preview draw only these: a cutaway naming a picture that is gone is
   * left out rather than failing.
   */
  async availableImages(workspaceId: string, assetIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(assetIds)].filter((id) => ULID_PATTERN.test(id));
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.brollAsset.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  /** Signed URLs for the pictures among `assetIds` the workspace still keeps, by asset id. */
  async imageUrls(
    workspaceId: string,
    assetIds: readonly string[],
    ttlSeconds: number = BROLL_IMAGE_URL_TTL_SECONDS,
  ): Promise<Record<string, string>> {
    const ids = [...new Set(assetIds)].filter((id) => ULID_PATTERN.test(id));
    if (ids.length === 0) return {};
    const rows = await this.prisma.brollAsset.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, storageKey: true },
    });
    const urls: Record<string, string> = {};
    for (const row of rows) urls[row.id] = await this.store.presignGet(row.storageKey, ttlSeconds);
    return urls;
  }

  // -------------------------------------------------------------------------

  /** Checks a stock photo's bytes as an upload's are checked, stores them, and records it. */
  private async keepStockPhoto(
    workspaceId: string,
    userId: string | null,
    photo: PexelsPhoto,
    bytes: Uint8Array,
    tags: readonly string[],
  ): Promise<BrollAsset> {
    const facts = probeImage(bytes);
    if (facts === undefined) throw invalid();
    const contentType = contentTypeOfFormat(facts.format);
    const assetId = ulid();
    // eslint-disable-next-line security/detect-object-injection -- a closed enum of three content types
    const key = brollAssetKey(workspaceId, assetId, BROLL_CONTENT_TYPES[contentType].extension);
    checkSize(facts);
    await this.store.put({ key, body: bytes, contentType });
    const credit: BrollCredit = {
      provider: "pexels",
      photographer: photo.photographer.slice(0, 200),
      photographerUrl: photo.photographerUrl.slice(0, 500),
      pageUrl: photo.pageUrl.slice(0, 500),
    };
    const alt = photo.alt.slice(0, BROLL_TITLE_MAX).trim();
    try {
      return await this.prisma.brollAsset.create({
        data: {
          id: assetId,
          workspaceId,
          storageKey: key,
          contentType,
          sizeBytes: bytes.byteLength,
          width: facts.width,
          height: facts.height,
          tags: [...tags],
          title: alt === "" ? null : alt,
          source: PEXELS_SOURCE,
          sourceRef: String(photo.id),
          credit: credit as unknown as Prisma.InputJsonValue,
          createdBy: userId,
        },
      });
    } catch (error) {
      await this.discard(key);
      // Saved at the same moment by another request: that row is the picture.
      if (!isUniqueViolation(error)) throw error;
      const kept = await this.prisma.brollAsset.findFirst({
        where: { workspaceId, source: PEXELS_SOURCE, sourceRef: String(photo.id) },
      });
      if (kept === null) throw error;
      return kept;
    }
  }

  /**
   * Reads back an uploaded picture's facts - it must open as `format`, at a
   * usable size - or deletes it and throws the refusal.
   */
  private async checkPicture(
    key: string,
    bytes: Uint8Array,
    format: BrollFormat,
  ): Promise<ImageFacts> {
    if (bytes.byteLength > BROLL_MAX_BYTES) {
      await this.discard(key);
      throw tooLarge(bytes.byteLength);
    }
    const facts = probeImage(bytes);
    if (facts === undefined || facts.format !== format) {
      await this.discard(key);
      throw invalid();
    }
    try {
      checkSize(facts);
    } catch (error) {
      await this.discard(key);
      throw error;
    }
    return facts;
  }

  /** @throws AppException 409 `broll/library_full` when the library holds its most. */
  private async assertRoom(workspaceId: string, beforeThrow?: () => Promise<void>): Promise<void> {
    const count = await this.prisma.brollAsset.count({ where: { workspaceId } });
    if (count < BROLL_MAX_ASSETS) return;
    await beforeThrow?.();
    throw new AppException(
      BROLL_ERROR_CODES.libraryFull,
      `A B-roll library keeps at most ${String(BROLL_MAX_ASSETS)} pictures. Delete some to add more.`,
      HttpStatus.CONFLICT,
      { maxAssets: BROLL_MAX_ASSETS },
    );
  }

  /** The workspace's own picture, or 404 (another workspace's is never found). */
  private async own(workspaceId: string, assetId: string): Promise<BrollAsset> {
    if (!ULID_PATTERN.test(assetId)) throw notFound();
    const row = await this.prisma.brollAsset.findFirst({ where: { id: assetId, workspaceId } });
    if (row === null) throw notFound();
    return row;
  }

  private async requireView(row: BrollAsset): Promise<BrollItemView> {
    const view = await this.itemView(row);
    if (view === undefined) throw notFound();
    return view;
  }

  private async itemView(row: BrollAsset): Promise<BrollItemView | undefined> {
    const format = formatOf(row.contentType);
    if (format === undefined) return undefined;
    return {
      assetId: row.id,
      format,
      contentType: row.contentType as BrollContentType,
      width: row.width,
      height: row.height,
      sizeBytes: row.sizeBytes,
      tags: row.tags,
      title: row.title,
      source: row.source === PEXELS_SOURCE ? "pexels" : "upload",
      credit: creditOf(row.credit),
      url: await this.store.presignGet(row.storageKey, BROLL_IMAGE_URL_TTL_SECONDS),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async discard(key: string): Promise<void> {
    await this.store.delete(key).catch((error: unknown) => {
      this.logger.warn({ key, err: error }, "could not delete a refused b-roll picture");
    });
  }
}

/** A picture as an overlay names it. */
export function overlayImageOfPicture(picture: LibraryPicture): OverlayImage {
  return {
    assetId: picture.id,
    format: picture.format,
    width: picture.width,
    height: picture.height,
  };
}

function pictureOfView(item: BrollItemView): LibraryPicture {
  return {
    id: item.assetId,
    tags: item.tags,
    title: item.title,
    width: item.width,
    height: item.height,
    format: item.format,
  };
}

function formatOf(contentType: string): BrollFormat | undefined {
  return Object.hasOwn(BROLL_CONTENT_TYPES, contentType)
    ? BROLL_CONTENT_TYPES[contentType as BrollContentType].format
    : undefined;
}

function contentTypeOfFormat(format: BrollFormat): BrollContentType {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}

function creditOf(value: Prisma.JsonValue | null): BrollCredit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string): string => {
    // eslint-disable-next-line security/detect-object-injection -- a fixed key of a stored credit
    const field = record[key];
    return typeof field === "string" ? field : "";
  };
  if (record["provider"] !== "pexels") return null;
  return {
    provider: "pexels",
    photographer: text("photographer"),
    photographerUrl: text("photographerUrl"),
    pageUrl: text("pageUrl"),
  };
}

/** @throws AppException 422 `broll/picture_bad_size` */
function checkSize(facts: ImageFacts): void {
  const sides = [facts.width, facts.height];
  if (sides.some((side) => side < BROLL_MIN_SIDE || side > BROLL_MAX_SIDE)) {
    throw new AppException(
      BROLL_ERROR_CODES.badSize,
      `A B-roll picture must be between ${String(BROLL_MIN_SIDE)} and ${String(BROLL_MAX_SIDE)} pixels on each side; this one is ${String(facts.width)} × ${String(facts.height)}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { width: facts.width, height: facts.height },
    );
  }
}

/** A stock call's failure, as the answer a person sees. */
function stockRefusal(error: unknown): AppException {
  if (error instanceof AppException) return error;
  if (!(error instanceof PexelsError)) {
    return new AppException(
      BROLL_ERROR_CODES.stockUnavailable,
      "Stock photos could not be reached. Try again in a moment.",
      HttpStatus.BAD_GATEWAY,
    );
  }
  switch (error.code) {
    case "disabled":
      return new AppException(
        BROLL_ERROR_CODES.stockDisabled,
        "Stock photos are not set up here.",
        HttpStatus.NOT_FOUND,
      );
    case "busy":
      return new AppException(
        BROLL_ERROR_CODES.stockBusy,
        "Stock photo searches are used up for now. Try again later, or use your own pictures.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    case "not_found":
      return new AppException(
        BROLL_ERROR_CODES.stockNotFound,
        "That stock photo is no longer available.",
        HttpStatus.NOT_FOUND,
      );
    case "unavailable":
      return new AppException(
        BROLL_ERROR_CODES.stockUnavailable,
        "Stock photos could not be reached. Try again in a moment.",
        HttpStatus.BAD_GATEWAY,
      );
  }
}

/** A unique constraint refused the write (Prisma `P2002`). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function tooLarge(sizeBytes: number): AppException {
  return new AppException(
    BROLL_ERROR_CODES.tooLarge,
    `A B-roll picture can be at most ${String(BROLL_MAX_BYTES / (1024 * 1024))} MB.`,
    HttpStatus.PAYLOAD_TOO_LARGE,
    { sizeBytes, maxBytes: BROLL_MAX_BYTES },
  );
}

function invalid(): AppException {
  return new AppException(
    BROLL_ERROR_CODES.invalid,
    "That file is not a PNG, JPEG or WebP image.",
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function notFound(): AppException {
  return new AppException(BROLL_ERROR_CODES.notFound, "No such picture.", HttpStatus.NOT_FOUND);
}

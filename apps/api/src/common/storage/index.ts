/** The object-store surface (CONTRACTS §6). Import from here, not from a file. */

export {
  DERIVED_STORE,
  DOWNLOAD_URL_TTL_SECONDS,
  MULTIPART_MAX_PARTS,
  MULTIPART_PART_SIZE_BYTES,
  partCountFor,
  RAW_STORE,
  UPLOAD_URL_TTL_SECONDS,
} from "./object-store.js";
export type {
  CompletedPart,
  CreateMultipartInput,
  MultipartUpload,
  ObjectHead,
  ObjectStore,
  PresignedPart,
  PutObjectInput,
} from "./object-store.js";
export { encodeTags, ObjectStoreError, S3ObjectStore } from "./s3-object-store.js";
export type { S3ObjectStoreConfig } from "./s3-object-store.js";
export {
  DERIVED_ARTEFACTS,
  derivedKey,
  exportKey,
  extensionOf,
  FONT_EXTENSIONS,
  fontKey,
  keyBelongsToWorkspace,
  mediaPrefix,
  normaliseExtension,
  rawKey,
  StorageKeyError,
  subtitleKey,
  thumbKey,
} from "./storage.keys.js";
export type { DerivedArtefact, FontExtension } from "./storage.keys.js";
export { StorageModule } from "./storage.module.js";

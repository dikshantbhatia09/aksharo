/**
 * The ONE list of media formats an upload may use, shared by the browser that
 * offers the file picker and the API that validates what it declared.
 *
 * These lived only in `apps/api/src/projects/projects.constants.ts`, and the web
 * kept a hand-written "subset of the backend's full allow-list" of its own in
 * `drop-zone.tsx`. The two drifted: the picker offered eight extensions while
 * the API accepted eighteen, so a perfectly supported `.avi`, `.m4v`, `.mpeg`
 * or `.3gp` was greyed out in the file dialog and could not be selected at all
 * — while dragging the same file in worked, because a drop bypasses `accept`.
 * "I can't upload my video" with nothing whatsoever in the server logs is what
 * that looks like from the outside.
 *
 * A subset is not a safe default here: `accept` is the only thing standing
 * between a user and their own file, and narrowing it silently removes
 * capability the product already paid to support. So both sides read this
 * module, and `media-formats.test.ts` pins extensions and MIME types to each
 * other so a future addition to one cannot quietly skip the other.
 *
 * The declared type is still only ever a *claim* (THREAT-MODEL **T7**): the
 * probe worker (A07) reads the real container and rewrites `mime`. This list
 * exists to reject the obvious before a gigabyte moves, and to tell the file
 * picker what to offer.
 */

/** Media types an upload may declare. */
export const ALLOWED_MEDIA_MIME_TYPES: readonly string[] = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "video/mpeg",
  "video/3gpp",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/vnd.wave",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/x-flac",
  "audio/webm",
];

/** Extensions that may appear in a raw key, paired with the list above. */
export const ALLOWED_MEDIA_EXTENSIONS: readonly string[] = [
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "mpg",
  "mpeg",
  "3gp",
  "mp3",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
  "weba",
];

/** Extension used when a filename has none we recognise but the MIME is allowed. */
export const MIME_FALLBACK_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
  "video/mpeg": "mpg",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "weba",
};

/**
 * The `accept` attribute for a media `<input type="file">`.
 *
 * Both extensions **and** MIME types, because neither alone is enough on every
 * platform: Windows resolves a file's type through a registry association that
 * is frequently missing or wrong for `.mkv`/`.m4v` (so the MIME half can be
 * blank), while some pickers match only on type. Listing both means a file is
 * selectable if *either* signal is recognised. Extension matching is
 * ASCII-case-insensitive per the HTML spec, so `IMG_8508.MOV` matches `.mov`.
 */
export const MEDIA_ACCEPT_ATTRIBUTE: string = [
  ...ALLOWED_MEDIA_EXTENSIONS.map((extension) => `.${extension}`),
  ...ALLOWED_MEDIA_MIME_TYPES,
].join(",");

/** The extension of `filename`, lower-cased and without its dot, or `undefined`. */
export function mediaExtensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Whether the browser should let this file into the upload funnel at all.
 *
 * Mirrors the API's own `assertAllowedType`, including its allowance for a
 * browser that could not guess a type: an empty or `application/octet-stream`
 * MIME is accepted when the extension is one we know. Keep the two in step —
 * refusing here something the API would have accepted is the exact failure
 * this module exists to prevent.
 */
export function isAllowedMediaFile(filename: string, mime: string): boolean {
  if (ALLOWED_MEDIA_MIME_TYPES.includes(mime)) return true;
  // Exactly the API's own allowance and no wider: a generic or absent type from
  // a browser that could not guess passes on the strength of a known extension;
  // anything else is refused. Being more permissive here would only trade a
  // clear message now for a 415 after the whole file has been hashed.
  const extension = mediaExtensionOf(filename);
  const knownExtension = extension !== undefined && ALLOWED_MEDIA_EXTENSIONS.includes(extension);
  return (mime === "" || mime === "application/octet-stream") && knownExtension;
}

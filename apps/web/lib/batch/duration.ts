/**
 * A file's playable duration, read client-side before anything uploads, so
 * the batch "Apply to all" sheet can quote credits up front (B15 brief §4)
 * without waiting on `media.probe`.
 *
 * A hidden `<video>` (also decodes audio-only files fine — a bare `<audio>`
 * element would need a second code path for no benefit) loads just its
 * metadata; `preload="metadata"` keeps this to a byte-range fetch of the
 * container header, not the whole file.
 */
export function readFileDurationMs(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement("video");
    element.preload = "metadata";
    element.src = url;

    const cleanup = (): void => {
      URL.revokeObjectURL(url);
      element.removeAttribute("src");
      element.load();
    };

    element.onloadedmetadata = (): void => {
      const ms = Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : 0;
      cleanup();
      resolve(ms);
    };
    element.onerror = (): void => {
      cleanup();
      resolve(0);
    };
  });
}

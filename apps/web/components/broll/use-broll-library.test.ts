import { describe, expect, it } from "vitest";

import {
  BROLL_MAX_BYTES,
  brollFileProblem,
  brollImagesOf,
  overlayImageOfPicture,
  parseTags,
  shrinkForUpload,
  tagsFromFileName,
  type BrollPicture,
} from "./use-broll-library";

const PICTURE: BrollPicture = {
  assetId: "01JPX0000000000000000000T1",
  format: "jpeg",
  contentType: "image/jpeg",
  width: 1440,
  height: 2560,
  sizeBytes: 400_000,
  tags: ["taj mahal"],
  title: null,
  source: "upload",
  credit: null,
  url: "https://cdn.test/broll/taj.jpg",
  createdAt: "2026-10-05T09:00:00.000Z",
};

describe("the B-roll library's helpers (2026-10-05)", () => {
  it("reads tags as a person types them: trimmed, lower case, once each, at most ten", () => {
    expect(parseTags(" Taj Mahal, taj mahal ,, Agra\nYamuna  River ")).toEqual([
      "taj mahal",
      "agra",
      "yamuna river",
    ]);
    expect(
      parseTags(Array.from({ length: 14 }, (_, index) => `t${String(index)}`).join(",")),
    ).toHaveLength(10);
    expect(parseTags("x".repeat(60))).toEqual(["x".repeat(40)]);
  });

  it("takes a first tag from a file's name, but not from a camera's", () => {
    expect(tagsFromFileName("taj-mahal_sunrise.jpg")).toEqual(["taj mahal sunrise"]);
    expect(tagsFromFileName("Masala Chai 2.png")).toEqual(["masala chai"]);
    expect(tagsFromFileName("IMG_2031.jpg")).toEqual([]);
    expect(tagsFromFileName("PXL_20260101_101010.jpg")).toEqual([]);
    expect(tagsFromFileName("12345.jpg")).toEqual([]);
  });

  it("refuses a file that is not a picture, or is empty", () => {
    expect(brollFileProblem({ type: "image/jpeg", size: 10 })).toBeNull();
    expect(brollFileProblem({ type: "image/gif", size: 10 })).toMatch("JPEG, PNG or WebP");
    expect(brollFileProblem({ type: "image/png", size: 0 })).toBe("That file is empty.");
  });

  it("names every picture for a renderer, and as an overlay draws it", () => {
    expect(brollImagesOf(null)).toEqual({});
    expect(
      brollImagesOf({
        items: [PICTURE],
        stock: { enabled: false, provider: null },
        limits: {} as never,
      }),
    ).toEqual({ [PICTURE.assetId]: PICTURE.url });
    expect(overlayImageOfPicture(PICTURE)).toEqual({
      assetId: PICTURE.assetId,
      format: "jpeg",
      width: 1440,
      height: 2560,
    });
  });

  it("sends a picture as it is where the browser cannot decode it here", async () => {
    const file = new File([new Uint8Array(16)], "chai.png", { type: "image/png" });
    const shrunk = await shrinkForUpload(file);
    expect(shrunk).toEqual({ body: file, contentType: "image/png" });
    expect(BROLL_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

import { describe, expect, it } from "vitest";

import * as web from "./formats";
import * as contracts from "../../../../packages/repurpose-contracts/src/formats";


describe("the run page's copy of the formats", () => {
  it("is the contracts package's list, word for word", () => {
    expect(web.VIDEO_SHAPES).toEqual(contracts.VIDEO_SHAPES);
    expect(web.VIDEO_SHAPE_SIZE).toEqual(contracts.VIDEO_SHAPE_SIZE);
    expect(web.IMAGE_FILES).toEqual(contracts.IMAGE_FILES);
    expect(web.PLATFORMS).toEqual(contracts.PLATFORMS);
    expect(web.FORMAT_TARGETS).toEqual(contracts.FORMAT_TARGETS);
  });
});

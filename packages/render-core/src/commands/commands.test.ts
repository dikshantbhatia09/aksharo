import { describe, expect, it } from "vitest";

import {
  blur,
  clip,
  clipRect,
  fill,
  group,
  IDENTITY_MATRIX,
  image,
  inflate,
  linearGradient,
  radialGradient,
  rect,
  rectHeight,
  rectWidth,
  roundRect,
  scaleTranslateMatrix,
  shadow,
  solid,
  stroke,
  text,
  transform,
} from "./build.js";
import { canonicalJson, hashCommands, sha256Hex } from "./hash.js";
import {
  countCommands,
  DRAW_COMMAND_KINDS,
  type DrawCommand,
  type GlyphRun,
  isContainerCommand,
  walkCommands,
} from "./types.js";

const RUN: GlyphRun = {
  fontId: "noto-sans-400",
  fontSizePx: 48,
  glyphs: [34, 55],
  positions: [10, 100, 40, 100],
  clusters: [0, 1],
  text: "AV",
};

describe("command constructors", () => {
  it("canonicalises colours and quantises coordinates", () => {
    const command = rect([0.000_1, 1.000_51, 10, 20], { fill: fill("#FF2E63") });
    expect(command).toEqual({
      kind: "rect",
      rect: [0, 1.001, 10, 20],
      fill: { paint: { type: "solid", color: "#ff2e63ff" } },
    });
  });

  it("omits an opacity of 1 so it never appears in a hash", () => {
    expect(fill("#ffffff", 1)).toEqual({ paint: solid("#ffffff") });
    expect(fill("#ffffff", 0.5)).toEqual({ paint: solid("#ffffff"), opacity: 0.5 });
    expect(group([], "g", 1)).toEqual({ kind: "group", id: "g", children: [] });
  });

  it("builds every command kind in the union", () => {
    const commands: DrawCommand[] = [
      text(RUN, { fill: fill("#ffffff"), stroke: stroke("#000000", 4) }),
      rect([0, 0, 1, 1], {}),
      roundRect([0, 0, 10, 10], 2, 2, { fill: fill("#000000") }),
      { kind: "path", d: "M0 0L1 1Z", fill: fill("#ffffff") },
      image("watermark", [0, 0, 10, 10], 0.5),
      group([], "g"),
      transform(IDENTITY_MATRIX, []),
      clip({ type: "path", d: "M0 0Z" }, []),
      shadow({ dx: 1, dy: 2, sigma: 3, color: "#000000" }, []),
      blur({ sigmaX: 1, sigmaY: 1 }, []),
    ];
    expect(commands.map((command) => command.kind).sort()).toEqual([...DRAW_COMMAND_KINDS].sort());
  });

  it("marks a backdrop blur and keeps its bounds", () => {
    expect(blur({ sigmaX: 2, sigmaY: 2, backdrop: true, bounds: [0, 0, 4, 4] }, [])).toMatchObject({
      backdrop: true,
      bounds: [0, 0, 4, 4],
    });
  });

  it("builds gradients with normalised stops", () => {
    expect(linearGradient([0, 0], [10, 0], [{ offset: 0, color: "#FFF000" }])).toEqual({
      type: "linear-gradient",
      from: [0, 0],
      to: [10, 0],
      stops: [{ offset: 0, color: "#fff000ff" }],
    });
    expect(radialGradient([5, 5], 4, [{ offset: 1, color: "#000000" }]).type).toBe(
      "radial-gradient",
    );
  });

  it("scales about a centre without moving it", () => {
    const [scaleX, , , scaleY, dx, dy] = scaleTranslateMatrix(2, 100, 50);
    expect([scaleX, scaleY]).toEqual([2, 2]);
    // (100, 50) maps to itself: x' = 2·100 + (100 − 2·100) = 100.
    expect(2 * 100 + dx).toBe(100);
    expect(2 * 50 + dy).toBe(50);
  });

  it("adds a translation on top of the scale", () => {
    const matrix = scaleTranslateMatrix(1, 0, 0, 7, -3);
    expect(matrix).toEqual([1, 0, 0, 1, 7, -3]);
  });

  it("measures and inflates rectangles", () => {
    expect(rectWidth([2, 0, 12, 0])).toBe(10);
    expect(rectHeight([0, 2, 0, 12])).toBe(10);
    expect(inflate([10, 10, 20, 20], 5)).toEqual([5, 5, 25, 25]);
  });

  it("clips to a rectangle with anti-aliasing on by default", () => {
    expect(clipRect([0, 0, 5, 5], [])).toEqual({
      kind: "clip",
      shape: { type: "rect", rect: [0, 0, 5, 5] },
      antiAlias: true,
      children: [],
    });
  });
});

describe("walking a command tree", () => {
  const tree: DrawCommand[] = [
    group([transform(IDENTITY_MATRIX, [rect([0, 0, 1, 1], {})]), rect([0, 0, 2, 2], {})], "outer"),
    text(RUN, {}),
  ];

  it("yields containers before their children", () => {
    expect([...walkCommands(tree)].map((command) => command.kind)).toEqual([
      "group",
      "transform",
      "rect",
      "rect",
      "text",
    ]);
  });

  it("counts nested commands", () => {
    expect(countCommands(tree)).toBe(5);
  });

  it("knows which kinds nest", () => {
    expect(isContainerCommand(group([]))).toBe(true);
    expect(isContainerCommand(text(RUN, {}))).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("sorts keys so insertion order cannot change a hash", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("drops undefined values", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("keeps array order, which is draw order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("writes non-finite numbers as null rather than crashing", () => {
    expect(canonicalJson(Number.NaN)).toBe("null");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(() => 1)).toBe("null");
  });

  it("handles the scalar cases", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("sha256Hex", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("survives a message longer than one block and a multi-byte one", () => {
    expect(sha256Hex("a".repeat(1000))).toHaveLength(64);
    expect(sha256Hex("हिंदी")).toHaveLength(64);
    expect(sha256Hex("a".repeat(55))).not.toBe(sha256Hex("a".repeat(56)));
  });
});

describe("hashCommands", () => {
  it("is stable across key order and unstable across content", () => {
    const a = hashCommands([rect([0, 0, 1, 1], { fill: fill("#ffffff") })]);
    const b = hashCommands([
      { rect: [0, 0, 1, 1], fill: { paint: solid("#ffffff") }, kind: "rect" },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(hashCommands([rect([0, 0, 1, 2], { fill: fill("#ffffff") })]));
  });
});

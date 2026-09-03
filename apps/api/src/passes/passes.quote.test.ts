import { describe, expect, it } from "vitest";

import { BURN_RATES } from "@montaj/config";

import {
  quoteAutocut,
  quoteMusic,
  quoteReframeZoom,
  quoteSfx,
  quoteTextFx,
} from "./passes.quote.js";

describe("the autocut pass quote", () => {
  it("charges the CONTRACTS §4 rate from packages/config, not a number of its own", () => {
    expect(BURN_RATES.autocutPass.ratePerUnitTenths).toBe(10);
    expect(BURN_RATES.autocutPass.basis).toBe("sourceMinute");
    // One minute at the flash rate (1 credit/minute).
    expect(quoteAutocut(60_000).tenths).toBe(10);
  });

  it("rounds source time up to the 0.1-minute billing quantum", () => {
    expect(quoteAutocut(6_100).deciMinutes).toBe(2);
    expect(quoteAutocut(12_000).deciMinutes).toBe(2);
    expect(quoteAutocut(1).deciMinutes).toBe(1);
  });

  it("never quotes zero for media that exists", () => {
    expect(quoteAutocut(1).tenths).toBeGreaterThan(0);
  });

  it("quotes a 90-second recording at 1.5 credits (flash)", () => {
    const quote = quoteAutocut(90_000);
    expect(quote.tenths).toBe(15);
    expect(quote.credits).toBe("1.5");
  });

  it("explains itself in the hold's audit trail", () => {
    expect(quoteAutocut(90_000).reason).toBe("ai.pass (autocut) · 1.5 source minutes");
  });
});

describe("the zoom/reframe pass quote", () => {
  it("charges the CONTRACTS §4 rate from packages/config, not a number of its own", () => {
    expect(BURN_RATES.reframeZoomPass.ratePerUnitTenths).toBe(10);
    expect(BURN_RATES.reframeZoomPass.basis).toBe("sourceMinute");
    // One minute at the flash rate (1 credit/minute).
    expect(quoteReframeZoom("zoom", 60_000).tenths).toBe(10);
  });

  it("quotes zoom and reframe at the same rate, tagged with the right reason", () => {
    const zoom = quoteReframeZoom("zoom", 90_000);
    const reframe = quoteReframeZoom("reframe", 90_000);
    expect(zoom.tenths).toBe(reframe.tenths);
    expect(zoom.reason).toBe("ai.pass (zoom) · 1.5 source minutes");
    expect(reframe.reason).toBe("ai.pass (reframe) · 1.5 source minutes");
  });

  it("rounds source time up to the 0.1-minute billing quantum", () => {
    expect(quoteReframeZoom("zoom", 6_100).deciMinutes).toBe(2);
    expect(quoteReframeZoom("zoom", 1).deciMinutes).toBe(1);
  });

  it("never quotes zero for media that exists", () => {
    expect(quoteReframeZoom("reframe", 1).tenths).toBeGreaterThan(0);
  });
});

describe("the sfx pass quote (D04a)", () => {
  it("charges the CONTRACTS §4 rate from packages/config, not a number of its own", () => {
    expect(BURN_RATES.sfxMusicPass.ratePerUnitTenths).toBe(10);
    expect(BURN_RATES.sfxMusicPass.basis).toBe("finishedMinute");
    expect(BURN_RATES.sfxMusicPass.minimumPlan).toBe("studio");
    expect(quoteSfx(60_000).tenths).toBe(10);
  });

  it("quotes against the finished (post-cut) timeline, not the source", () => {
    expect(quoteSfx(90_000).reason).toBe("ai.pass (sfx) · 1.5 finished minutes");
  });

  it("rounds finished time up to the 0.1-minute billing quantum", () => {
    expect(quoteSfx(6_100).deciMinutes).toBe(2);
    expect(quoteSfx(1).deciMinutes).toBe(1);
  });

  it("never quotes zero for a finished timeline that exists", () => {
    expect(quoteSfx(1).tenths).toBeGreaterThan(0);
  });
});

describe("the music pass quote (D05)", () => {
  it("shares sfxMusicPass with the sfx quote (finished minutes, Studio+)", () => {
    expect(BURN_RATES.sfxMusicPass.ratePerUnitTenths).toBe(10);
    expect(BURN_RATES.sfxMusicPass.basis).toBe("finishedMinute");
    expect(quoteMusic(60_000).tenths).toBe(10);
  });

  it("quotes against the finished (post-cut) timeline, not the source", () => {
    expect(quoteMusic(90_000).reason).toBe("ai.pass (music) · 1.5 finished minutes");
  });

  it("rounds finished time up to the 0.1-minute billing quantum", () => {
    expect(quoteMusic(6_100).deciMinutes).toBe(2);
    expect(quoteMusic(1).deciMinutes).toBe(1);
  });

  it("never quotes zero for a finished timeline that exists", () => {
    expect(quoteMusic(1).tenths).toBeGreaterThan(0);
  });
});

describe("the text-fx pass quote", () => {
  it("charges the CONTRACTS §4 rate from packages/config, on finished minutes", () => {
    expect(BURN_RATES.textFxPass.ratePerUnitTenths).toBe(10);
    expect(BURN_RATES.textFxPass.basis).toBe("finishedMinute");
    expect(quoteTextFx(60_000).tenths).toBe(10);
  });

  it("quotes a 90-second finished timeline at 1.5 credits", () => {
    const quote = quoteTextFx(90_000);
    expect(quote.tenths).toBe(15);
    expect(quote.credits).toBe("1.5");
    expect(quote.reason).toBe("ai.pass (textfx) · 1.5 finished minutes");
  });

  it("never quotes zero for a finished timeline that exists", () => {
    expect(quoteTextFx(1).tenths).toBeGreaterThan(0);
  });
});

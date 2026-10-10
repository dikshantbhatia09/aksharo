import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformSocialPack, RepurposeClipCopy } from "@montaj/api-client";
import { toast } from "@montaj/ui";

import { SocialCopyTabs } from "./social-copy-tabs";

const TEST_PACK: PlatformSocialPack = {
  youtube: {
    title: "How We Scaled to $1M ARR #Shorts",
    description: "Detailed breakdown of our bootstrapped SaaS journey.",
    tags: ["Shorts", "SaaS", "Startups"],
  },
  instagram: {
    caption: "Stop doing this in 2026 🛑\n\nSave this breakdown for your next launch.",
    callToAction: "Save this reel for later",
    hashtags: ["#startups", "#saas", "#tech"],
  },
  tiktok: {
    caption: "the brutal truth about startups #fyp #techtok",
    hashtags: ["#fyp", "#techtok"],
  },
  linkedin: {
    postText: "A critical shift in B2B SaaS architecture:\n\n1. The Problem\n2. The Solution",
    hashtags: ["#leadership", "#technology"],
  },
  twitter: {
    tweetText: "Most founders get customer acquisition wrong. Here is the contrarian truth:",
  },
};

const TEST_COPY: RepurposeClipCopy = {
  summary: "A powerful breakdown on scaling companies efficiently.",
  hook: "Stop making this blunder",
  cta: "Follow for daily insights",
  hashtags: ["#startups", "#growth", "#saas"],
  locale: "en",
  title: "Scaling companies efficiently",
  socialPack: TEST_PACK,
};

describe("SocialCopyTabs Component (Pillar 7 §02)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders all 5 destination platform tabs", () => {
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    expect(screen.getByTestId("social-copy-tabs")).toBeDefined();
    expect(screen.getByTestId("tab-youtube")).toBeDefined();
    expect(screen.getByTestId("tab-instagram")).toBeDefined();
    expect(screen.getByTestId("tab-tiktok")).toBeDefined();
    expect(screen.getByTestId("tab-linkedin")).toBeDefined();
    expect(screen.getByTestId("tab-x")).toBeDefined();
  });

  it("displays YouTube Shorts copy by default with < 70 chars title compliance", () => {
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    expect(screen.getByTestId("platform-panel-youtube")).toBeDefined();
    expect(screen.getByText("How We Scaled to $1M ARR #Shorts")).toBeDefined();
    expect(screen.getByTestId("yt-title-limit-badge")).toHaveTextContent("32/70 chars");
    expect(screen.getByText("#Shorts ✓")).toBeDefined();
    expect(screen.getByText("Detailed breakdown of our bootstrapped SaaS journey.")).toBeDefined();
  });

  it("switches to Instagram Reels tab when clicked", () => {
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    fireEvent.click(screen.getByTestId("tab-instagram"));

    expect(screen.getByTestId("platform-panel-instagram")).toBeDefined();
    expect(screen.getByText(/Stop doing this in 2026/)).toBeDefined();
    expect(screen.getByText(/Save this reel for later/)).toBeDefined();
    expect(screen.getByText("#startups")).toBeDefined();
  });

  it("switches to TikTok tab when clicked", () => {
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    fireEvent.click(screen.getByTestId("tab-tiktok"));

    expect(screen.getByTestId("platform-panel-tiktok")).toBeDefined();
    expect(screen.getByText(/the brutal truth about startups/)).toBeDefined();
  });

  it("switches to LinkedIn tab when clicked", () => {
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    fireEvent.click(screen.getByTestId("tab-linkedin"));

    expect(screen.getByTestId("platform-panel-linkedin")).toBeDefined();
    expect(screen.getByText(/A critical shift in B2B SaaS architecture/)).toBeDefined();
  });

  it("switches to X (Twitter) tab and verifies < 280 chars limit compliance", () => {
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    fireEvent.click(screen.getByTestId("tab-x"));

    expect(screen.getByTestId("platform-panel-x")).toBeDefined();
    expect(screen.getByText(/Most founders get customer acquisition wrong/)).toBeDefined();
    expect(screen.getByTestId("x-tweet-limit-badge")).toHaveTextContent("75/280 chars");
  });

  it("copies 1-click YouTube title and fires success toast confirmation", async () => {
    const successSpy = vi.spyOn(toast, "success");
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    const copyBtn = screen.getByTestId("copy-yt-title");
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("How We Scaled to $1M ARR #Shorts");
    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledWith("Copied YouTube title to clipboard");
    });
  });

  it("copies active platform full pack using header button", async () => {
    const successSpy = vi.spyOn(toast, "success");
    render(<SocialCopyTabs socialPack={TEST_PACK} />);

    const copyActiveBtn = screen.getByTestId("copy-active-platform-btn");
    fireEvent.click(copyActiveBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledWith("Copied YouTube Shorts pack to clipboard");
    });
  });

  it("automatically derives PlatformSocialPack from RepurposeClipCopy when socialPack is not provided", () => {
    const legacyCopy: RepurposeClipCopy = {
      summary: "Legacy summary blurb.",
      hook: "Killer opening hook",
      cta: "Save this post",
      hashtags: ["#marketing", "#sales"],
      locale: "en",
      title: "How to sell more software online",
    };

    render(<SocialCopyTabs copy={legacyCopy} />);

    expect(screen.getByTestId("platform-panel-youtube")).toBeDefined();
    expect(screen.getAllByText(/#Shorts/).length).toBeGreaterThanOrEqual(1);
  });
});

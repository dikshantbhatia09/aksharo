import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  SUBTITLE_TRANSLATION_LANGUAGES,
  SubtitleLanguageModal,
} from "./subtitle-language-modal";

describe("SubtitleLanguageModal Component (Pillar 4 §09, Step 3)", () => {
  it("renders 50+ languages catalog with SLA indicator and default selection", () => {
    const onTranslate = vi.fn();
    const onOpenChange = vi.fn();

    expect(SUBTITLE_TRANSLATION_LANGUAGES.length).toBeGreaterThanOrEqual(50);

    render(
      <SubtitleLanguageModal
        open={true}
        onOpenChange={onOpenChange}
        onTranslate={onTranslate}
        initialLanguage="en"
      />,
    );

    expect(screen.getByTestId("subtitle-language-modal")).toBeDefined();
    expect(screen.getByText("1-Click Subtitle Translation")).toBeDefined();
    expect(screen.getByText(/Neural Cross-Lingual Sync/i)).toBeDefined();
    expect(screen.getByText(/Latency ≤ 2.5s \/ 60s/i)).toBeDefined();

    // Verify option for English
    const enOption = screen.getByTestId("lang-option-en");
    expect(enOption).toBeDefined();
  });

  it("filters language list in real-time when searching", () => {
    const onTranslate = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <SubtitleLanguageModal
        open={true}
        onOpenChange={onOpenChange}
        onTranslate={onTranslate}
      />,
    );

    const searchInput = screen.getByTestId("language-search-input");
    fireEvent.change(searchInput, { target: { value: "Spanish" } });

    // Spanish option should be present
    expect(screen.getByTestId("lang-option-es")).toBeDefined();
    // German option should be filtered out
    expect(screen.queryByTestId("lang-option-de")).toBeNull();
  });

  it("allows switching presentation mode between Replace and Bilingual Stacked", () => {
    const onTranslate = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <SubtitleLanguageModal
        open={true}
        onOpenChange={onOpenChange}
        onTranslate={onTranslate}
        initialLanguage="hi"
        initialMode="replace"
      />,
    );

    const bilingualButton = screen.getByTestId("mode-bilingual");
    fireEvent.click(bilingualButton);

    const confirmButton = screen.getByTestId("translate-confirm-button");
    fireEvent.click(confirmButton);

    expect(onTranslate).toHaveBeenCalledWith({
      targetLanguage: "hi",
      mode: "bilingual",
      languageName: "Hindi",
    });
  });

  it("selects a different language and triggers translation callback with correct arguments", () => {
    const onTranslate = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <SubtitleLanguageModal
        open={true}
        onOpenChange={onOpenChange}
        onTranslate={onTranslate}
        initialLanguage="en"
      />,
    );

    // Select Japanese
    const jaOption = screen.getByTestId("lang-option-ja");
    fireEvent.click(jaOption);

    const confirmButton = screen.getByTestId("translate-confirm-button");
    fireEvent.click(confirmButton);

    expect(onTranslate).toHaveBeenCalledWith({
      targetLanguage: "ja",
      mode: "replace",
      languageName: "Japanese",
    });
  });
});


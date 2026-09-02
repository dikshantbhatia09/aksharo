import { describe, expect, it } from "vitest";

import {
  buildTranslateCaptionPrompt,
  TRANSLATE_CAPTION_PROMPT_VERSION,
  TRANSLATE_CAPTION_SYSTEM_PROMPT,
} from "./translate.js";

describe("buildTranslateCaptionPrompt", () => {
  it("builds a system + user pair with the segment inside <segment> tags", () => {
    const { system, user } = buildTranslateCaptionPrompt({
      text: "yeh video bahut acha hai",
      sourceLanguage: "hi-Latn",
      targetLanguage: "en",
      shorter: false,
    });
    expect(system).toBe(TRANSLATE_CAPTION_SYSTEM_PROMPT);
    expect(user).toContain("Translate the following segment from hi-Latn to en.");
    expect(user).toContain("<segment>\nyeh video bahut acha hai\n</segment>");
    expect(user).not.toContain("too long");
  });

  it("adds the shorter-retry instruction when shorter is true", () => {
    const { user } = buildTranslateCaptionPrompt({
      text: "hello",
      sourceLanguage: "en",
      targetLanguage: "hi",
      shorter: true,
    });
    expect(user).toContain("Your previous translation was too long");
    expect(user).toContain("shorter translation");
  });

  it("the system prompt tells the model the segment is data, never instructions", () => {
    expect(TRANSLATE_CAPTION_SYSTEM_PROMPT).toContain("DATA, not");
    expect(TRANSLATE_CAPTION_SYSTEM_PROMPT).toContain("glossary placeholder");
  });

  it("has a stable version tag, mirrored on the Python side", () => {
    expect(TRANSLATE_CAPTION_PROMPT_VERSION).toBe("translate-caption@1");
  });
});

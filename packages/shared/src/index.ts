/**
 * @montaj/shared — Canonical types, DTOs, and schemas for the Kalakar platform.
 */

export type PlanTier = "FREE" | "CREATOR" | "STUDIO";

export interface UserQuota {
  storageUsedBytes: bigint | number;
  storageLimitBytes: bigint | number;
  transcriptionSecondsRemaining: number;
  transcriptionLimitSec: number;
  audioCleanCreditsRemaining: number;
  audioCleanCreditsLimit: number;
  planTier: PlanTier;
}

export type ProjectStatus = "DRAFT" | "UPLOADING" | "PROCESSING" | "READY" | "FAILED" | "EXPORTING";

export interface CaptionWord {
  id: string;
  text: string;
  cleanText: string;
  startMs: number;
  endMs: number;
  confidence: number;
  isEmphasized: boolean;
  customColorHex?: string;
  emoji?: {
    char: string;
    position: "before" | "after";
  };
}

export interface CaptionLine {
  id: string;
  lineIndex: number;
  startMs: number;
  endMs: number;
  speakerTag?: string;
  words: CaptionWord[];
}

export interface CaptionToolsConfig {
  displaySettings: {
    wordsPerCard: "default" | "few" | "many";
    maxCharsPerLine: number;
    linesPerCard: 1 | 2;
  };
  actions: {
    removePunctuation: boolean;
    removeEmphasis: boolean;
    removeGapsInCaptions: boolean;
    removeEmojis: boolean;
  };
  timing: {
    captionDelayMs: number;
  };
}

export const SUPPORTED_LANGUAGES = [
  { code: "auto", label: "Auto-Detect", scriptLocked: false },
  { code: "en", label: "English", scriptLocked: false },
  { code: "hi", label: "Hindi", scriptLocked: false },
  { code: "hinglish", label: "Hinglish", scriptLocked: true, script: "latin" },
  { code: "mr", label: "Marathi", scriptLocked: false },
  { code: "gu", label: "Gujarati", scriptLocked: false },
  { code: "pa", label: "Punjabi", scriptLocked: false },
  { code: "bn", label: "Bengali", scriptLocked: false },
  { code: "ta", label: "Tamil", scriptLocked: false },
  { code: "te", label: "Telugu", scriptLocked: false },
  { code: "kn", label: "Kannada", scriptLocked: false },
  { code: "ml", label: "Malayalam", scriptLocked: false },
] as const;

export const SUPPORTED_SCRIPTS = [
  { code: "latin", label: "Latin / English Alphabet" },
  { code: "native", label: "Native Script (Devanagari, etc.)" },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];
export type SupportedScriptCode = (typeof SUPPORTED_SCRIPTS)[number]["code"];

export function isHinglish(languageCode: string | undefined): boolean {
  if (!languageCode) return false;
  const normalized = languageCode.toLowerCase().trim();
  return normalized === "hinglish" || normalized === "hi-latn" || normalized === "hin-latn";
}

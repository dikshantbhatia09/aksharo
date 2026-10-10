"use client";

/**
 * Subtitle Language Modal & Cross-Lingual Translation Selector (Pillar 4 §09).
 *
 * Implements:
 * 1. 50+ target language selector with live search and category filters
 *    (Popular, Indian / Regional, European, Asian & Middle-Eastern).
 * 2. Display mode selection:
 *    - Mode 1: Replace original subtitles with translated kinetic text.
 *    - Mode 2: Show bilingual stacked subtitles (Native muted on top, translated neon on bottom).
 * 3. SLA indicator (latency <= 2.5s, speech onset alignment within +-50ms).
 */

import {
  Check,
  Globe,
  Languages,
  Loader2,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import * as React from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@montaj/ui";

import { cn } from "@/lib/utils";

export type SubtitleTranslationMode = "replace" | "bilingual";

export interface SubtitleTranslationLanguage {
  readonly code: string;
  readonly label: string;
  readonly nativeLabel: string;
  readonly category: "popular" | "indian" | "european" | "asian" | "middle-eastern" | "other";
}

export const SUBTITLE_TRANSLATION_LANGUAGES: readonly SubtitleTranslationLanguage[] = [
  // Popular / Global
  { code: "en", label: "English", nativeLabel: "English", category: "popular" },
  { code: "es", label: "Spanish", nativeLabel: "Español", category: "popular" },
  { code: "fr", label: "French", nativeLabel: "Français", category: "popular" },
  { code: "de", label: "German", nativeLabel: "Deutsch", category: "popular" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語", category: "popular" },
  { code: "ko", label: "Korean", nativeLabel: "한국어", category: "popular" },
  { code: "zh", label: "Chinese (Simplified)", nativeLabel: "简体中文", category: "popular" },
  { code: "zh-TW", label: "Chinese (Traditional)", nativeLabel: "繁體中文", category: "popular" },
  { code: "pt", label: "Portuguese", nativeLabel: "Português", category: "popular" },
  { code: "ru", label: "Russian", nativeLabel: "Русский", category: "popular" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", category: "popular" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी", category: "popular" },

  // Indian Languages (22 Scheduled & Popular)
  { code: "ta", label: "Tamil", nativeLabel: "தமிழ்", category: "indian" },
  { code: "te", label: "Telugu", nativeLabel: "తెలుగు", category: "indian" },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা", category: "indian" },
  { code: "mr", label: "Marathi", nativeLabel: "मराठी", category: "indian" },
  { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી", category: "indian" },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ", category: "indian" },
  { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം", category: "indian" },
  { code: "pa", label: "Punjabi", nativeLabel: "ਪੰਜਾਬੀ", category: "indian" },
  { code: "or", label: "Odia", nativeLabel: "ଓଡ଼ିଆ", category: "indian" },
  { code: "as", label: "Assamese", nativeLabel: "অসমীয়া", category: "indian" },
  { code: "ur", label: "Urdu", nativeLabel: "اردو", category: "indian" },
  { code: "sa", label: "Sanskrit", nativeLabel: "संस्कृतम्", category: "indian" },
  { code: "ne", label: "Nepali", nativeLabel: "नेपाली", category: "indian" },
  { code: "sd", label: "Sindhi", nativeLabel: "سنڌي", category: "indian" },
  { code: "ks", label: "Kashmiri", nativeLabel: "کٲشُر", category: "indian" },
  { code: "kok", label: "Konkani", nativeLabel: "कोंकणी", category: "indian" },
  { code: "mai", label: "Maithili", nativeLabel: "मैथिली", category: "indian" },
  { code: "mni", label: "Manipuri", nativeLabel: "মণিপুরী", category: "indian" },
  { code: "sat", label: "Santali", nativeLabel: "ᱥᱟᱱᱛᱟᱲᱤ", category: "indian" },
  { code: "brx", label: "Bodo", nativeLabel: "बर'", category: "indian" },
  { code: "doi", label: "Dogri", nativeLabel: "डोगरी", category: "indian" },

  // European Languages
  { code: "it", label: "Italian", nativeLabel: "Italiano", category: "european" },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands", category: "european" },
  { code: "pl", label: "Polish", nativeLabel: "Polski", category: "european" },
  { code: "sv", label: "Swedish", nativeLabel: "Svenska", category: "european" },
  { code: "uk", label: "Ukrainian", nativeLabel: "Українська", category: "european" },
  { code: "el", label: "Greek", nativeLabel: "Ελληνικά", category: "european" },
  { code: "cs", label: "Czech", nativeLabel: "Čeština", category: "european" },
  { code: "da", label: "Danish", nativeLabel: "Dansk", category: "european" },
  { code: "fi", label: "Finnish", nativeLabel: "Suomi", category: "european" },
  { code: "ro", label: "Romanian", nativeLabel: "Română", category: "european" },
  { code: "hu", label: "Hungarian", nativeLabel: "Magyar", category: "european" },
  { code: "no", label: "Norwegian", nativeLabel: "Norsk", category: "european" },
  { code: "sk", label: "Slovak", nativeLabel: "Slovenčina", category: "european" },
  { code: "bg", label: "Bulgarian", nativeLabel: "Български", category: "european" },
  { code: "hr", label: "Croatian", nativeLabel: "Hrvatski", category: "european" },
  { code: "sr", label: "Serbian", nativeLabel: "Srpski", category: "european" },
  { code: "lt", label: "Lithuanian", nativeLabel: "Lietuvių", category: "european" },
  { code: "sl", label: "Slovenian", nativeLabel: "Slovenščina", category: "european" },
  { code: "et", label: "Estonian", nativeLabel: "Eesti", category: "european" },
  { code: "lv", label: "Latvian", nativeLabel: "Latviešu", category: "european" },

  // Asian & Middle-Eastern Languages
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe", category: "middle-eastern" },
  { code: "he", label: "Hebrew", nativeLabel: "עברית", category: "middle-eastern" },
  { code: "fa", label: "Persian (Farsi)", nativeLabel: "فارسی", category: "middle-eastern" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt", category: "asian" },
  { code: "th", label: "Thai", nativeLabel: "ไทย", category: "asian" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia", category: "asian" },
  { code: "ms", label: "Malay", nativeLabel: "Bahasa Melayu", category: "asian" },
  { code: "tl", label: "Filipino (Tagalog)", nativeLabel: "Tagalog", category: "asian" },
  { code: "sw", label: "Swahili", nativeLabel: "Kiswahili", category: "other" },
];

export interface SubtitleLanguageModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onTranslate: (options: {
    targetLanguage: string;
    mode: SubtitleTranslationMode;
    languageName: string;
  }) => Promise<void> | void;
  readonly initialLanguage?: string;
  readonly initialMode?: SubtitleTranslationMode;
  readonly isTranslating?: boolean;
}

export function SubtitleLanguageModal({
  open,
  onOpenChange,
  onTranslate,
  initialLanguage = "en",
  initialMode = "replace",
  isTranslating = false,
}: SubtitleLanguageModalProps): React.JSX.Element {
  const [search, setSearch] = React.useState("");
  const [selectedLanguage, setSelectedLanguage] = React.useState<string>(initialLanguage);
  const [mode, setMode] = React.useState<SubtitleTranslationMode>(initialMode);
  const [category, setCategory] = React.useState<string>("all");

  React.useEffect(() => {
    if (open) {
      setSelectedLanguage(initialLanguage);
      setMode(initialMode);
      setSearch("");
    }
  }, [open, initialLanguage, initialMode]);

  const filteredLanguages = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return SUBTITLE_TRANSLATION_LANGUAGES.filter((item) => {
      const matchesCategory =
        category === "all" ||
        item.category === category ||
        (category === "popular" && item.category === "popular");

      if (!matchesCategory) return false;
      if (!q) return true;

      return (
        item.code.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.nativeLabel.toLowerCase().includes(q)
      );
    });
  }, [search, category]);

  const selectedItem = SUBTITLE_TRANSLATION_LANGUAGES.find(
    (item) => item.code === selectedLanguage,
  );

  const handleConfirm = async (): Promise<void> => {
    if (!selectedLanguage) return;
    await onTranslate({
      targetLanguage: selectedLanguage,
      mode,
      languageName: selectedItem?.label ?? selectedLanguage,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="subtitle-language-modal"
        className="max-w-2xl bg-bg-card p-6 border-border shadow-2xl"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Languages className="h-5 w-5" />
            </span>
            <div>
              <DialogTitle className="text-lg font-bold text-fg-default">
                1-Click Subtitle Translation
              </DialogTitle>
              <DialogDescription className="text-xs text-fg-subtle">
                Translate caption subtitles into 50+ languages with synchronized word timings.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Display Mode Selection: Replace vs Bilingual Stacked */}
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-bg-subtle p-3.5">
          <label className="text-xs font-semibold text-fg-default">
            Subtitle Presentation Mode
          </label>
          <div className="grid grid-cols-2 gap-3">
            {/* Mode 1: Replace */}
            <button
              type="button"
              data-testid="mode-replace"
              onClick={() => setMode("replace")}
              className={cn(
                "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all",
                mode === "replace"
                  ? "border-primary bg-primary/10 text-primary ring-1 ring-primary"
                  : "border-border/60 bg-bg-card text-fg-subtle hover:border-border hover:bg-bg-subtle",
              )}
            >
              <div className="flex items-center justify-between w-full">
                <span className="text-xs font-semibold text-fg-default">Replace Original</span>
                {mode === "replace" && <Check className="h-3.5 w-3.5 text-primary" />}
              </div>
              <p className="text-[11px] text-fg-subtle">
                Replaces existing caption track with translated subtitles.
              </p>
            </button>

            {/* Mode 2: Bilingual Stacked */}
            <button
              type="button"
              data-testid="mode-bilingual"
              onClick={() => setMode("bilingual")}
              className={cn(
                "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all",
                mode === "bilingual"
                  ? "border-primary bg-primary/10 text-primary ring-1 ring-primary"
                  : "border-border/60 bg-bg-card text-fg-subtle hover:border-border hover:bg-bg-subtle",
              )}
            >
              <div className="flex items-center justify-between w-full">
                <span className="text-xs font-semibold text-fg-default">
                  Bilingual Stacked (CapCut Style)
                </span>
                {mode === "bilingual" && <Check className="h-3.5 w-3.5 text-primary" />}
              </div>
              <p className="text-[11px] text-fg-subtle">
                Native speech muted on top, translated kinetic bounce on bottom.
              </p>
            </button>
          </div>
        </div>

        {/* Category Tabs & Search Bar */}
        <div className="mt-4 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
              {[
                { id: "all", label: "All (55)" },
                { id: "popular", label: "Popular" },
                { id: "indian", label: "Indian & Regional (20+)" },
                { id: "european", label: "European" },
                { id: "asian", label: "Asian & MENA" },
              ].map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategory(cat.id)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    category === cat.id
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "text-fg-subtle hover:bg-bg-subtle hover:text-fg-default",
                  )}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
            <input
              type="text"
              data-testid="language-search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search language by name or code (e.g. Hindi, Spanish, ja, de)..."
              className="h-9 w-full rounded-lg border border-border bg-bg-card pl-9 pr-3 text-xs text-fg-default placeholder:text-fg-subtle focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        {/* Language Grid */}
        <div
          data-testid="language-grid"
          className="mt-3 max-h-60 overflow-y-auto rounded-lg border border-border bg-bg-subtle/50 p-2.5 grid grid-cols-3 gap-2"
        >
          {filteredLanguages.length === 0 ? (
            <div className="col-span-3 py-6 text-center text-xs text-fg-subtle">
              No matching languages found.
            </div>
          ) : (
            filteredLanguages.map((lang) => {
              const isSelected = selectedLanguage === lang.code;
              return (
                <button
                  key={lang.code}
                  type="button"
                  data-testid={`lang-option-${lang.code}`}
                  onClick={() => setSelectedLanguage(lang.code)}
                  className={cn(
                    "flex flex-col items-start rounded-md border p-2 text-left transition-colors",
                    isSelected
                      ? "border-primary bg-primary/10 text-primary font-semibold ring-1 ring-primary"
                      : "border-border/40 bg-bg-card text-fg-default hover:border-border hover:bg-bg-subtle",
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="text-xs truncate">{lang.label}</span>
                    <span className="text-[10px] uppercase text-fg-subtle font-mono">
                      {lang.code}
                    </span>
                  </div>
                  <span className="text-[11px] text-fg-subtle truncate">{lang.nativeLabel}</span>
                </button>
              );
            })
          )}
        </div>

        {/* Performance & SLA Banner */}
        <div className="mt-4 flex items-center justify-between rounded-lg bg-bg-subtle px-3 py-2 text-[11px] text-fg-subtle border border-border/50">
          <div className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-accent" />
            <span>
              Neural Cross-Lingual Sync &middot; Word onset alignment &plusmn;50ms
            </span>
          </div>
          <span className="font-mono text-[10px] text-fg-muted">
            Latency &le; 2.5s / 60s
          </span>
        </div>

        <DialogFooter className="mt-5 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isTranslating}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="translate-confirm-button"
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={!selectedLanguage || isTranslating}
            className="gap-1.5"
          >
            {isTranslating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Translating...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Translate to {selectedItem?.label ?? "Selected Language"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


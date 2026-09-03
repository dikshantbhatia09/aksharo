"use client";

/**
 * Minimal ICU MessageFormat locale support (B17 brief §3: "Hindi UI strings
 * for the onboarding flow ... with a language switch in the profile menu;
 * English default").
 *
 * There is no i18n framework in the repo yet (checked before adding one) —
 * this is deliberately the smallest thing that is still real ICU: two flat
 * message catalogues and `intl-messageformat` (already pinned in the
 * lockfile for `apps/api`'s notification templates, `notify/templates/render.ts`)
 * to interpolate them, rather than hand-rolled `{placeholder}` substitution.
 * A fuller catalogue covering the rest of the app is future work — this pass
 * covers the surface the brief names: onboarding and the profile menu's
 * language switch.
 *
 * The active locale is `CurrentUser.locale` once loaded (persisted through
 * the existing `PATCH /me`), mirrored into `localStorage` so the switch is
 * instant and survives a reload before `/me` answers again.
 */
import { IntlMessageFormat } from "intl-messageformat";
import * as React from "react";

import en from "@/messages/en.json";
import hi from "@/messages/hi.json";

export type SupportedLocale = "en" | "hi";

const CATALOGUES: Record<SupportedLocale, Record<string, string>> = { en, hi };
const STORAGE_KEY = "aksharo.locale";
const formatCache = new Map<string, IntlMessageFormat>();

export function resolveSupportedLocale(locale: string | undefined): SupportedLocale {
  return locale !== undefined && locale.toLowerCase().startsWith("hi") ? "hi" : "en";
}

function readStoredLocale(): SupportedLocale | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "hi" || raw === "en" ? raw : null;
  } catch {
    return null;
  }
}

interface LocaleContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  profileLocale,
  children,
}: {
  /** `CurrentUser.locale`, once loaded; `undefined` before then or signed out. */
  profileLocale?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [override, setOverride] = React.useState<SupportedLocale | null>(null);

  React.useEffect(() => {
    setOverride(readStoredLocale());
  }, []);

  const locale = override ?? resolveSupportedLocale(profileLocale);

  const setLocale = React.useCallback((next: SupportedLocale) => {
    setOverride(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage disabled — the choice still applies for this session via state.
    }
  }, []);

  const t = React.useCallback(
    (key: string, values?: Record<string, string | number>): string => {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const catalogue = CATALOGUES[locale];
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const pattern = catalogue[key] ?? CATALOGUES.en[key] ?? key;
      const cacheKey = `${locale}:${key}`;
      let formatter = formatCache.get(cacheKey);
      if (formatter === undefined) {
        formatter = new IntlMessageFormat(pattern, locale);
        formatCache.set(cacheKey, formatter);
      }
      const result = formatter.format(values ?? {});
      return typeof result === "string" ? result : key;
    },
    [locale],
  );

  const value = React.useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Falls back to an English-only, no-provider formatter — never throws outside a provider. */
export function useT(): (key: string, values?: Record<string, string | number>) => string {
  const context = React.useContext(LocaleContext);
  if (context !== null) return context.t;
  return (key: string, values?: Record<string, string | number>) => {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const pattern = CATALOGUES.en[key] ?? key;
    try {
      const result = new IntlMessageFormat(pattern, "en").format(values ?? {});
      return typeof result === "string" ? result : key;
    } catch {
      return pattern;
    }
  };
}

export function useLocale(): [SupportedLocale, (locale: SupportedLocale) => void] {
  const context = React.useContext(LocaleContext);
  if (context === null) return ["en", () => undefined];
  return [context.locale, context.setLocale];
}

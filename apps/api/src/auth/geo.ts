import type { IncomingHttpHeaders } from "node:http";

/**
 * Approximate location of the device asking for approval (THREAT-MODEL T3).
 *
 * The approval screen has to say "someone in Pune is asking to sign in on Premiere
 * Pro" for the user to be able to spot a phished device-code flow. There is no
 * geo-IP database in this deployment and no environment variable for one
 * (CONTRACTS section 1 is a frozen list), so the only source is whatever the CDN
 * in front of the API already resolved. When nothing is available the screen says
 * so rather than guessing -- an invented location is worse than none.
 *
 * Adding MaxMind (or the equivalent) is an infrastructure change: see the open
 * question in `apps/api/src/auth/README.md`.
 */
export interface CoarseLocation {
  /** ISO-3166 alpha-2, upper case. */
  readonly country?: string;
  readonly region?: string;
  readonly city?: string;
}

/** Headers the common edges set, most specific first. */
const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "x-geo-country"] as const;
const REGION_HEADERS = ["x-vercel-ip-country-region", "x-geo-region"] as const;
const CITY_HEADERS = ["cf-ipcity", "x-vercel-ip-city", "x-geo-city"] as const;

function firstHeader(headers: IncomingHttpHeaders, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function resolveCoarseLocation(headers: IncomingHttpHeaders): CoarseLocation | undefined {
  const country = firstHeader(headers, COUNTRY_HEADERS);
  const region = firstHeader(headers, REGION_HEADERS);
  const city = firstHeader(headers, CITY_HEADERS);

  // `XX` is Cloudflare's "unknown", and `T1` is its Tor exit marker.
  const normalisedCountry =
    country === undefined || country === "XX" || country === "T1"
      ? undefined
      : country.toUpperCase().slice(0, 2);

  // A region or a city with no country is not something a user can act on, so the
  // whole answer is "unknown" rather than a half-location.
  if (normalisedCountry === undefined) return undefined;

  return {
    country: normalisedCountry,
    ...(region === undefined ? {} : { region: truncate(region) }),
    ...(city === undefined ? {} : { city: truncate(city) }),
  };
}

/** Decode what an edge percent-encoded, and cap what a hostile one could pad. */
function truncate(value: string): string {
  try {
    return decodeURIComponent(value).slice(0, 64);
  } catch {
    return value.slice(0, 64);
  }
}

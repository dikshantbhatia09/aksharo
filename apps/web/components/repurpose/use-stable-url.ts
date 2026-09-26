"use client";

import * as React from "react";

/**
 * How long a URL whose lifetime cannot be read from it is reused: long enough
 * to watch a clip through, short of the hour the API signs clip files for.
 */
export const URL_REUSE_MS = 50 * 60_000;

/**
 * The share of a presigned URL's lifetime it is held for before a fresher copy
 * replaces it. The rest is the margin in which the page's next refresh has to
 * bring that copy: a quarter of an hour on an hour-long clip URL (the list is
 * re-read every ten minutes), and 75 s on a five-minute render-preview URL.
 */
const HOLD_SHARE = 0.75;

/** The object a presigned URL points at: everything before its signature. */
function objectOf(url: string): string {
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * A presigned URL's lifetime, from its own `X-Amz-Expires` (seconds). The API
 * signs different files for very different times — an hour for a clip, five
 * minutes for a render preview's proxy and face track — so a single constant
 * held the short ones for up to 50 minutes after they had stopped working.
 */
export function signedLifetimeMs(url: string): number | undefined {
  const cut = url.indexOf("?");
  if (cut === -1) return undefined;
  const raw = new URLSearchParams(url.slice(cut + 1)).get("X-Amz-Expires");
  const seconds = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

interface Held {
  readonly url: string;
  readonly version: string | undefined;
  /**
   * When this page first saw it. Timed from here rather than from the URL's
   * `X-Amz-Date`, which is the server's clock: a laptop running a few minutes
   * off would otherwise hold a five-minute URL too long, or never at all. The
   * API presigns on every read, so arrival is within a request of signing.
   */
  readonly at: number;
  /** Whether it was recorded while holding; one recorded while not is not held on to. */
  readonly holding: boolean;
}

/** When `held` should give way to a fresher copy of the same object. */
function renewAt(held: Held): number {
  const lifetimeMs = signedLifetimeMs(held.url);
  return lifetimeMs === undefined ? held.at + URL_REUSE_MS : held.at + lifetimeMs * HOLD_SHARE;
}

function sameThing(held: Held, url: string, version: string | undefined): boolean {
  return objectOf(held.url) === objectOf(url) && held.version === version;
}

/**
 * The first presigned URL seen for an object, for as long as it is still good.
 *
 * Every poll of the clips list (and of a render preview) presigns afresh, so the
 * same file arrives under a new URL every few seconds — and a `<video>` whose
 * `src` changes starts over. A preview the person was watching restarted on
 * each poll. This keeps the URL they started with until most of its signed
 * lifetime has passed ({@link HOLD_SHARE}), or until `version` changes: a
 * re-cut overwrites the SAME key, so the object's checksum, not its address,
 * is what says the picture is new.
 *
 * `hold: false` passes every new URL straight through: for a caller with
 * nothing playing yet, where the freshest URL is simply the best one. When it
 * turns true, the URL of that moment is the one held — not an older one seen
 * while nothing was playing, which would start playback closer to its expiry.
 */
export function useStableUrl(
  url: string | undefined,
  version?: string,
  options: { readonly hold?: boolean } = {},
): string | undefined {
  const hold = options.hold ?? true;
  const [held, setHeld] = React.useState<Held>();
  React.useEffect(() => {
    if (url === undefined) return;
    setHeld((current) => {
      if (current !== undefined && current.url === url && current.version === version) {
        // The same URL: keep when it was first seen, which is what it expires by.
        return current.holding === hold ? current : { ...current, holding: hold };
      }
      const keep =
        hold &&
        current !== undefined &&
        current.holding &&
        sameThing(current, url, version) &&
        Date.now() < renewAt(current);
      return keep ? current : { url, version, at: Date.now(), holding: hold };
    });
  }, [url, version, hold]);
  if (url === undefined) return undefined;
  return hold && held !== undefined && held.holding && sameThing(held, url, version)
    ? held.url
    : url;
}

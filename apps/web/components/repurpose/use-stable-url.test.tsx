import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { URL_REUSE_MS, signedLifetimeMs, useStableUrl } from "./use-stable-url";

/**
 * Every poll of the clip list presigns afresh, and a `<video>` whose `src`
 * changes starts over: a preview being watched restarted every few seconds.
 */
const FIRST = "https://media.test/ws/x/master.mp4?X-Amz-Signature=first";
const SECOND = "https://media.test/ws/x/master.mp4?X-Amz-Signature=second";

describe("useStableUrl", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the first URL for the same object when a poll re-signs it", () => {
    const { result, rerender } = renderHook(({ url }) => useStableUrl(url, "sum-1"), {
      initialProps: { url: FIRST },
    });
    expect(result.current).toBe(FIRST);
    rerender({ url: SECOND });
    expect(result.current).toBe(FIRST);
  });

  it("takes the new URL when the picture itself changed (a re-cut, same key)", () => {
    const { result, rerender } = renderHook(({ url, sum }) => useStableUrl(url, sum), {
      initialProps: { url: FIRST, sum: "sum-1" },
    });
    rerender({ url: SECOND, sum: "sum-2" });
    expect(result.current).toBe(SECOND);
  });

  it("takes a fresh URL once the held one nears expiry", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ url }) => useStableUrl(url), {
      initialProps: { url: FIRST },
    });
    vi.advanceTimersByTime(URL_REUSE_MS + 1);
    rerender({ url: SECOND });
    rerender({ url: SECOND });
    expect(result.current).toBe(SECOND);
  });

  it("is undefined while there is nothing to show", () => {
    const { result } = renderHook(() => useStableUrl(undefined));
    expect(result.current).toBeUndefined();
  });

  // A render preview's proxy is signed for five minutes, not an hour. Held for
  // the old constant 50 minutes, a clip played six minutes after the page
  // loaded mounted its stage on a URL MinIO had stopped accepting.
  it("renews a short-lived URL by its own signed lifetime, not the hour a clip URL gets", () => {
    vi.useFakeTimers();
    const short = (sig: string): string =>
      `https://media.test/ws/x/proxy540.mp4?X-Amz-Expires=300&X-Amz-Signature=${sig}`;
    const { result, rerender } = renderHook(({ url }) => useStableUrl(url), {
      initialProps: { url: short("first") },
    });
    vi.advanceTimersByTime(3 * 60_000);
    rerender({ url: short("second") });
    expect(result.current).toBe(short("first"));

    vi.advanceTimersByTime(60_000);
    rerender({ url: short("third") });
    rerender({ url: short("third") });
    expect(result.current).toBe(short("third"));
  });

  it("holds an hour-long URL for most of its hour", () => {
    vi.useFakeTimers();
    const long = (sig: string): string =>
      `https://media.test/ws/x/master.mp4?X-Amz-Expires=3600&X-Amz-Signature=${sig}`;
    const { result, rerender } = renderHook(({ url }) => useStableUrl(url), {
      initialProps: { url: long("first") },
    });
    vi.advanceTimersByTime(40 * 60_000);
    rerender({ url: long("second") });
    expect(result.current).toBe(long("first"));
    vi.advanceTimersByTime(6 * 60_000);
    rerender({ url: long("third") });
    rerender({ url: long("third") });
    expect(result.current).toBe(long("third"));
  });

  it("passes every URL through while nothing is playing, then holds the newest", () => {
    const { result, rerender } = renderHook(
      ({ url, hold }) => useStableUrl(url, undefined, { hold }),
      { initialProps: { url: FIRST, hold: false } },
    );
    rerender({ url: SECOND, hold: false });
    expect(result.current).toBe(SECOND);

    // Play pressed as a fresh copy lands: that copy is the one held, not the
    // older one seen while nothing was playing.
    const third = "https://media.test/ws/x/master.mp4?X-Amz-Signature=third";
    rerender({ url: third, hold: true });
    expect(result.current).toBe(third);
    rerender({ url: FIRST, hold: true });
    expect(result.current).toBe(third);
  });
});

describe("signedLifetimeMs", () => {
  it("reads X-Amz-Expires, and nothing from a URL without it", () => {
    expect(
      signedLifetimeMs("https://m.test/a.mp4?X-Amz-Date=20260926T100000Z&X-Amz-Expires=300"),
    ).toBe(300_000);
    expect(signedLifetimeMs("https://m.test/a.mp4?X-Amz-Signature=x")).toBeUndefined();
    expect(signedLifetimeMs("https://m.test/a.mp4")).toBeUndefined();
  });
});

"use client";

/**
 * A picked file's length, read in the browser before anything is uploaded
 * (2026-10-01): the start form's cost line uses it, as OpusClip's does once a
 * video is in. Only the file's header is read (`preload="metadata"`).
 *
 * `undefined` while it is being read, for no file, and for a file the browser
 * cannot open (an MKV in Safari, say): the form then reads as a video of
 * unknown length, never as a wrong one.
 */
import * as React from "react";

import { isAudioFile } from "@/components/repurpose/use-cover";

export function useMediaDuration(file: File | null): number | undefined {
  const [durationMs, setDurationMs] = React.useState<number | undefined>(undefined);
  React.useEffect(() => {
    setDurationMs(undefined);
    if (file === null || typeof URL.createObjectURL !== "function") return undefined;
    const element = document.createElement(isAudioFile(file) ? "audio" : "video");
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    };
    element.preload = "metadata";
    element.muted = true;
    element.onloadedmetadata = () => {
      const seconds = element.duration;
      if (Number.isFinite(seconds) && seconds > 0) setDurationMs(Math.round(seconds * 1000));
      finish();
    };
    element.onerror = finish;
    element.src = url;
    return finish;
  }, [file]);
  return durationMs;
}

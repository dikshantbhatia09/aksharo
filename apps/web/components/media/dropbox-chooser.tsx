"use client";

import * as React from "react";
import { Button, cn, toast } from "@montaj/ui";

declare global {
  interface Window {
    Dropbox?: {
      choose: (options: DropboxChooserOptions) => void;
      isBrowserSupported: () => boolean;
    };
  }
}

export interface DropboxFileItem {
  readonly id?: string;
  readonly name: string;
  readonly link: string;
  readonly bytes?: number;
  readonly icon?: string;
  readonly thumbnailLink?: string;
}

export interface DropboxChooserOptions {
  readonly success: (files: readonly DropboxFileItem[]) => void;
  readonly cancel?: () => void;
  readonly linkType?: "preview" | "direct";
  readonly multiselect?: boolean;
  readonly extensions?: readonly string[];
  readonly folderselect?: boolean;
  readonly sizeLimit?: number;
}

export interface DropboxPickedFile {
  readonly provider: "DROPBOX";
  readonly fileId: string;
  readonly fileName: string;
  readonly fileSizeBytes?: number;
  readonly downloadUrl: string;
}

export interface DropboxChooserProps {
  readonly onFileSelected: (file: DropboxPickedFile) => void;
  readonly appKey?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * Dropbox Chooser Component.
 * Integrates official Dropbox Chooser API drop-in script.
 * Returns direct download link for zero-disk server-to-server streaming to S3.
 */
export function DropboxChooserButton({
  onFileSelected,
  appKey,
  disabled = false,
  className,
}: DropboxChooserProps): React.JSX.Element {
  const [loading, setLoading] = React.useState(false);

  const effectiveAppKey =
    appKey || process.env.NEXT_PUBLIC_DROPBOX_APP_KEY || "";

  const loadScript = React.useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;

    if (window.Dropbox) return true;

    const existingScript = document.getElementById("dropboxjs");
    if (existingScript) {
      if (window.Dropbox) return true;
      // Wait for existing script to load
      return new Promise((resolve) => {
        existingScript.addEventListener("load", () => resolve(true));
        existingScript.addEventListener("error", () => resolve(false));
      });
    }

    if (!effectiveAppKey) {
      toast.error(
        "Dropbox App Key is not configured. Please set NEXT_PUBLIC_DROPBOX_APP_KEY.",
      );
      return false;
    }

    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.id = "dropboxjs";
      script.type = "text/javascript";
      script.src = "https://www.dropbox.com/static/api/2/dropins.js";
      script.setAttribute("data-app-key", effectiveAppKey);
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }, [effectiveAppKey]);

  const handleOpenChooser = async (): Promise<void> => {
    if (disabled || loading) return;

    setLoading(true);
    try {
      const ready = await loadScript();
      if (!ready || !window.Dropbox) {
        toast.error("Failed to load Dropbox Chooser. Check your internet connection or ad-blocker.");
        return;
      }

      if (!window.Dropbox.isBrowserSupported()) {
        toast.error("Dropbox Chooser is not supported in this browser.");
        return;
      }

      window.Dropbox.choose({
        linkType: "direct",
        multiselect: false,
        extensions: [
          ".mp4",
          ".mov",
          ".avi",
          ".mkv",
          ".webm",
          ".m4v",
          ".mp3",
          ".wav",
          ".aac",
          ".m4a",
          ".ogg",
          ".flac",
        ],
        success: (files: readonly DropboxFileItem[]) => {
          const selected = files[0];
          if (!selected) return;

          onFileSelected({
            provider: "DROPBOX",
            fileId: selected.id || selected.name,
            fileName: selected.name,
            fileSizeBytes: selected.bytes,
            downloadUrl: selected.link,
          });

          toast.success(`Selected "${selected.name}" from Dropbox`);
        },
        cancel: () => {
          // User closed chooser without picking
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Dropbox error: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || loading}
      onClick={handleOpenChooser}
      className={cn("gap-2", className)}
      data-testid="dropbox-chooser-button"
    >
      <svg
        className="size-4 text-blue-500"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M7.06 1.5L0 6.06l4.94 4.09L12 6.06 7.06 1.5zM16.94 1.5L12 6.06l7.06 4.09L24 6.06l-7.06-4.56zM0 14.25l7.06 4.56L12 14.25l-7.06-4.1L0 14.25zm24 0l-7.06-4.1-4.94 4.1 4.94 4.56L24 14.25zm-12 1.35l-4.94 3.2-2.12-1.36v1.36L12 22.5l7.06-3.7v-1.36l-2.12 1.36-4.94-3.2z" />
      </svg>
      {loading ? "Connecting…" : "Dropbox"}
    </Button>
  );
}


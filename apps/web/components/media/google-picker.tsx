"use client";

import * as React from "react";
import { Button, cn, toast } from "@montaj/ui";

declare global {
  interface Window {
    gapi?: {
      load: (api: string, callback: () => void) => void;
    };
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
          }) => { requestAccessToken: () => void };
        };
      };
      picker?: {
        PickerBuilder: new () => {
          addView: (view: unknown) => any;
          setOAuthToken: (token: string) => any;
          setDeveloperKey: (key: string) => any;
          setCallback: (callback: (data: any) => void) => any;
          enableFeature: (feature: any) => any;
          setTitle: (title: string) => any;
          build: () => { setVisible: (visible: boolean) => void };
        };
        ViewId: {
          DOCS_VIDEOS: string;
        };
        Feature: {
          SUPPORT_DRIVES: string;
          NAV_HIDDEN: string;
        };
        Action: {
          PICKED: string;
          CANCEL: string;
        };
        Response: {
          DOCUMENTS: string;
          ACTION: string;
        };
        Document: {
          ID: string;
          NAME: string;
          SIZE_BYTES: string;
          MIME_TYPE: string;
        };
      };
    };
  }
}

export interface GoogleDrivePickedFile {
  readonly provider: "GOOGLE_DRIVE";
  readonly fileId: string;
  readonly fileName: string;
  readonly fileSizeBytes?: number;
  readonly mimeType?: string;
  readonly token: string;
}

export interface GooglePickerProps {
  readonly onFileSelected: (file: GoogleDrivePickedFile) => void;
  readonly clientId?: string;
  readonly apiKey?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * Google Drive Picker Component.
 * Integrates Google Picker API with full support for Google Workspace Shared Drives (Team Drives).
 * Implements Step 4 of Pillar 1 §02 Cloud Storage Connectors.
 */
export function GooglePickerButton({
  onFileSelected,
  clientId,
  apiKey,
  disabled = false,
  className,
}: GooglePickerProps): React.JSX.Element {
  const [loading, setLoading] = React.useState(false);

  const effectiveClientId =
    clientId || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
  const effectiveApiKey =
    apiKey || process.env.NEXT_PUBLIC_GOOGLE_API_KEY || "";

  const loadScripts = React.useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;

    // Load GAPI script if not already loaded
    if (!window.gapi) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://apis.google.com/js/api.js";
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Google API script"));
        document.body.appendChild(script);
      });
    }

    // Load Google Identity Services script
    if (!window.google?.accounts) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Google Identity script"));
        document.body.appendChild(script);
      });
    }

    // Load Picker library
    await new Promise<void>((resolve) => {
      window.gapi?.load("picker", resolve);
    });

    return true;
  }, []);

  const openPicker = React.useCallback(
    (accessToken: string) => {
      if (!window.google?.picker) {
        toast.error("Google Picker API is unavailable");
        setLoading(false);
        return;
      }

      const pickerBuilder = new window.google.picker.PickerBuilder();

      // Configure video view
      pickerBuilder.addView(window.google.picker.ViewId.DOCS_VIDEOS);

      // Support Google Workspace Shared Drives (formerly Team Drives)
      pickerBuilder.enableFeature(window.google.picker.Feature.SUPPORT_DRIVES);

      pickerBuilder.setOAuthToken(accessToken);
      if (effectiveApiKey) {
        pickerBuilder.setDeveloperKey(effectiveApiKey);
      }
      pickerBuilder.setTitle("Select a Video from Google Drive");

      pickerBuilder.setCallback((data: any) => {
        if (data[window.google!.picker!.Response.ACTION] === window.google!.picker!.Action.PICKED) {
          const doc = data[window.google!.picker!.Response.DOCUMENTS]?.[0];
          if (doc) {
            const pickedFile: GoogleDrivePickedFile = {
              provider: "GOOGLE_DRIVE",
              fileId: doc[window.google!.picker!.Document.ID],
              fileName: doc[window.google!.picker!.Document.NAME] || "drive-video.mp4",
              fileSizeBytes: doc[window.google!.picker!.Document.SIZE_BYTES]
                ? Number(doc[window.google!.picker!.Document.SIZE_BYTES])
                : undefined,
              mimeType: doc[window.google!.picker!.Document.MIME_TYPE] || "video/mp4",
              token: accessToken,
            };
            onFileSelected(pickedFile);
            toast.success(`Selected "${pickedFile.fileName}" from Google Drive`);
          }
        }
        setLoading(false);
      });

      const picker = pickerBuilder.build();
      picker.setVisible(true);
    },
    [effectiveApiKey, onFileSelected],
  );

  const handleClick = React.useCallback(async () => {
    setLoading(true);
    try {
      await loadScripts();

      if (!effectiveClientId) {
        // Fallback prompt dialog for development or when client ID is not configured
        const manualId = window.prompt(
          "Google Drive Import:\nEnter a Google Drive File ID or Share URL (e.g. 1AbCdEfGhIjKlMnOpQrStUvWxYz012345):",
        );
        if (manualId) {
          const cleanId = manualId.includes("/file/d/")
            ? manualId.split("/file/d/")[1]?.split("/")[0] || manualId
            : manualId.trim();
          onFileSelected({
            provider: "GOOGLE_DRIVE",
            fileId: cleanId,
            fileName: `gdrive-${cleanId.slice(0, 8)}.mp4`,
            token: "oauth-token-placeholder",
          });
          toast.success("Google Drive video selected for import");
        }
        setLoading(false);
        return;
      }

      // Request OAuth Access Token
      const tokenClient = window.google!.accounts.oauth2.initTokenClient({
        client_id: effectiveClientId,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        callback: (response) => {
          if (response.error || !response.access_token) {
            toast.error("Google Drive authorization cancelled or failed");
            setLoading(false);
            return;
          }
          openPicker(response.access_token);
        },
      });

      tokenClient.requestAccessToken();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open Google Drive picker");
      setLoading(false);
    }
  }, [effectiveClientId, loadScripts, onFileSelected, openPicker]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || loading}
      onClick={handleClick}
      aria-label="Import video from Google Drive"
      data-testid="google-picker-button"
      className={cn(
        "inline-flex items-center gap-2 border-border/80 bg-bg-2 text-fg-0 hover:bg-bg-3",
        className,
      )}
    >
      <svg
        className="size-4 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M7.74 3.52L1.15 15l3.41 5.91 6.59-11.48-3.41-5.91z"
          fill="#4285F4"
        />
        <path
          d="M16.26 3.52H9.44l6.59 11.48h6.82l-6.59-11.48z"
          fill="#0F9D58"
        />
        <path
          d="M22.85 15l-3.41-5.91H9.44L12.85 15h10z"
          fill="#FFBB00"
        />
      </svg>
      <span>{loading ? "Connecting..." : "Google Drive"}</span>
    </Button>
  );
}

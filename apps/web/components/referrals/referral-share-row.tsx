"use client";

import { Copy } from "lucide-react";
import * as React from "react";

import { Button, Input, toast } from "@montaj/ui";

import { instagramCaption, referralSignupUrl, whatsappShareUrl, xShareUrl } from "./share-links";

import { useRuntimeConfig } from "@/components/providers";

/**
 * The copy-link/code row and share buttons (brief §3: "copy link/code and
 * share buttons — WhatsApp, X, Instagram copy"). Shared between the give-get
 * sheet and the Invite-friends tab so both surfaces behave identically.
 */
export function ReferralShareRow({ code }: { code: string }): React.JSX.Element {
  // The link must point at the deployment the sharer is on, not a hard-coded
  // production domain (F07-E8).
  const { webOrigin } = useRuntimeConfig();
  const link = referralSignupUrl(code, webOrigin);

  const copy = React.useCallback(
    (value: string, label: string) => () => {
      void navigator.clipboard
        .writeText(value)
        .then(() => {
          toast.success(`${label} copied`);
        })
        .catch(() => {
          toast.error(`Could not copy the ${label.toLowerCase()}`);
        });
    },
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-fg-2 text-xs font-medium" htmlFor="referral-code">
          Your code
        </label>
        <div className="flex gap-2">
          <Input id="referral-code" readOnly value={code} className="font-mono" />
          <Button variant="secondary" onClick={copy(code, "Code")} aria-label="Copy referral code">
            <Copy aria-hidden="true" />
            Copy
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-fg-2 text-xs font-medium" htmlFor="referral-link">
          Your link
        </label>
        <div className="flex gap-2">
          <Input id="referral-link" readOnly value={link} />
          <Button variant="secondary" onClick={copy(link, "Link")} aria-label="Copy referral link">
            <Copy aria-hidden="true" />
            Copy
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="primary">
          <a href={whatsappShareUrl(code, webOrigin)} target="_blank" rel="noopener noreferrer">
            Share on WhatsApp
          </a>
        </Button>
        <Button asChild variant="secondary">
          <a href={xShareUrl(code, webOrigin)} target="_blank" rel="noopener noreferrer">
            Share on X
          </a>
        </Button>
        <Button
          variant="secondary"
          onClick={copy(instagramCaption(code, webOrigin), "Instagram caption")}
        >
          Copy for Instagram
        </Button>
      </div>
    </div>
  );
}

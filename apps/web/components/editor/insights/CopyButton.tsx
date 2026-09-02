"use client";

import { Copy } from "lucide-react";
import * as React from "react";

import { Button, toast } from "@montaj/ui";

/** A small "Copy" button over `navigator.clipboard`, the referral row's pattern. */
export function CopyButton({
  value,
  label,
  className,
}: {
  readonly value: string;
  readonly label: string;
  readonly className?: string;
}): React.JSX.Element {
  const onCopy = React.useCallback(() => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        toast.success(`${label} copied`);
      })
      .catch(() => {
        toast.error(`Could not copy the ${label.toLowerCase()}`);
      });
  }, [value, label]);

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onCopy}
      aria-label={`Copy ${label.toLowerCase()}`}
      className={className}
    >
      <Copy aria-hidden="true" />
      Copy
    </Button>
  );
}

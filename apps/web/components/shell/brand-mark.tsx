import { cn } from "@montaj/ui";

import type * as React from "react";

/**
 * The canvas's brand mark: the Devanagari letter अ — *a*, the first letter of
 * अक्षर (akshara, "syllable"), which is what the product is named for — inside
 * a 1 px accent-outlined 8 px square.
 *
 * An outline rather than a fill, because Nocturne spends the accent on lines
 * and never floods with it, and a glyph rather than an SVG so it inherits the
 * page's font stack and stays crisp at 30 px on any display.
 */
export function BrandMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="brand-mark"
      className={cn(
        "border-accent text-accent flex shrink-0 items-center justify-center rounded-sm border",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.53) }}
    >
      अ
    </span>
  );
}

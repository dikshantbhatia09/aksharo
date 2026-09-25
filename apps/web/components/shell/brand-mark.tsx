import { cn } from "@montaj/ui";

import type * as React from "react";

/**
 * The brand mark: the Devanagari letter अ — *a*, the first letter of अक्षर
 * (akshara, "syllable"), which is what the product is named for — on a quiet
 * surface tile, hanging from a short rani bar.
 *
 * The bar is the shirorekha, the headline Devanagari letters hang from, and
 * the brand mark is one of the three places DESIGN.md allows it (page titles,
 * the brand mark, one hero moment). The glyph itself stays in the warm
 * foreground rather than the accent, so the bar is the only pink in the
 * lockup. A glyph rather than an SVG, so it inherits the page's font stack and
 * the on-demand Noto face, and stays crisp at any size.
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
        "border-border bg-surface text-fg-0 relative flex shrink-0 items-center justify-center overflow-hidden rounded-sm border",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.53) }}
    >
      <span className="bg-accent absolute inset-x-0 top-0 h-[3px]" />
      <span className="translate-y-[1px] leading-none">अ</span>
    </span>
  );
}

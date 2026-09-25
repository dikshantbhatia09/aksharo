import { renderOgImage, OG_SIZE } from "../_components/og-template";

export const alt = "Aksharo caption styles gallery.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image(): ReturnType<typeof renderOgImage> {
  return renderOgImage(
    "One bold style, every word tunable.",
    "Built for Reels, Shorts and YouTube. Hover to animate.",
  );
}

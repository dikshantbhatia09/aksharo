import { renderOgImage, OG_SIZE } from "../_components/og-template";

export const alt = "Aksharo features.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image(): ReturnType<typeof renderOgImage> {
  return renderOgImage(
    "What Aksharo actually does.",
    "Measured Hinglish accuracy, word-level editing, autocut and zoom, in-timeline plugins.",
  );
}

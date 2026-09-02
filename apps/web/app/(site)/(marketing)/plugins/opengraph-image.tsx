import { renderOgImage, OG_SIZE } from "../_components/og-template";

export const alt = "Aksharo Panel and Aksharo for DaVinci Resolve.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image(): ReturnType<typeof renderOgImage> {
  return renderOgImage(
    "The same brain, inside your timeline.",
    "Aksharo Panel for Premiere Pro and After Effects. Aksharo for DaVinci Resolve.",
  );
}

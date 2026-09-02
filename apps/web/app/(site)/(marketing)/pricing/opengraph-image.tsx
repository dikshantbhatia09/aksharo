import { renderOgImage, OG_SIZE } from "../_components/og-template";

export const alt = "Aksharo pricing — one credit pool, every surface.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image(): ReturnType<typeof renderOgImage> {
  return renderOgImage(
    "One credit pool. Every surface.",
    "Rupee pricing by default, a USD toggle, a free clean export on us.",
  );
}

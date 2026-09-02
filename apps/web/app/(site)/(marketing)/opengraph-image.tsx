import { renderOgImage, OG_SIZE } from "./_components/og-template";

export const alt = "Aksharo — captions, cuts and polish, done inside your timeline.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image(): ReturnType<typeof renderOgImage> {
  return renderOgImage(
    "Captions that get how you actually speak.",
    "Hinglish-accurate captions, autocut and zoom, one plan for every surface.",
  );
}

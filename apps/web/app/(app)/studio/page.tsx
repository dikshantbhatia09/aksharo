import { redirect } from "next/navigation";

/**
 * `/studio` was the shell's landing page before Home and Projects existed. Both
 * shipped; the scaffold copy underneath ("Uploads and projects arrive with
 * A14") outlived them, so the route now sends its old bookmarks to the real
 * list instead (F07-E6).
 */
export default function StudioPage(): never {
  redirect("/projects");
}

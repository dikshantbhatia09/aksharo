import { redirect } from "next/navigation";

/** `/settings` is not a screen of its own; Profile is the first section. */
export default function SettingsIndexPage(): never {
  redirect("/settings/profile");
}

// tsc does not copy non-TS assets; the offline page's and the pairing
// approval window's HTML need to sit next to their compiled `.js` in dist/main.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(join(root, "src", "main", "offline.html"), join(root, "dist", "main", "offline.html"));
copyFileSync(
  join(root, "src", "main", "pairing-approval.html"),
  join(root, "dist", "main", "pairing-approval.html"),
);

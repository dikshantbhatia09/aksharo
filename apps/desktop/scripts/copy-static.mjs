// tsc does not copy non-TS assets; the offline page's HTML needs to sit next
// to its compiled `offline.js` in dist/main.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(join(root, "src", "main", "offline.html"), join(root, "dist", "main", "offline.html"));

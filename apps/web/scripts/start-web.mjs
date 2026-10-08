import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const releaseMarker = "C:\\Dikshant\\Crest Mond\\Product 2\\05-build\\_orchestration\\release\\web-dist.txt";

let distDir = process.env.NEXT_DIST_DIR;
if (!distDir && fs.existsSync(releaseMarker)) {
  distDir = fs.readFileSync(releaseMarker, "utf8").trim();
}

const envVars = {
  ...process.env,
  NEXT_DIST_DIR: distDir || ".next",
  NODE_ENV: "production",
  PORT: "3914",
};

function run() {
  const child = spawn(
    process.execPath,
    ["--env-file=../../.env.local-run", "node_modules/next/dist/bin/next", "start", "-p", "3914"],
    {
      cwd: appDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: envVars,
    }
  );

  child.on("exit", (code, signal) => {
    console.error(`Next.js web exited with code ${code}, signal ${signal}. Restarting in 2s...`);
    setTimeout(run, 2000);
  });
}

run();

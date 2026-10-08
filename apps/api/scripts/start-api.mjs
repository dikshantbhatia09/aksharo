import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");

function run() {
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=4096", "--env-file=../../.env.local-run", "dist/main.js"],
    {
      cwd: appDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    }
  );

  child.on("exit", (code, signal) => {
    console.error(`API exited with code ${code}, signal ${signal}. Restarting in 2s...`);
    setTimeout(run, 2000);
  });
}

run();

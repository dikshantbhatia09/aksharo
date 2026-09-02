import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import { aksharoDir } from "./discovery.js";

/**
 * Cross-platform secret storage for the per-install bridge private key
 * (THREAT-MODEL T14: "private key in OS keychain/DPAPI; regenerated on
 * reinstall"). C01 shipped the key as a `0600` file under `~/.aksharo/cert/`;
 * this is the documented fallback (`FileKeyStore`), still used on Linux/CI
 * where neither a keychain nor DPAPI is available.
 *
 * Deliberately no new native/npm dependency here: both OS-backed stores shell
 * out to a tool the OS itself ships and maintains (`security` on macOS,
 * PowerShell's `System.Security.Cryptography.ProtectedData` — DPAPI — on
 * Windows), which is also the only approach that survives being bundled into
 * the `apps/bridge` Node SEA binary (a native npm addon's `.node` file has no
 * stable path once esbuild bundles everything into one `dist/bundle.cjs`, and
 * a real system keychain's own client library is a native addon on every
 * platform we ship). See `apps/bridge/README.md` for the WP report's write-up.
 */
export interface KeyStore {
  /** Reads the named secret, or `undefined` if it has never been saved here. */
  load(name: string): Promise<string | undefined>;
  save(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** A short label for logs/diagnostics, e.g. `"keychain"`, `"dpapi"`, `"file"`. */
  readonly kind: string;
}

const SERVICE_NAME = "com.aksharo.bridge";

/** Test double: never touches disk or any OS API. */
export class InMemoryKeyStore implements KeyStore {
  readonly kind = "memory";
  private readonly values = new Map<string, string>();

  load(name: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(name));
  }
  save(name: string, value: string): Promise<void> {
    this.values.set(name, value);
    return Promise.resolve();
  }
  delete(name: string): Promise<void> {
    this.values.delete(name);
    return Promise.resolve();
  }
}

/** The documented fallback: a `0600` file per secret under `~/.aksharo/keys/`. */
export class FileKeyStore implements KeyStore {
  readonly kind = "file";

  constructor(private readonly dir: string = join(aksharoDir(), "keys")) {}

  private pathFor(name: string): string {
    return join(this.dir, `${name}.key`);
  }

  load(name: string): Promise<string | undefined> {
    const path = this.pathFor(name);
    if (!existsSync(path)) return Promise.resolve(undefined);
    return Promise.resolve(readFileSync(path, "utf8"));
  }

  save(name: string, value: string): Promise<void> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.pathFor(name), value, { mode: 0o600 });
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    rmSync(this.pathFor(name), { force: true });
    return Promise.resolve();
  }
}

/**
 * macOS Keychain, via the `security` CLI Apple ships and maintains (no npm
 * dependency, no native addon). Stores each secret as a generic password
 * item scoped to `SERVICE_NAME`/`name`.
 */
export class KeychainKeyStore implements KeyStore {
  readonly kind = "keychain";

  load(name: string): Promise<string | undefined> {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-a", name, "-s", SERVICE_NAME, "-w"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const value = out.toString("utf8").trim();
      return Promise.resolve(value.length > 0 ? value : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  save(name: string, value: string): Promise<void> {
    // `-U` updates the item in place if it already exists (upsert).
    execFileSync(
      "security",
      ["add-generic-password", "-a", name, "-s", SERVICE_NAME, "-w", value, "-U"],
      { stdio: "ignore" },
    );
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    try {
      execFileSync("security", ["delete-generic-password", "-a", name, "-s", SERVICE_NAME], {
        stdio: "ignore",
      });
    } catch {
      // Nothing to delete.
    }
    return Promise.resolve();
  }
}

/**
 * Windows DPAPI, via a PowerShell one-liner calling
 * `System.Security.Cryptography.ProtectedData` (no npm dependency, no native
 * addon — PowerShell and .NET ship with Windows). `CurrentUser` scope means
 * only the OS user account that ran the bridge can decrypt the blob, which is
 * the same trust boundary the `0600` file fallback already assumed. The
 * encrypted blob itself is still a file on disk (DPAPI protects bytes; it has
 * no notion of named entries the way a keychain does), stored base64-encoded
 * under `~/.aksharo/keys/`.
 */
export class DpapiKeyStore implements KeyStore {
  readonly kind = "dpapi";

  constructor(private readonly dir: string = join(aksharoDir(), "keys")) {}

  private pathFor(name: string): string {
    return join(this.dir, `${name}.dpapi`);
  }

  load(name: string): Promise<string | undefined> {
    const path = this.pathFor(name);
    if (!existsSync(path)) return Promise.resolve(undefined);
    const protectedB64 = readFileSync(path, "utf8").trim();
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$bytes = [Convert]::FromBase64String('${protectedB64}')`,
      "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(" +
        "$bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))",
    ].join("; ");
    try {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      return Promise.resolve(out.toString("utf8"));
    } catch {
      return Promise.resolve(undefined);
    }
  }

  save(name: string, value: string): Promise<void> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const plainB64 = Buffer.from(value, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$plain = [Convert]::FromBase64String('${plainB64}')`,
      "$protected = [System.Security.Cryptography.ProtectedData]::Protect(" +
        "$plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Convert]::ToBase64String($protected))",
    ].join("; ");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    writeFileSync(this.pathFor(name), out.toString("utf8"), { mode: 0o600 });
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    rmSync(this.pathFor(name), { force: true });
    return Promise.resolve();
  }
}

/**
 * Picks the OS-backed store for the current platform, falling back to
 * `FileKeyStore` if the OS call is not actually usable (headless CI without
 * `security`/PowerShell, a locked-down PowerShell execution policy, etc.) —
 * probed once with a cheap round-trip rather than assumed from `os.platform()`
 * alone, so the fallback is real rather than platform-guessed.
 */
export async function createDefaultKeyStore(): Promise<KeyStore> {
  const candidate: KeyStore | undefined =
    platform() === "darwin"
      ? new KeychainKeyStore()
      : platform() === "win32"
        ? new DpapiKeyStore()
        : undefined;
  if (candidate === undefined) return new FileKeyStore();
  if (!(await probeKeyStore(candidate))) return new FileKeyStore();
  return candidate;
}

async function probeKeyStore(store: KeyStore): Promise<boolean> {
  const probeName = "__aksharo_bridge_probe__";
  try {
    await store.save(probeName, "probe");
    const value = await store.load(probeName);
    return value === "probe";
  } catch {
    return false;
  } finally {
    try {
      await store.delete(probeName);
    } catch {
      // Best effort cleanup; a failed probe already means "use the fallback".
    }
  }
}

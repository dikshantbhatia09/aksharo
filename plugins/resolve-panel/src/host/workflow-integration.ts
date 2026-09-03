/**
 * The ONLY file in this package allowed to touch Resolve's `WorkflowIntegration` host
 * global. Everything else — the RPC client, the session state machine, the transcribe flow
 * and every UI component — takes a `WorkflowIntegrationHost` and is fully testable without
 * Resolve installed, mirroring `plugins/premiere-uxp/src/host/premiere.ts`'s rule for UXP.
 *
 * UNCONFIRMED PENDING A00-04 (docs/PLAN.md; plugins/resolve/README.md "Known limitations"
 * lists the same open questions for the script side): whether DaVinci Resolve Studio's
 * Workflow Integration host exposes a `window.workflowIntegration`-style bridge object at
 * all, and if so, what it can do (open a URL in the system browser, read a small file such
 * as this script's own discovery file at `~/.aksharo/resolve.json`, report the host's
 * version string). No public API reference for it exists in this repo or was cited by the
 * brief, so `createRealWorkflowIntegrationHost` below throws "unverified" for every method,
 * exactly like `createRealPremiereHost`'s real adapter does for calls the A00-03 spike has
 * not confirmed. `MockWorkflowIntegrationHost` is what every test and this package's own
 * development against no Resolve install use.
 *
 * This host adapter is deliberately tiny: the panel's own business logic (discover ->
 * bearer -> JSON-RPC to `aksharo_core`'s loopback server) lives in `src/rpc/*`, which only
 * needs the host for three things — reading the discovery file, opening an external URL
 * (device-code approval) and the host version string for the footer version line.
 */

/** Mirrors `plugins/resolve/aksharo_core_app/discovery.py`'s `DiscoveryFile.to_wire()`. */
export interface DiscoveryFile {
  readonly port: number;
  readonly bearer: string;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
}

export interface WorkflowIntegrationHost {
  /** Resolve's own version string, for the footer version line. */
  getHostVersion(): Promise<string>;

  /** Whether this Resolve install is Studio (Workflow Integration plugins are Studio-only,
   * D24/D65 — Free installs never load this panel, but the host still needs to answer this
   * for the panel's own "Resolve Studio required" guard). */
  isStudio(): Promise<boolean>;

  /** Reads `~/.aksharo/resolve.json` (`aksharo_core_app/discovery.py`), or `undefined` when
   * the script hasn't started/written it yet. */
  readDiscoveryFile(): Promise<DiscoveryFile | undefined>;

  /** Opens a URL in the OS default browser (device-code sign-in approval). */
  openExternalUrl(url: string): Promise<void>;
}

export interface MockWorkflowIntegrationHostOptions {
  readonly hostVersion?: string;
  readonly isStudio?: boolean;
  readonly discoveryFile?: DiscoveryFile | undefined;
}

/**
 * In-memory `WorkflowIntegrationHost` used by every test in this package and by local panel
 * development (there is no Resolve Studio to attach to on this build host). Deterministic:
 * no timers, no randomness.
 */
export class MockWorkflowIntegrationHost implements WorkflowIntegrationHost {
  private hostVersion: string;
  private studio: boolean;
  private discoveryFile: DiscoveryFile | undefined;
  readonly openedUrls: string[] = [];

  constructor(options: MockWorkflowIntegrationHostOptions = {}) {
    this.hostVersion = options.hostVersion ?? "19.1.0";
    this.studio = options.isStudio ?? true;
    this.discoveryFile = options.discoveryFile;
  }

  async getHostVersion(): Promise<string> {
    return this.hostVersion;
  }

  async isStudio(): Promise<boolean> {
    return this.studio;
  }

  async readDiscoveryFile(): Promise<DiscoveryFile | undefined> {
    return this.discoveryFile;
  }

  async openExternalUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }

  /** Test helper: simulate `aksharo_core` starting (or restarting on a new port/bearer). */
  setDiscoveryFile(file: DiscoveryFile | undefined): void {
    this.discoveryFile = file;
  }

  /** Test helper: simulate opening this panel on a Free install (should never happen once
   * C10's installer only ships the panel to Studio, but the panel still guards for it). */
  setIsStudio(value: boolean): void {
    this.studio = value;
  }
}

/**
 * Real adapter — runs only inside the Resolve Studio Workflow Integration host. Every method
 * is unverified against a live Resolve install (no Resolve Studio, no A00-04 spike result
 * exist on this build host; see this file's header comment and `README.md`). Constructed by
 * `src/index.tsx` only when a `workflowIntegration` global is present; never imported by
 * tests, which exercise `MockWorkflowIntegrationHost` only.
 */
export function createRealWorkflowIntegrationHost(): WorkflowIntegrationHost {
  const bridge = (
    globalThis as {
      workflowIntegration?: unknown;
    }
  ).workflowIntegration;
  if (!bridge) {
    throw new Error(
      "createRealWorkflowIntegrationHost() must run inside the Resolve Studio Workflow " +
        "Integration host",
    );
  }
  return {
    async getHostVersion(): Promise<string> {
      throw new Error(
        "getHostVersion: unverified against a real Resolve Studio install (Gate C, A00-04)",
      );
    },
    async isStudio(): Promise<boolean> {
      throw new Error(
        "isStudio: unverified against a real Resolve Studio install (Gate C, A00-04)",
      );
    },
    async readDiscoveryFile(): Promise<DiscoveryFile | undefined> {
      // GATE-C: confirm whether the Workflow Integration host gives panels any file-read
      // capability at all (see header comment); this may need a different discovery
      // transport (e.g. the script pushing its port/bearer over a well-known local HTTP
      // probe) if it does not.
      throw new Error(
        "readDiscoveryFile: unverified against a real Resolve Studio install (Gate C, A00-04)",
      );
    },
    async openExternalUrl(): Promise<void> {
      throw new Error(
        "openExternalUrl: unverified against a real Resolve Studio install (Gate C, A00-04)",
      );
    },
  };
}

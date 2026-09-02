#!/usr/bin/env node
/* eslint-disable no-console -- this file is the CLI's own user-facing output */
import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { runBuildDesktop } from "./commands/buildDesktop.js";
import { runChecksums } from "./commands/checksums.js";
import { runNotarize } from "./commands/notarize.js";
import { runPackageCcx } from "./commands/packageCcx.js";
import { runPackageResolve } from "./commands/packageResolve.js";
import { runPromote } from "./commands/promote.js";
import { runPublish } from "./commands/publish.js";
import { runSbom } from "./commands/sbom.js";
import { runSignNested } from "./commands/signNested.js";
import { runSignZxp } from "./commands/signZxp.js";
import { runVerifyRelease } from "./commands/verifyRelease.js";
import {
  computeNextVersion,
  groupCommitsForChangelog,
  insertChangelogSection,
  renderChangelogSection,
} from "./commands/version.js";
import { createContext, loadReleaseConfig } from "./config.js";
import { loadReleaseDotEnv } from "./env.js";
import { ReleaseFailClosedError } from "./types.js";

// Loads tools/release/.env (CI/GitHub-environment secrets; never the repo root .env — see
// src/env.ts) before any command reads process.env. A real environment variable already set
// (a GitHub Actions secret, a shell export) always wins over this file.
loadReleaseDotEnv(path.join(__dirname, "..", ".env"));

const program = new Command();
program
  .name("release")
  .description("Aksharo signing & release pipeline (C00). Dry-run by default.");

function contextFromOpts(opts: { dryRun?: boolean }) {
  return createContext({
    mode: opts.dryRun === false ? undefined : opts.dryRun ? "dry-run" : undefined,
  });
}

program
  .command("version")
  .description("Compute next semver from conventional commits and write a CHANGELOG.md section")
  .requiredOption("--current <version>", "current package.json version")
  .option(
    "--subjects <file>",
    "path to a newline-delimited file of commit subjects (defaults to stdin unavailable in CI; use git log --format=%s > file)",
  )
  .option("--dry-run", "print the result, don't write CHANGELOG.md", true)
  .option(
    "--no-dry-run",
    "actually write CHANGELOG.md (or sign/notarize/publish for real if RELEASE_MODE=signed)",
  )
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const subjects = opts.subjects
      ? (await fs.readFile(opts.subjects, "utf8")).split("\n").filter(Boolean)
      : [];
    const { next, bump } = computeNextVersion(opts.current, subjects);
    const date = new Date(ctx.now()).toISOString().slice(0, 10);
    const section = renderChangelogSection(groupCommitsForChangelog(subjects, next, date));
    console.log(`current=${opts.current} next=${next} bump=${bump ?? "none"}`);
    if (opts.dryRun === false) {
      const changelogPath = path.join(ctx.repoRoot, "CHANGELOG.md");
      const existing = await fs
        .readFile(changelogPath, "utf8")
        .catch(() => "# Changelog\n\n## Unreleased\n\n");
      await fs.writeFile(changelogPath, insertChangelogSection(existing, section), "utf8");
    } else {
      console.log(section);
    }
  });

program
  .command("build-desktop")
  .description(
    "Build the desktop app for one platform/channel via electron-builder (or a placeholder tree if apps/desktop has no code yet)",
  )
  .requiredOption("--platform <platform>", "mac|win")
  .requiredOption("--channel <channel>", "alpha|beta|stable")
  .option("--dry-run", "never sign for real; unsigned artifacts only", true)
  .option(
    "--no-dry-run",
    "sign for real if RELEASE_MODE=signed and secrets are set (fails closed otherwise)",
  )
  .option(
    "--placeholder",
    "force the synthesized placeholder app tree even if a real electron-builder --dir output exists (CI dry runs without Electron)",
    false,
  )
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const config = await loadReleaseConfig(ctx.repoRoot);
    const result = await runBuildDesktop(ctx, config, {
      platform: opts.platform,
      channel: opts.channel,
      dryRun: opts.dryRun !== false,
      placeholder: Boolean(opts.placeholder),
    });
    if (result.placeholderApp) {
      console.warn(
        `WARNING: apps/desktop has no built app yet; built against a placeholder tree at ${result.appDir}`,
      );
    }
    console.log(`artifact: ${result.artifactPath}`);
    console.log(`signed ${result.signed.length} target(s) with dry-run marker(s)`);
  });

program
  .command("sign-nested")
  .description("Sign every nested binary in a built app tree, then the outer bundle")
  .requiredOption("--app-dir <dir>")
  .requiredOption("--bundle <path>")
  .requiredOption("--platform <platform>")
  .option("--dry-run", "", true)
  .option(
    "--no-dry-run",
    "sign for real if RELEASE_MODE=signed and secrets are set (fails closed otherwise)",
  )
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const result = await runSignNested(ctx, opts.appDir, opts.bundle, opts.platform);
    console.log(`provider: ${result.provider}`);
    console.log(
      `signed ${result.signed.length}, verified ${result.verified.filter((v) => v.verified).length}/${result.verified.length}`,
    );
  });

program
  .command("notarize")
  .description("Submit + wait + staple; enforces the 24h buffer before stable")
  .requiredOption("--artifact <path>")
  .requiredOption("--name <artifactName>")
  .option("--dry-run", "", true)
  .option(
    "--no-dry-run",
    "notarize for real if RELEASE_MODE=signed and secrets are set (fails closed otherwise)",
  )
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const record = await runNotarize(ctx, { artifactPath: opts.artifact, artifactName: opts.name });
    console.log(JSON.stringify(record, null, 2));
  });

program
  .command("package-ccx")
  .description("Package the Premiere UXP plugin folder into a .ccx (no signing required)")
  .option("--version <version>", "", "0.1.0")
  .option("--dry-run", "", true)
  .option("--no-dry-run", "no real signing needed for .ccx; kept for CLI symmetry")
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const config = await loadReleaseConfig(ctx.repoRoot);
    const result = await runPackageCcx(ctx, {
      pluginDir: config.ccx.pluginDir,
      minPremiereVersion: config.ccx.minPremiereVersion,
      version: opts.version,
    });
    if (result.placeholderPlugin) {
      console.warn(
        "WARNING: plugins/premiere-uxp has no manifest.json yet (C05a not landed); packaged a placeholder plugin",
      );
    }
    console.log(`ccx: ${result.ccxPath}`);
  });

program
  .command("sign-zxp")
  .description("Package + sign the AE CEP panel as a .zxp")
  .option("--version <version>", "", "0.1.0")
  .option("--dry-run", "", true)
  .option(
    "--no-dry-run",
    "sign for real if RELEASE_MODE=signed and secrets are set (fails closed otherwise)",
  )
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const config = await loadReleaseConfig(ctx.repoRoot);
    const result = await runSignZxp(ctx, {
      pluginDir: config.zxp.pluginDir,
      version: opts.version,
    });
    if (result.placeholderPlugin) {
      console.warn(
        "WARNING: plugins/ae-cep has no CSXS/manifest.xml yet (C07 not landed); packaged a placeholder plugin",
      );
    }
    console.log(`zxp: ${result.zxpPath} signed=${result.signed}`);
  });

program
  .command("package-resolve")
  .description("Zip the Resolve script bundle + per-OS installer scripts")
  .option("--version <version>", "", "0.1.0")
  .option(
    "--dry-run",
    "no signing step exists for this bundle (RR-03); kept for CLI symmetry",
    true,
  )
  .option("--no-dry-run", "same as --dry-run: this command never signs anything")
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const config = await loadReleaseConfig(ctx.repoRoot);
    const result = await runPackageResolve(ctx, config, opts.version);
    if (result.placeholderPlugin) {
      console.warn(
        "WARNING: plugins/resolve has no aksharo_core.py yet (C08 not landed); packaged a placeholder plugin",
      );
    }
    if (result.placeholderPanel) {
      console.warn(
        "WARNING: plugins/resolve-panel has no built dist/ yet (run `pnpm --filter " +
          "@montaj/resolve-panel build` first); packaged a placeholder Studio panel",
      );
    }
    console.log(`bundle: ${result.bundlePath}`);
  });

program
  .command("sbom")
  .description("Generate a CycloneDX SBOM for an artifact")
  .requiredOption("--artifact-name <name>")
  .option("--version <version>", "", "0.1.0")
  .option("--package-json <paths...>", "package.json files to include", [])
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const result = await runSbom(ctx, {
      artifactName: opts.artifactName,
      version: opts.version,
      packageJsonPaths: opts.packageJson,
    });
    console.log(`sbom: ${result.path} (${result.componentCount} components)`);
  });

program
  .command("checksums")
  .description("SHA-256 manifest + signed SIGNATURES.txt over every artifact")
  .option("--channel <channel>", "", "alpha")
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const result = await runChecksums(ctx, opts.channel);
    console.log(`manifest: ${result.manifestPath}`);
    console.log(`signatures: ${result.signaturePath}`);
  });

program
  .command("publish")
  .description("Upload artifacts + updater feeds to a release channel")
  .requiredOption("--channel <channel>")
  .requiredOption("--version <version>")
  .option("--mac-artifact <path>")
  .option("--win-artifact <path>")
  .option("--force", "override the 24h stable gate", false)
  .option("--reason <text>", "required with --force")
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const result = await runPublish(ctx, {
      channel: opts.channel,
      version: opts.version,
      macArtifact: opts.macArtifact,
      winArtifact: opts.winArtifact,
      force: opts.force,
      reason: opts.reason,
    });
    console.log(`published to: ${result.destDir}`);
    console.log(`files: ${result.uploaded.length}, feeds: ${result.feeds.length}`);
  });

program
  .command("promote")
  .description("Copy a channel's artifacts to another channel (24h gate applies for stable)")
  .requiredOption("--from <channel>")
  .requiredOption("--to <channel>")
  .option("--artifact-name <name>")
  .option("--force", "", false)
  .option("--reason <text>")
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const result = await runPromote(ctx, {
      from: opts.from,
      to: opts.to,
      artifactName: opts.artifactName,
      force: opts.force,
      reason: opts.reason,
    });
    if (!result.gate.allowed) {
      console.error(`BLOCKED: ${result.gate.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`copied ${result.copied.length} file(s): ${result.gate.reason}`);
  });

program
  .command("verify-release")
  .description("Re-verify checksums for a published channel directory")
  .requiredOption("--channel-dir <dir>")
  .action(async (opts) => {
    const ctx = contextFromOpts(opts);
    const result = await runVerifyRelease(ctx, opts.channelDir);
    if (!result.ok) {
      console.error(`MISMATCH:\n${result.mismatches.join("\n")}`);
      process.exitCode = 1;
      return;
    }
    console.log("verify-release: OK");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof ReleaseFailClosedError) {
    console.error(`FAILED CLOSED: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});

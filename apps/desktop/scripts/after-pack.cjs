// electron-builder `afterPack` hook: flips the Electron fuses required by the
// brief (§1) — run-as-node off, cookie encryption on, ASAR integrity on.
// electron-builder invokes this with the packaged app's context; it is a
// no-op-safe CommonJS script (no bundler needed) so C00's release pipeline
// can call it unmodified. Uses dynamic `import()` for its dependencies rather
// than `require()` (repo lint policy: no CommonJS `require` imports).

/** @param {import("electron-builder").AfterPackContext} context */
module.exports = async function afterPack(context) {
  const path = await import("node:path");
  const { flipFuses, FuseVersion, FuseV1Options } = await import("@electron/fuses");

  const { electronPlatformName, appOutDir, packager } = context;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const ext = { darwin: ".app", win32: ".exe", linux: "" }[electronPlatformName] ?? "";
  const exeName = packager.appInfo.productFilename;
  const electronExecutable = path.join(
    appOutDir,
    electronPlatformName === "darwin" ? `${exeName}.app` : `${exeName}${ext}`,
  );

  await flipFuses(electronExecutable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};

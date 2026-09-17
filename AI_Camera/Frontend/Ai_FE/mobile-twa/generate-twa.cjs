// One-off generator script — NOT part of the build pipeline. Drives
// @bubblewrap/core directly (the library the `bubblewrap` CLI itself
// wraps) to non-interactively produce two real Trusted Web Activity
// Android projects (Admin, Super Admin), each with its own signing
// keystore, from the two role-scoped web manifests already published in
// Frontend/Ai_FE/public/. Run once per app; re-run only to regenerate
// after changing package id / host / icons.
//
// Usage: node generate-twa.cjs <admin|super-admin>
const path = require("path");
const fs = require("fs");
const CORE_ROOT = path.join(
  require("os").homedir(),
  "AppData/Local/npm-cache/_npx/881cef4662d2c421/node_modules/@bubblewrap/core/dist"
);
const { TwaManifest } = require(path.join(CORE_ROOT, "lib/TwaManifest"));
const { TwaGenerator } = require(path.join(CORE_ROOT, "lib/TwaGenerator"));
const { JdkHelper } = require(path.join(CORE_ROOT, "lib/jdk/JdkHelper"));
const { KeyTool } = require(path.join(CORE_ROOT, "lib/jdk/KeyTool"));
const { Config } = require(path.join(CORE_ROOT, "lib/Config"));
const { ConsoleLog } = require(path.join(CORE_ROOT, "lib/Log"));

// manifestUrl is fetched only to seed icons/name/colors at generation
// time — it does NOT need to be internet-reachable, so it points at a
// local `vite preview` of THIS repo's build (guaranteed to have the
// current manifest content) rather than the live production domain.
// zynex.mita.in does not serve these files yet as of this run (it's
// still on an older deploy — GET /manifest-admin.webmanifest there
// currently 200s with the SPA's index.html, not the manifest JSON,
// because the current production dist/ predates this feature). This
// script never depends on that changing: PRODUCTION_HOST below is set
// independently and is what actually ends up in the generated app.
const LOCAL_PREVIEW = process.env.TWA_MANIFEST_ORIGIN || "http://localhost:4173";
const APPS = {
  admin: {
    manifestUrl: `${LOCAL_PREVIEW}/manifest-admin.webmanifest`,
    packageId: "in.zynez.admin",
    launcherName: "Zynez Admin",
    dir: path.join(__dirname, "admin"),
    // App Links path scope — see patchIntentFilterPathPrefix below. Keeps
    // this app's OS-level "open zynex.mita.in links in this app" claim to
    // its own portal only, so a plain Chrome visit to any OTHER path
    // (the public site, /user/login, the other TWA's portal) is never
    // intercepted by this app even if it's installed. The TWA's own
    // launch (tapping its icon) is completely unaffected either way — it
    // always opens LauncherActivity's fixed DEFAULT_URL directly and
    // never goes through this intent-filter at all.
    intentFilterPathPrefix: "/admin/",
  },
  "super-admin": {
    manifestUrl: `${LOCAL_PREVIEW}/manifest-super-admin.webmanifest`,
    packageId: "in.zynez.superadmin",
    launcherName: "Zynez SuperAdmin",
    dir: path.join(__dirname, "super-admin"),
    intentFilterPathPrefix: "/super-admin/",
  },
};

// Real, live production frontend domain (already deployed — see
// mobile-twa/README.md). Digital Asset Links (assetlinks.json) must be
// served from THIS exact host at /.well-known/assetlinks.json for the
// TWA to open without a URL bar; https://zynex.mita.in/.well-known/
// assetlinks.json already serves it (same dist/ deploy as everything
// else). TWA_HOST can still override for a future domain change.
const PRODUCTION_HOST = process.env.TWA_HOST || "zynex.mita.in";

async function generate(key) {
  const app = APPS[key];
  if (!app) throw new Error(`Unknown app "${key}" — expected one of: ${Object.keys(APPS).join(", ")}`);

  fs.mkdirSync(app.dir, { recursive: true });

  const twaManifest = await TwaManifest.fromWebManifest(app.manifestUrl);
  twaManifest.packageId = app.packageId;
  twaManifest.launcherName = app.launcherName;
  twaManifest.host = PRODUCTION_HOST;
  twaManifest.signingKey.path = path.join(app.dir, "android.keystore");
  twaManifest.signingKey.alias = key.replace("-", "");

  const error = twaManifest.validate();
  if (error) throw new Error(`Invalid TWA manifest for ${key}: ${error}`);

  const generator = new TwaGenerator();
  await generator.createTwaProject(app.dir, twaManifest, new ConsoleLog(key));
  await twaManifest.saveToFile(path.join(app.dir, "twa-manifest.json"));
  patchIntentFilterPathPrefix(app.dir, app.intentFilterPathPrefix);

  // Real, locally-valid signing key (debug/local use) — see
  // mobile-twa/README.md for regenerating your own before a Play Store
  // release. Skipped if a keystore already exists at this path.
  if (!fs.existsSync(twaManifest.signingKey.path)) {
    const config = new Config(
      process.env.JAVA_HOME || "C:/Program Files/Microsoft/jdk-17.0.20.101-hotspot",
      process.env.ANDROID_SDK_ROOT || "C:/Users/JEGAN/AppData/Local/Android/Sdk"
    );
    const jdkHelper = new JdkHelper(process, config);
    const keytool = new KeyTool(jdkHelper);
    await keytool.createSigningKey({
      path: twaManifest.signingKey.path,
      alias: twaManifest.signingKey.alias,
      fullName: "Zynez",
      organizationalUnit: "Engineering",
      organization: "Zynez",
      country: "IN",
      password: "zynezandroid",
      keypassword: "zynezandroid",
    });
  }

  const fingerprintOutput = await keytoolFingerprint(twaManifest);
  console.log(`\n=== ${key} ===`);
  console.log("packageId:", app.packageId);
  console.log("host (update TWA_HOST env for the real domain):", PRODUCTION_HOST);
  console.log("keystore:", twaManifest.signingKey.path);
  console.log("sha256Fingerprint:", fingerprintOutput);
  return { packageId: app.packageId, sha256Fingerprint: fingerprintOutput };
}

// Bubblewrap's own generated AndroidManifest.xml scopes the App Links
// (autoVerify) intent-filter to the whole host with no path restriction
// — <data android:scheme="https" android:host="@string/hostName" />,
// nothing else. That's what let Android's OS-level link-verification
// hand off ANY zynex.mita.in URL (opened normally in Chrome — not
// through this app at all) to whichever of the two apps happens to be
// installed, including the public site and the other app's own login
// page. There's no twa-manifest.json field for this (Bubblewrap doesn't
// expose one), so this patches the generated XML directly, every time
// this script runs — regenerating a project (e.g. after a branding
// change) can never silently drop the fix.
function patchIntentFilterPathPrefix(appDir, pathPrefix) {
  const manifestPath = path.join(appDir, "app/src/main/AndroidManifest.xml");
  const xml = fs.readFileSync(manifestPath, "utf8");

  const unscoped = /<data android:scheme="https"\s*\n\s*android:host="@string\/hostName"\s*\n\s*\n\s*\/>/;

  if (!unscoped.test(xml)) {
    if (xml.includes(`android:pathPrefix="${pathPrefix}"`)) {
      return; // already patched (e.g. re-run without a template change)
    }
    throw new Error(
      `Could not find the expected unscoped App Links <data> element in ${manifestPath} — ` +
        "Bubblewrap's template may have changed; update the regex above."
    );
  }

  const scoped =
    `<data android:scheme="https"\n` +
    `                    android:host="@string/hostName"\n` +
    `                    android:pathPrefix="${pathPrefix}"\n` +
    `                />`;

  fs.writeFileSync(manifestPath, xml.replace(unscoped, scoped));
  console.log(`Patched App Links intent-filter in ${manifestPath} -> pathPrefix="${pathPrefix}"`);
}

async function keytoolFingerprint(twaManifest) {
  const config = new Config(
    process.env.JAVA_HOME || "C:/Program Files/Microsoft/jdk-17.0.20.101-hotspot",
    process.env.ANDROID_SDK_ROOT || "C:/Users/JEGAN/AppData/Local/Android/Sdk"
  );
  const jdkHelper = new JdkHelper(process, config);
  const keytool = new KeyTool(jdkHelper);
  const info = await keytool.keyInfo({
    path: twaManifest.signingKey.path,
    alias: twaManifest.signingKey.alias,
    keypassword: "zynezandroid",
    password: "zynezandroid",
  });
  return info.fingerprints.get("SHA256");
}

async function main() {
  const targets = process.argv[2] ? [process.argv[2]] : Object.keys(APPS);
  const results = {};
  for (const key of targets) {
    results[key] = await generate(key);
  }

  const assetLinks = Object.values(results).map((r) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: r.packageId,
      sha256_cert_fingerprints: [r.sha256Fingerprint],
    },
  }));

  const outDir = path.join(__dirname, "..", "public", ".well-known");
  fs.mkdirSync(outDir, { recursive: true });
  const existingPath = path.join(outDir, "assetlinks.json");
  let merged = assetLinks;
  if (fs.existsSync(existingPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingPath, "utf8"));
      const otherPackages = existing.filter(
        (e) => !assetLinks.some((n) => n.target.package_name === e.target?.package_name)
      );
      merged = [...otherPackages, ...assetLinks];
    } catch {
      // Corrupt/empty existing file — overwrite with the freshly generated entries.
    }
  }
  fs.writeFileSync(existingPath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nWrote ${existingPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

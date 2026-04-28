// Pack every built plugin under packages/<slug>/dist into release artifacts.
//
// For each plugin:
//   - <slug>-v<version>.zip   (versioned, what the GitHub release pins)
//   - <slug>.zip              (unversioned alias — enables a stable
//                              releases/latest/download/<slug>.zip URL)
//
// CRX packing is intentionally not handled here. The realistic install path
// for a self-distributed MV3 extension is "Load unpacked" from the unzipped
// release ZIP — Chrome blocks .crx installs from outside the Web Store on
// the consumer channel anyway.

import { readdirSync, readFileSync, copyFileSync, mkdirSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PACKAGES = resolve(ROOT, "packages");
const OUT = resolve(ROOT, "dist-release");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const slugs = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const built = [];

for (const slug of slugs) {
  const pkgDir = resolve(PACKAGES, slug);
  const distDir = resolve(pkgDir, "dist");
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    console.log(`[skip ] ${slug}: no dist/ — run \`npm run build\` first`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));
  const version = pkg.version ?? "0.0.0";
  const versioned = `${slug}-v${version}.zip`;
  const alias = `${slug}.zip`;
  const versionedPath = resolve(OUT, versioned);
  const aliasPath = resolve(OUT, alias);

  console.log(`[zip  ] ${slug}@${version}`);
  const zip = new AdmZip();
  zip.addLocalFolder(distDir);
  writeFileSync(versionedPath, zip.toBuffer());
  copyFileSync(versionedPath, aliasPath);
  built.push({ slug, version, files: [versioned, alias] });
}

if (built.length === 0) {
  console.error("No plugins built. Did you forget `npm run build`?");
  process.exit(1);
}

console.log("\nRelease assets:");
for (const b of built) {
  for (const f of b.files) console.log(`  dist-release/${f}`);
}

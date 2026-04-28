// Pack dist/ into dist.zip for Chrome Web Store / unpacked-distribution sharing.
// Uses the system `zip` binary so we don't pull in a Node dep just for this.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
if (!existsSync(dist)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}
const out = resolve(root, "dist.zip");
execSync(`rm -f "${out}" && cd "${dist}" && zip -r "${out}" .`, { stdio: "inherit" });
console.log(`Packed ${out}`);

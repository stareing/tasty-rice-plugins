import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const workspaceRoot = resolve(pkgRoot, "../..");
const coreRoot = resolve(workspaceRoot, "node_modules/@ffmpeg/core/dist/umd");
const outRoot = resolve(pkgRoot, "public/ffmpeg");

await mkdir(outRoot, { recursive: true });

for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  await copyFile(resolve(coreRoot, name), resolve(outRoot, name));
}

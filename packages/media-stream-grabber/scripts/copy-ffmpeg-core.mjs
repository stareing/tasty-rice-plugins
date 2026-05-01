import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const workspaceRoot = resolve(pkgRoot, "../..");
// @ffmpeg/ffmpeg v0.12 spawns a *module* Web Worker, so its core loader does
// `(await import(coreURL)).default` once importScripts fails. The UMD build
// has no `export default`, so the load throws "failed to import ffmpeg-core.js".
// The ESM build ends with `export default createFFmpegCore` — that's the build
// the module worker can actually consume.
const coreRoot = resolve(workspaceRoot, "node_modules/@ffmpeg/core/dist/esm");
const outRoot = resolve(pkgRoot, "public/ffmpeg");

await mkdir(outRoot, { recursive: true });

for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  await copyFile(resolve(coreRoot, name), resolve(outRoot, name));
}

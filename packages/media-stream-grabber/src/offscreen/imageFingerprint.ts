import {
  FINGERPRINT_DIM_BLOCK,
  FINGERPRINT_DIM_INPUT,
  FINGERPRINT_LEN,
} from "@/lib/perceptualHash";

/**
 * Perceptual-hash style image fingerprint. Runs in the offscreen document
 * (which is a regular DOM page → full canvas / WebGPU access; co-located
 * with ffmpeg.wasm so we don't bloat the SW or stand up another offscreen
 * lifecycle). Pipeline:
 *
 *   fetch(url) → Blob
 *   createImageBitmap         (decode — Chrome routes to GPU image decode)
 *   OffscreenCanvas('2d')     (resize to 32×32 — Chrome's 2D canvas is GPU-
 *                              accelerated, so the bilinear/cubic resize
 *                              happens on the compositor thread)
 *   getImageData              (one CPU readback — 32×32×4 = 4 KB)
 *   grayscale (BT.709)        (256 floats)
 *   2D DCT-II (row + column)  (precomputed cosine basis, no allocations
 *                              inside the inner loops)
 *   8×8 low-freq block        (drop DC → zero-mean: brightness invariance)
 *   → 64-element Float32Array
 *
 * The result is shipped back to the SW via `image:fingerprint:result`; the
 * SW does the cosine-similarity compare against existing fingerprints in
 * the same aspect-ratio bucket (see `imageDedup.ts`).
 *
 * If we ever need SIFT / template matching / dHash variants, the offscreen
 * is also where OpenCV.js would live — same context, same lifecycle.
 */

const N = FINGERPRINT_DIM_INPUT;
const M = FINGERPRINT_DIM_BLOCK;

// DCT-II cosine basis: cosTable[k * N + n] = cos((π / N) * (n + 0.5) * k).
// Computed once at module load — the table is reused for both the row pass
// and the column pass, which makes the inner DCT loop a tight multiply-add.
const cosTable: Float32Array = (() => {
  const t = new Float32Array(N * N);
  for (let k = 0; k < N; k++) {
    for (let n = 0; n < N; n++) {
      t[k * N + n] = Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
  }
  return t;
})();

export interface FingerprintResult {
  vector: Float32Array;
  width: number;
  height: number;
}

export async function computeImageFingerprint(
  url: string,
  referer?: string,
): Promise<FingerprintResult | undefined> {
  let blob: Blob;
  try {
    const headers: Record<string, string> = {};
    if (referer) headers["Referer"] = referer;
    const res = await fetch(url, {
      headers,
      credentials: "include",
      redirect: "follow",
    });
    if (!res.ok) return undefined;
    blob = await res.blob();
  } catch {
    return undefined;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return undefined;
  }
  const w = bitmap.width;
  const h = bitmap.height;

  let gray: Float32Array;
  try {
    const oc = new OffscreenCanvas(N, N);
    const ctx = oc.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return undefined;
    }
    ctx.imageSmoothingEnabled = true;
    (ctx as { imageSmoothingQuality?: ImageSmoothingQuality }).imageSmoothingQuality =
      "high";
    ctx.drawImage(bitmap, 0, 0, N, N);
    bitmap.close();
    const data = ctx.getImageData(0, 0, N, N).data;
    gray = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      gray[i] =
        (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
    }
  } catch {
    return undefined;
  }

  // Row pass: dctRow[r, k] = Σ_n gray[r, n] * cos((π/N)(n+0.5)k)
  // Only the first M output columns are needed downstream; we still compute
  // all N because the column pass below reads them (we discard the rest at
  // the very end).
  const dctRow = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    const baseG = r * N;
    const baseR = r * N;
    for (let k = 0; k < N; k++) {
      let sum = 0;
      const baseC = k * N;
      for (let n = 0; n < N; n++) sum += gray[baseG + n] * cosTable[baseC + n];
      dctRow[baseR + k] = sum;
    }
  }

  // Column pass: dctCol[k, c] = Σ_r dctRow[r, c] * cos((π/N)(r+0.5)k)
  // We only need the top-left M×M block, so the outer loop bounds k < M
  // — the rest of the spectrum is irrelevant once we've discarded the high
  // frequencies.
  const vector = new Float32Array(FINGERPRINT_LEN);
  for (let c = 0; c < M; c++) {
    for (let k = 0; k < M; k++) {
      let sum = 0;
      const baseC = k * N;
      for (let r = 0; r < N; r++) sum += dctRow[r * N + c] * cosTable[baseC + r];
      // Drop DC (k===0 && c===0) by zeroing it. Brightness invariance:
      // two images that differ only in average luminance still match.
      vector[k * M + c] = k === 0 && c === 0 ? 0 : sum;
    }
  }

  return { vector, width: w, height: h };
}

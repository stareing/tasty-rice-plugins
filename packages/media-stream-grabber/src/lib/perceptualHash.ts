/**
 * Pure helpers for image fingerprint comparison. The fingerprint itself is
 * computed in the offscreen document (`src/offscreen/imageFingerprint.ts`) —
 * 32×32 grayscale → 2D DCT-II → 8×8 low-frequency block (DC zeroed). This
 * module only owns the *consumption* side: aspect-ratio bucketing for
 * grouping and cosine similarity for the actual comparison.
 *
 * Threshold: cosine similarity ≥ 0.99 → near-identical raster (the same
 * photo at two resolutions, or one re-encoded with slightly different
 * quality settings). 0.95–0.99 is "visually similar but distinct" and is
 * intentionally NOT deduped — different crops of the same subject would
 * fall in that band.
 *
 * Aspect bucket: log₂(width/height) rounded to 0.1. Two images with
 * matching ratios within ~7 % land in the same bucket; this is stricter
 * than "same orientation" and looser than "same exact ratio". Photos and
 * their thumbnails share a bucket; a portrait crop of a landscape does not.
 */

/**
 * Resize target before the DCT — must stay a power of 2 multiple of the
 * block dimension so the DCT-II row+column passes are square. 32 is the
 * pHash standard: small enough to keep DCT cheap, large enough to retain
 * structural detail in the low-frequency block.
 */
export const FINGERPRINT_DIM_INPUT = 32;
/** Side of the low-frequency block extracted from the DCT output. */
export const FINGERPRINT_DIM_BLOCK = 8;
/** 64-element feature vector — `block * block`. */
export const FINGERPRINT_LEN = FINGERPRINT_DIM_BLOCK * FINGERPRINT_DIM_BLOCK;

/** Cosine-similarity threshold above which two fingerprints are "the same image". */
export const SIMILARITY_THRESHOLD = 0.99;

/**
 * Discretise the aspect ratio so two images can be quickly tested for
 * "same proportions". Returns "?" for invalid dimensions; otherwise a
 * single decimal of log₂(w/h) (e.g. "0.0" for 1:1, "1.0" for 2:1, "-0.4"
 * for 3:4).
 */
export function aspectBucket(width: number, height: number): string {
  if (!width || !height || !isFinite(width) || !isFinite(height)) return "?";
  const r = Math.log2(width / height);
  return (Math.round(r * 10) / 10).toFixed(1);
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 when
 * either input is empty / zero-magnitude / mismatched length, so callers
 * can treat the result as a similarity score in `[0, 1]` without nullable
 * paths. The dot-product loop is the hottest path in the dedup pipeline —
 * keep it tight, no allocations.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

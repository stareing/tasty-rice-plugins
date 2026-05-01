import {
  SIMILARITY_THRESHOLD,
  aspectBucket,
  cosineSimilarity,
} from "@/lib/perceptualHash";
import type { RuntimeMessage } from "@/lib/types";

/**
 * SW-side image near-duplicate dedup. The actual fingerprint compute (GPU
 * resize + 2D DCT) lives in the offscreen document
 * (`src/offscreen/imageFingerprint.ts`); this module only owns:
 *
 *   1. Per-tab fingerprint cache (`fingerprintsByTab`).
 *   2. Aspect-ratio bucket grouping — only same-proportion images are
 *      compared (per the explicit user requirement: dot-product runs on
 *      same-ratio entries only).
 *   3. Cosine similarity ≥ `SIMILARITY_THRESHOLD` decision + the
 *      "keep larger area" tiebreaker.
 *   4. Serialisation of fingerprint requests so a gallery sniffing 50
 *      images in a burst doesn't spam offscreen with parallel decodes.
 *
 * If we ever need SIFT / dHash / template matching, the offscreen module
 * is where OpenCV.js would live (alongside ffmpeg.wasm). The SW interface
 * (`dedupCheck` / `clearTabFingerprints` / `dropStreamFingerprint`)
 * doesn't change.
 */

interface ImageFingerprint {
  streamId: string;
  url: string;
  bucket: string;
  vector: Float32Array;
  area: number;
}

export type DedupResult =
  | { duplicate: false }
  | {
      duplicate: true;
      loserId: string;
      loserIsNew: boolean;
    };

const fingerprintsByTab = new Map<number, Map<string, ImageFingerprint>>();
let queue: Promise<unknown> = Promise.resolve();

interface PendingRequest {
  resolve: (
    res:
      | { vector: Float32Array; width: number; height: number }
      | undefined,
  ) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingRequests = new Map<string, PendingRequest>();
const FINGERPRINT_TIMEOUT_MS = 8_000;

/**
 * Wired from the SW's main `chrome.runtime.onMessage` handler — call this
 * when a `image:fingerprint:result` broadcast arrives. Decoupled so the
 * SW can keep a single onMessage listener without needing this module to
 * register its own (which would race with the main listener's target gate).
 */
export function handleFingerprintResult(
  msg: Extract<RuntimeMessage, { type: "image:fingerprint:result" }>,
): void {
  const pending = pendingRequests.get(msg.requestId);
  if (!pending) return;
  pendingRequests.delete(msg.requestId);
  clearTimeout(pending.timer);
  if (
    msg.error ||
    !msg.vector ||
    typeof msg.width !== "number" ||
    typeof msg.height !== "number"
  ) {
    pending.resolve(undefined);
    return;
  }
  // Reconstruct the typed array — structuredClone preserves Float32Array,
  // but defensive checks keep us safe if the wire format ever drifts.
  let vector: Float32Array;
  if (msg.vector instanceof Float32Array) {
    vector = msg.vector;
  } else if (ArrayBuffer.isView(msg.vector)) {
    vector = new Float32Array(
      (msg.vector as ArrayBufferView).buffer,
      (msg.vector as ArrayBufferView).byteOffset,
      (msg.vector as ArrayBufferView).byteLength / 4,
    );
  } else {
    pending.resolve(undefined);
    return;
  }
  pending.resolve({ vector, width: msg.width, height: msg.height });
}

/**
 * Public API. Call after admitting an image stream — returns whether the
 * new admission collides with an existing one. The caller then drops the
 * loser (`loserIsNew` distinguishes which side to remove).
 *
 * Requires `ensureOffscreenReady()` to have been awaited at least once
 * before the first call (caller's responsibility — the SW wires this up
 * inside the dedup post-admit path).
 */
export function dedupCheck(args: {
  tabId: number;
  streamId: string;
  url: string;
  referer?: string;
}): Promise<DedupResult> {
  return (queue = queue.then(() => runOne(args))) as Promise<DedupResult>;
}

async function runOne(args: {
  tabId: number;
  streamId: string;
  url: string;
  referer?: string;
}): Promise<DedupResult> {
  const { tabId, streamId, url, referer } = args;
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) {
    return { duplicate: false };
  }

  const requestId = newRequestId();
  const pendingPromise = new Promise<
    { vector: Float32Array; width: number; height: number } | undefined
  >((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(undefined);
    }, FINGERPRINT_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, timer });
  });

  void chrome.runtime
    .sendMessage({
      type: "image:fingerprint:request",
      requestId,
      url,
      referer,
      target: "offscreen",
    } satisfies RuntimeMessage)
    .catch(() => {
      const pending = pendingRequests.get(requestId);
      if (pending) {
        pendingRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(undefined);
      }
    });

  const result = await pendingPromise;
  if (!result) return { duplicate: false };
  const { vector, width, height } = result;

  const bucket = aspectBucket(width, height);
  const area = width * height;
  const fp: ImageFingerprint = { streamId, url, bucket, vector, area };

  let perTab = fingerprintsByTab.get(tabId);
  if (!perTab) {
    perTab = new Map();
    fingerprintsByTab.set(tabId, perTab);
  }

  // Only same-aspect-ratio entries are compared. Different-ratio entries
  // skip the cosine compare entirely — different proportions cannot be the
  // same source image.
  for (const existing of perTab.values()) {
    if (existing.bucket !== bucket) continue;
    if (existing.streamId === streamId) continue;
    const sim = cosineSimilarity(existing.vector, vector);
    if (sim < SIMILARITY_THRESHOLD) continue;
    if (area > existing.area) {
      perTab.set(streamId, fp);
      perTab.delete(existing.streamId);
      return { duplicate: true, loserId: existing.streamId, loserIsNew: false };
    }
    return { duplicate: true, loserId: streamId, loserIsNew: true };
  }

  perTab.set(streamId, fp);
  return { duplicate: false };
}

function newRequestId(): string {
  return (
    "fp-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

export function clearTabFingerprints(tabId: number): void {
  fingerprintsByTab.delete(tabId);
}

export function dropStreamFingerprint(tabId: number, streamId: string): void {
  const perTab = fingerprintsByTab.get(tabId);
  if (!perTab) return;
  perTab.delete(streamId);
  if (perTab.size === 0) fingerprintsByTab.delete(tabId);
}

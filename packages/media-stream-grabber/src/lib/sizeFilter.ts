/**
 * Minimum-size filter — drops tracking pixels / ad jingles / sub-threshold
 * preview clips before they ever reach the popup. Applied at sniff time
 * using the `Content-Length` response header; resources without a length
 * header pass through (we don't second-guess streams of unknown size).
 *
 * Filter only applies to direct binary kinds (`image` / `audio` / `mp4`).
 * Manifests (`hls` / `dash`) and subtitles / danmaku (`text`) are
 * inherently small by design — filtering them by size would silently hide
 * legitimate playlists.
 *
 * User-facing unit is **megabytes** (entered on the Options page); the
 * storage key holds the resolved byte count so the SW can compare directly
 * against `Content-Length` without an extra conversion on the hot path.
 * Default 0 MB — filter is disabled out of the box, opt-in through the
 * options UI.
 */

import type { StreamKind } from "./types";

export const MIN_SIZE_KEY = "msg.minDownloadSize.v1";
export const DEFAULT_MIN_SIZE_BYTES = 0;
export const BYTES_PER_MB = 1024 * 1024;

/** Returns the configured threshold (bytes), falling back to default on error. */
export async function getMinSizeBytes(): Promise<number> {
  try {
    const data = await chrome.storage.local.get(MIN_SIZE_KEY);
    const v = data[MIN_SIZE_KEY];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  } catch {
    /* storage unavailable — fall through to default */
  }
  return DEFAULT_MIN_SIZE_BYTES;
}

/** Persist the threshold (bytes). Setting `0` disables the filter entirely. */
export async function setMinSizeBytes(bytes: number): Promise<void> {
  const safe = Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : 0;
  await chrome.storage.local.set({ [MIN_SIZE_KEY]: safe });
}

/** Convenience for the Options UI which edits the threshold in MB. */
export function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  // Round to two decimals so a 1.5 MB entry round-trips cleanly.
  return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
}

export function mbToBytes(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.round(mb * BYTES_PER_MB);
}

/** True for kinds where the size filter is meaningful. Manifests and text
 *  are exempt (they're tiny by design). */
export function isFilteredKind(kind: StreamKind): boolean {
  return kind === "image" || kind === "audio" || kind === "mp4";
}

/**
 * Decision helper. Returns true when the resource should be admitted; false
 * when it falls below the threshold for a filtered kind. Kinds outside the
 * filtered set always pass.
 */
export function passesSizeFilter(
  kind: StreamKind,
  contentLength: number | undefined,
  minBytes: number,
): boolean {
  if (minBytes <= 0) return true;
  if (!isFilteredKind(kind)) return true;
  if (contentLength === undefined) return true;
  return contentLength >= minBytes;
}

import { hasQualityHint, isIconUrl, isLosslessAudio } from "./streamClassify";
import type { DetectedStream, FocusContext } from "./types";

/**
 * Pure scoring of a sniffed stream against the user's right-click focus.
 * Higher score → more likely the user-intended stream.
 *
 * Inputs are read-only; the function never throws and never touches the
 * network / DOM / storage. Keeping it pure is what lets the SW recompute
 * scores cheaply on every insert without dragging side effects with it.
 *
 * The output is a clamped 0..100 integer. Threshold 70+ is treated by the
 * popup as a "high-confidence" badge; the rest is sort-only signal.
 */
export function scoreStream(
  stream: DetectedStream,
  focus: FocusContext | undefined,
  now: number,
): number {
  let s = 40; // neutral baseline so every row has somewhere to fall from

  // ---- URL / kind shape -----------------------------------------------
  if (stream.kind === "hls" || stream.kind === "dash") s += 25;
  else if (stream.kind === "mp4") s += 15;
  else if (stream.kind === "audio") {
    // Lossless containers (FLAC / WAV / ALAC / DSD) score above lossy
    // formats — when a page exposes both a 320 kbps mp3 preview and a
    // FLAC original, the original is what the user wants.
    const lossless = stream.metadata?.lossless ?? isLosslessAudio(stream.url, stream.mimeType);
    s += lossless ? 12 : 5;
    // Very short audio (< 5 s) is almost always a UI ping / notification
    // rather than music. Penalise hard but don't hide — a 4-second voice
    // memo is still worth surfacing if the user explicitly asked for it.
    const dur = stream.metadata?.durationSec;
    if (typeof dur === "number" && dur > 0 && dur < 5) s -= 20;
  } else if (stream.kind === "image") {
    // Default image penalty stays at -25, but URL hints / dimensions /
    // icon detection adjust it. The popup's "image" category filter still
    // controls whether images are listed at all — this only changes ranking.
    if (stream.metadata?.isIcon || isIconUrl(stream.url, stream.mimeType)) {
      s -= 45;
    } else {
      const w = stream.metadata?.width ?? 0;
      const h = stream.metadata?.height ?? 0;
      const minDim = Math.min(w, h);
      const maxDim = Math.max(w, h);
      if (minDim > 0 && minDim < 64) {
        // Icon-sized — likely an avatar / button graphic.
        s -= 35;
      } else if (maxDim >= 1080) {
        // Photo-sized — bias toward visibility.
        s -= 5;
      } else if (hasQualityHint(stream.url)) {
        // No dimensions probed yet, but the URL says "original" / "large".
        s -= 10;
      } else {
        s -= 25;
      }
    }
  } else if (stream.kind === "text") s -= 10;

  if (MANIFEST_RE.test(stream.url)) s += 10;
  if (AD_HOST_RE.test(stream.url)) s -= 35;
  if (TRACKING_PATH_RE.test(stream.url)) s -= 15;

  // ---- runtime signals ------------------------------------------------
  // Page-crawler hits come from a fetch/XHR the page itself made, so they
  // line up with the actual player far better than tab-wide webRequest
  // captures (which can include preloads, beacons, sibling-frame requests).
  if (stream.source === "page-crawler") s += 10;
  if (stream.mseDetected) s += 8;
  if (stream.drmDetected) s -= 30;

  // ---- focus alignment ------------------------------------------------
  if (focus && focus.tabId !== undefined) {
    if (
      typeof focus.frameId === "number" &&
      typeof stream.frameId === "number" &&
      focus.frameId === stream.frameId
    ) {
      s += 20;
    }

    const dt = stream.detectedAt - focus.clickedAt;
    if (dt < -2_000) {
      // sniffed before the right-click — likely a preload / unrelated request
      s -= 5;
    } else if (dt <= 8_000) {
      s += 18;
    } else if (dt <= 30_000) {
      s += 8;
    }

    // srcUrl is set when the user right-clicked an actual <video>/<audio>/
    // <img>/link with a usable URL. Same host = strong evidence the sniffed
    // request is the player's own traffic. blob:/data: never reach here.
    const focusHost = safeHost(focus.srcUrl);
    if (focusHost) {
      if (safeHost(stream.url) === focusHost) s += 8;
    }
    const pageHost = safeHost(stream.pageUrl);
    if (pageHost && safeHost(stream.url) === pageHost) s += 4;

    // The user explicitly right-clicked an image element → image rows on
    // that frame become the wanted result for once.
    if (focus.mediaTag === "image" && stream.kind === "image") s += 30;
  }

  // ---- staleness ------------------------------------------------------
  // Streams older than ~10min lose a few points so a fresh sniff on the
  // same tab can outrank cached entries the popup still shows.
  const age = now - stream.detectedAt;
  if (age > 10 * 60_000) s -= 5;

  if (s < 0) return 0;
  if (s > 100) return 100;
  return Math.round(s);
}

const MANIFEST_RE = /\.(m3u8|mpd)(\?|$|#)/i;

/**
 * Hostnames known to serve ads / tracking. Matched as a substring of the
 * URL host. The list is intentionally small — false positives turn legit
 * streams into low-ranked rows, which is worse than letting an ad through.
 */
const AD_HOST_RE = new RegExp(
  [
    "doubleclick\\.net",
    "googlesyndication\\.com",
    "googleadservices\\.com",
    "googletagmanager\\.com",
    "google-analytics\\.com",
    "scorecardresearch\\.com",
    "adnxs\\.com",
    "adsystem\\.com",
    "advertising\\.com",
    "criteo\\.(com|net)",
    "moatads\\.com",
    "taboola\\.com",
    "outbrain\\.com",
    "amazon-adsystem\\.com",
    "rubiconproject\\.com",
    "openx\\.net",
    "pubmatic\\.com",
  ].join("|"),
  "i",
);

const TRACKING_PATH_RE = /\/(?:ads?|adserver|beacon|telemetry|pixel|track)\//i;

function safeHost(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return undefined;
  }
}

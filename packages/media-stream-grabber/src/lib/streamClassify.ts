import type { StreamKind } from "./types";

const HLS_PATTERNS = [/\.m3u8(\?|$|#)/i, /application\/(vnd\.apple\.)?mpegurl/i];
const DASH_PATTERNS = [/\.mpd(\?|$|#)/i, /application\/dash\+xml/i];
const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|ts|flv)(\?|$|#)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$|#)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|$|#)/i;

const FILENAME_FORBIDDEN = /[\\/:*?"<>|]+/g;
const FILENAME_TRIM = /^[.\s]+|[.\s]+$/g;

/** Classify a request by URL + Content-Type. Returns null when it is not media. */
export function classify(url: string, contentType?: string): StreamKind | null {
  const ct = (contentType || "").toLowerCase();
  const u = url.split("#")[0];

  if (HLS_PATTERNS.some((re) => re.test(u) || re.test(ct))) return "hls";
  if (DASH_PATTERNS.some((re) => re.test(u) || re.test(ct))) return "dash";

  if (ct.startsWith("video/") || VIDEO_EXT.test(u)) return "mp4";
  if (ct.startsWith("audio/") || AUDIO_EXT.test(u)) return "audio";
  if (ct.startsWith("image/") || IMAGE_EXT.test(u)) return "image";

  return null;
}

export function slugify(input: string, max = 80): string {
  const cleaned = input
    .replace(FILENAME_FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(FILENAME_TRIM, "");
  return cleaned.slice(0, max);
}

function urlBasename(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    return last;
  } catch {
    return "";
  }
}

function extensionFor(kind: StreamKind, fallbackUrl: string): string {
  if (kind === "hls" || kind === "dash") return ".mp4";
  const base = urlBasename(fallbackUrl);
  const m = /\.([a-z0-9]{1,5})(\?|$|#)/i.exec(base);
  return m ? `.${m[1].toLowerCase()}` : "";
}

/**
 * Build a sane filename. Prefer the page title (slugified) so the user sees
 * a meaningful name; fall back to the URL basename. HLS / DASH always end .mp4.
 */
export function suggestedFilename(
  url: string,
  kind: StreamKind,
  pageTitle?: string,
): string {
  const ext = extensionFor(kind, url);
  if (pageTitle) {
    const slug = slugify(pageTitle);
    if (slug) return ext && !slug.toLowerCase().endsWith(ext) ? `${slug}${ext}` : slug;
  }
  const base = urlBasename(url) || "stream";
  const stripped = base.replace(/\.(m3u8|mpd)(\?.*)?$/i, "");
  const slug = slugify(stripped) || "stream";
  return ext && !slug.toLowerCase().endsWith(ext) ? `${slug}${ext}` : slug;
}

/** djb2 hash → base36; cheap, no crypto needed. */
export function hashId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

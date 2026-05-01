import { siteFilenameHint, siteFilenameHintAsync } from "./siteRules";
import type { StreamKind } from "./types";

const HLS_PATTERNS = [/\.m3u8(\?|$|#)/i, /application\/(vnd\.apple\.)?mpegurl/i];
const DASH_PATTERNS = [/\.mpd(\?|$|#)/i, /application\/dash\+xml/i];
const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|ts|flv)(\?|$|#)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$|#)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|$|#)/i;

/**
 * Subtitles + danmaku ("comment scrolling overlay") share a single "text"
 * kind because they're treated identically downstream — direct download,
 * no remux. Patterns split into two pools so we can attach a friendlier
 * sub-label later if the popup wants it; matching either qualifies the URL
 * as kind=text.
 *
 * Subtitle file extensions: WebVTT (.vtt), SubRip (.srt), Advanced SSA
 * (.ass / .ssa), TTML (.ttml / .dfxp), generic (.sub).
 *
 * Danmaku endpoints: Bilibili's two well-known shapes — `comment.bilibili.com/<cid>.xml`
 * for the legacy XML danmaku and `api.bilibili.com/x/v2/dm/web/seg.so` /
 * `…/list.so` for the protobuf v2 segments. Plus generic path-based hints
 * (`/danmaku/`, `/danmu/`) used by independent player SDKs and a handful of
 * regional sites.
 *
 * The danmaku patterns are deliberately path-specific (no bare `.xml` or
 * `.protobuf`) — XML and protobuf are far too generic to classify as media
 * on their own.
 */
const SUBTITLE_EXT = /\.(vtt|srt|ass|ssa|ttml|dfxp|sub)(\?|$|#)/i;
const DANMAKU_PATTERNS = [
  /comment\.bilibili\.com\/[^/]+\.xml(\?|$|#)/i,
  /\/x\/v\d+\/dm\/(?:web\/)?(?:seg\.so|list\.so)/i,
  /\/danmaku\//i,
  /\/danmu\//i,
];
const SUBTITLE_CT = /^(text\/vtt|application\/x-subrip|application\/ttml\+xml)/i;

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

  // Subtitle / danmaku resources. URL extension is checked before
  // content-type because some CDNs serve `.vtt` as `text/plain`.
  if (SUBTITLE_EXT.test(u)) return "text";
  if (DANMAKU_PATTERNS.some((re) => re.test(u))) return "text";
  if (ct && SUBTITLE_CT.test(ct)) return "text";

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

function withExt(slug: string, ext: string): string {
  return ext && !slug.toLowerCase().endsWith(ext) ? `${slug}${ext}` : slug;
}

/**
 * Build a sane filename. Preference order:
 *   1. Page title (slugified) — usually the most meaningful.
 *   2. Site-rule hint (e.g. "YouTube - dQw4w9WgXcQ") when the page URL maps
 *      to a known site — covers titleless tabs and embedded players.
 *   3. URL basename, stripped of `.m3u8` / `.mpd` suffixes.
 * HLS / DASH always end .mp4.
 *
 * Synchronous variant — used in places where awaiting a storage roundtrip
 * is awkward (the popup's optimistic UI). The async variant below
 * additionally honours user-defined site rules from chrome.storage.local.
 */
export function suggestedFilename(
  url: string,
  kind: StreamKind,
  pageTitle?: string,
  pageUrl?: string,
): string {
  const ext = extensionFor(kind, url);
  if (pageTitle) {
    const slug = slugify(pageTitle);
    if (slug) return withExt(slug, ext);
  }
  const hint = siteFilenameHint(pageUrl);
  if (hint) {
    const slug = slugify(hint);
    if (slug) return withExt(slug, ext);
  }
  const base = urlBasename(url) || "stream";
  const stripped = base.replace(/\.(m3u8|mpd)(\?.*)?$/i, "");
  const slug = slugify(stripped) || "stream";
  return withExt(slug, ext);
}

/**
 * Filename derivation with user-defined rule lookup. Falls back to
 * `suggestedFilename` when no user rule matches.
 */
export async function suggestedFilenameAsync(
  url: string,
  kind: StreamKind,
  pageTitle?: string,
  pageUrl?: string,
): Promise<string> {
  const ext = extensionFor(kind, url);
  if (pageTitle) {
    const slug = slugify(pageTitle);
    if (slug) return withExt(slug, ext);
  }
  const hint = await siteFilenameHintAsync(pageUrl);
  if (hint) {
    const slug = slugify(hint);
    if (slug) return withExt(slug, ext);
  }
  return suggestedFilename(url, kind, pageTitle, pageUrl);
}

/** djb2 hash → base36; cheap, no crypto needed. */
export function hashId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

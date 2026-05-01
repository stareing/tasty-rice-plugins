/**
 * Per-site recognition + filename hint helpers.
 *
 * Two reasons this file exists:
 *   1. The popup wants to surface a friendlier "site name" than a raw host
 *      string (`m.youtube.com` → "YouTube").
 *   2. Page titles on video sites are usually noisy (`(123) Foo Bar - YouTube`,
 *      breadcrumbs, view counts). Pulling the canonical video id out of the
 *      URL gives `suggestedFilename` something stable to fall back on when
 *      the title is empty or has been mangled.
 *
 * Hostname-to-site mappings are facts about where these sites live; the
 * URL → id helpers below match each site's *publicly documented* URL shapes
 * (YouTube `?v=`, Vimeo `/video/<id>`, etc.). No third-party code is reused.
 *
 * IMPORTANT: this file deliberately does not implement any page-side hooks
 * (fetch wrapping, MSE interception, MAIN-world probes). The MSG privacy
 * contract — no content scripts, sniff only inside the 30s armed window —
 * still holds. siteRules is read-only metadata.
 */

export interface SiteRule {
  /** Stable id used internally and in metadata payloads. */
  id: string;
  /** Human-readable name for the popup. */
  name: string;
  /** Hostname suffixes — `endsWith` style match against the request host. */
  hostMatches: string[];
  /**
   * Optional: pull a stable id (video id, post id, …) out of the page URL.
   * Returns undefined when the URL doesn't expose one cheaply — callers fall
   * back to the page title or URL basename.
   */
  videoIdFromUrl?: (url: URL) => string | undefined;
}

const RULES: SiteRule[] = [
  {
    id: "youtube",
    name: "YouTube",
    hostMatches: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
    videoIdFromUrl: (url) => {
      // youtu.be/<id>
      if (url.hostname.endsWith("youtu.be")) {
        const m = url.pathname.match(/^\/([\w-]{6,})/);
        return m?.[1];
      }
      // youtube.com/watch?v=<id>
      const v = url.searchParams.get("v");
      if (v && /^[\w-]{6,}$/.test(v)) return v;
      // youtube.com/shorts/<id> | /embed/<id> | /live/<id>
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return m?.[1];
    },
  },
  {
    id: "vimeo",
    name: "Vimeo",
    hostMatches: ["vimeo.com", "player.vimeo.com"],
    videoIdFromUrl: (url) => {
      // vimeo.com/<numeric id> | player.vimeo.com/video/<id>
      const m = url.pathname.match(/^\/(?:video\/)?(\d{5,})/);
      return m?.[1];
    },
  },
  {
    id: "facebook",
    name: "Facebook",
    hostMatches: ["facebook.com", "fb.watch"],
    videoIdFromUrl: (url) => {
      const m = url.pathname.match(/\/videos\/(\d{6,})/);
      return m?.[1];
    },
  },
  {
    id: "instagram",
    name: "Instagram",
    hostMatches: ["instagram.com"],
    videoIdFromUrl: (url) => {
      const m = url.pathname.match(/\/(?:p|reel|tv)\/([\w-]+)/);
      return m?.[1];
    },
  },
  {
    id: "tiktok",
    name: "TikTok",
    hostMatches: ["tiktok.com"],
    videoIdFromUrl: (url) => {
      const m = url.pathname.match(/\/video\/(\d+)/);
      return m?.[1];
    },
  },
  {
    id: "twitter",
    name: "X",
    hostMatches: ["twitter.com", "x.com"],
    videoIdFromUrl: (url) => {
      const m = url.pathname.match(/\/status\/(\d+)/);
      return m?.[1];
    },
  },
  {
    id: "bilibili",
    name: "Bilibili",
    hostMatches: ["bilibili.com"],
    videoIdFromUrl: (url) => {
      // bilibili.com/video/BV<id> or /video/av<id>
      const m = url.pathname.match(/\/video\/(BV[\w]+|av\d+)/i);
      return m?.[1];
    },
  },
  {
    id: "vk",
    name: "VK",
    hostMatches: ["vk.com", "vk.ru", "vkvideo.ru"],
    videoIdFromUrl: (url) => {
      const z = url.searchParams.get("z");
      if (z) {
        const m = z.match(/video(-?\d+_\d+)/);
        if (m) return m[1];
      }
      const m = url.pathname.match(/\/video(-?\d+_\d+)/);
      return m?.[1];
    },
  },
  {
    id: "odnoklassniki",
    name: "OK.ru",
    hostMatches: ["ok.ru"],
    videoIdFromUrl: (url) => {
      const m = url.pathname.match(/\/video\/(\d+)/);
      return m?.[1];
    },
  },
  {
    id: "canva",
    name: "Canva",
    hostMatches: ["canva.com"],
  },
  {
    id: "iqiyi",
    name: "iQ.com",
    hostMatches: ["iq.com", "iqiyi.com"],
  },
];

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith("." + suffix);
}

/** Resolve the site rule for a page URL. Undefined when no rule matches. */
export function siteRuleForUrl(pageUrl: string | undefined): SiteRule | undefined {
  if (!pageUrl) return undefined;
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return RULES.find((r) => r.hostMatches.some((s) => hostMatches(host, s)));
}

/**
 * Best-effort filename hint for a page URL: returns "<site> - <id>" when both
 * are available, "<site>" alone otherwise, or undefined when no rule matches.
 * The caller still owns slugification / extension forcing.
 */
export function siteFilenameHint(pageUrl: string | undefined): string | undefined {
  const rule = siteRuleForUrl(pageUrl);
  if (!rule) return undefined;
  if (!pageUrl) return rule.name;
  let id: string | undefined;
  try {
    id = rule.videoIdFromUrl?.(new URL(pageUrl));
  } catch {
    /* malformed URL — fall through */
  }
  return id ? `${rule.name} - ${id}` : rule.name;
}

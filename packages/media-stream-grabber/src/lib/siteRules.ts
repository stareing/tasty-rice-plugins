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

/* ------------------------- user-defined rules ------------------------- */
//
// The options page persists user rules into chrome.storage.local; the SW
// loads them on each page-URL classification. Rules are intentionally
// declarative (string-typed config, no eval / no custom code) — the
// programmable surface is a regex against the URL plus a filename hint
// template. The privacy contract still holds: nothing in this file
// reaches into the page's runtime; user rules just rename what the
// sniffer / context menu already produces.
//
// A user rule can:
//   - match against URL host suffix (same shape as built-in rules)
//   - extract a video id via a regex applied to URL pathname or full URL
//   - render a filename hint as `${name}` / `${id}` / `${title}` template
//
// Rules with malformed regexes fail fast (caller treats them as missing).

export interface UserSiteRule {
  /** Stable id chosen by the user. */
  id: string;
  /** Human-readable label. */
  name: string;
  /** Hostname suffixes — same `endsWith` match as built-ins. */
  hostMatches: string[];
  /** Optional URL pattern; first capture group becomes `${id}`. */
  idPattern?: string;
  /** `name`/`id`/`title` substitutions; defaults to `${name} - ${id}`. */
  filenameTemplate?: string;
}

const USER_RULES_KEY = "msg.userSiteRules.v1";

let cached: UserSiteRule[] | null = null;
let cachePromise: Promise<UserSiteRule[]> | null = null;

async function loadUserRules(): Promise<UserSiteRule[]> {
  if (cached) return cached;
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    try {
      const data =
        typeof chrome !== "undefined" && chrome.storage?.local
          ? await chrome.storage.local.get(USER_RULES_KEY)
          : {};
      const raw = data[USER_RULES_KEY] as UserSiteRule[] | undefined;
      const list = Array.isArray(raw)
        ? raw.filter(
            (r): r is UserSiteRule =>
              !!r &&
              typeof r.id === "string" &&
              typeof r.name === "string" &&
              Array.isArray(r.hostMatches),
          )
        : [];
      cached = list;
      return list;
    } catch {
      cached = [];
      return [];
    }
  })();
  const out = await cachePromise;
  cachePromise = null;
  return out;
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (USER_RULES_KEY in changes) {
      cached = null;
    }
  });
}

export async function getUserRules(): Promise<UserSiteRule[]> {
  return loadUserRules();
}

export async function saveUserRules(rules: UserSiteRule[]): Promise<void> {
  cached = rules;
  await chrome.storage.local.set({ [USER_RULES_KEY]: rules });
}

function applyTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\$\{(name|id|title)\}/g, (_, key: string) =>
    String(vars[key] ?? ""),
  );
}

function matchUserRule(rule: UserSiteRule, url: URL): string | undefined {
  if (!rule.hostMatches.some((s) => hostMatches(url.hostname.toLowerCase(), s.toLowerCase()))) {
    return undefined;
  }
  let id: string | undefined;
  if (rule.idPattern) {
    try {
      const re = new RegExp(rule.idPattern);
      const m = re.exec(url.toString());
      id = m?.[1] ?? undefined;
    } catch {
      // Malformed regex — skip ID extraction; the rule still applies for
      // the bare `<name>` filename hint.
    }
  }
  const tmpl = rule.filenameTemplate || (id ? "${name} - ${id}" : "${name}");
  return applyTemplate(tmpl, { name: rule.name, id, title: "" });
}

/**
 * Async filename hint that consults user rules first, then falls back to
 * the built-in synchronous hint. Callers that don't want to take the
 * async hop can still call `siteFilenameHint`.
 */
export async function siteFilenameHintAsync(
  pageUrl: string | undefined,
): Promise<string | undefined> {
  if (!pageUrl) return undefined;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  const userRules = await loadUserRules();
  for (const rule of userRules) {
    const hit = matchUserRule(rule, url);
    if (hit) return hit;
  }
  return siteFilenameHint(pageUrl);
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

/**
 * Self-contained scripts injected into target pages via
 * `chrome.scripting.executeScript({ func, args })`. Chrome serialises the
 * function source — these functions MUST NOT reference module-scope
 * identifiers, imports, or TypeScript-only constructs at runtime. They run
 * inside the target page's JavaScript context, so be defensive: catch every
 * throw, never break the page's own fetch/XHR semantics, never report after
 * the armed window expires.
 *
 * Privacy contract: no global hook installed implicitly. The SW only injects
 * these after the user explicitly arms a tab. The hooks become no-ops the
 * moment `armedUntil` elapses; the page-lifetime references survive on
 * `window` but every callback short-circuits.
 */

export interface CrawlerOptions {
  nonce: string;
  armedUntil: number;
}

export interface BridgeOptions {
  nonce: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * MAIN-world crawler. Hooks `window.fetch` and `XMLHttpRequest` to surface
 * media URLs visible only to in-page scripts (e.g. JSON-embedded m3u8 URLs
 * fetched by the player). The hook is idempotent — a second
 * `executeScript` (e.g. when the user re-arms the same tab) only updates
 * the existing instance's armed-until / nonce instead of stacking hooks.
 */
export function installCrawler(opts: CrawlerOptions): void {
  const w = window as any;
  if (w.__msgCrawler) {
    if (typeof opts.armedUntil === "number") {
      w.__msgCrawler.armedUntil = Math.max(
        w.__msgCrawler.armedUntil,
        opts.armedUntil,
      );
    }
    if (typeof opts.nonce === "string") {
      w.__msgCrawler.nonce = opts.nonce;
    }
    return;
  }
  w.__msgCrawler = {
    armedUntil: opts.armedUntil,
    nonce: opts.nonce,
  };

  function isArmed(): boolean {
    const state = w.__msgCrawler;
    return !!state && Date.now() < state.armedUntil;
  }

  function report(url: string, contentType?: string): void {
    try {
      window.postMessage(
        {
          __msg: "msg-crawler",
          nonce: w.__msgCrawler && w.__msgCrawler.nonce,
          url: url,
          contentType: contentType,
          pageUrl: location.href,
        },
        "*",
      );
    } catch (_e) {
      /* ignore */
    }
  }

  const MEDIA_EXT_RE =
    /\.(m3u8|mpd|mp4|m4v|m4s|webm|mov|mkv|mp3|m4a|aac|ogg|opus|flac|wav)(\?|$|#)/i;
  const MEDIA_CT_RE =
    /^(application\/(vnd\.apple\.)?(x-)?mpegurl|application\/dash\+xml|video\/|audio\/)/i;

  function looksMedia(url: string, contentType?: string): boolean {
    try {
      if (typeof url === "string" && MEDIA_EXT_RE.test(url)) return true;
      if (contentType && MEDIA_CT_RE.test(contentType)) return true;
    } catch (_e) {
      /* ignore */
    }
    return false;
  }

  // Hook fetch — forward arguments untouched, observe the resolved Response.
  // Never await before returning the original promise (callers depend on
  // identity / timing). Never read the body — `res.url` and headers are
  // enough, and `.text()` would consume the page's own response.
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (this: any) {
        const args = arguments;
        let result: Promise<Response>;
        try {
          result = origFetch.apply(this, args as any);
        } catch (e) {
          return Promise.reject(e);
        }
        try {
          Promise.resolve(result).then(
            function (res: Response) {
              if (!isArmed()) return;
              try {
                let url = "";
                try {
                  url = (res && res.url) || "";
                } catch (_e) {
                  /* ignore */
                }
                if (!url) {
                  const first: any = args[0];
                  if (typeof first === "string") url = first;
                  else if (first && typeof first.url === "string")
                    url = first.url;
                }
                if (!url) return;
                let ct: string | undefined;
                try {
                  ct =
                    (res &&
                      res.headers &&
                      (res.headers.get("content-type") || undefined)) ||
                    undefined;
                } catch (_e) {
                  ct = undefined;
                }
                if (looksMedia(url, ct)) report(url, ct);
              } catch (_e) {
                /* ignore */
              }
            },
            function () {
              /* upstream rejection — page handles it; nothing to report */
            },
          );
        } catch (_e) {
          /* ignore */
        }
        return result;
      } as typeof window.fetch;
    }
  } catch (_e) {
    /* fetch hook install failed — leave the page alone */
  }

  // Hook XMLHttpRequest. Capture URL at `open()` (responseURL is sometimes
  // empty for cross-origin without CORS), report at `loadend` so we observe
  // both success and failure responses without modifying behaviour.
  try {
    const xhrProto = XMLHttpRequest.prototype;
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;
    xhrProto.open = function (this: any, _method: string, url: string) {
      try {
        this.__msgUrl = typeof url === "string" ? url : String(url);
      } catch (_e) {
        /* ignore */
      }
      return origOpen.apply(this, arguments as any);
    } as any;
    xhrProto.send = function (this: any) {
      try {
        const xhr = this;
        const onLoad = function () {
          if (!isArmed()) return;
          try {
            let url = "";
            try {
              url = xhr.__msgUrl || xhr.responseURL || "";
            } catch (_e) {
              /* ignore */
            }
            if (!url) return;
            let ct: string | undefined;
            try {
              ct =
                (xhr.getResponseHeader &&
                  (xhr.getResponseHeader("content-type") || undefined)) ||
                undefined;
            } catch (_e) {
              ct = undefined;
            }
            if (looksMedia(url, ct)) report(url, ct);
          } catch (_e) {
            /* ignore */
          }
        };
        xhr.addEventListener("load", onLoad);
      } catch (_e) {
        /* ignore */
      }
      return origSend.apply(this, arguments as any);
    } as any;
  } catch (_e) {
    /* XHR hook install failed — leave the page alone */
  }
}

/**
 * ISOLATED-world bridge. Listens for the MAIN-world crawler's
 * `window.postMessage` and forwards them to the SW. Validates the per-arm
 * nonce so a malicious page script can't fabricate reports. Only forwards
 * the four fields the SW actually consumes.
 */
export function installBridge(opts: BridgeOptions): void {
  const w = window as any;
  if (w.__msgBridge) {
    w.__msgBridge.nonce = opts.nonce;
    return;
  }
  w.__msgBridge = { nonce: opts.nonce };

  window.addEventListener("message", function (ev: MessageEvent) {
    try {
      if (ev.source !== window) return;
      const data: any = ev.data;
      if (!data || data.__msg !== "msg-crawler") return;
      if (!w.__msgBridge || data.nonce !== w.__msgBridge.nonce) return;
      if (typeof data.url !== "string" || !data.url) return;
      chrome.runtime
        .sendMessage({
          type: "streams:report-direct",
          url: data.url,
          contentType:
            typeof data.contentType === "string" ? data.contentType : undefined,
          pageUrl:
            typeof data.pageUrl === "string" ? data.pageUrl : undefined,
          target: "sw",
        })
        .catch(function () {
          /* SW evicted / popup closed — nothing to do */
        });
    } catch (_e) {
      /* ignore */
    }
  });
}

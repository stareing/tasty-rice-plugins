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
  /**
   * When true, the SourceBuffer.appendBuffer hook clones every payload
   * and forwards it to the SW. Off by default — capturing megabytes of
   * media bytes is only worth it when the user has explicitly opted in
   * for MSE capture (the page may have a blob: URL with no underlying
   * sniffable manifest).
   */
  mseCapture?: boolean;
}

export interface BridgeOptions {
  nonce: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * MAIN-world crawler. Surfaces media URLs that the SW's webRequest sniffer
 * can't see on its own, plus DRM / MSE runtime signals:
 *
 *   1. Existing `<video>` / `<audio>` retro sweep on install — catches the
 *      already-loaded media when the user arms / page-sniffs after playback
 *      already started, so the user no longer has to reload the page.
 *   2. Live hooks on `HTMLMediaElement.src` setter, `setAttribute("src",…)`,
 *      and a `MutationObserver` for newly-attached players.
 *   3. `window.fetch` / `XMLHttpRequest` hooks — capture URLs, plus a
 *      bounded JSON / text body scan that extracts inline m3u8 / mpd URLs
 *      embedded in player config responses.
 *   4. `navigator.requestMediaKeySystemAccess` and
 *      `MediaSource.prototype.addSourceBuffer` hooks — emit DRM / MSE flags
 *      so the popup can warn the user before a wasted download.
 *
 * All hooks are idempotent — a second `executeScript` (e.g. when the user
 * re-arms the same tab) only updates the existing instance's armed-until /
 * nonce instead of stacking hooks.
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
    if (typeof opts.mseCapture === "boolean") {
      w.__msgCrawler.mseCapture = opts.mseCapture;
    }
    // Re-running the install path triggers a fresh retro sweep so a tab that
    // was page-sniffed *after* a video started playing still surfaces the
    // already-attached `<video>.currentSrc`.
    try {
      if (typeof w.__msgCrawlerSweep === "function") w.__msgCrawlerSweep();
    } catch (_e) {
      /* ignore */
    }
    return;
  }
  w.__msgCrawler = {
    armedUntil: opts.armedUntil,
    nonce: opts.nonce,
    mseCapture: !!opts.mseCapture,
    /** Tabs share a single page; `flagsSent` dedupes DRM/MSE reports so we
     *  don't spam the SW once per `appendBuffer` / `requestMediaKeySystemAccess`
     *  call. The flag is sticky for the page's lifetime. */
    flagsSent: {} as Record<string, boolean>,
  };

  function isArmed(): boolean {
    const state = w.__msgCrawler;
    return !!state && Date.now() < state.armedUntil;
  }

  function postBridge(payload: any): void {
    try {
      window.postMessage(payload, "*");
    } catch (_e) {
      /* ignore */
    }
  }

  function reportUrl(url: string, contentType?: string): void {
    postBridge({
      __msg: "msg-crawler",
      nonce: w.__msgCrawler && w.__msgCrawler.nonce,
      url: url,
      contentType: contentType,
      pageUrl: location.href,
    });
  }

  function reportFlag(flag: string): void {
    try {
      const state = w.__msgCrawler;
      if (!state) return;
      if (state.flagsSent[flag]) return;
      state.flagsSent[flag] = true;
    } catch (_e) {
      /* ignore */
    }
    postBridge({
      __msg: "msg-crawler-flag",
      nonce: w.__msgCrawler && w.__msgCrawler.nonce,
      flag: flag,
      pageUrl: location.href,
    });
  }

  const MEDIA_EXT_RE =
    /\.(m3u8|mpd|mp4|m4v|m4s|webm|mov|mkv|mp3|m4a|aac|ogg|opus|flac|wav)(\?|$|#)/i;
  const MEDIA_CT_RE =
    /^(application\/(vnd\.apple\.)?(x-)?mpegurl|application\/dash\+xml|video\/|audio\/)/i;
  // Body scan only applies to text-shaped payloads; binary types are skipped
  // so we never decode an image / segment body as text.
  const SCANNABLE_CT_RE =
    /^(application\/(json|xml|x-mpegurl|dash\+xml)|text\/)/i;
  // Embedded URL extraction. The character class excludes JSON / HTML quoting
  // characters so we don't grab trailing `"` / `}` / spaces.
  const URL_HLS_RE = /https?:\/\/[^\s"'<>{}\\]+\.m3u8(?:\?[^\s"'<>{}\\]*)?/gi;
  const URL_DASH_RE = /https?:\/\/[^\s"'<>{}\\]+\.mpd(?:\?[^\s"'<>{}\\]*)?/gi;
  const BODY_SCAN_MAX_BYTES = 256 * 1024;

  function looksMedia(url: string, contentType?: string): boolean {
    try {
      if (typeof url === "string" && MEDIA_EXT_RE.test(url)) return true;
      if (contentType && MEDIA_CT_RE.test(contentType)) return true;
    } catch (_e) {
      /* ignore */
    }
    return false;
  }

  function isLiveSrc(value: any): value is string {
    return (
      typeof value === "string" &&
      !!value &&
      value.indexOf("blob:") !== 0 &&
      value.indexOf("data:") !== 0
    );
  }

  function reportElementSources(el: Element | null): void {
    if (!el) return;
    try {
      const direct = (el as any).currentSrc || (el as any).src;
      if (isLiveSrc(direct) && looksMedia(direct)) reportUrl(direct);
      if (el.querySelectorAll) {
        const sources = el.querySelectorAll("source");
        for (let i = 0; i < sources.length; i++) {
          const s = (sources[i] as HTMLSourceElement).src ||
            sources[i].getAttribute("src") || "";
          if (isLiveSrc(s) && looksMedia(s)) reportUrl(s);
        }
      }
    } catch (_e) {
      /* ignore */
    }
  }

  function sweepDom(): void {
    if (!isArmed()) return;
    try {
      if (!document || !document.querySelectorAll) return;
      const els = document.querySelectorAll("video, audio");
      for (let i = 0; i < els.length; i++) reportElementSources(els[i]);
    } catch (_e) {
      /* ignore */
    }
    sweepGlobals();
  }
  // Expose the sweeper so a follow-up arm (re-running installCrawler) can
  // re-scan without redefining hooks.
  w.__msgCrawlerSweep = sweepDom;

  // Server-rendered SPA frameworks dump initial player state on `window` —
  // Next.js (`__NEXT_DATA__`), Nuxt (`__NUXT__`), Vue/Pinia (`__INITIAL_STATE__`),
  // Apollo (`__APOLLO_STATE__`), various player SDKs (`playerConfig`,
  // `playInfo`, `videoData`). When the page hydrates from one of these blobs,
  // the m3u8/mpd URL is already in JS heap before any fetch fires. Walk the
  // documented blobs (cheap, deterministic) plus any other own-property whose
  // value is a string starting with `https://…/master.m3u8` or `…/manifest.mpd`.
  const KNOWN_GLOBALS = [
    "__INITIAL_STATE__",
    "__NUXT__",
    "__NEXT_DATA__",
    "__APOLLO_STATE__",
    "__data",
    "_INITIAL_PROPS_",
    "playerConfig",
    "playInfo",
    "videoData",
    "__playinfo__",
    "__PRELOADED_STATE__",
  ];
  function sweepGlobals(): void {
    if (!isArmed()) return;
    try {
      // Stringify each known blob to a bounded body and reuse the
      // body-scan extractor — m3u8/mpd URLs anywhere inside, however
      // deeply nested, surface the same way.
      for (let i = 0; i < KNOWN_GLOBALS.length; i++) {
        const name = KNOWN_GLOBALS[i];
        try {
          const v = w[name];
          if (!v) continue;
          let s: string;
          if (typeof v === "string") s = v;
          else {
            try { s = JSON.stringify(v); } catch (_e) { continue; }
          }
          if (s) scanBodyForUrls(s);
        } catch (_e) {
          /* ignore — page may have getters that throw */
        }
      }
      // Quick scan over enumerable own-string-properties of `window` so a
      // page that uses an unconventional name (e.g. `bv_player_config`)
      // is still caught. Bounded to short strings to keep the cost trivial.
      try {
        const keys = Object.keys(w);
        for (let i = 0; i < keys.length && i < 200; i++) {
          const v = (w as any)[keys[i]];
          if (typeof v !== "string" || v.length < 8 || v.length > 4096) continue;
          if (v.indexOf(".m3u8") < 0 && v.indexOf(".mpd") < 0) continue;
          scanBodyForUrls(v);
        }
      } catch (_e) {
        /* ignore */
      }
    } catch (_e) {
      /* ignore */
    }
  }

  // Run a few sweeps — once now, once after async player init, once after
  // ad rolls / hydration finish. 1500ms is empirical: most sites attach the
  // real <video>.src within a beat, but YouTube-style players hot-swap it.
  sweepDom();
  try {
    setTimeout(sweepDom, 250);
    setTimeout(sweepDom, 1500);
  } catch (_e) {
    /* ignore */
  }

  // Hook the HTMLMediaElement.src setter so future assignments (the common
  // case — JS sets `video.src = "https://…/master.m3u8"`) are reported even
  // when fetch / XHR aren't involved (e.g. native MP4 playback).
  try {
    const proto = HTMLMediaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "src");
    if (desc && typeof desc.set === "function" && typeof desc.get === "function") {
      const origSet = desc.set;
      const origGet = desc.get;
      Object.defineProperty(proto, "src", {
        configurable: !!desc.configurable,
        enumerable: !!desc.enumerable,
        get: function () {
          return origGet.call(this);
        },
        set: function (value: any) {
          try {
            if (isArmed() && isLiveSrc(value) && looksMedia(value)) {
              reportUrl(value);
            }
          } catch (_e) {
            /* ignore */
          }
          return origSet.call(this, value);
        },
      });
    }
  } catch (_e) {
    /* property re-define refused — fall back to setAttribute hook below */
  }

  // Hook setAttribute("src", …) for video/audio/source — covers libraries
  // that prefer attribute-based assignment (HLS.js sometimes does this).
  try {
    const elProto = Element.prototype;
    const origSetAttr = elProto.setAttribute;
    elProto.setAttribute = function (this: Element, name: string, value: string) {
      try {
        if (
          isArmed() &&
          typeof name === "string" &&
          name.toLowerCase() === "src" &&
          isLiveSrc(value) &&
          looksMedia(value)
        ) {
          const tag = (this && (this as any).tagName)
            ? (this as any).tagName.toLowerCase()
            : "";
          if (tag === "video" || tag === "audio" || tag === "source") {
            reportUrl(value);
          }
        }
      } catch (_e) {
        /* ignore */
      }
      return origSetAttr.apply(this, arguments as any);
    } as typeof elProto.setAttribute;
  } catch (_e) {
    /* ignore */
  }

  // MutationObserver: catches `<video>` elements injected late by a player
  // shell. Subtree=true so the new node anywhere in the DOM is seen.
  try {
    if (typeof MutationObserver === "function") {
      const mo = new MutationObserver(function (records) {
        if (!isArmed()) return;
        try {
          for (let i = 0; i < records.length; i++) {
            const added = records[i].addedNodes;
            for (let j = 0; j < added.length; j++) {
              const n: any = added[j];
              if (!n || n.nodeType !== 1) continue;
              const tag = n.tagName ? n.tagName.toLowerCase() : "";
              if (tag === "video" || tag === "audio") {
                reportElementSources(n as Element);
              } else if (typeof n.querySelectorAll === "function") {
                const inner = n.querySelectorAll("video, audio");
                for (let k = 0; k < inner.length; k++) {
                  reportElementSources(inner[k]);
                }
              }
            }
          }
        } catch (_e) {
          /* ignore */
        }
      });
      const start = function () {
        try {
          if (document && document.documentElement) {
            mo.observe(document.documentElement, {
              childList: true,
              subtree: true,
            });
          }
        } catch (_e) {
          /* ignore */
        }
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
      } else {
        start();
      }
    }
  } catch (_e) {
    /* ignore */
  }

  // EME hook — flags the page as DRM-protected. We don't capture the license
  // request itself; just letting the popup mark "encrypted" before the probe
  // round-trip saves the user from a wasted download attempt.
  try {
    const nav: any = navigator;
    if (nav && typeof nav.requestMediaKeySystemAccess === "function") {
      const orig = nav.requestMediaKeySystemAccess.bind(nav);
      nav.requestMediaKeySystemAccess = function () {
        try {
          if (isArmed()) reportFlag("drm");
        } catch (_e) {
          /* ignore */
        }
        return orig.apply(nav, arguments);
      };
    }
  } catch (_e) {
    /* ignore */
  }

  // MSE hook — flags the page as using MediaSource and (when capture is
  // enabled) clones every SourceBuffer.appendBuffer payload. The clone is
  // forwarded to the bridge → SW → offscreen pipe so the offscreen can
  // write it to OPFS and assemble a downloadable file. The clone is shape-
  // and reference-safe: we read from a fresh Uint8Array view over the
  // payload's underlying buffer before the page's appendBuffer runs, so
  // even if the page reuses the same ArrayBuffer for the next chunk our
  // copy is independent.
  try {
    if (typeof MediaSource !== "undefined" && MediaSource.prototype) {
      const origASB = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime: string) {
        try {
          if (isArmed()) reportFlag("mse");
        } catch (_e) {
          /* ignore */
        }
        const sb: SourceBuffer = origASB.apply(this, arguments as any);
        try {
          const state = w.__msgCrawler;
          if (state) {
            // Track session-id per SourceBuffer so multi-track players
            // (separate audio + video buffers) don't intermix payloads.
            const sessionId =
              "mse-" + Date.now().toString(36) + "-" +
              Math.random().toString(36).slice(2, 8);
            (sb as any).__msgSessionId = sessionId;
            (sb as any).__msgMime = typeof mime === "string" ? mime : undefined;
            (sb as any).__msgOrdinal = 0;
            (sb as any).__msgInitSent = false;
          }
        } catch (_e) {
          /* ignore */
        }
        return sb;
      };

      const origAppend = (SourceBuffer.prototype as any).appendBuffer;
      if (typeof origAppend === "function") {
        (SourceBuffer.prototype as any).appendBuffer = function (
          data: ArrayBuffer | ArrayBufferView,
        ) {
          try {
            const state = w.__msgCrawler;
            // Capture is opt-in — the SW arms the global flag through the
            // bridge nonce update path. `mseCapture` defaults false so an
            // arm by itself never copies bytes.
            if (state && state.mseCapture && isArmed() && data) {
              const view =
                data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : new Uint8Array(
                      (data as ArrayBufferView).buffer,
                      (data as ArrayBufferView).byteOffset,
                      (data as ArrayBufferView).byteLength,
                    );
              // Defensive copy — the page may reuse the source buffer.
              const copy = new Uint8Array(view.byteLength);
              copy.set(view);
              const sessionId = (this as any).__msgSessionId;
              const mime = (this as any).__msgMime;
              const ordinal = ((this as any).__msgOrdinal =
                ((this as any).__msgOrdinal || 0) + 1);
              const isInit = !((this as any).__msgInitSent);
              (this as any).__msgInitSent = true;
              postBridge({
                __msg: "msg-mse-chunk",
                nonce: state.nonce,
                sessionId: sessionId,
                mimeType: mime,
                bytes: copy,
                isInit: isInit,
                ordinal: ordinal,
              });
            }
          } catch (_e) {
            /* ignore — must not break playback */
          }
          return origAppend.apply(this, arguments as any);
        };
      }
    }
  } catch (_e) {
    /* ignore */
  }

  function scanBodyForUrls(text: string): void {
    if (!text || text.length > BODY_SCAN_MAX_BYTES) return;
    try {
      const seen: Record<string, boolean> = {};
      let m: RegExpExecArray | null;
      URL_HLS_RE.lastIndex = 0;
      while ((m = URL_HLS_RE.exec(text)) !== null) {
        const u = m[0];
        if (!seen[u]) {
          seen[u] = true;
          reportUrl(u, "application/vnd.apple.mpegurl");
        }
        if (URL_HLS_RE.lastIndex === m.index) URL_HLS_RE.lastIndex++;
      }
      URL_DASH_RE.lastIndex = 0;
      while ((m = URL_DASH_RE.exec(text)) !== null) {
        const u = m[0];
        if (!seen[u]) {
          seen[u] = true;
          reportUrl(u, "application/dash+xml");
        }
        if (URL_DASH_RE.lastIndex === m.index) URL_DASH_RE.lastIndex++;
      }
    } catch (_e) {
      /* ignore */
    }
  }

  // Hook fetch — forward arguments untouched, observe the resolved Response.
  // Never await before returning the original promise (callers depend on
  // identity / timing). For the body scan we use `res.clone()` so the
  // page's own consumer still sees an untouched stream.
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
                if (url && looksMedia(url, ct)) reportUrl(url, ct);

                // Inline manifest extraction: if the response looks like a
                // small player-config blob, decode and scan for embedded
                // m3u8 / mpd URLs. Bail on giant bodies to keep the cost
                // bounded — a 50 MB transcript shouldn't trigger a 50 MB
                // string allocation.
                if (ct && SCANNABLE_CT_RE.test(ct)) {
                  let len = -1;
                  try {
                    const cl =
                      (res.headers && res.headers.get("content-length")) || "";
                    if (cl) len = parseInt(cl, 10) || -1;
                  } catch (_e) {
                    /* ignore */
                  }
                  if (len < 0 || len <= BODY_SCAN_MAX_BYTES) {
                    let cloned: Response | null = null;
                    try {
                      cloned = res.clone();
                    } catch (_e) {
                      cloned = null;
                    }
                    if (cloned) {
                      cloned
                        .text()
                        .then(function (txt: string) {
                          if (!isArmed()) return;
                          scanBodyForUrls(txt);
                        })
                        .catch(function () {
                          /* body already consumed / abort — ignore */
                        });
                    }
                  }
                }
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
  // both success and failure responses without modifying behaviour. Body
  // scan piggy-backs on the existing `responseText` we already have.
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
            let ct: string | undefined;
            try {
              ct =
                (xhr.getResponseHeader &&
                  (xhr.getResponseHeader("content-type") || undefined)) ||
                undefined;
            } catch (_e) {
              ct = undefined;
            }
            if (url && looksMedia(url, ct)) reportUrl(url, ct);
            if (ct && SCANNABLE_CT_RE.test(ct)) {
              try {
                // responseType "" / "text" → readable string; other types
                // are skipped (arraybuffer / blob would need decode).
                const rt = xhr.responseType;
                if (rt === "" || rt === "text") {
                  const txt = xhr.responseText;
                  if (typeof txt === "string" && txt.length <= BODY_SCAN_MAX_BYTES) {
                    scanBodyForUrls(txt);
                  }
                }
              } catch (_e) {
                /* ignore */
              }
            }
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
 * MAIN-world proxy-fetch endpoint. The page's own JS context owns the
 * cookies / Authorization headers / interceptors that authenticate against
 * its CDN. When the offscreen-document fetch hits 401/403 (because DNR
 * Referer rewriting wasn't enough — e.g. the CDN signs requests with a
 * page-runtime token), the SW asks this hook to refetch *from the page*
 * and ship the bytes back. From the CDN's perspective the request is
 * indistinguishable from one the page would issue on its own — same
 * origin, same cookies, same custom headers.
 *
 * Privacy: the bridge gates every proxy call on the per-arm nonce, and
 * the offscreen only attempts this fallback inside a job the user
 * explicitly started. The hook is a no-op outside that window.
 */
export function installProxyFetch(opts: BridgeOptions): void {
  const w = window as any;
  if (w.__msgProxyFetch) {
    w.__msgProxyFetch.nonce = opts.nonce;
    return;
  }
  w.__msgProxyFetch = { nonce: opts.nonce };

  window.addEventListener("message", function (ev: MessageEvent) {
    try {
      if (ev.source !== window) return;
      const data: any = ev.data;
      if (!data || data.__msg !== "msg-proxy-fetch-request") return;
      if (!w.__msgProxyFetch || data.nonce !== w.__msgProxyFetch.nonce) return;
      const reqId: string = data.reqId;
      const url: string = data.url;
      const headers: Record<string, string> = data.headers || {};
      const method: string = data.method || "GET";
      if (typeof url !== "string" || !url) return;

      function reply(payload: any): void {
        try {
          window.postMessage(
            {
              __msg: "msg-proxy-fetch-response",
              nonce: w.__msgProxyFetch && w.__msgProxyFetch.nonce,
              reqId: reqId,
              ...payload,
            },
            "*",
          );
        } catch (_e) {
          /* ignore */
        }
      }

      // `credentials: include` — same-origin cookies travel automatically;
      // cross-origin only travels when the CDN explicitly opts in via CORS.
      // Either way the page-side fetch matches what the page would do.
      try {
        const init: any = { method: method, credentials: "include", headers: headers };
        Promise.resolve(fetch(url, init))
          .then(function (res: Response) {
            const status = res.status;
            return res
              .arrayBuffer()
              .then(function (buf: ArrayBuffer) {
                reply({
                  ok: res.ok,
                  status: status,
                  bytes: new Uint8Array(buf),
                });
              })
              .catch(function (err: any) {
                reply({ ok: false, status: status, error: String(err && err.message || err) });
              });
          })
          .catch(function (err: any) {
            reply({ ok: false, status: 0, error: String(err && err.message || err) });
          });
      } catch (err: any) {
        reply({ ok: false, status: 0, error: String(err && err.message || err) });
      }
    } catch (_e) {
      /* ignore */
    }
  });
}

/**
 * ISOLATED-world bridge. Listens for the MAIN-world crawler's
 * `window.postMessage` and forwards them to the SW. Validates the per-arm
 * nonce so a malicious page script can't fabricate reports. Forwards three
 * envelope shapes: `msg-crawler` (URL report), `msg-crawler-flag`
 * (DRM / MSE detection), and `msg-mse-chunk` (captured SourceBuffer chunk).
 *
 * Also exposes the proxy-fetch reverse path: SW → bridge → MAIN-world hook
 * → page fetch → MAIN → bridge → SW. The SW addresses the bridge with a
 * `tabs.sendMessage`-tagged envelope `target: "page-proxy"`.
 */
export function installBridge(opts: BridgeOptions): void {
  const w = window as any;
  if (w.__msgBridge) {
    w.__msgBridge.nonce = opts.nonce;
    return;
  }
  w.__msgBridge = {
    nonce: opts.nonce,
    pendingProxy: {} as Record<string, (resp: any) => void>,
  };

  window.addEventListener("message", function (ev: MessageEvent) {
    try {
      if (ev.source !== window) return;
      const data: any = ev.data;
      if (!data || !w.__msgBridge || data.nonce !== w.__msgBridge.nonce) return;

      if (data.__msg === "msg-crawler") {
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
        return;
      }

      if (data.__msg === "msg-crawler-flag") {
        if (data.flag !== "drm" && data.flag !== "mse") return;
        chrome.runtime
          .sendMessage({
            type: "streams:report-flag",
            flag: data.flag,
            pageUrl:
              typeof data.pageUrl === "string" ? data.pageUrl : undefined,
            target: "sw",
          })
          .catch(function () {
            /* SW evicted — drop */
          });
        return;
      }

      if (data.__msg === "msg-mse-chunk") {
        // MSE binary capture relay. The MAIN-world hook hands raw
        // SourceBuffer payloads to the bridge; we forward them to the SW
        // which writes to OPFS through the offscreen document.
        try {
          chrome.runtime
            .sendMessage({
              type: "mse:chunk",
              sessionId: data.sessionId,
              mimeType: data.mimeType,
              bytes: data.bytes,
              isInit: !!data.isInit,
              ordinal: data.ordinal,
              target: "sw",
            })
            .catch(function () {
              /* SW evicted — drop chunk */
            });
        } catch (_e) {
          /* ignore */
        }
        return;
      }

      if (data.__msg === "msg-proxy-fetch-response") {
        // Reply from the MAIN-world proxy fetch — resolve the pending SW
        // request that's waiting on this reqId.
        try {
          const cb = w.__msgBridge.pendingProxy[data.reqId];
          if (cb) {
            delete w.__msgBridge.pendingProxy[data.reqId];
            cb(data);
          }
        } catch (_e) {
          /* ignore */
        }
        return;
      }
    } catch (_e) {
      /* ignore */
    }
  });

  // SW → bridge channel. Only `target: "page-proxy"` envelopes are honoured.
  // Reply via `sendResponse` so the SW can await the result.
  chrome.runtime.onMessage.addListener(function (msg: any, _sender: any, sendResponse: any) {
    try {
      if (!msg || msg.target !== "page-proxy") return false;
      if (msg.type !== "page-proxy:fetch") return false;
      const reqId = "p" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      const state = w.__msgBridge;
      if (!state) {
        sendResponse({ ok: false, status: 0, error: "bridge-not-initialised" });
        return false;
      }
      state.pendingProxy[reqId] = function (resp: any) {
        try { sendResponse(resp); } catch (_e) { /* ignore */ }
      };
      try {
        window.postMessage(
          {
            __msg: "msg-proxy-fetch-request",
            nonce: state.nonce,
            reqId: reqId,
            url: msg.url,
            method: msg.method || "GET",
            headers: msg.headers || {},
          },
          "*",
        );
      } catch (e: any) {
        delete state.pendingProxy[reqId];
        sendResponse({ ok: false, status: 0, error: String(e && e.message || e) });
        return false;
      }
      // Async reply.
      return true;
    } catch (_e) {
      return false;
    }
  });
}

/**
 * Minimal DASH MPD parser. Handles the realistic OTT case:
 *   - Single static Period (live MPDs and multi-period assets are out of scope)
 *   - BaseURL chain (MPD → Period → AdaptationSet → Representation)
 *   - SegmentTemplate inherited from AdaptationSet to Representation
 *   - Number-based segments via @duration + (period|MPD) duration
 *   - SegmentTimeline with <S t d r> triples
 *   - Templates: $RepresentationID$, $Number$, $Bandwidth$, $Time$, $$
 *
 * What it does NOT do (yet):
 *   - SegmentBase / SegmentList
 *   - DRM (ClearKey, Widevine, PlayReady) — DASH segments are returned raw
 *   - Multi-period concatenation
 *   - Live (dynamic) MPDs
 */

export interface DashSegmentRef {
  uri: string;
  /** Segment duration in seconds. */
  duration: number;
}

export interface DashRepresentation {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
  /** Initialization segment URL — fMP4 init for nearly all DASH. */
  initUrl?: string;
  segments: DashSegmentRef[];
}

export interface DashAdaptationSet {
  id: string;
  contentType: "video" | "audio" | "text" | "unknown";
  mimeType?: string;
  lang?: string;
  /** Whether this set is a "default" subtitle / audio track. */
  default: boolean;
  representations: DashRepresentation[];
}

export interface DashManifest {
  videoSets: DashAdaptationSet[];
  audioSets: DashAdaptationSet[];
  textSets: DashAdaptationSet[];
}

const ISO_DURATION_RE = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function parseIsoDuration(text: string | null | undefined): number {
  if (!text) return 0;
  const m = ISO_DURATION_RE.exec(text.trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return (
    Number(y || 0) * 31_536_000 +
    Number(mo || 0) * 2_592_000 +
    Number(d || 0) * 86_400 +
    Number(h || 0) * 3_600 +
    Number(mi || 0) * 60 +
    Number(s || 0)
  );
}

function resolveBase(parent: string, child: string | null | undefined): string {
  if (!child) return parent;
  try {
    return new URL(child, parent).toString();
  } catch {
    return parent;
  }
}

function firstChild(node: Element, tag: string): Element | null {
  for (const c of Array.from(node.children)) {
    if (c.localName === tag) return c;
  }
  return null;
}

function children(node: Element, tag: string): Element[] {
  return Array.from(node.children).filter((c) => c.localName === tag);
}

function attr(node: Element | null | undefined, name: string): string | undefined {
  if (!node) return undefined;
  const v = node.getAttribute(name);
  return v == null ? undefined : v;
}

function applyTemplate(
  template: string,
  vars: { representationId: string; bandwidth: number; number?: number; time?: number },
): string {
  return template.replace(/\$(\$|RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, key: string, pad?: string) => {
    if (key === "$") return "$";
    let value: number | string;
    switch (key) {
      case "RepresentationID":
        value = vars.representationId;
        break;
      case "Bandwidth":
        value = vars.bandwidth;
        break;
      case "Number":
        value = vars.number ?? 0;
        break;
      case "Time":
        value = vars.time ?? 0;
        break;
      default:
        return "";
    }
    if (pad && typeof value === "number") {
      return String(value).padStart(Number(pad), "0");
    }
    return String(value);
  });
}

interface InheritedTemplate {
  initialization?: string;
  media?: string;
  startNumber: number;
  timescale: number;
  duration?: number;
  segmentTimeline?: { t: number; d: number; r: number }[];
}

function readSegmentTemplate(
  parent: InheritedTemplate | undefined,
  el: Element | null,
): InheritedTemplate | undefined {
  if (!el && !parent) return undefined;
  const merged: InheritedTemplate = {
    initialization: parent?.initialization,
    media: parent?.media,
    startNumber: parent?.startNumber ?? 1,
    timescale: parent?.timescale ?? 1,
    duration: parent?.duration,
    segmentTimeline: parent?.segmentTimeline,
  };
  if (!el) return merged;
  if (attr(el, "initialization")) merged.initialization = attr(el, "initialization");
  if (attr(el, "media")) merged.media = attr(el, "media");
  if (attr(el, "startNumber")) merged.startNumber = Number(attr(el, "startNumber"));
  if (attr(el, "timescale")) merged.timescale = Number(attr(el, "timescale"));
  if (attr(el, "duration")) merged.duration = Number(attr(el, "duration"));
  const timeline = firstChild(el, "SegmentTimeline");
  if (timeline) {
    merged.segmentTimeline = children(timeline, "S").map((s) => ({
      t: Number(attr(s, "t") ?? 0),
      d: Number(attr(s, "d") ?? 0),
      r: Number(attr(s, "r") ?? 0),
    }));
  }
  return merged;
}

function expandSegments(
  tpl: InheritedTemplate,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
  periodDurationSec: number,
): { initUrl?: string; segments: DashSegmentRef[] } {
  const initUrl = tpl.initialization
    ? resolveBase(
        baseUrl,
        applyTemplate(tpl.initialization, { representationId, bandwidth }),
      )
    : undefined;

  if (!tpl.media) return { initUrl, segments: [] };

  const segments: DashSegmentRef[] = [];

  if (tpl.segmentTimeline && tpl.segmentTimeline.length) {
    let number = tpl.startNumber;
    let time = 0;
    for (const s of tpl.segmentTimeline) {
      let curTime = s.t > 0 || time === 0 ? s.t : time;
      const repeat = s.r >= 0 ? s.r : 0;
      for (let i = 0; i <= repeat; i++) {
        const uri = resolveBase(
          baseUrl,
          applyTemplate(tpl.media, {
            representationId,
            bandwidth,
            number,
            time: curTime,
          }),
        );
        segments.push({ uri, duration: s.d / tpl.timescale });
        curTime += s.d;
        number++;
      }
      time = curTime;
    }
    return { initUrl, segments };
  }

  if (!tpl.duration) return { initUrl, segments };

  const segDurSec = tpl.duration / tpl.timescale;
  const count = segDurSec > 0 ? Math.ceil(periodDurationSec / segDurSec) : 0;
  for (let i = 0; i < count; i++) {
    const number = tpl.startNumber + i;
    const uri = resolveBase(
      baseUrl,
      applyTemplate(tpl.media, {
        representationId,
        bandwidth,
        number,
        time: i * tpl.duration,
      }),
    );
    segments.push({ uri, duration: segDurSec });
  }
  return { initUrl, segments };
}

function classifyContentType(mimeType: string | undefined, hint: string | undefined): DashAdaptationSet["contentType"] {
  const m = (mimeType || hint || "").toLowerCase();
  if (m.startsWith("video")) return "video";
  if (m.startsWith("audio")) return "audio";
  if (m.startsWith("text") || m.includes("vtt") || m.includes("ttml")) return "text";
  return "unknown";
}

export function parseMpd(xmlText: string, mpdUrl: string): DashManifest {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== "MPD") {
    throw new Error("Not an MPD document.");
  }

  const mpdBaseEl = firstChild(mpd, "BaseURL");
  const mpdBaseUrl = mpdBaseEl
    ? resolveBase(mpdUrl, mpdBaseEl.textContent?.trim() || "")
    : mpdUrl;

  const period = firstChild(mpd, "Period");
  if (!period) throw new Error("MPD has no Period.");

  const periodBaseEl = firstChild(period, "BaseURL");
  const periodBase = periodBaseEl
    ? resolveBase(mpdBaseUrl, periodBaseEl.textContent?.trim() || "")
    : mpdBaseUrl;

  const totalDurationSec =
    parseIsoDuration(attr(period, "duration")) ||
    parseIsoDuration(attr(mpd, "mediaPresentationDuration"));

  const adaptations = children(period, "AdaptationSet");
  const sets: DashAdaptationSet[] = [];

  for (let aIdx = 0; aIdx < adaptations.length; aIdx++) {
    const a = adaptations[aIdx];
    const aBaseEl = firstChild(a, "BaseURL");
    const aBase = aBaseEl
      ? resolveBase(periodBase, aBaseEl.textContent?.trim() || "")
      : periodBase;

    const aTemplate = readSegmentTemplate(undefined, firstChild(a, "SegmentTemplate"));
    const aMime = attr(a, "mimeType") || attr(a, "contentType");
    const contentType = classifyContentType(attr(a, "mimeType"), attr(a, "contentType"));

    const reps = children(a, "Representation");
    const representations: DashRepresentation[] = [];

    for (const r of reps) {
      const rBaseEl = firstChild(r, "BaseURL");
      const rBase = rBaseEl
        ? resolveBase(aBase, rBaseEl.textContent?.trim() || "")
        : aBase;
      const rTemplate = readSegmentTemplate(aTemplate, firstChild(r, "SegmentTemplate"));
      const rId = attr(r, "id") || `rep${representations.length}`;
      const rBandwidth = Number(attr(r, "bandwidth") || 0);
      if (!rTemplate?.media) continue; // SegmentBase / SegmentList not yet supported

      const { initUrl, segments } = expandSegments(
        rTemplate,
        rId,
        rBandwidth,
        rBase,
        totalDurationSec,
      );
      if (!segments.length) continue;

      representations.push({
        id: rId,
        bandwidth: rBandwidth,
        width: attr(r, "width") ? Number(attr(r, "width")) : undefined,
        height: attr(r, "height") ? Number(attr(r, "height")) : undefined,
        codecs: attr(r, "codecs") || attr(a, "codecs"),
        mimeType: attr(r, "mimeType") || aMime,
        initUrl,
        segments,
      });
    }

    if (!representations.length) continue;

    sets.push({
      id: attr(a, "id") || `as${aIdx}`,
      contentType,
      mimeType: aMime,
      lang: attr(a, "lang"),
      default: attr(a, "default") === "true",
      representations,
    });
  }

  return {
    videoSets: sets.filter((s) => s.contentType === "video"),
    audioSets: sets.filter((s) => s.contentType === "audio"),
    textSets: sets.filter((s) => s.contentType === "text"),
  };
}

/** Sort DASH representations the same way HLS variants are: height-first. */
export function compareRepresentationsBest(
  a: DashRepresentation,
  b: DashRepresentation,
): number {
  const ha = a.height ?? 0;
  const hb = b.height ?? 0;
  if (ha !== hb) return hb - ha;
  return b.bandwidth - a.bandwidth;
}

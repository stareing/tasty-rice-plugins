/**
 * HLS playlist parser. Handles:
 *   - master playlist (#EXT-X-STREAM-INF) with all variant attrs incl.
 *     VIDEO-RANGE (SDR/HLG/PQ — i.e. HDR signal) and FRAME-RATE
 *   - alternate renditions (#EXT-X-MEDIA TYPE=AUDIO/SUBTITLES/VIDEO)
 *   - media playlist with relative or absolute URIs
 *   - byte-range segments (#EXT-X-BYTERANGE)
 *   - AES-128 keys (#EXT-X-KEY METHOD=AES-128, IV=...) with rotation
 *   - fMP4 init segments (#EXT-X-MAP) — required for any modern ≥1080p stream
 *   - #EXT-X-MEDIA-SEQUENCE (required to compute the default IV per RFC 8216
 *     §5.2 when an explicit IV attribute is absent — using array index would
 *     decrypt to garbage on any stream where MEDIA-SEQUENCE != 0)
 *   - DRM hints (#EXT-X-SESSION-KEY at master level + non-AES-128 #EXT-X-KEY
 *     in media playlists), classified via KEYFORMAT — FairPlay / Widevine /
 *     PlayReady / ClearKey. We do NOT implement the EME flow; classification
 *     lets the SW fail early with a human-readable message instead of
 *     downloading 200 segments and producing garbage MP4.
 *   - Live vs VOD distinction (#EXT-X-PLAYLIST-TYPE + presence of
 *     #EXT-X-ENDLIST per RFC 8216 §4.3.3.4-5). A live playlist's segment
 *     list slides; merging it into a single MP4 makes no sense.
 *
 * Still NOT handled: SAMPLE-AES playback (we only detect-and-bail).
 */

export interface HlsKey {
  method: "AES-128";
  uri: string;
  iv?: Uint8Array;
}

/** HLS dynamic-range signal — see RFC 8216-bis VIDEO-RANGE attribute. */
export type HlsVideoRange = "SDR" | "HLG" | "PQ";

/**
 * DRM systems we can recognise from KEYFORMAT. We never decrypt these — the
 * point of recognising them is to refuse the job up-front.
 */
export type HlsDrmSystem =
  | "fairplay"
  | "widevine"
  | "playready"
  | "clearkey"
  | "unknown";

/** Default-IV-only AES-128 encrypts segments with a key the parser CAN fetch.
 *  Anything else is content-protection that requires an EME flow. */
export type HlsLiveness = "vod" | "event" | "live";

export interface HlsByteRange {
  length: number;
  offset: number;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  byteRange?: HlsByteRange;
  key?: HlsKey;
  /**
   * Absolute Media Sequence Number (RFC 8216 §4.3.3.2). Required to compute
   * the default AES-128 IV — using the playlist-relative array index instead
   * decrypts to garbage on any stream that does not start with sequence 0.
   */
  sequence: number;
}

export interface HlsInitSegment {
  uri: string;
  byteRange?: HlsByteRange;
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[];
  totalDuration: number;
  /** From #EXT-X-MAP — fMP4 init segment, played before any media segment. */
  initSegment?: HlsInitSegment;
  /** Media Sequence Number of the first segment. Defaults to 0 per spec. */
  mediaSequence: number;
  /** vod / event / live — see HlsLiveness. Defaults to vod when ENDLIST present. */
  liveness: HlsLiveness;
  /** DRM systems referenced by any non-AES-128 #EXT-X-KEY in this playlist. */
  drmSystems: HlsDrmSystem[];
}

export interface HlsVariant {
  bandwidth: number;
  resolution?: string;
  /** Pixel height parsed out of resolution; 0 when unknown. */
  height: number;
  /** Decoded frame rate from FRAME-RATE; undefined when omitted. */
  frameRate?: number;
  codecs?: string;
  /** SDR / HLG / PQ. Undefined → assume SDR per spec when absent. */
  videoRange?: HlsVideoRange;
  uri: string;
  audioGroup?: string;
  subtitleGroup?: string;
}

export interface HlsRendition {
  type: "AUDIO" | "SUBTITLES" | "VIDEO" | "CLOSED-CAPTIONS";
  groupId: string;
  name: string;
  language?: string;
  default: boolean;
  uri?: string;
}

export type HlsParseResult =
  | {
      kind: "master";
      variants: HlsVariant[];
      renditions: HlsRendition[];
      /** DRM seen via #EXT-X-SESSION-KEY at the master level. */
      drmSystems: HlsDrmSystem[];
    }
  | { kind: "media"; playlist: HlsMediaPlaylist };

const ATTR_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;

function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(line)) !== null) {
    out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function parseByteRange(value: string, prevEnd: number): HlsByteRange {
  const [lenStr, offStr] = value.split("@");
  const length = parseInt(lenStr, 10);
  const offset = offStr !== undefined ? parseInt(offStr, 10) : prevEnd;
  return { length, offset };
}

function parseHeight(resolution: string | undefined): number {
  if (!resolution) return 0;
  const m = /(\d+)x(\d+)/i.exec(resolution);
  return m ? Number(m[2]) || 0 : 0;
}

function parseVideoRange(value: string | undefined): HlsVideoRange | undefined {
  if (!value) return undefined;
  const v = value.toUpperCase();
  if (v === "SDR" || v === "HLG" || v === "PQ") return v;
  return undefined;
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Recognise a DRM system from a KEYFORMAT URI. The values below are the
 * stable identifiers published by each DRM provider — they are part of the
 * HLS spec / public DASH-IF guidelines, not vendor IP. We only classify;
 * the segments stay encrypted and the SW will refuse the job.
 */
function classifyDrm(keyformat: string | undefined, method: string | undefined): HlsDrmSystem | null {
  // AES-128 with default identity KEYFORMAT — handled natively by the
  // existing HlsKey path. Don't tag it as DRM.
  const m = (method || "").toUpperCase();
  if (m === "AES-128") return null;
  if (m === "NONE") return null;

  const kf = (keyformat || "").toLowerCase();
  if (!kf || kf === "identity") {
    // Method !== AES-128 with identity KEYFORMAT shouldn't really happen,
    // but if it does we still can't safely play it.
    return "unknown";
  }
  if (kf.includes("apple.streamingkeydelivery")) return "fairplay";
  if (kf.includes("microsoft.playready")) return "playready";
  // Widevine + DASH-IF use this specific UUID.
  if (kf.includes("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")) return "widevine";
  if (kf.includes("urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e")) return "clearkey";
  return "unknown";
}

function pushUnique<T>(list: T[], v: T): void {
  if (!list.includes(v)) list.push(v);
}

function resolveUri(base: string, ref: string): string {
  return new URL(ref, base).toString();
}

/** Sort by visible height first, fall back to bandwidth.
 *  HEVC 1080p with lower bandwidth must rank above H.264 720p. */
export function compareVariantsBest(a: HlsVariant, b: HlsVariant): number {
  if (a.height !== b.height) return b.height - a.height;
  return b.bandwidth - a.bandwidth;
}

export function parseM3U8(text: string, baseUrl: string): HlsParseResult {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  const segments: HlsSegment[] = [];
  const sessionDrm: HlsDrmSystem[] = [];
  const mediaDrm: HlsDrmSystem[] = [];
  let currentKey: HlsKey | undefined;
  let initSegment: HlsInitSegment | undefined;
  let pendingDuration = 0;
  let pendingByteRange: HlsByteRange | undefined;
  let lastEndOffset = 0;
  let isMaster = false;
  let mediaSequence = 0;
  let endListSeen = false;
  let playlistType: "VOD" | "EVENT" | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      const attrs = parseAttrs(line.slice("#EXT-X-STREAM-INF:".length));
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith("#")) {
        const resolution = attrs.RESOLUTION;
        variants.push({
          bandwidth: Number(attrs.BANDWIDTH || 0),
          resolution,
          height: parseHeight(resolution),
          frameRate: parseFrameRate(attrs["FRAME-RATE"]),
          codecs: attrs.CODECS,
          videoRange: parseVideoRange(attrs["VIDEO-RANGE"]),
          uri: resolveUri(baseUrl, next),
          audioGroup: attrs.AUDIO,
          subtitleGroup: attrs.SUBTITLES,
        });
        i++;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-SESSION-KEY:")) {
      // Master-level DRM hint. Carries no segment URI but tells us the
      // content is protected before we even fetch a media playlist.
      const attrs = parseAttrs(line.slice("#EXT-X-SESSION-KEY:".length));
      const sys = classifyDrm(attrs.KEYFORMAT, attrs.METHOD);
      if (sys) pushUnique(sessionDrm, sys);
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      isMaster = true;
      const attrs = parseAttrs(line.slice("#EXT-X-MEDIA:".length));
      const type = attrs.TYPE as HlsRendition["type"] | undefined;
      if (!type) continue;
      renditions.push({
        type,
        groupId: attrs["GROUP-ID"] || "",
        name: attrs.NAME || "",
        language: attrs.LANGUAGE,
        default: attrs.DEFAULT === "YES",
        uri: attrs.URI ? resolveUri(baseUrl, attrs.URI) : undefined,
      });
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-KEY:".length));
      if (attrs.METHOD === "NONE") {
        currentKey = undefined;
      } else if (attrs.METHOD === "AES-128" && attrs.URI) {
        currentKey = {
          method: "AES-128",
          uri: resolveUri(baseUrl, attrs.URI),
          iv: attrs.IV ? hexToBytes(attrs.IV) : undefined,
        };
      } else {
        // SAMPLE-AES, SAMPLE-AES-CTR, etc. — content protection we cannot
        // satisfy. Tag it and drop the AES-128 path so callers don't try
        // to "decrypt" with a key we never fetched.
        const sys = classifyDrm(attrs.KEYFORMAT, attrs.METHOD);
        if (sys) pushUnique(mediaDrm, sys);
        currentKey = undefined;
      }
      continue;
    }

    if (line === "#EXT-X-ENDLIST") {
      endListSeen = true;
      continue;
    }

    if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      const v = line.slice("#EXT-X-PLAYLIST-TYPE:".length).trim().toUpperCase();
      if (v === "VOD" || v === "EVENT") playlistType = v;
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) {
        let byteRange: HlsByteRange | undefined;
        if (attrs.BYTERANGE) {
          byteRange = parseByteRange(attrs.BYTERANGE, 0);
        }
        initSegment = { uri: resolveUri(baseUrl, attrs.URI), byteRange };
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      const v = line.slice("#EXTINF:".length).split(",")[0];
      pendingDuration = parseFloat(v) || 0;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const v = line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim();
      const parsed = parseInt(v, 10);
      if (Number.isFinite(parsed) && parsed >= 0) mediaSequence = parsed;
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingByteRange = parseByteRange(
        line.slice("#EXT-X-BYTERANGE:".length),
        lastEndOffset,
      );
      lastEndOffset = pendingByteRange.offset + pendingByteRange.length;
      continue;
    }

    if (line.startsWith("#")) continue;

    // Non-comment line under media playlist == segment URI.
    segments.push({
      uri: resolveUri(baseUrl, line),
      duration: pendingDuration,
      byteRange: pendingByteRange,
      key: currentKey,
      sequence: mediaSequence + segments.length,
    });
    pendingDuration = 0;
    pendingByteRange = undefined;
  }

  if (isMaster) {
    variants.sort(compareVariantsBest);
    return { kind: "master", variants, renditions, drmSystems: sessionDrm };
  }
  const totalDuration = segments.reduce((acc, s) => acc + s.duration, 0);
  // RFC 8216 §6.2.1: ENDLIST marks a finished VOD-style playlist; an explicit
  // PLAYLIST-TYPE=VOD also implies it. EVENT is "growing but never trims" —
  // still a sliding window in practice, treat it as live for our purposes.
  const liveness: HlsLiveness =
    playlistType === "VOD" || endListSeen
      ? "vod"
      : playlistType === "EVENT"
        ? "event"
        : "live";
  return {
    kind: "media",
    playlist: {
      segments,
      totalDuration,
      initSegment,
      mediaSequence,
      liveness,
      drmSystems: mediaDrm,
    },
  };
}

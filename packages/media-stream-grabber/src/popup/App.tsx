import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AudioTrackOption,
  DetectedStream,
  DownloadProgress,
  DownloadSelection,
  ProbeResult,
  RuntimeMessage,
  StreamKind,
  SubtitleTrackOption,
  VariantOption,
} from "@/lib/types";

function useActiveTab(): chrome.tabs.Tab | null {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      setTab(tabs[0] ?? null);
    });
  }, []);
  return tab;
}

function send<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "sw" }, (resp: T) => resolve(resp));
  });
}

const KIND_LABEL: Record<StreamKind, string> = {
  hls: "HLS",
  dash: "DASH",
  mp4: "MP4",
  audio: "AUDIO",
  image: "IMG",
  other: "FILE",
};

type CategoryKey = "all" | "video" | "audio" | "image";

const VIDEO_KINDS: ReadonlySet<StreamKind> = new Set(["hls", "dash", "mp4"]);

function categoryOf(kind: StreamKind): Exclude<CategoryKey, "all"> | null {
  if (VIDEO_KINDS.has(kind)) return "video";
  if (kind === "audio") return "audio";
  if (kind === "image") return "image";
  return null;
}

const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "image", label: "Image" },
];

interface PendingPicker {
  jobId: string;
  stream: DetectedStream;
  result: ProbeResult;
}

export function App(): JSX.Element {
  const tab = useActiveTab();
  const [streams, setStreams] = useState<DetectedStream[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [picker, setPicker] = useState<PendingPicker | null>(null);
  const [armedUntil, setArmedUntil] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());
  const [thumbsRequesting, setThumbsRequesting] = useState<Set<string>>(() => new Set());
  const [sniffActive, setSniffActive] = useState<boolean>(false);
  const [category, setCategory] = useState<CategoryKey>("all");
  const jobToStreamRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    if (!tab?.id) return;
    const resp = await send<RuntimeMessage>({ type: "streams:list", tabId: tab.id });
    if (resp && (resp as RuntimeMessage).type === "streams:list:result") {
      setStreams((resp as Extract<RuntimeMessage, { type: "streams:list:result" }>).streams);
    }
  }, [tab?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull the current page-sniff state once on mount. Subsequent state changes
  // (toggle, navigation-driven auto-disable) arrive via `pagesniff:status`
  // broadcasts in the listener below.
  useEffect(() => {
    if (!tab?.id) return;
    void send<RuntimeMessage>({ type: "pagesniff:query", tabId: tab.id }).then(
      (resp) => {
        if (resp && (resp as RuntimeMessage).type === "pagesniff:status") {
          setSniffActive(
            (resp as Extract<RuntimeMessage, { type: "pagesniff:status" }>)
              .active,
          );
        }
      },
    );
  }, [tab?.id]);

  useEffect(() => {
    const handler = (msg: RuntimeMessage) => {
      // CLAUDE.md cross-context convention: every context early-returns on
      // mismatched target. The popup is only a consumer of "sw"-tagged
      // broadcasts (status updates, probe results, fresh stream rows).
      if (msg.target && msg.target !== "sw") return;
      if (msg.type === "streams:added" && tab?.id && msg.tabId === tab.id) {
        setStreams((prev) => {
          // Merge by id; the SW may re-emit `streams:added` for the same id
          // (e.g. when a sibling child playlist is sniffed and dedupes).
          const idx = prev.findIndex((s) => s.id === msg.stream.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...msg.stream };
            return next;
          }
          return [msg.stream, ...prev];
        });
      }
      if (msg.type === "thumb:result" && msg.dataUrl) {
        setStreams((prev) => {
          const idx = prev.findIndex((s) => s.id === msg.streamId);
          if (idx < 0) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], thumbDataUrl: msg.dataUrl };
          return next;
        });
        setThumbsRequesting((prev) => {
          if (!prev.has(msg.streamId)) return prev;
          const next = new Set(prev);
          next.delete(msg.streamId);
          return next;
        });
      }
      if (msg.type === "thumb:result" && msg.error) {
        setThumbsRequesting((prev) => {
          if (!prev.has(msg.streamId)) return prev;
          const next = new Set(prev);
          next.delete(msg.streamId);
          return next;
        });
      }
      if (msg.type === "download:progress") {
        setProgress((prev) => ({ ...prev, [msg.payload.jobId]: msg.payload }));
      }
      if (msg.type === "capture:status" && tab?.id && msg.tabId === tab.id) {
        setArmedUntil(msg.armedUntil);
      }
      if (
        msg.type === "pagesniff:status" &&
        tab?.id &&
        msg.tabId === tab.id
      ) {
        setSniffActive(msg.active);
      }
      if (msg.type === "download:probe:result") {
        setPicker((prev) => {
          if (!prev || prev.jobId !== msg.jobId) return prev;
          // Probe-time refusal: live, DRM, or otherwise unfit. Keep the
          // modal open so the user sees *why* — auto-starting would just
          // produce a download:progress error a beat later.
          const refused = msg.result.unsupported || msg.result.isLive;
          // If the probe came back with no choices and is fine, auto-start.
          if (
            !refused &&
            (msg.result.singlePlaylist || msg.result.variants.length === 0)
          ) {
            void send({
              type: "download:start",
              stream: prev.stream,
              jobId: prev.jobId,
              selection: {},
            });
            return null;
          }
          return { ...prev, result: msg.result };
        });
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [tab?.id]);

  const onClear = useCallback(async () => {
    if (!tab?.id) return;
    await send({ type: "streams:clear", tabId: tab.id });
    setStreams([]);
    setProgress({});
  }, [tab?.id]);

  const onArm = useCallback(async () => {
    if (!tab?.id) return;
    const resp = await send<RuntimeMessage>({ type: "capture:arm", tabId: tab.id });
    if (resp && (resp as RuntimeMessage).type === "capture:status") {
      setArmedUntil((resp as Extract<RuntimeMessage, { type: "capture:status" }>).armedUntil);
    }
  }, [tab?.id]);

  const onToggleSniff = useCallback(async () => {
    if (!tab?.id) return;
    const next = !sniffActive;
    // Optimistic flip — the SW broadcast will reconcile if anything
    // (e.g. a parallel popup, an auto-disable on navigation) disagrees.
    setSniffActive(next);
    await send({
      type: "pagesniff:toggle",
      tabId: tab.id,
      enable: next,
    });
  }, [tab?.id, sniffActive]);

  // Tick the countdown while the capture window is open. The interval is cheap
  // and only mounts while the popup is visible.
  useEffect(() => {
    if (armedUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [armedUntil]);

  const armedSecondsLeft = Math.max(0, Math.ceil((armedUntil - now) / 1000));
  const isArmed = armedSecondsLeft > 0;

  const onCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  }, []);

  const onDownload = useCallback(async (stream: DetectedStream) => {
    const jobId = `${stream.id}-${Date.now().toString(36)}`;
    jobToStreamRef.current.set(jobId, stream.id);
    setProgress((prev) => ({
      ...prev,
      [jobId]: { jobId, phase: "probing", ratio: 0 },
    }));
    if (stream.kind === "hls" || stream.kind === "dash") {
      // Probe first so the user can pick a variant / audio track. The SW
      // will reply with `download:probe:result`; the listener decides
      // whether to show the picker or auto-start.
      setPicker({
        jobId,
        stream,
        result: { variants: [], audioTracks: [], subtitleTracks: [], singlePlaylist: false },
      });
      await send({ type: "download:probe", stream, jobId });
    } else {
      await send({ type: "download:start", stream, jobId, selection: {} });
    }
  }, []);

  const onCancel = useCallback(async (jobId: string) => {
    await send({ type: "download:cancel", jobId });
  }, []);

  const onRequestThumb = useCallback(async (stream: DetectedStream) => {
    if (thumbsRequesting.has(stream.id)) return;
    setThumbsRequesting((prev) => {
      const next = new Set(prev);
      next.add(stream.id);
      return next;
    });
    await send({ type: "thumb:request", streamId: stream.id, stream });
  }, [thumbsRequesting]);

  const onPickerConfirm = useCallback(
    async (selection: DownloadSelection) => {
      if (!picker) return;
      await send({
        type: "download:start",
        stream: picker.stream,
        jobId: picker.jobId,
        selection,
      });
      setPicker(null);
    },
    [picker],
  );

  const onPickerCancel = useCallback(() => {
    if (picker) {
      setProgress((prev) => {
        const next = { ...prev };
        delete next[picker.jobId];
        return next;
      });
      jobToStreamRef.current.delete(picker.jobId);
    }
    setPicker(null);
  }, [picker]);

  const progressByStream = useMemo(() => {
    const map: Record<string, DownloadProgress> = {};
    for (const [jobId, sid] of jobToStreamRef.current) {
      const p = progress[jobId];
      if (p) map[sid] = p;
    }
    return map;
  }, [progress]);

  const counts = useMemo(() => {
    const c = { all: streams.length, video: 0, audio: 0, image: 0 };
    for (const s of streams) {
      const cat = categoryOf(s.kind);
      if (cat) c[cat]++;
    }
    return c;
  }, [streams]);

  const visibleStreams = useMemo(() => {
    if (category === "all") return streams;
    return streams.filter((s) => categoryOf(s.kind) === category);
  }, [streams, category]);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__title">Media Stream Grabber</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="app__count">{streams.length} found</span>
          <button
            className={`app__btn${sniffActive ? " app__btn--active" : ""}`}
            onClick={onToggleSniff}
            disabled={!tab?.id}
            title={
              sniffActive
                ? "Stop capturing every media request on this tab."
                : "Capture every media request on this tab until you stop or the page navigates. Includes images."
            }
          >
            {sniffActive ? "Stop sniffing" : "Sniff page"}
          </button>
          <button
            className="app__btn"
            onClick={onArm}
            disabled={!tab?.id || isArmed || sniffActive}
            title={
              sniffActive
                ? "Page-sniff is on — broader capture is already active."
                : "Arm a 30s capture window for this tab. Nothing is sniffed otherwise."
            }
          >
            {isArmed ? `Capturing… ${armedSecondsLeft}s` : "Arm 30s"}
          </button>
          <button className="app__btn" onClick={onClear} disabled={!streams.length}>
            Clear
          </button>
        </div>
      </header>

      <nav className="cats" role="tablist" aria-label="Filter by media type">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            role="tab"
            aria-selected={category === c.key}
            className={`cats__btn${category === c.key ? " cats__btn--active" : ""}`}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
            <span className="cats__count">{counts[c.key]}</span>
          </button>
        ))}
      </nav>

      {streams.length === 0 ? (
        <div className="empty">
          Nothing captured on this tab.
          <br />
          Click <strong>Sniff page</strong> for whole-page capture, or right-click
          a video and pick
          <br />
          <strong>Media Stream Grabber → Capture next 30s of media</strong>.
        </div>
      ) : visibleStreams.length === 0 ? (
        <div className="empty">No {category} captured on this tab.</div>
      ) : (
        visibleStreams.map((s) => {
          const job = [...jobToStreamRef.current.entries()].find(([, sid]) => sid === s.id);
          const jobId = job?.[0];
          return (
            <StreamCard
              key={s.id}
              stream={s}
              progress={progressByStream[s.id]}
              thumbLoading={thumbsRequesting.has(s.id)}
              onCopy={() => onCopy(s.url)}
              onDownload={() => onDownload(s)}
              onCancel={jobId ? () => onCancel(jobId) : undefined}
              onRequestThumb={() => onRequestThumb(s)}
            />
          );
        })
      )}

      {picker ? (
        <PickerModal
          picker={picker}
          onConfirm={onPickerConfirm}
          onCancel={onPickerCancel}
        />
      ) : null}
    </div>
  );
}

function StreamCard({
  stream,
  progress,
  thumbLoading,
  onCopy,
  onDownload,
  onCancel,
  onRequestThumb,
}: {
  stream: DetectedStream;
  progress?: DownloadProgress;
  thumbLoading: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onCancel?: () => void;
  onRequestThumb: () => void;
}): JSX.Element {
  const tagClass = `stream__tag stream__tag--${stream.kind}`;
  const inFlight = progress && progress.phase !== "done" && progress.phase !== "error";
  const ratio = Math.max(0, Math.min(1, progress?.ratio ?? 0));
  // For images we just render the resource URL itself — no ffmpeg round
  // trip needed. Everything else uses the ffmpeg-extracted first frame
  // (auto-enqueued by the SW; the "Preview" button is a manual retry).
  const thumbSrc =
    stream.kind === "image" ? stream.url : stream.thumbDataUrl;
  const canExtract = stream.kind === "hls" || stream.kind === "dash" || stream.kind === "mp4" || stream.kind === "audio";
  const showPreviewButton = !stream.thumbDataUrl && canExtract;

  return (
    <div className="stream">
      <div className="stream__body">
        <div className={`stream__thumb${thumbSrc ? "" : " stream__thumb--placeholder"}`}>
          {thumbSrc ? (
            <img src={thumbSrc} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          ) : thumbLoading ? (
            <span className="stream__thumb-label">…</span>
          ) : (
            <span className="stream__thumb-label">{KIND_LABEL[stream.kind]}</span>
          )}
        </div>
        <div className="stream__meta">
          <div className="stream__head">
            <span className={tagClass}>{KIND_LABEL[stream.kind]}</span>
            <span className="stream__name" title={stream.suggestedName}>
              {stream.suggestedName}
            </span>
          </div>
          <p className="stream__url" title={stream.url}>
            {stream.url}
          </p>
        </div>
      </div>
      <div className="stream__actions">
        <button onClick={onCopy}>Copy URL</button>
        {showPreviewButton ? (
          <button onClick={onRequestThumb} disabled={thumbLoading}>
            {thumbLoading ? "Extracting…" : "Preview"}
          </button>
        ) : null}
        {inFlight && onCancel ? (
          <button onClick={onCancel}>Cancel</button>
        ) : (
          <button className="primary" onClick={onDownload} disabled={!!inFlight}>
            {inFlight ? "Working…" : "Download"}
          </button>
        )}
      </div>
      {progress ? (
        <>
          <div className="progress">
            <div className="progress__bar" style={{ width: `${ratio * 100}%` }} />
          </div>
          <p
            className={
              progress.phase === "error"
                ? "progress__label progress__label--error"
                : progress.phase === "done"
                  ? "progress__label progress__label--done"
                  : "progress__label"
            }
          >
            {formatPhase(progress)}
          </p>
        </>
      ) : null}
    </div>
  );
}

function formatPhase(p: DownloadProgress): string {
  if (p.phase === "error") return `Error: ${p.error || "unknown"}`;
  if (p.phase === "done") return "Saved.";
  const seg = p.segmentsTotal ? ` (${p.segmentsDone ?? 0}/${p.segmentsTotal})` : "";
  const retries = p.retries ? ` · ${p.retries} retries` : "";
  const msg = p.message ? ` — ${p.message}` : "";
  return `${p.phase}${seg}${retries}${msg}`;
}

function PickerModal({
  picker,
  onConfirm,
  onCancel,
}: {
  picker: PendingPicker;
  onConfirm: (sel: DownloadSelection) => void;
  onCancel: () => void;
}): JSX.Element {
  const {
    variants,
    audioTracks,
    subtitleTracks,
    recommendedVariantUri,
    recommendedAudioId,
    isLive,
    unsupported,
  } = picker.result;
  const playableVariants = variants.filter((v) => !v.drm);
  const [variantUri, setVariantUri] = useState<string | undefined>(
    recommendedVariantUri && playableVariants.some((v) => v.uri === recommendedVariantUri)
      ? recommendedVariantUri
      : playableVariants[0]?.uri,
  );
  const [audioId, setAudioId] = useState<string | undefined>(recommendedAudioId);
  const [subtitleId, setSubtitleId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!variantUri && playableVariants[0]) setVariantUri(playableVariants[0].uri);
  }, [playableVariants, variantUri]);
  useEffect(() => {
    if (!audioId && audioTracks[0]) setAudioId(audioTracks[0].id);
  }, [audioTracks, audioId]);

  const probing =
    !variants.length &&
    !audioTracks.length &&
    !subtitleTracks.length &&
    !unsupported &&
    !isLive;
  const blocked = !!unsupported || !!isLive || (variants.length > 0 && playableVariants.length === 0);

  return (
    <div className="modal">
      <div className="modal__panel">
        <div className="modal__title">Pick what to download</div>
        <p className="modal__sub" title={picker.stream.url}>
          {picker.stream.suggestedName}
        </p>

        {probing ? (
          <div className="modal__probing">Probing playlist…</div>
        ) : blocked ? (
          <div className="modal__probing modal__probing--error">
            {unsupported?.reason ||
              (isLive
                ? "This is a live or event stream; merging a sliding window into one MP4 isn't supported."
                : "Every rendition in this manifest is DRM-protected.")}
          </div>
        ) : (
          <>
            {variants.length > 0 ? (
              <div className="modal__section">
                <div className="modal__label">Resolution</div>
                <div className="modal__list">
                  {variants.map((v) => (
                    <VariantRow
                      key={v.uri}
                      variant={v}
                      selected={variantUri === v.uri}
                      recommended={v.uri === recommendedVariantUri}
                      onPick={() => setVariantUri(v.uri)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {audioTracks.length > 0 ? (
              <div className="modal__section">
                <div className="modal__label">Audio track</div>
                <div className="modal__list">
                  {audioTracks.map((a) => (
                    <AudioRow
                      key={a.id}
                      track={a}
                      selected={audioId === a.id}
                      onPick={() => setAudioId(a.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {subtitleTracks.length > 0 ? (
              <div className="modal__section">
                <div className="modal__label">Subtitles (optional)</div>
                <div className="modal__list">
                  <button
                    className={`row${!subtitleId ? " row--selected" : ""}`}
                    onClick={() => setSubtitleId(undefined)}
                  >
                    <span className="row__main">None</span>
                  </button>
                  {subtitleTracks.map((t) => (
                    <SubtitleRow
                      key={t.id}
                      track={t}
                      selected={subtitleId === t.id}
                      onPick={() => setSubtitleId(t.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}

        <div className="modal__actions">
          <button onClick={onCancel}>{blocked ? "Close" : "Cancel"}</button>
          {blocked ? null : (
            <button
              className="primary"
              disabled={probing || !variantUri}
              onClick={() => onConfirm({ variantUri, audioId, subtitleId })}
            >
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function VariantRow({
  variant,
  selected,
  recommended,
  onPick,
}: {
  variant: VariantOption;
  selected: boolean;
  recommended: boolean;
  onPick: () => void;
}): JSX.Element {
  const label = variant.height
    ? `${variant.height}p`
    : variant.resolution || "unknown";
  const fps =
    variant.frameRate && variant.frameRate >= 1
      ? `${Math.round(variant.frameRate)}`
      : null;
  const mbps = variant.bandwidth
    ? ` · ${(variant.bandwidth / 1_000_000).toFixed(2)} Mbps`
    : "";
  const codec = variant.codecs ? ` · ${variant.codecs}` : "";
  // VIDEO-RANGE: HLS marks PQ for HDR10 / HLG for hybrid log-gamma. SDR is
  // the default and not worth a badge.
  const hdr = variant.videoRange && variant.videoRange !== "SDR" ? variant.videoRange : null;
  const drm = variant.drm ? variant.drm.toUpperCase() : null;
  return (
    <button
      className={`row${selected ? " row--selected" : ""}${drm ? " row--disabled" : ""}`}
      onClick={drm ? undefined : onPick}
      disabled={!!drm}
      title={drm ? "Encrypted by DRM — segments cannot be saved." : undefined}
    >
      <span className="row__main">
        {label}
        {fps ? `@${fps}` : ""}
        {mbps}
        {codec}
      </span>
      {hdr ? <span className="row__pill row__pill--hdr">{hdr}</span> : null}
      {drm ? <span className="row__pill row__pill--drm">DRM · {drm}</span> : null}
      {!drm && recommended ? <span className="row__pill">recommended</span> : null}
    </button>
  );
}

function AudioRow({
  track,
  selected,
  onPick,
}: {
  track: AudioTrackOption;
  selected: boolean;
  onPick: () => void;
}): JSX.Element {
  const lang = track.language ? ` · ${track.language}` : "";
  return (
    <button
      className={`row${selected ? " row--selected" : ""}`}
      onClick={onPick}
    >
      <span className="row__main">
        {track.name}
        {lang}
      </span>
      {track.default ? <span className="row__pill">default</span> : null}
    </button>
  );
}

function SubtitleRow({
  track,
  selected,
  onPick,
}: {
  track: SubtitleTrackOption;
  selected: boolean;
  onPick: () => void;
}): JSX.Element {
  const lang = track.language ? ` · ${track.language}` : "";
  return (
    <button
      className={`row${selected ? " row--selected" : ""}`}
      onClick={onPick}
    >
      <span className="row__main">
        {track.name}
        {lang}
      </span>
      {track.default ? <span className="row__pill">default</span> : null}
    </button>
  );
}

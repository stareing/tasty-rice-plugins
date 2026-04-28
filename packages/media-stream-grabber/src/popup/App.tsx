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

  useEffect(() => {
    const handler = (msg: RuntimeMessage) => {
      // CLAUDE.md cross-context convention: every context early-returns on
      // mismatched target. The popup is only a consumer of "sw"-tagged
      // broadcasts (status updates, probe results, fresh stream rows).
      if (msg.target && msg.target !== "sw") return;
      if (msg.type === "streams:added" && tab?.id && msg.tabId === tab.id) {
        setStreams((prev) =>
          prev.some((s) => s.id === msg.stream.id) ? prev : [msg.stream, ...prev],
        );
      }
      if (msg.type === "download:progress") {
        setProgress((prev) => ({ ...prev, [msg.payload.jobId]: msg.payload }));
      }
      if (msg.type === "download:probe:result") {
        setPicker((prev) => {
          if (!prev || prev.jobId !== msg.jobId) return prev;
          // If the probe came back with no choices, auto-start.
          if (msg.result.singlePlaylist || msg.result.variants.length === 0) {
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

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__title">Media Stream Grabber</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="app__count">{streams.length} found</span>
          <button className="app__btn" onClick={onClear} disabled={!streams.length}>
            Clear
          </button>
        </div>
      </header>

      {streams.length === 0 ? (
        <div className="empty">
          No streams detected on this tab yet.
          <br />
          Play a video and they will appear here.
        </div>
      ) : (
        streams.map((s) => {
          const job = [...jobToStreamRef.current.entries()].find(([, sid]) => sid === s.id);
          const jobId = job?.[0];
          return (
            <StreamCard
              key={s.id}
              stream={s}
              progress={progressByStream[s.id]}
              onCopy={() => onCopy(s.url)}
              onDownload={() => onDownload(s)}
              onCancel={jobId ? () => onCancel(jobId) : undefined}
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
  onCopy,
  onDownload,
  onCancel,
}: {
  stream: DetectedStream;
  progress?: DownloadProgress;
  onCopy: () => void;
  onDownload: () => void;
  onCancel?: () => void;
}): JSX.Element {
  const tagClass = `stream__tag stream__tag--${stream.kind}`;
  const inFlight = progress && progress.phase !== "done" && progress.phase !== "error";
  const ratio = Math.max(0, Math.min(1, progress?.ratio ?? 0));

  return (
    <div className="stream">
      <div className="stream__head">
        <span className={tagClass}>{KIND_LABEL[stream.kind]}</span>
        <span className="stream__name" title={stream.suggestedName}>
          {stream.suggestedName}
        </span>
      </div>
      <p className="stream__url" title={stream.url}>
        {stream.url}
      </p>
      <div className="stream__actions">
        <button onClick={onCopy}>Copy URL</button>
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
  const { variants, audioTracks, subtitleTracks, recommendedVariantUri, recommendedAudioId } =
    picker.result;
  const [variantUri, setVariantUri] = useState<string | undefined>(recommendedVariantUri);
  const [audioId, setAudioId] = useState<string | undefined>(recommendedAudioId);
  const [subtitleId, setSubtitleId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!variantUri && variants[0]) setVariantUri(variants[0].uri);
  }, [variants, variantUri]);
  useEffect(() => {
    if (!audioId && audioTracks[0]) setAudioId(audioTracks[0].id);
  }, [audioTracks, audioId]);

  const probing = !variants.length && !audioTracks.length && !subtitleTracks.length;

  return (
    <div className="modal">
      <div className="modal__panel">
        <div className="modal__title">Pick what to download</div>
        <p className="modal__sub" title={picker.stream.url}>
          {picker.stream.suggestedName}
        </p>

        {probing ? (
          <div className="modal__probing">Probing playlist…</div>
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
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={probing}
            onClick={() => onConfirm({ variantUri, audioId, subtitleId })}
          >
            Download
          </button>
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
  const mbps = variant.bandwidth
    ? ` · ${(variant.bandwidth / 1_000_000).toFixed(2)} Mbps`
    : "";
  const codec = variant.codecs ? ` · ${variant.codecs}` : "";
  return (
    <button
      className={`row${selected ? " row--selected" : ""}`}
      onClick={onPick}
    >
      <span className="row__main">
        {label}
        {mbps}
        {codec}
      </span>
      {recommended ? <span className="row__pill">recommended</span> : null}
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

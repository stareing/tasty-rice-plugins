import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DetectedStream,
  DownloadProgress,
  RuntimeMessage,
  StreamKind,
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
    chrome.runtime.sendMessage(msg, (resp: T) => resolve(resp));
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

export function App(): JSX.Element {
  const tab = useActiveTab();
  const [streams, setStreams] = useState<DetectedStream[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const jobToStreamRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    if (!tab?.id) return;
    const resp = await send<RuntimeMessage>({ type: "streams:list", tabId: tab.id });
    if (resp.type === "streams:list:result") setStreams(resp.streams);
  }, [tab?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = (msg: RuntimeMessage) => {
      if (msg.type === "streams:added" && tab?.id && msg.tabId === tab.id) {
        setStreams((prev) =>
          prev.some((s) => s.id === msg.stream.id) ? prev : [msg.stream, ...prev],
        );
      }
      if (msg.type === "download:progress") {
        setProgress((prev) => ({ ...prev, [msg.payload.jobId]: msg.payload }));
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
      [jobId]: { jobId, phase: "fetching-playlist", ratio: 0 },
    }));
    await send({ type: "download:start", stream, jobId });
  }, []);

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
        streams.map((s) => (
          <StreamCard
            key={s.id}
            stream={s}
            progress={progressByStream[s.id]}
            onCopy={() => onCopy(s.url)}
            onDownload={() => onDownload(s)}
          />
        ))
      )}
    </div>
  );
}

function StreamCard({
  stream,
  progress,
  onCopy,
  onDownload,
}: {
  stream: DetectedStream;
  progress?: DownloadProgress;
  onCopy: () => void;
  onDownload: () => void;
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
        <button className="primary" onClick={onDownload} disabled={!!inFlight}>
          {inFlight ? "Working…" : "Download"}
        </button>
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
            {progress.phase === "error"
              ? `Error: ${progress.error || "unknown"}`
              : progress.phase === "done"
                ? "Saved."
                : `${progress.phase}${
                    progress.segmentsTotal
                      ? ` (${progress.segmentsDone ?? 0}/${progress.segmentsTotal})`
                      : ""
                  }`}
          </p>
        </>
      ) : null}
    </div>
  );
}

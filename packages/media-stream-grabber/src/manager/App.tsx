import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DownloadProgress,
  ManagedJobRecord,
  RuntimeMessage,
} from "@/lib/types";

function send<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "sw" }, (resp: T) => resolve(resp));
  });
}

const ACTIVE_PHASES: ReadonlySet<string> = new Set([
  "fetching-playlist",
  "downloading-segments",
  "downloading-audio",
  "merging",
  "saving",
  "probing",
]);

/**
 * Standalone downloads manager. Reads the managed-job log from
 * chrome.storage.local (mirrored by the SW from every download:progress
 * event) and watches live `download:progress` broadcasts so in-flight rows
 * stay current without polling.
 */
export function App(): JSX.Element {
  const [jobs, setJobs] = useState<ManagedJobRecord[]>([]);
  const [filter, setFilter] = useState<"all" | "active" | "done" | "error">(
    "all",
  );

  const refresh = useCallback(async () => {
    const resp = await send<RuntimeMessage>({ type: "jobs:list" });
    if (resp && (resp as RuntimeMessage).type === "jobs:list:result") {
      setJobs(
        (resp as Extract<RuntimeMessage, { type: "jobs:list:result" }>).jobs,
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for live progress so the row reflects the current phase without
  // an explicit re-fetch. The SW already mirrors progress into the log,
  // but the broadcast is faster than the manager-page query path.
  useEffect(() => {
    const handler = (msg: RuntimeMessage) => {
      if (msg.target && msg.target !== "sw") return;
      if (msg.type !== "download:progress") return;
      const payload = msg.payload as DownloadProgress;
      setJobs((prev) => {
        const idx = prev.findIndex((r) => r.jobId === payload.jobId);
        if (idx < 0) {
          // New job started after we loaded — schedule a full reload to
          // pick up its stream metadata.
          void refresh();
          return prev;
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          phase: payload.phase,
          ratio: payload.ratio,
          segmentsDone: payload.segmentsDone,
          segmentsTotal: payload.segmentsTotal,
          retries: payload.retries,
          message: payload.message,
          error: payload.phase === "error" ? payload.error : undefined,
          finishedAt:
            payload.phase === "done" || payload.phase === "error"
              ? Date.now()
              : next[idx].finishedAt,
        };
        return next;
      });
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [refresh]);

  const onRemove = useCallback(async (jobId: string) => {
    await send({ type: "jobs:remove", jobId });
    setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
  }, []);

  const onCancel = useCallback(async (jobId: string) => {
    await send({ type: "download:cancel", jobId });
  }, []);

  const onRetry = useCallback(async (job: ManagedJobRecord) => {
    // New jobId so the SW persists this as a separate entry rather than
    // resurrecting the failed one — the user can compare the outcomes.
    const newId = `${job.stream.id}-retry-${Date.now().toString(36)}`;
    await send({
      type: "download:start",
      stream: job.stream,
      jobId: newId,
      selection: job.selection ?? {},
    });
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    const sorted = [...jobs].sort((a, b) => b.startedAt - a.startedAt);
    if (filter === "all") return sorted;
    if (filter === "active") return sorted.filter((j) => ACTIVE_PHASES.has(j.phase));
    if (filter === "done") return sorted.filter((j) => j.phase === "done");
    return sorted.filter((j) => j.phase === "error");
  }, [jobs, filter]);

  const counts = useMemo(() => {
    const c = { all: jobs.length, active: 0, done: 0, error: 0 };
    for (const j of jobs) {
      if (ACTIVE_PHASES.has(j.phase)) c.active++;
      else if (j.phase === "done") c.done++;
      else if (j.phase === "error") c.error++;
    }
    return c;
  }, [jobs]);

  return (
    <div className="app">
      <header className="manager__toolbar">
        <span className="manager__title">Downloads</span>
        <button
          className="app__btn"
          onClick={() => {
            void chrome.tabs.create({
              url: chrome.runtime.getURL("src/options/index.html"),
            });
          }}
        >
          Options
        </button>
        <nav className="cats" style={{ marginBottom: 0, border: 0 }}>
          {(["all", "active", "done", "error"] as const).map((k) => (
            <button
              key={k}
              className={`cats__btn${filter === k ? " cats__btn--active" : ""}`}
              onClick={() => setFilter(k)}
            >
              {k.charAt(0).toUpperCase() + k.slice(1)}
              <span className="cats__count">{counts[k]}</span>
            </button>
          ))}
        </nav>
      </header>

      {visible.length === 0 ? (
        <div className="manager__empty">No downloads in this category.</div>
      ) : (
        visible.map((job) => (
          <JobRow
            key={job.jobId}
            job={job}
            onRemove={() => onRemove(job.jobId)}
            onCancel={() => onCancel(job.jobId)}
            onRetry={() => onRetry(job)}
          />
        ))
      )}
    </div>
  );
}

function JobRow({
  job,
  onRemove,
  onCancel,
  onRetry,
}: {
  job: ManagedJobRecord;
  onRemove: () => void;
  onCancel: () => void;
  onRetry: () => void;
}): JSX.Element {
  const active = ACTIVE_PHASES.has(job.phase);
  const phaseClass =
    job.phase === "done"
      ? "manager__phase--done"
      : job.phase === "error"
        ? "manager__phase--error"
        : active
          ? "manager__phase--running"
          : "";

  const segCount =
    job.segmentsTotal && job.segmentsTotal > 0
      ? ` · ${job.segmentsDone ?? 0}/${job.segmentsTotal}`
      : "";
  const retries = job.retries ? ` · ${job.retries} retries` : "";

  return (
    <div className="manager__row">
      <div>
        <div className="manager__name" title={job.stream.suggestedName}>
          {job.stream.suggestedName}
        </div>
        <div className="manager__sub" title={job.stream.url}>
          {job.stream.kind.toUpperCase()} · {job.stream.url}
        </div>
        {active ? (
          <div className="progress" style={{ marginTop: 6 }}>
            <div className="progress__bar" style={{ width: `${job.ratio * 100}%` }} />
          </div>
        ) : null}
        {job.message || job.error ? (
          <div className="manager__sub">
            {job.error || job.message}
            {segCount}
            {retries}
          </div>
        ) : null}
      </div>
      <span className={`manager__phase ${phaseClass}`}>{job.phase}</span>
      <div style={{ display: "flex", gap: 6 }}>
        {active ? (
          <button className="app__btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {job.phase === "error" ? (
          <button className="app__btn" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {!active ? (
          <button className="app__btn" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

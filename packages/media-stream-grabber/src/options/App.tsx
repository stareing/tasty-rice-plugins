import { useCallback, useEffect, useState } from "react";
import {
  getUserRules,
  saveUserRules,
  type UserSiteRule,
} from "@/lib/siteRules";
import {
  bytesToMb,
  getMinSizeBytes,
  mbToBytes,
  setMinSizeBytes,
} from "@/lib/sizeFilter";

/**
 * Options page: per-site filename rules.
 *
 * The programmable surface is intentionally declarative — host suffixes,
 * a regex applied to the URL for `${id}` extraction, and a filename
 * template using `${name}` / `${id}` / `${title}`. No JS sandbox, no
 * code execution: rules just feed the existing `suggestedFilename`
 * pipeline so misuse can never escalate beyond a renamed file.
 */
export function App(): JSX.Element {
  const [rules, setRules] = useState<UserSiteRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minSizeMb, setMinSizeMb] = useState<string>("0");
  const [minSizeSaved, setMinSizeSaved] = useState<boolean>(false);

  useEffect(() => {
    void getUserRules().then((r) => {
      setRules(r);
      setLoaded(true);
    });
    void getMinSizeBytes().then((b) => {
      setMinSizeMb(bytesToMb(b).toString());
    });
  }, []);

  const onSaveMinSize = useCallback(async () => {
    const parsed = parseFloat(minSizeMb);
    const mb = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    await setMinSizeBytes(mbToBytes(mb));
    setMinSizeMb(mb.toString());
    setMinSizeSaved(true);
    setTimeout(() => setMinSizeSaved(false), 1500);
  }, [minSizeMb]);

  const onSave = useCallback(async () => {
    try {
      // Pre-flight regex compile — surface a clear error before
      // shipping a bad regex into chrome.storage.local.
      for (const r of rules) {
        if (r.idPattern) {
          new RegExp(r.idPattern);
        }
      }
      await saveUserRules(rules);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [rules]);

  const onAdd = useCallback(() => {
    setRules((prev) => [
      ...prev,
      {
        id: `rule-${Date.now().toString(36)}`,
        name: "New site",
        hostMatches: [],
        idPattern: "",
        filenameTemplate: "${name} - ${id}",
      },
    ]);
  }, []);

  const onRemove = useCallback((id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const onChange = useCallback(
    (id: string, patch: Partial<UserSiteRule>) => {
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [],
  );

  if (!loaded) {
    return (
      <div className="app">
        <div className="manager__empty">Loading…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="manager__toolbar">
        <span className="manager__title">Minimum download size</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="number"
            min={0}
            step={0.1}
            value={minSizeMb}
            onChange={(e) => setMinSizeMb(e.target.value)}
            style={{ width: 90 }}
          />
          <span>MB</span>
          <button className="app__btn app__btn--active" onClick={onSaveMinSize}>
            {minSizeSaved ? "Saved" : "Save"}
          </button>
        </div>
      </header>
      <p className="options__hint">
        Resources below this size are filtered before they reach the popup.
        Applies to direct image / audio / mp4 downloads only — manifests
        (HLS / DASH) and subtitles are exempt because they are inherently
        small. Use <code>0</code> to disable. Decisions use the response&apos;s
        <code>Content-Length</code>; resources without that header always
        pass through.
      </p>

      <header className="manager__toolbar">
        <span className="manager__title">Site rules</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="app__btn" onClick={onAdd}>Add rule</button>
          <button className="app__btn app__btn--active" onClick={onSave}>Save</button>
        </div>
      </header>

      <p className="options__hint">
        User rules override the built-in <code>siteRules</code> for filename hints.
        Supply hostname suffixes (one per line, e.g. <code>example.com</code>),
        an optional regex with one capture group for the video id, and a
        template using <code>{"${name}"}</code> / <code>{"${id}"}</code> /
        <code>{"${title}"}</code>. Rules apply on every newly-sniffed stream.
      </p>
      {error ? <div className="options__error">{error}</div> : null}

      {rules.length === 0 ? (
        <div className="manager__empty">No user rules yet.</div>
      ) : (
        rules.map((rule) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            onChange={(patch) => onChange(rule.id, patch)}
            onRemove={() => onRemove(rule.id)}
          />
        ))
      )}
    </div>
  );
}

function RuleCard({
  rule,
  onChange,
  onRemove,
}: {
  rule: UserSiteRule;
  onChange: (patch: Partial<UserSiteRule>) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="options__rule">
      <div className="options__rule__row">
        <label>
          Name
          <input
            value={rule.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        <label>
          Hostname suffixes (one per line)
          <textarea
            value={rule.hostMatches.join("\n")}
            onChange={(e) =>
              onChange({
                hostMatches: e.target.value
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      </div>
      <label>
        URL id pattern (regex with one capture group)
        <input
          value={rule.idPattern || ""}
          onChange={(e) => onChange({ idPattern: e.target.value })}
          placeholder="e.g. /watch\\?v=([\\w-]+)"
        />
      </label>
      <label>
        Filename template
        <input
          value={rule.filenameTemplate || ""}
          onChange={(e) => onChange({ filenameTemplate: e.target.value })}
          placeholder="${name} - ${id}"
        />
      </label>
      <div className="options__rule__actions">
        <button className="app__btn" onClick={onRemove}>Delete</button>
      </div>
    </div>
  );
}

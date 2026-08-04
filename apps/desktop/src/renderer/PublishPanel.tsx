import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Account, FolderSummary, Queue, QueueEntry, PrivacyStatus, UploadProgressEvent, AutoSyncStatus, ScheduleItem,
  UploadDefaults, EntryAnalytics, ChannelTrend, CommentSummary, SeoReport, BulkEditPatch, ChannelDashboardData,
} from "../shared/ipc.js";

const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
  { id: "1", label: "Film & Animation" },
  { id: "10", label: "Music" },
  { id: "20", label: "Gaming" },
  { id: "22", label: "People & Blogs" },
  { id: "23", label: "Comedy" },
  { id: "24", label: "Entertainment" },
  { id: "26", label: "Howto & Style" },
  { id: "27", label: "Education" },
  { id: "28", label: "Science & Technology" },
];

function fmtCount(n?: number): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const api = window.api;
const SCHEDULE_VIEW = "__schedule__";
const DASHBOARD_VIEW = "__dashboard__";

function fmtDate(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}
function fmtDay(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "No date set";
}
function toInputDatetime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PublishPanel({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [auto, setAuto] = useState<AutoSyncStatus | null>(null);
  const [titlePrefix, setTitlePrefix] = useState("");
  const [schedule, setSchedule] = useState<ScheduleItem[] | null>(null);
  const [dashboards, setDashboards] = useState<ChannelDashboardData[] | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);

  const pushLog = (line: string) => setLog((l) => [...l.slice(-200), line]);

  const refreshAccounts = () => api.ytListAccounts().then(setAccounts);
  const refreshFolders = () => api.ytListFolders().then(setFolders);
  const refreshQueue = (folder: string) => api.ytGetQueue(folder).then(setQueue);
  const refreshAuto = (folder: string) => api.ytAutoStatus(folder).then(setAuto);
  const refreshSchedule = () => api.ytGetSchedule().then(setSchedule);
  const refreshDashboard = () => api.ytGetDashboard().then(setDashboards);

  useEffect(() => { refreshAccounts(); refreshFolders(); }, []);
  useEffect(() => {
    if (selected === SCHEDULE_VIEW) { refreshSchedule(); setQueue(null); }
    else if (selected === DASHBOARD_VIEW) { refreshDashboard(); setQueue(null); }
    else if (selected) { refreshQueue(selected); refreshAuto(selected); }
    else setQueue(null);
  }, [selected]);
  useEffect(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }), [log]);

  useEffect(() => {
    const un1 = api.onUploadProgress(({ folder, ev }: { folder: string; ev: UploadProgressEvent }) => {
      if (ev.kind === "uploading") pushLog(`⬆️  [${folder}] ${ev.id} …`);
      else if (ev.kind === "done") pushLog(`✅ [${folder}] ${ev.id} → youtu.be/${ev.videoId}`);
      else if (ev.kind === "error") pushLog(`❌ [${folder}] ${ev.id}: ${ev.error}`);
      else if (ev.kind === "quota") pushLog(`⏸️  [${folder}] daily quota reached (${ev.uploaded}/${ev.total}) — resumes next run`);
      if (selected === folder) refreshQueue(folder);
      if (selected === SCHEDULE_VIEW) refreshSchedule();
    });
    const un2 = api.onSyncProgress(({ folder, msg }: { folder: string; msg: string }) => {
      pushLog(`🔗 [${folder}] ${msg}`);
      if (selected === folder) refreshQueue(folder);
      if (selected === SCHEDULE_VIEW) refreshSchedule();
    });
    const un3 = api.onThumbnailProgress(({ folder, ev }: { folder: string; ev: { id: string; ok: boolean; error?: string } }) => {
      pushLog(ev.ok ? `🖼️  [${folder}] ${ev.id} done` : `🖼️  [${folder}] ${ev.id} failed: ${ev.error}`);
    });
    return () => { un1(); un2(); un3(); };
  }, [selected]);

  const selectedFolder = useMemo(() => folders.find((f) => f.path === selected) ?? null, [folders, selected]);

  const pickFolder = async () => {
    const path = await api.ytPickFolder();
    if (path) { await refreshFolders(); setSelected(path); }
  };

  const addVideos = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const added = await api.ytAddToQueue(selected, { everyDays: 3, titlePrefix: titlePrefix.trim() || undefined });
      pushLog(added.length ? `Added ${added.length} video(s) to the queue.` : "Nothing new to add.");
      await refreshQueue(selected); await refreshFolders();
    } finally { setBusy(false); }
  };

  const runUploads = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.ytRun(selected);
      pushLog(`Run complete: ${r.uploaded}/${r.total} uploaded${r.quotaHit ? " (quota reached)" : ""}.`);
      await refreshFolders();
    } finally { setBusy(false); }
  };

  const runEverything = async () => {
    setBusy(true);
    try {
      pushLog(`Running ${folders.length} folder(s) concurrently…`);
      const results = await api.ytRunAll(folders.map((f) => f.path));
      for (const r of results) {
        pushLog(r.error ? `❌ ${r.folder}: ${r.error}` : `${r.folder}: ${r.upload.uploaded}/${r.upload.total} uploaded${r.sync ? `, +${r.sync.added.length} to playlist` : ""}`);
      }
      await refreshFolders(); if (selected) await refreshQueue(selected);
    } finally { setBusy(false); }
  };

  const retryThumbs = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.ytRetryThumbnails(selected);
      pushLog(r.total === 0 ? "Nothing to retry." : `${r.fixed}/${r.total} thumbnails fixed${r.quotaHit ? " (quota reached)" : ""}.`);
      await refreshQueue(selected);
    } finally { setBusy(false); }
  };

  const refreshFolderLiveStatus = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const touched = await api.ytRefreshLiveStatus(selected);
      pushLog(touched.length === 0 ? "Nothing to check yet." : `Refreshed live status/stats for ${touched.length} video(s).`);
      await refreshQueue(selected);
    } finally { setBusy(false); }
  };

  return (
    <div className="publish">
      <div className="publish-head">
        <span className="publish-title">📤 Publish</span>
        <div className="spacer" />
        <button className="primary" onClick={runEverything} disabled={busy || folders.length === 0}>▶ Run everything</button>
        <button onClick={onClose}>✕</button>
      </div>

      <div className="publish-body">
        <aside className="publish-sidebar">
          <div className="publish-section-label">Accounts</div>
          {accounts.map((a) => (
            <div key={a.id} className="account-chip" title={a.channelTitle ?? "not authorized"}>
              <span className="dot" style={{ background: a.channelTitle ? "#2fd6a0" : "#ffb347" }} />
              <span className="account-chip-label">{a.label}{a.channelTitle ? ` — ${a.channelTitle}` : ""}</span>
              <button
                className="account-reauth-btn"
                title="Re-grant permissions (needed once for Analytics access on accounts connected before it was added)"
                onClick={async () => {
                  pushLog(`Re-authorizing "${a.id}"… check your browser.`);
                  try {
                    const { channel } = await api.ytReauthorizeAccount(a.id);
                    pushLog(`✅ "${a.id}" re-authorized — channel "${channel}".`);
                    refreshAccounts();
                  } catch (err) { pushLog(`❌ ${(err as Error).message}`); }
                }}
              >
                ⟲
              </button>
            </div>
          ))}
          <button onClick={() => setShowAddAccount(true)}>+ Add account</button>

          <div className="publish-section-label" style={{ marginTop: 16 }}>Overview</div>
          <div
            className={`folder-item ${selected === SCHEDULE_VIEW ? "selected" : ""}`}
            onClick={() => setSelected(SCHEDULE_VIEW)}
          >
            <div className="folder-label">📅 Release Schedule</div>
            <div className="folder-stats">every album, one timeline</div>
          </div>
          <div
            className={`folder-item ${selected === DASHBOARD_VIEW ? "selected" : ""}`}
            onClick={() => setSelected(DASHBOARD_VIEW)}
          >
            <div className="folder-label">📊 Channel Dashboard</div>
            <div className="folder-stats">compare every channel</div>
          </div>

          <div className="publish-section-label" style={{ marginTop: 16 }}>Folders</div>
          {folders.map((f) => (
            <div key={f.path} className={`folder-item ${selected === f.path ? "selected" : ""}`} onClick={() => setSelected(f.path)}>
              <div className="folder-label">{f.label}</div>
              <div className="folder-stats">{f.uploaded} up · {f.pending} pending{f.errored ? ` · ${f.errored} err` : ""}</div>
            </div>
          ))}
          <button onClick={pickFolder}>+ Add folder</button>
        </aside>

        <main className="publish-main">
          {selected === SCHEDULE_VIEW ? (
            <ScheduleView items={schedule} accounts={accounts} onChanged={refreshSchedule} pushLog={pushLog} />
          ) : selected === DASHBOARD_VIEW ? (
            <DashboardView dashboards={dashboards} onRefresh={refreshDashboard} />
          ) : !selected || !queue ? (
            <div className="publish-empty">Pick a folder to manage its upload queue, or open the Release Schedule.</div>
          ) : (
            <>
              <div className="publish-toolbar">
                <select
                  value={queue.accountId ?? "default"}
                  onChange={async (e) => { await api.ytSetAccount(selected, e.target.value); refreshQueue(selected); }}
                >
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
                <input
                  className="title-prefix-input"
                  placeholder="Title prefix (e.g. your artist/channel name)"
                  value={titlePrefix}
                  onChange={(e) => setTitlePrefix(e.target.value)}
                  title="Prepended as “<prefix> - <filename>” to each new video's auto-generated title"
                />
                <button onClick={addVideos} disabled={busy}>Scan for new videos</button>
                <button onClick={runUploads} disabled={busy}>Upload pending</button>
                <button onClick={retryThumbs} disabled={busy}>Retry thumbnails</button>
                <button onClick={refreshFolderLiveStatus} disabled={busy}>🔄 Refresh from YouTube</button>
                <button onClick={() => api.revealPath(selected)}>Open folder</button>
                <button
                  className={bulkMode ? "active" : ""}
                  onClick={() => { setBulkMode((v) => !v); setSelectedIds(new Set()); }}
                >
                  {bulkMode ? "Cancel bulk edit" : "☑ Bulk edit"}
                </button>
              </div>

              {bulkMode && (
                <BulkEditBar
                  folder={selected}
                  selectedIds={selectedIds}
                  onDone={() => { setSelectedIds(new Set()); refreshQueue(selected); }}
                  pushLog={pushLog}
                />
              )}

              <div className="queue-table">
                {queue.entries.length === 0 && <div className="publish-empty">No videos queued yet.</div>}
                {queue.entries.map((e) => (
                  <EntryRow
                    key={e.id}
                    folder={selected}
                    entry={e}
                    onChanged={() => refreshQueue(selected)}
                    selectable={bulkMode && e.status === "uploaded"}
                    selected={selectedIds.has(e.id)}
                    onToggleSelect={() => setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.id)) next.delete(e.id); else next.add(e.id);
                      return next;
                    })}
                  />
                ))}
              </div>

              <PlaylistSection folder={selected} queue={queue} onChanged={() => refreshQueue(selected)} pushLog={pushLog} busy={busy} setBusy={setBusy} />
              <UploadSettingsSection folder={selected} queue={queue} pushLog={pushLog} />
              <AutoSyncSection folder={selected} auto={auto} onChanged={() => refreshAuto(selected)} pushLog={pushLog} />
            </>
          )}

          <div className="publish-log" ref={logRef}>
            {log.map((l, i) => <div key={i} className="publish-log-line">{l}</div>)}
          </div>
        </main>
      </div>

      {showAddAccount && (
        <AddAccountModal
          onCancel={() => setShowAddAccount(false)}
          onDone={() => { setShowAddAccount(false); refreshAccounts(); }}
          pushLog={pushLog}
        />
      )}
    </div>
  );
}

/** entry.status only means "we uploaded it" — YouTube auto-flips privacyStatus
 *  to public at publishAt server-side, so livePrivacyStatus (cached, refreshed
 *  on demand via ytRefreshLiveStatus) is what actually tells you if it's public yet. */
function StatusBadge({ entry }: { entry: QueueEntry }) {
  if (entry.status === "error") return <span className="badge-status error" title={entry.error}>❌ error</span>;
  if (entry.status === "pending") return <span className="badge-status pending">⏳ pending upload</span>;
  if (entry.livePrivacyStatus === "public") {
    return <span className="badge-status live">🌐 live{entry.addedToPlaylist ? " · in playlist" : ""}</span>;
  }
  return (
    <span className="badge-status uploaded" title={entry.livePrivacyStatus ? undefined : "Live status not checked yet — click Refresh live status"}>
      🔒 scheduled {entry.publishAt ? `for ${fmtDate(entry.publishAt)}` : ""}
    </span>
  );
}

/** Mirrors YouTube's own view/like/comment counts — only meaningful once the
 *  video is actually live, and only as fresh as the last "Refresh live status". */
function StatsLine({ entry }: { entry: QueueEntry }) {
  if (entry.livePrivacyStatus !== "public" || entry.viewCount === undefined) return null;
  return (
    <div className="queue-stats" title={entry.liveCheckedAt ? `As of ${fmtDate(entry.liveCheckedAt)}` : undefined}>
      👁 {fmtCount(entry.viewCount)} · 👍 {fmtCount(entry.likeCount)} · 💬 {fmtCount(entry.commentCount)}
    </div>
  );
}

function ScheduleView({ items, accounts, onChanged, pushLog }: {
  items: ScheduleItem[] | null; accounts: Account[]; onChanged: () => void; pushLog: (s: string) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<"list" | "calendar">("list");
  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [selected, setSelected] = useState<{ folder: string; id: string } | null>(null);
  const autoJumped = useRef(false);

  useEffect(() => {
    if (!items || items.length === 0 || autoJumped.current) return;
    autoJumped.current = true;
    const now = Date.now();
    const upcoming = items.find((i) => i.entry.publishAt && new Date(i.entry.publishAt).getTime() >= now);
    const target = upcoming ?? items[items.length - 1];
    if (target?.entry.publishAt) setViewMonth(new Date(target.entry.publishAt));
  }, [items]);

  const refreshLive = async () => {
    if (!items) return;
    setRefreshing(true);
    try {
      const folders = [...new Set(items.map((i) => i.folder))];
      let total = 0;
      for (const folder of folders) {
        const touched = await api.ytRefreshLiveStatus(folder);
        total += touched.length;
      }
      pushLog(`Checked live status for ${total} video(s) across ${folders.length} folder(s).`);
      onChanged();
    } finally { setRefreshing(false); }
  };

  if (!items) return <div className="publish-empty">Loading schedule…</div>;
  if (items.length === 0) return <div className="publish-empty">No videos queued anywhere yet — add some from a folder first.</div>;

  const groups: { day: string; items: ScheduleItem[] }[] = [];
  for (const item of items) {
    const day = fmtDay(item.entry.publishAt);
    if (groups.length === 0 || groups[groups.length - 1]!.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1]!.items.push(item);
  }

  const selectedItem = selected ? items.find((i) => i.folder === selected.folder && i.entry.id === selected.id) ?? null : null;

  return (
    <div className="schedule-view">
      <ChannelHealthStrip accounts={accounts} />
      <div className="publish-toolbar">
        <div className="view-toggle">
          <button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>📋 List</button>
          <button className={mode === "calendar" ? "active" : ""} onClick={() => setMode("calendar")}>🗓️ Calendar</button>
        </div>
        <button className="primary" onClick={refreshLive} disabled={refreshing}>
          {refreshing ? "Checking…" : "🔄 Refresh from YouTube"}
        </button>
        <span className="hint">Pulls real publish status plus views/likes/comments straight from YouTube.</span>
      </div>

      {mode === "calendar" ? (
        <>
          <div className="calendar-nav">
            <button onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}>‹</button>
            <div className="calendar-month-label">{viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
            <button onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}>›</button>
            <button onClick={() => setViewMonth(new Date())}>Today</button>
          </div>
          <CalendarGrid items={items} viewMonth={viewMonth} onSelect={(item) => setSelected({ folder: item.folder, id: item.entry.id })} />
          {selectedItem && (
            <div className="schedule-detail">
              <EntryRow folder={selectedItem.folder} entry={selectedItem.entry} folderLabel={selectedItem.folderLabel} onChanged={onChanged} />
              <button onClick={() => setSelected(null)}>Close</button>
            </div>
          )}
        </>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="schedule-group">
            <div className="schedule-day-label">{g.day}</div>
            {g.items.map((item) => (
              <EntryRow key={`${item.folder}/${item.entry.id}`} folder={item.folder} entry={item.entry} folderLabel={item.folderLabel} onChanged={onChanged} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** Per-account "this week vs channel total" cards — built from local history
 *  that accumulates each time "Refresh from YouTube" runs (see
 *  recordChannelSnapshot in channelhealth.ts). Silently shows nothing for an
 *  account until it has at least one recorded day. */
function ChannelHealthStrip({ accounts }: { accounts: Account[] }) {
  const [trends, setTrends] = useState<Record<string, ChannelTrend>>({});
  const accountIds = accounts.map((a) => a.id).join(",");

  useEffect(() => {
    let cancelled = false;
    Promise.all(accounts.map((a) => api.ytGetChannelHealth(a.id).then((t) => [a.id, t] as const)))
      .then((pairs) => { if (!cancelled) setTrends(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIds]);

  const withData = accounts.filter((a) => trends[a.id]?.latest);
  if (withData.length === 0) return null;

  return (
    <div className="channel-health-strip">
      {withData.map((a) => {
        const t = trends[a.id]!;
        return (
          <div key={a.id} className="channel-health-card">
            <div className="channel-health-name">{a.label}</div>
            <div className="channel-health-total">{fmtCount(t.latest!.subscriberCount)} subs · {fmtCount(t.latest!.viewCount)} total views</div>
            {t.last7Days && (
              <div className="channel-health-week">
                +{fmtCount(t.last7Days.views)} views · +{t.last7Days.subscribers} subs
                <span className="hint"> past 7 days</span>
                {t.prev7Days && (
                  t.last7Days.views >= t.prev7Days.views
                    ? <span className="trend-up"> ▲</span>
                    : <span className="trend-down"> ▼</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmtMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Per-channel + cross-channel comparison — one row per connected account, so
 *  adding a second channel (e.g. a different-brand channel) automatically
 *  turns this into a real side-by-side comparison with no extra work. */
function DashboardView({ dashboards, onRefresh }: { dashboards: ChannelDashboardData[] | null; onRefresh: () => void }) {
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  if (!dashboards) return <div className="publish-empty">Loading dashboard…</div>;
  if (dashboards.length === 0) return <div className="publish-empty">No accounts connected yet — add one from the sidebar.</div>;

  return (
    <div className="dashboard-view">
      <div className="publish-toolbar">
        <button className="primary" onClick={refresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "🔄 Refresh dashboard"}</button>
        <span className="hint">Lifetime totals + week-over-week come from local history (see each folder's "Refresh from YouTube"); the 28-day columns are live Analytics API data.</span>
      </div>

      <div className="dashboard-table-wrap">
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Subscribers</th>
              <th>Total views</th>
              <th>Videos</th>
              <th>Views (28d)</th>
              <th>Watch time (28d)</th>
              <th>Avg duration</th>
              <th>Avg % viewed</th>
              <th>Subs Δ (28d)</th>
              <th>7-day trend</th>
            </tr>
          </thead>
          <tbody>
            {dashboards.map((d) => (
              <tr key={d.accountId}>
                <td className="dashboard-channel-cell">
                  <div className="dashboard-channel-label">{d.accountLabel}</div>
                  {d.channelTitle && <div className="hint">{d.channelTitle}</div>}
                </td>
                <td>{d.lifetime ? fmtCount(d.lifetime.subscriberCount) : "—"}</td>
                <td>{d.lifetime ? fmtCount(d.lifetime.viewCount) : "—"}</td>
                <td>{d.lifetime ? d.lifetime.videoCount : "—"}</td>
                <td>{d.last28Days ? fmtCount(d.last28Days.views) : "—"}</td>
                <td>{d.last28Days ? fmtMinutes(d.last28Days.estimatedMinutesWatched) : "—"}</td>
                <td>{d.last28Days ? fmtDuration(d.last28Days.averageViewDuration) : "—"}</td>
                <td>{d.last28Days ? `${d.last28Days.averageViewPercentage.toFixed(0)}%` : "—"}</td>
                <td>{d.last28Days ? `+${d.last28Days.subscribersGained}/-${d.last28Days.subscribersLost}` : "—"}</td>
                <td>
                  {d.weekTrend ? (
                    <>
                      +{fmtCount(d.weekTrend.views)} views
                      {d.weekTrend.subscribers !== 0 && `, +${d.weekTrend.subscribers} subs`}
                    </>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dashboards.some((d) => d.error) && (
        <div className="dashboard-errors">
          {dashboards.filter((d) => d.error).map((d) => (
            <div key={d.accountId} className="hint">⚠ {d.accountLabel}: {d.error}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function pillStatus(entry: QueueEntry): string {
  if (entry.status === "error") return "error";
  if (entry.status === "pending") return "pending";
  if (entry.livePrivacyStatus === "public") return "live";
  return "scheduled";
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function CalendarGrid({ items, viewMonth, onSelect }: {
  items: ScheduleItem[]; viewMonth: Date; onSelect: (item: ScheduleItem) => void;
}) {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const byDay = new Map<number, ScheduleItem[]>();
  for (const item of items) {
    if (!item.entry.publishAt) continue;
    const d = new Date(item.entry.publishAt);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const key = d.getDate();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(item);
    }
  }

  const today = new Date();
  const isToday = (day: number) => today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;

  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="calendar-grid">
      <div className="calendar-cells calendar-weekdays">
        {WEEKDAY_LABELS.map((d) => <div key={d} className="calendar-weekday">{d}</div>)}
      </div>
      <div className="calendar-cells">
        {cells.map((day, i) => (
          <div key={i} className={`calendar-cell${day === null ? " empty" : ""}${day !== null && isToday(day) ? " today" : ""}`}>
            {day !== null && (
              <>
                <div className="calendar-day-num">{day}</div>
                <div className="calendar-day-items">
                  {(byDay.get(day) ?? []).map((item) => (
                    <button
                      key={`${item.folder}/${item.entry.id}`}
                      className={`calendar-pill status-${pillStatus(item.entry)}`}
                      onClick={() => onSelect(item)}
                      title={`${item.entry.title} — ${item.folderLabel}`}
                    >
                      {item.entry.title}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One video's row — used identically by the per-folder queue view and the
 *  cross-folder schedule view. Editing (title/description/tags/schedule)
 *  works the same whether the video is still pending or already live: for a
 *  live video, saving also pushes the change to YouTube itself (see
 *  updateQueueEntry in manager.ts) — no more "go edit it on YouTube directly." */
/** Apply one change across every selected already-uploaded video at once —
 *  built on the same updateLiveVideo path as single-entry editing, so it's
 *  the exact same real API call repeated, not a separate code path. */
function BulkEditBar({ folder, selectedIds, onDone, pushLog }: {
  folder: string; selectedIds: Set<string>; onDone: () => void; pushLog: (s: string) => void;
}) {
  const [addTag, setAddTag] = useState("");
  const [removeTag, setRemoveTag] = useState("");
  const [privacy, setPrivacy] = useState<"" | PrivacyStatus>("");
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    const patch: BulkEditPatch = {};
    if (addTag.trim()) patch.addTags = [addTag.trim()];
    if (removeTag.trim()) patch.removeTags = [removeTag.trim()];
    if (privacy) patch.privacyStatus = privacy;
    if (Object.keys(patch).length === 0) return;

    setBusy(true);
    try {
      const result = await api.ytBulkUpdate(folder, [...selectedIds], patch);
      pushLog(
        `Bulk edit: updated ${result.updated.length}/${selectedIds.size}` +
        (result.quotaHit ? " (quota reached — re-run for the rest)" : "") +
        (result.failed.length ? `, ${result.failed.length} failed` : ""),
      );
      setAddTag(""); setRemoveTag(""); setPrivacy("");
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="bulk-edit-bar">
      <span className="bulk-edit-count">{selectedIds.size} selected</span>
      <input placeholder="+ add tag" value={addTag} onChange={(e) => setAddTag(e.target.value)} />
      <input placeholder="− remove tag" value={removeTag} onChange={(e) => setRemoveTag(e.target.value)} />
      <select value={privacy} onChange={(e) => setPrivacy(e.target.value as "" | PrivacyStatus)}>
        <option value="">Leave privacy as-is</option>
        <option value="public">Set public</option>
        <option value="unlisted">Set unlisted</option>
        <option value="private">Set private</option>
      </select>
      <button className="primary" onClick={apply} disabled={busy || selectedIds.size === 0}>
        {busy ? "Applying…" : `Apply to ${selectedIds.size}`}
      </button>
    </div>
  );
}

function EntryRow({ folder, entry, folderLabel, onChanged, selectable, selected, onToggleSelect }: {
  folder: string; entry: QueueEntry; folderLabel?: string; onChanged: () => void;
  selectable?: boolean; selected?: boolean; onToggleSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [description, setDescription] = useState(entry.description);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [when, setWhen] = useState(toInputDatetime(entry.publishAt));
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [busy, setBusy] = useState(false);

  const isPublic = entry.livePrivacyStatus === "public";

  const startEdit = () => {
    setTitle(entry.title); setDescription(entry.description); setTags(entry.tags.join(", ")); setWhen(toInputDatetime(entry.publishAt));
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.ytUpdateEntry(folder, entry.id, {
        title,
        description,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        ...(isPublic ? {} : { publishAt: when ? new Date(when).toISOString() : undefined }),
      });
      setEditing(false);
      onChanged();
    } finally { setBusy(false); }
  };
  const remove = async () => {
    await api.ytRemoveEntry(folder, entry.id);
    onChanged();
  };

  return (
    <div className="entry-row-wrap">
      <div className="queue-row">
        {selectable && (
          <input type="checkbox" className="entry-select-checkbox" checked={Boolean(selected)} onChange={onToggleSelect} />
        )}
        {entry.thumbnailPath && <img className="queue-thumb" src={`vfile://local/${encodeURIComponent(entry.thumbnailPath)}`} />}
        <div className="queue-info">
          {editing ? (
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          ) : (
            <div className="queue-title">{entry.title}</div>
          )}
          <div className="queue-date">
            {folderLabel && <span className="folder-chip">{folderLabel}</span>}
            {editing && !isPublic ? (
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            ) : (
              <> · publishes {fmtDate(entry.publishAt)}</>
            )}
          </div>
          <StatsLine entry={entry} />
        </div>
        <StatusBadge entry={entry} />
        <div className="queue-actions">
          {editing ? (
            <>
              <button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
              <button onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={startEdit}>Edit</button>
              {entry.status === "pending" && <button className="danger" onClick={remove}>Remove</button>}
              {entry.status === "uploaded" && <button onClick={() => setShowAnalytics((v) => !v)}>{showAnalytics ? "Hide" : "📊"}</button>}
              {entry.status === "uploaded" && <button onClick={() => setShowComments((v) => !v)}>{showComments ? "Hide" : "💬"}</button>}
              {entry.youtubeVideoId && <a href={`https://youtu.be/${entry.youtubeVideoId}`} target="_blank" rel="noreferrer">View</a>}
            </>
          )}
        </div>
      </div>
      {editing && (
        <div className="entry-edit-extra">
          <textarea rows={3} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <input placeholder="tags, comma, separated" value={tags} onChange={(e) => setTags(e.target.value)} />
          <KeywordSuggest onAdd={(kw) => setTags((t) => (t.trim() ? `${t}, ${kw}` : kw))} />
          <SeoPanel title={title} description={description} tags={tags.split(",").map((t) => t.trim()).filter(Boolean)} />
        </div>
      )}
      {showAnalytics && <AnalyticsPanel folder={folder} entryId={entry.id} />}
      {showComments && <CommentsPanel folder={folder} entryId={entry.id} />}
    </div>
  );
}

/** Deterministic checklist scored against YouTube's own documented metadata
 *  conventions (title/description length, links, hashtags, tag budget,
 *  title↔tag overlap) — no model guessing, just the same rules a human SEO
 *  checklist would use. Debounced since it recomputes on every keystroke. */
function SeoPanel({ title, description, tags }: { title: string; description: string; tags: string[] }) {
  const [report, setReport] = useState<SeoReport | null>(null);
  const tagsKey = tags.join(",");

  useEffect(() => {
    const t = setTimeout(() => { api.ytCheckSeo({ title, description, tags }).then(setReport); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, tagsKey]);

  if (!report) return null;
  return (
    <div className="seo-panel">
      <div className="seo-score">SEO checklist — <b>{report.score}%</b></div>
      <ul className="seo-checklist">
        {report.checks.map((c) => (
          <li key={c.id} className={c.passed ? "seo-pass" : "seo-fail"}>{c.passed ? "✓" : "✗"} {c.message}</li>
        ))}
      </ul>
    </div>
  );
}

/** Tag/keyword ideas straight from YouTube's own search-autocomplete — real
 *  search demand, not a guess — click a suggestion to add it as a tag. */
function KeywordSuggest({ onAdd }: { onAdd: (keyword: string) => void }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try { setSuggestions(await api.ytSuggestKeywords(query.trim())); } finally { setBusy(false); }
  };

  return (
    <div className="keyword-suggest">
      <div className="keyword-suggest-row">
        <input
          placeholder="Keyword idea (e.g. your genre, mood)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
        />
        <button onClick={search} disabled={busy || !query.trim()}>{busy ? "…" : "Suggest"}</button>
      </div>
      {suggestions.length > 0 && (
        <div className="keyword-chips">
          {suggestions.map((s) => (
            <button key={s} className="keyword-chip" onClick={() => onAdd(s)} title="Add as a tag">+ {s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalyticsPanel({ folder, entryId }: { folder: string; entryId: string }) {
  const [state, setState] = useState<{ loading: boolean; error?: string; data?: EntryAnalytics }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    api.ytGetAnalytics(folder, entryId)
      .then((data) => { if (!cancelled) setState({ loading: false, data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: (err as Error).message }); });
    return () => { cancelled = true; };
  }, [folder, entryId]);

  if (state.loading) return <div className="analytics-panel hint">Loading analytics…</div>;
  if (state.error) return <div className="analytics-panel hint">Couldn't load analytics: {state.error}</div>;
  const { analytics, trafficSources } = state.data!;
  if (!analytics) return <div className="analytics-panel hint">No analytics data yet — check back once it's had some views.</div>;

  const mins = Math.floor(analytics.averageViewDuration / 60);
  const secs = Math.round(analytics.averageViewDuration % 60);
  return (
    <div className="analytics-panel">
      <div className="analytics-stat"><b>{fmtCount(analytics.views)}</b> views</div>
      <div className="analytics-stat"><b>{fmtCount(Math.round(analytics.estimatedMinutesWatched))}</b> min watched</div>
      <div className="analytics-stat"><b>{mins}:{String(secs).padStart(2, "0")}</b> avg view duration</div>
      <div className="analytics-stat"><b>{analytics.averageViewPercentage.toFixed(0)}%</b> avg viewed</div>
      <div className="analytics-stat"><b>+{analytics.subscribersGained}/-{analytics.subscribersLost}</b> subs</div>
      {trafficSources.length > 0 && (
        <div className="analytics-traffic">
          Top traffic: {trafficSources.slice(0, 3).map((t) => `${t.source} (${fmtCount(t.views)})`).join(", ")}
        </div>
      )}
    </div>
  );
}

/** Note: YouTube's public API has no way to PIN a comment (Studio-only) — this
 *  covers reading, posting a new top-level comment, and replying. */
function CommentsPanel({ folder, entryId }: { folder: string; entryId: string }) {
  const [comments, setComments] = useState<CommentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newText, setNewText] = useState("");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setComments(null);
    setError(null);
    api.ytListComments(folder, entryId).then(setComments).catch((err) => setError((err as Error).message));
  };
  useEffect(refresh, [folder, entryId]);

  const postNew = async () => {
    if (!newText.trim()) return;
    setBusy(true);
    try { await api.ytPostComment(folder, entryId, newText.trim()); setNewText(""); refresh(); } finally { setBusy(false); }
  };
  const sendReply = async (parentId: string) => {
    if (!replyText.trim()) return;
    setBusy(true);
    try { await api.ytReplyComment(folder, parentId, replyText.trim()); setReplyText(""); setReplyingTo(null); refresh(); } finally { setBusy(false); }
  };

  return (
    <div className="comments-panel">
      <div className="comments-post-new">
        <input
          placeholder="Post a new comment (e.g. links, a shoutout, a CTA)…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
        />
        <button onClick={postNew} disabled={busy || !newText.trim()}>Post</button>
      </div>
      {error && <div className="hint">Couldn't load comments: {error}</div>}
      {comments === null && !error && <div className="hint">Loading comments…</div>}
      {comments?.length === 0 && <div className="hint">No comments yet (or comments are turned off for this video).</div>}
      {comments?.map((c) => (
        <div key={c.id} className="comment-row">
          <div className="comment-header"><b>{c.authorDisplayName}</b> <span className="hint">{fmtDate(c.publishedAt)} · 👍 {c.likeCount}</span></div>
          <div className="comment-text">{c.textDisplay}</div>
          {replyingTo === c.id ? (
            <div className="comment-reply-box">
              <input placeholder="Reply…" value={replyText} onChange={(e) => setReplyText(e.target.value)} autoFocus />
              <button onClick={() => sendReply(c.id)} disabled={busy || !replyText.trim()}>Send</button>
              <button onClick={() => setReplyingTo(null)}>Cancel</button>
            </div>
          ) : (
            <button className="comment-reply-btn" onClick={() => setReplyingTo(c.id)}>
              Reply{c.totalReplyCount ? ` (${c.totalReplyCount})` : ""}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function PlaylistSection({ folder, queue, onChanged, pushLog, busy, setBusy }: {
  folder: string; queue: Queue; onChanged: () => void;
  pushLog: (s: string) => void; busy: boolean; setBusy: (b: boolean) => void;
}) {
  const [title, setTitle] = useState(queue.playlist?.title ?? "");
  const [privacy, setPrivacy] = useState<PrivacyStatus>(queue.playlist?.privacyStatus ?? "public");

  useEffect(() => { setTitle(queue.playlist?.title ?? ""); setPrivacy(queue.playlist?.privacyStatus ?? "public"); }, [queue.playlist?.title]);

  const save = async () => {
    if (!title.trim()) return;
    await api.ytSetPlaylist(folder, { title, privacyStatus: privacy });
    onChanged();
    pushLog(`Playlist config saved: "${title}".`);
  };
  const preview = async () => {
    const plan = await api.ytPreviewSync(folder);
    pushLog(`Playlist preview — would add ${plan.toAdd.length}, ${plan.notLiveYet.length} not live yet.`);
  };
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api.ytSyncPlaylist(folder);
      pushLog(r.quotaHit ? "Quota reached — retry later." : `Playlist synced — added ${r.added.length}.`);
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <div className="publish-subsection">
      <div className="publish-section-label">Playlist</div>
      <div className="playlist-row">
        <input placeholder="Playlist title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={privacy} onChange={(e) => setPrivacy(e.target.value as PrivacyStatus)}>
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </select>
        <button onClick={save}>Save</button>
        <button onClick={preview} disabled={busy}>Preview</button>
        <button className="primary" onClick={sync} disabled={busy || !queue.playlist}>Sync now</button>
      </div>
      {queue.playlist?.playlistId && (
        <a href={`https://www.youtube.com/playlist?list=${queue.playlist.playlistId}`} target="_blank" rel="noreferrer">
          View playlist on YouTube
        </a>
      )}
    </div>
  );
}

/** Per-folder defaults (category, made-for-kids, license, …) applied to
 *  every NEW video added to this folder's queue — e.g. a kids'-content
 *  channel can default madeForKids to true so it doesn't need setting by
 *  hand on every upload. Doesn't change videos already queued/uploaded. */
function UploadSettingsSection({ folder, queue, pushLog }: { folder: string; queue: Queue; pushLog: (s: string) => void }) {
  const d = queue.uploadDefaults ?? {};
  const [categoryId, setCategoryId] = useState(d.categoryId ?? "10");
  const [madeForKids, setMadeForKids] = useState(d.madeForKids ?? false);
  const [license, setLicense] = useState<"youtube" | "creativeCommon">(d.license ?? "youtube");
  const [embeddable, setEmbeddable] = useState(d.embeddable ?? true);
  const [publicStatsViewable, setPublicStatsViewable] = useState(d.publicStatsViewable ?? true);
  const [notifySubscribers, setNotifySubscribers] = useState(d.notifySubscribers ?? true);
  const [descriptionTemplate, setDescriptionTemplate] = useState(d.descriptionTemplate ?? "");
  const [autoCommentTemplate, setAutoCommentTemplate] = useState(d.autoCommentTemplate ?? "");

  useEffect(() => {
    const nd = queue.uploadDefaults ?? {};
    setCategoryId(nd.categoryId ?? "10");
    setMadeForKids(nd.madeForKids ?? false);
    setLicense(nd.license ?? "youtube");
    setEmbeddable(nd.embeddable ?? true);
    setPublicStatsViewable(nd.publicStatsViewable ?? true);
    setNotifySubscribers(nd.notifySubscribers ?? true);
    setDescriptionTemplate(nd.descriptionTemplate ?? "");
    setAutoCommentTemplate(nd.autoCommentTemplate ?? "");
  }, [folder]);

  const save = async () => {
    const defaults: UploadDefaults = {
      categoryId, madeForKids, license, embeddable, publicStatsViewable, notifySubscribers,
      descriptionTemplate: descriptionTemplate || undefined,
      autoCommentTemplate: autoCommentTemplate || undefined,
    };
    await api.ytSetUploadDefaults(folder, defaults);
    pushLog(`Upload defaults saved for new videos in this folder${madeForKids ? " (made for kids)" : ""}.`);
  };

  return (
    <div className="publish-subsection">
      <div className="publish-section-label">Upload settings (applied to new videos added here)</div>
      <div className="upload-settings-grid">
        <label>
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {YOUTUBE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label>
          License
          <select value={license} onChange={(e) => setLicense(e.target.value as "youtube" | "creativeCommon")}>
            <option value="youtube">Standard YouTube License</option>
            <option value="creativeCommon">Creative Commons — Attribution</option>
          </select>
        </label>
        <label className="checkbox-label" title="Required by YouTube (COPPA) — restricts comments, notifications, and personalized ads on the video.">
          <input type="checkbox" checked={madeForKids} onChange={(e) => setMadeForKids(e.target.checked)} />
          Made for kids
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={embeddable} onChange={(e) => setEmbeddable(e.target.checked)} />
          Allow embedding
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={publicStatsViewable} onChange={(e) => setPublicStatsViewable(e.target.checked)} />
          Public stats (views/likes visible to everyone)
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={notifySubscribers} onChange={(e) => setNotifySubscribers(e.target.checked)} />
          Notify subscribers on upload
        </label>
      </div>
      <label className="template-field">
        Description template <span className="hint">— {"{title}"} is replaced with each video's title; leave blank to just use the title</span>
        <textarea rows={3} value={descriptionTemplate} onChange={(e) => setDescriptionTemplate(e.target.value)} placeholder={"{title}\n\nListen everywhere: https://...\n#yourtag #genre"} />
      </label>
      <label className="template-field">
        Auto-comment on upload <span className="hint">— posted automatically right after each upload (YouTube's API can't pin it, only post it); leave blank to skip</span>
        <textarea rows={2} value={autoCommentTemplate} onChange={(e) => setAutoCommentTemplate(e.target.value)} placeholder="Thanks for listening! Full tracklist + links below 👇" />
      </label>
      <button className="primary" onClick={save}>Save upload settings</button>
    </div>
  );
}

function AutoSyncSection({ folder, auto, onChanged, pushLog }: {
  folder: string; auto: AutoSyncStatus | null; onChanged: () => void; pushLog: (s: string) => void;
}) {
  const [time, setTime] = useState(auto?.time ?? "09:00");

  const enable = async () => {
    await api.ytAutoEnable(folder, time);
    pushLog(`Daily auto-run scheduled at ${time}.`);
    onChanged();
  };
  const disable = async () => {
    await api.ytAutoDisable(folder);
    pushLog("Auto-run disabled.");
    onChanged();
  };
  const runNow = async () => {
    await api.ytAutoRunNow(folder);
    pushLog("Triggered the scheduled task now.");
  };

  return (
    <div className="publish-subsection">
      <div className="publish-section-label">Automatic daily run</div>
      <div className="playlist-row">
        <span className={`auto-dot ${auto?.enabled ? "on" : ""}`} />
        <span>{auto?.enabled ? `Enabled — next run ${auto.nextRun ?? "?"}` : "Disabled"}</span>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        {auto?.enabled ? (
          <>
            <button onClick={enable}>Update time</button>
            <button className="danger" onClick={disable}>Disable</button>
            <button onClick={runNow}>Run now</button>
          </>
        ) : (
          <button className="primary" onClick={enable}>Enable</button>
        )}
      </div>
    </div>
  );
}

function AddAccountModal({ onCancel, onDone, pushLog }: { onCancel: () => void; onDone: () => void; pushLog: (s: string) => void }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [clientSecretPath, setClientSecretPath] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const pick = async () => setClientSecretPath(await api.ytPickClientSecret());
  const submit = async () => {
    if (!id.trim()) return;
    setWorking(true);
    try {
      pushLog(`Authorizing account "${id}"… check your browser.`);
      const { channel } = await api.ytAddAccount(id, label || id, clientSecretPath ?? undefined);
      pushLog(`✅ Account "${id}" authorized — channel "${channel}".`);
      onDone();
    } catch (err) {
      pushLog(`❌ ${(err as Error).message}`);
    } finally { setWorking(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add YouTube account</h2>
        <label>Account ID<input value={id} onChange={(e) => setId(e.target.value)} placeholder="kids-books" /></label>
        <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Kids Books Channel" /></label>
        <label>
          OAuth client (optional — reuses your default one if skipped)
          <button onClick={pick}>{clientSecretPath ? "Change file…" : "Pick client_secret.json…"}</button>
        </label>
        <p className="hint">This opens your browser to sign in with the Google account for this channel.</p>
        <div className="modal-actions">
          <button onClick={onCancel} disabled={working}>Cancel</button>
          <button className="primary" onClick={submit} disabled={working || !id.trim()}>{working ? "Authorizing…" : "Connect"}</button>
        </div>
      </div>
    </div>
  );
}

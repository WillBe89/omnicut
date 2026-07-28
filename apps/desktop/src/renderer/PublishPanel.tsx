import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Account, FolderSummary, Queue, QueueEntry, PrivacyStatus, UploadProgressEvent, AutoSyncStatus,
} from "../shared/ipc.js";

const api = window.api;

function fmtDate(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "—";
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
  const logRef = useRef<HTMLDivElement>(null);

  const pushLog = (line: string) => setLog((l) => [...l.slice(-200), line]);

  const refreshAccounts = () => api.ytListAccounts().then(setAccounts);
  const refreshFolders = () => api.ytListFolders().then(setFolders);
  const refreshQueue = (folder: string) => api.ytGetQueue(folder).then(setQueue);
  const refreshAuto = (folder: string) => api.ytAutoStatus(folder).then(setAuto);

  useEffect(() => { refreshAccounts(); refreshFolders(); }, []);
  useEffect(() => { if (selected) { refreshQueue(selected); refreshAuto(selected); } else setQueue(null); }, [selected]);
  useEffect(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }), [log]);

  useEffect(() => {
    const un1 = api.onUploadProgress(({ folder, ev }: { folder: string; ev: UploadProgressEvent }) => {
      if (ev.kind === "uploading") pushLog(`⬆️  [${folder}] ${ev.id} …`);
      else if (ev.kind === "done") pushLog(`✅ [${folder}] ${ev.id} → youtu.be/${ev.videoId}`);
      else if (ev.kind === "error") pushLog(`❌ [${folder}] ${ev.id}: ${ev.error}`);
      else if (ev.kind === "quota") pushLog(`⏸️  [${folder}] daily quota reached (${ev.uploaded}/${ev.total}) — resumes next run`);
      if (selected === folder) refreshQueue(folder);
    });
    const un2 = api.onSyncProgress(({ folder, msg }: { folder: string; msg: string }) => {
      pushLog(`🔗 [${folder}] ${msg}`);
      if (selected === folder) refreshQueue(folder);
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
              {a.label}{a.channelTitle ? ` — ${a.channelTitle}` : ""}
            </div>
          ))}
          <button onClick={() => setShowAddAccount(true)}>+ Add account</button>

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
          {!selected || !queue ? (
            <div className="publish-empty">Pick a folder to manage its upload queue.</div>
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
                <button onClick={() => api.revealPath(selected)}>Open folder</button>
              </div>

              <div className="queue-table">
                {queue.entries.length === 0 && <div className="publish-empty">No videos queued yet.</div>}
                {queue.entries.map((e) => (
                  <QueueRow key={e.id} folder={selected} entry={e} onChanged={() => refreshQueue(selected)} />
                ))}
              </div>

              <PlaylistSection folder={selected} queue={queue} onChanged={() => refreshQueue(selected)} pushLog={pushLog} busy={busy} setBusy={setBusy} />
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

function QueueRow({ folder, entry, onChanged }: { folder: string; entry: QueueEntry; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [when, setWhen] = useState(toInputDatetime(entry.publishAt));

  const save = async () => {
    await api.ytUpdateEntry(folder, entry.id, { title, publishAt: when ? new Date(when).toISOString() : undefined });
    setEditing(false);
    onChanged();
  };
  const remove = async () => {
    await api.ytRemoveEntry(folder, entry.id);
    onChanged();
  };

  const statusBadge =
    entry.status === "uploaded" ? <span className="badge-status uploaded">✅ {entry.youtubeVideoId}{entry.addedToPlaylist ? " · in playlist" : ""}</span>
    : entry.status === "error" ? <span className="badge-status error" title={entry.error}>❌ error</span>
    : <span className="badge-status pending">⏳ pending</span>;

  return (
    <div className="queue-row">
      {entry.thumbnailPath && <img className="queue-thumb" src={`vfile://local/${encodeURIComponent(entry.thumbnailPath)}`} />}
      <div className="queue-info">
        {editing ? (
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        ) : (
          <div className="queue-title">{entry.title}</div>
        )}
        {editing ? (
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        ) : (
          <div className="queue-date">publishes {fmtDate(entry.publishAt)}</div>
        )}
      </div>
      {statusBadge}
      <div className="queue-actions">
        {editing ? (
          <button onClick={save}>Save</button>
        ) : entry.status === "pending" ? (
          <>
            <button onClick={() => setEditing(true)}>Edit</button>
            <button className="danger" onClick={remove}>Remove</button>
          </>
        ) : entry.youtubeVideoId ? (
          <a href={`https://youtu.be/${entry.youtubeVideoId}`} target="_blank" rel="noreferrer">View</a>
        ) : null}
      </div>
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

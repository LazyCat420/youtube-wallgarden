"""
Wallgarden Sync Service
=======================

A tiny shared state store so the YouTube Wallgarden dashboard's curation is the
same in every browser instead of being trapped in each browser's localStorage.

The dashboard is otherwise a static site: user data lives in localStorage, which
is per-browser even on the same URL. This service is the single source of truth,
so a like/unlike/dislike made anywhere shows up everywhere.

MONOLITH: one global document (no per-profile partitioning — profiles were a
per-browser footgun, since sharing silently depended on both browsers picking the
same profile name).

Storage: a self-contained SQLite file on a Docker volume (no external database).
Everything runs inside the youtube-wallgarden container — nginx + this app — with
the DB persisted on the `wallgarden-data` volume across redeploys. The whole
global document is one JSON blob in a single row.

Merge model — signals are EVENTS, not a set:

* `ratings`: a map { videoId: { r, t, v } } where `r` is the rating (5 = like,
  -5 = dislike, 0 = cleared) and `t` is when it changed (ms). Merge is per-video
  LAST-WRITE-WINS on `t`. This makes unlike (r→0) and dislike (r→-5) first-class
  and *propagating* — the newest decision wins, so removals are no longer lost.
  `v` carries minimal video metadata so any browser can render the liked list.
* `queue`: a map { videoId: { p, t, v } } — `p` is presence (1 in / 0 removed),
  per-item LWW on `t`. Removing from the watchlist propagates.
* `playlists`: { plId: { name, createdAt, deleted, t, videos: { vId: {p,t,v} } } }.
  Playlist meta (name / delete) is LWW on the playlist `t`; each video is per-item
  LWW. Deleting a playlist and removing a video from one both propagate.
* `watched`: additive map, max-timestamp.
"""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware

DB_PATH = os.environ.get("WALLGARDEN_DB_PATH", "/data/wallgarden.db")
DOC_ID = "global"  # single monolithic document

# Serializes the read-modify-write in PUT so concurrent syncs can't lose updates.
_write_lock = threading.Lock()


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    return conn


def _load_doc():
    with _connect() as conn:
        row = conn.execute("SELECT data FROM state WHERE id = ?", (DOC_ID,)).fetchone()
    return json.loads(row[0]) if row else {}


def _save_doc(doc):
    payload = json.dumps(doc)
    with _connect() as conn:
        conn.execute(
            "INSERT INTO state (id, data) VALUES (?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (DOC_ID, payload),
        )
        conn.commit()


# Make sure the DB directory exists (the volume mounts /data, but be defensive
# for local runs) and the table is created before the first request.
os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
_connect().close()

app = FastAPI(title="Wallgarden Sync", version="3.0.0")

# The dashboard calls us same-origin through its own nginx (/sync/*), but keep
# CORS permissive so it also works if hit directly on the LAN.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Fields we sync. Anything not listed here stays browser-local by design
# (e.g. the ontology graph, which each browser rebuilds from merged ratings).
SYNC_FIELDS = ["ratings", "queue", "playlists", "watched"]


def _merge_lww_map(base, incoming):
    """Per-key last-write-wins on `t`. Newest decision wins — so a tombstone
    (rating r=0, or queue p=0) with a newer timestamp overrides an older add.
    Used for both `ratings` and `queue`."""
    out = dict(base) if isinstance(base, dict) else {}  # tolerate legacy/garbage shapes
    for key, rec in (incoming or {}).items():
        if not isinstance(rec, dict):
            continue
        cur = out.get(key)
        if not cur or (rec.get("t", 0) or 0) >= (cur.get("t", 0) or 0):
            out[key] = rec
    return out


def _merge_watched(base, incoming):
    """Union of {videoId: timestamp}, keeping the most recent watch time."""
    out = dict(base or {})
    for vid, ts in (incoming or {}).items():
        try:
            out[vid] = max(out.get(vid, 0) or 0, ts or 0)
        except TypeError:
            out[vid] = ts
    return out


def _merge_playlists(base, incoming):
    """Merge { plId: { name, createdAt, deleted, t, videos: {vId:{p,t,v}} } }.
    Playlist meta (name/deleted/createdAt) is LWW on the playlist `t`; the
    nested videos map is per-item LWW — so a video removal (p=0) or a whole
    playlist deletion (deleted=true) with a newer timestamp propagates."""
    base = base if isinstance(base, dict) else {}  # tolerate legacy/garbage shapes
    out = {pid: dict(pl) for pid, pl in base.items() if isinstance(pl, dict)}
    for pid, pl in (incoming or {}).items():
        if not isinstance(pl, dict):
            continue
        cur = out.get(pid)
        if not cur:
            out[pid] = pl
            continue
        merged = dict(cur)
        if (pl.get("t", 0) or 0) >= (cur.get("t", 0) or 0):
            merged["name"] = pl.get("name", cur.get("name"))
            merged["deleted"] = pl.get("deleted", cur.get("deleted", False))
            merged["createdAt"] = pl.get("createdAt", cur.get("createdAt"))
            merged["t"] = pl.get("t", cur.get("t"))
        merged["videos"] = _merge_lww_map(cur.get("videos"), pl.get("videos"))
        out[pid] = merged
    return out


_MERGERS = {
    "ratings": _merge_lww_map,
    "queue": _merge_lww_map,
    "playlists": _merge_playlists,
    "watched": _merge_watched,
}


def _project(doc):
    """Return only the syncable fields present in a stored document."""
    return {f: doc[f] for f in SYNC_FIELDS if f in doc}


@app.get("/health")
def health():
    try:
        _load_doc()
        return {"ok": True, "db": DB_PATH}
    except Exception as exc:  # noqa: BLE001 — report, don't crash the probe
        return {"ok": False, "error": str(exc)}


# The {profile} segment is accepted for URL/nginx compatibility but ignored:
# there is one global document. Old per-profile clients therefore all converge
# onto the same shared state.
@app.get("/sync/{profile}")
def get_state(profile: str = "global"):
    doc = _load_doc()
    return {"fields": _project(doc), "updatedAt": doc.get("updatedAt")}


# PUT is the normal path; POST is accepted too so the dashboard's unload-flush
# via navigator.sendBeacon() (which can only POST) lands as well.
@app.api_route("/sync/{profile}", methods=["PUT", "POST"])
def put_state(profile: str = "global", body: dict = Body(default={})):
    incoming = (body or {}).get("fields", {}) or {}

    with _write_lock:  # atomic read-modify-write
        existing = _load_doc()
        merged = {}
        for field in SYNC_FIELDS:
            if field in incoming:
                merged[field] = _MERGERS[field](existing.get(field), incoming[field])
            elif field in existing:
                merged[field] = existing[field]
        merged["updatedAt"] = datetime.now(timezone.utc).isoformat()
        _save_doc(merged)

    return {"fields": _project(merged), "updatedAt": merged["updatedAt"]}

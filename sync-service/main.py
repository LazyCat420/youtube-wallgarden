"""
Wallgarden Sync Service
=======================

A tiny per-profile state store so the YouTube Wallgarden dashboard's curation
(likes/ratings, liked videos, watchlist queue, playlists, watch history) is
shared across browsers instead of being trapped in each browser's localStorage.

The dashboard is otherwise a static site: all user data lives in localStorage,
which is per-browser even on the same URL. This service gives every *profile* a
single server-side home keyed by profile name, so liking a video in Chrome shows
up in Vivaldi (and vice-versa) as long as both use the same profile.

Storage: MongoDB, database `wallgarden` (isolated from all other ecosystem data),
collection `profiles`, one document per profile (`_id` = profile name).

Merge model: SMART MERGE (additive union). A PUT merges the incoming fields into
what's already stored rather than overwriting — so concurrent activity in two
browsers is combined and a like made in one never clobbers a like made in the
other. NOTE: because merges are additive, explicit *removals* (un-like, delete
from queue) do not propagate across browsers in this version — adds always win.
"""

import os
from datetime import datetime, timezone

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient

MONGO_URI = os.environ.get("MONGO_URI")
DB_NAME = os.environ.get("WALLGARDEN_MONGO_DB", "wallgarden")

if not MONGO_URI:
    raise RuntimeError("MONGO_URI is required (set it in the deploy env)")

_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
_db = _client[DB_NAME]
_profiles = _db["profiles"]

app = FastAPI(title="Wallgarden Sync", version="1.0.0")

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
SYNC_FIELDS = ["video_ratings", "liked_videos", "queue", "playlists", "watched"]


def _merge_object(base, incoming):
    """Shallow key union; incoming value wins on a key conflict."""
    out = dict(base or {})
    out.update(incoming or {})
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


def _merge_list_by_id(base, incoming):
    """Union of a list of video objects by their `id`; incoming refreshes existing."""
    by_id = {}
    order = []
    for item in list(base or []) + list(incoming or []):
        if isinstance(item, dict) and item.get("id"):
            vid = item["id"]
            if vid not in by_id:
                order.append(vid)
            by_id[vid] = item
    return [by_id[v] for v in order]


def _merge_playlists(base, incoming):
    """Merge {playlistId: {name, videos[]}} by id; union each playlist's videos."""
    out = {pid: dict(pl) for pid, pl in (base or {}).items()}
    for pid, pl in (incoming or {}).items():
        if pid in out:
            merged_videos = _merge_list_by_id(out[pid].get("videos"), (pl or {}).get("videos"))
            out[pid] = {**out[pid], **(pl or {}), "videos": merged_videos}
        else:
            out[pid] = pl
    return out


_MERGERS = {
    "video_ratings": _merge_object,
    "liked_videos": _merge_list_by_id,
    "queue": _merge_list_by_id,
    "playlists": _merge_playlists,
    "watched": _merge_watched,
}


def _project(doc):
    """Return only the syncable fields present in a stored document."""
    return {f: doc[f] for f in SYNC_FIELDS if f in doc}


@app.get("/health")
def health():
    try:
        _client.admin.command("ping")
        return {"ok": True, "db": DB_NAME}
    except Exception as exc:  # noqa: BLE001 — report, don't crash the probe
        return {"ok": False, "error": str(exc)}


@app.get("/sync/{profile}")
def get_profile(profile: str):
    doc = _profiles.find_one({"_id": profile}) or {}
    return {
        "profile": profile,
        "fields": _project(doc),
        "updatedAt": doc.get("updatedAt"),
    }


# PUT is the normal path; POST is accepted too so the dashboard's unload-flush
# via navigator.sendBeacon() (which can only POST) lands as well.
@app.api_route("/sync/{profile}", methods=["PUT", "POST"])
def put_profile(profile: str, body: dict = Body(default={})):
    incoming = (body or {}).get("fields", {}) or {}
    existing = _profiles.find_one({"_id": profile}) or {}

    merged = {}
    for field in SYNC_FIELDS:
        if field in incoming:
            merged[field] = _MERGERS[field](existing.get(field), incoming[field])
        elif field in existing:
            merged[field] = existing[field]

    merged["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _profiles.update_one({"_id": profile}, {"$set": merged}, upsert=True)

    return {
        "profile": profile,
        "fields": _project(merged),
        "updatedAt": merged["updatedAt"],
    }

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
same profile name). Storage: MongoDB, database `wallgarden`, collection `state`,
document `_id = "global"`.

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
import threading
import urllib.request
from datetime import datetime, timezone

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient

from brain_graph import (
    classify_music_video,
    extract_discriminating_facets,
    extract_music_likes_feed,
    ground_topics_algorithmically,
    rank_brain_topics,
)

MONGO_URI = os.environ.get("MONGO_URI")
DB_NAME = os.environ.get("WALLGARDEN_MONGO_DB", "wallgarden")
DOC_ID = "global"  # single monolithic document

# The music player's sync webhook: called after ratings change so the player
# pulls the new likes without waiting for its own poll interval.
MUSIC_PLAYER_SYNC_URL = os.environ.get(
    "MUSIC_PLAYER_SYNC_URL", "http://10.0.0.16:8002/api/youtube/wallgarden/sync"
)

if not MONGO_URI:
    raise RuntimeError("MONGO_URI is required (set it in the deploy env)")

_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
_db = _client[DB_NAME]
_state = _db["state"]

app = FastAPI(title="Wallgarden Sync", version="2.0.0")

# The dashboard calls us same-origin through its own nginx (/sync/*), but keep
# CORS permissive so it also works if hit directly on the LAN.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _notify_music_player_async(updated_at: int) -> None:
    """Tell the music player that ratings changed, off the request thread.

    Fire-and-forget: the player is a separate service and may be down or
    restarting, and a failed ping must never fail the sync write itself (the
    player also polls on its own).
    """
    def _post():
        try:
            req = urllib.request.Request(
                MUSIC_PLAYER_SYNC_URL,
                data=json.dumps({"updatedAt": updated_at}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=3).read()
        except Exception:
            pass

    threading.Thread(target=_post, daemon=True).start()


# Fields we sync. Anything not listed here stays browser-local by design
# (e.g. the ontology graph, which each browser rebuilds from merged ratings).
#
# * `mined`: { videoId: { t, topics: [..] } } — liked videos already mined into
#   topics by the LLM. Per-video LWW so a second browser reuses the extraction
#   instead of re-paying the LLM call.
# * `profile`: { text, clusters, generatedAt, likeCount } — the LLM-written
#   taste profile. Whole-value LWW on `generatedAt`.
# * `topicSignals`: { topic: { t, c: {clientId: {imp,open,play}}, f: {...} } } —
#   how much interest each topic has accumulated. NOT last-write-wins; see
#   _merge_topic_signals.
# * `avoided`: { videoId: { t, channelName, title, reason } } — unclicked
#   YouTube FYP recommendations or rejected videos to avoid in feeds.
# * `rejectedFacets`: { facet: { facet, fromTopic, protectedAnchors, aliases, t, permanent } } —
#   discriminating negative modifiers extracted when burning compound topics.
SYNC_FIELDS = [
    "ratings",
    "queue",
    "playlists",
    "watched",
    "mined",
    "profile",
    "topicSignals",
    "avoided",
    "rejectedFacets",
]


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


def _merge_profile(base, incoming):
    """Whole-value LWW on `generatedAt` — the newest taste profile wins."""
    if not isinstance(incoming, dict) or not incoming:
        return base
    if not isinstance(base, dict) or not base:
        return incoming
    base_t = base.get("generatedAt", 0) or 0
    inc_t = incoming.get("generatedAt", 0) or 0
    return incoming if inc_t >= base_t else base


def _merge_topic_signals(base, incoming):
    """Per-CLIENT high-water merge of the topic interest counters.

    Every other field here is last-write-wins, and LWW is WRONG for this one.
    Two browsers each hold their own progress toward a threshold; whole-record
    LWW would discard one of them on every push, so a topic could be viewed
    five times in Chrome and five in Vivaldi and never reach a threshold of ten.

    Summing is equally wrong in the other direction: the client re-pushes its
    entire map on a 1.5s debounce, so `sum` would inflate the counts on every
    push. Each browser writes only its own sub-counter, which is monotonic, so
    taking the max per (topic, clientId, kind) is both lossless and idempotent.
    The effective total is the sum ACROSS clients, computed by the reader.

    `f` (fired-at high-water marks) merges by max for the same reason: a
    threshold already spent on one browser must not be spent again on another.
    """
    out = dict(base) if isinstance(base, dict) else {}
    for topic, rec in (incoming or {}).items():
        if not isinstance(rec, dict):
            continue
        cur = out.get(topic)
        if not isinstance(cur, dict):
            cur = {"t": 0, "c": {}, "f": {}}
        merged_c = dict(cur.get("c") or {})
        for cid, per in (rec.get("c") or {}).items():
            if not isinstance(per, dict):
                continue
            mine = dict(merged_c.get(cid) or {})
            for kind, n in per.items():
                if isinstance(n, (int, float)):
                    mine[kind] = max(mine.get(kind, 0) or 0, n)
            merged_c[cid] = mine
        merged_f = dict(cur.get("f") or {})
        for kind, n in (rec.get("f") or {}).items():
            if isinstance(n, (int, float)):
                merged_f[kind] = max(merged_f.get(kind, 0) or 0, n)
        out[topic] = {
            "t": max(cur.get("t", 0) or 0, rec.get("t", 0) or 0),
            "c": merged_c,
            "f": merged_f,
        }
    return out


_MERGERS = {
    "ratings": _merge_lww_map,
    "queue": _merge_lww_map,
    "playlists": _merge_playlists,
    "watched": _merge_watched,
    "mined": _merge_lww_map,
    "topicSignals": _merge_topic_signals,
    "profile": _merge_profile,
    "avoided": _merge_lww_map,
    "rejectedFacets": _merge_lww_map,
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


@app.get("/sync/brain/recommendations")
def get_brain_recommendations(n: int = 30):
    doc = _state.find_one({"_id": DOC_ID}) or {}
    return rank_brain_topics(doc, n=n)


@app.post("/sync/brain/ground")
def post_brain_ground(body: dict = Body(default={})):
    doc = _state.find_one({"_id": DOC_ID}) or {}
    items = (body or {}).get("items") or []
    rejected_facets = (body or {}).get("rejectedFacets") or doc.get("rejectedFacets") or {}
    verdicts = ground_topics_algorithmically(items, rejected_facets=rejected_facets)
    return {"verdicts": verdicts, "count": len(verdicts), "failed": False}


@app.post("/sync/brain/reject-facet")
def post_brain_reject_facet(body: dict = Body(default={})):
    phrase = (body or {}).get("phrase") or ""
    positive_phrases = (body or {}).get("positivePhrases") or []
    doc = _state.find_one({"_id": DOC_ID}) or {}
    res = extract_discriminating_facets(phrase, doc=doc, extra_positive_phrases=positive_phrases)
    if res.get("rejectedFacets"):
        merged_facets = _merge_lww_map(doc.get("rejectedFacets") or {}, res["rejectedFacets"])
        _state.update_one(
            {"_id": DOC_ID},
            {
                "$set": {
                    "rejectedFacets": merged_facets,
                    "updatedAt": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )
        res["mergedRejectedFacets"] = merged_facets
    return res


# The {profile} segment is accepted for URL/nginx compatibility but ignored:
# there is one global document. Old per-profile clients therefore all converge
# onto the same shared state.
@app.get("/sync/{profile}")
def get_state(profile: str = "global"):
    doc = _state.find_one({"_id": DOC_ID}) or {}
    return {"fields": _project(doc), "updatedAt": doc.get("updatedAt")}


# Music-player feed: only the ratings that classify as music, with the artist /
# title split the player needs. Declared before the generic /sync/{profile}
# route so "/sync/music/likes" is not swallowed as profile="music".
@app.get("/sync/music/likes")
@app.get("/sync/{profile}/music/likes")
def get_music_likes(profile: str = "global", since: int = 0, include_unliked: bool = True):
    doc = _state.find_one({"_id": DOC_ID}) or {}
    return extract_music_likes_feed(doc, since=since, include_unliked=include_unliked)


# PUT is the normal path; POST is accepted too so the dashboard's unload-flush
# via navigator.sendBeacon() (which can only POST) lands as well.
@app.api_route("/sync/{profile}", methods=["PUT", "POST"])
def put_state(profile: str = "global", body: dict = Body(default={})):
    incoming = (body or {}).get("fields", {}) or {}
    existing = _state.find_one({"_id": DOC_ID}) or {}

    merged = {}
    for field in SYNC_FIELDS:
        if field in incoming:
            merged[field] = _MERGERS[field](existing.get(field), incoming[field])
        elif field in existing:
            merged[field] = existing[field]

    merged["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _state.update_one({"_id": DOC_ID}, {"$set": merged}, upsert=True)

    # A like landed: nudge the music player so it re-reads the feed now.
    if "ratings" in incoming and incoming["ratings"]:
        _notify_music_player_async(int(datetime.now(timezone.utc).timestamp() * 1000))

    return {"fields": _project(merged), "updatedAt": merged["updatedAt"]}

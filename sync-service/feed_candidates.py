"""
feed_candidates.py — server-side ledger for the discovery feed's supply.
========================================================================

The finance-feed work (Options A/B, the brainstorm focus gate) could only be
judged in the browser console: the `liked-channel-finance` form, the
`FINANCE_EXPLORE_ALTERNATION` drip arm, the `financeScamReason()` pump gate and
the `domainFocus` decision were all console/localStorage-only.

The dashboard's discovery pipeline now posts one row per candidate it evaluated
to `POST /sync/feed/candidates`. This module persists those rows in the
`feed_candidates` collection of the SAME MongoDB database the Wallgarden
collector/sync already writes to (`WALLGARDEN_MONGO_DB`, default `wallgarden`)
— no new database and no new env var — and exposes the read-only aggregate:

    python3 feed_candidates.py --days 14

The aggregate is pure over a list of rows (`aggregate_feed`), so it is unit
tested without Mongo or a network. `--days` bounds the window on each row's
`t` (client epoch ms).

Rows are untrusted browser input: every field is type-checked and length-capped
before it is stored, and the upsert key (video_id, topic, form) keeps a
re-evaluated candidate from duplicating itself.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime, timezone

DB_NAME = os.environ.get("WALLGARDEN_MONGO_DB", "wallgarden")
COLLECTION = "feed_candidates"
MAX_ROWS_PER_REQUEST = 500
MAX_TICKERS = 8

_client = None


def _get_collection():
    """Lazy Mongo handle: importing this module must not need a network."""
    global _client
    if _client is None:
        from pymongo import MongoClient

        uri = os.environ.get("MONGO_URI")
        if not uri:
            raise RuntimeError("MONGO_URI is required to persist feed candidates")
        _client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    return _client[DB_NAME][COLLECTION]


def _as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, out))


def _clean_str(value, limit: int = 200) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def _clean_tickers(value) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        ticker = _clean_str(item, 8).upper()
        if ticker and ticker.isalnum() and ticker not in out:
            out.append(ticker)
        if len(out) >= MAX_TICKERS:
            break
    return out


def normalize_row(row, received_at: datetime | None = None) -> dict | None:
    """Validate one browser row; None when it has no usable identity."""
    if not isinstance(row, dict):
        return None
    video_id = _clean_str(row.get("video_id"), 32)
    if not video_id:
        return None
    topic = _clean_str(row.get("topic"), 120)
    form = _clean_str(row.get("form"), 40)
    rejected = _clean_str(row.get("rejected"), 60) or None
    scam_pattern = _clean_str(row.get("scam_pattern"), 60) or None
    return {
        "video_id": video_id,
        "topic": topic,
        "form": form,
        "channel_id": _clean_str(row.get("channel_id"), 64),
        "channel_name": _clean_str(row.get("channel_name"), 120),
        "title": _clean_str(row.get("title"), 240),
        "finance": bool(row.get("finance")),
        "finance_trust": _as_float(row.get("finance_trust")),
        "accepted": bool(row.get("accepted")),
        "rejected": rejected,
        "scam_pattern": scam_pattern,
        "tickers": _clean_tickers(row.get("tickers")),
        "drip_mode": _clean_str(row.get("drip_mode"), 20),
        "t": _as_int(row.get("t")),
        "received_at": received_at or datetime.now(timezone.utc),
    }


def record_candidates(rows, now: datetime | None = None) -> dict:
    """Upsert candidate rows into the Wallgarden feed ledger.

    Returns {"received", "stored", "dropped"} — instrumentation must never
    break the feed, so malformed rows are dropped rather than raising.
    """
    from pymongo import UpdateOne

    if not isinstance(rows, list):
        rows = []
    received_at = now or datetime.now(timezone.utc)
    ops: list[UpdateOne] = []
    dropped = 0
    for row in rows[:MAX_ROWS_PER_REQUEST]:
        doc = normalize_row(row, received_at=received_at)
        if doc is None:
            dropped += 1
            continue
        key = {"video_id": doc["video_id"], "topic": doc["topic"], "form": doc["form"]}
        ops.append(UpdateOne(key, {"$set": doc}, upsert=True))
    if ops:
        _get_collection().bulk_write(ops, ordered=False)
    return {"received": len(rows), "stored": len(ops), "dropped": dropped}


def load_candidates(days: int, now_ms: int | None = None) -> list[dict]:
    """Read the rows inside the `days` window (read-only)."""
    now_ms = _as_int(now_ms if now_ms is not None else time.time() * 1000)
    since = now_ms - max(0, _as_int(days)) * 86_400_000
    cursor = _get_collection().find({"t": {"$gte": since}})
    return list(cursor)


def aggregate_feed(rows, days: int, now_ms: int | None = None) -> dict:
    """The yield of the finance-feed arms over a `days` window.

    Pure: reads only its arguments. `finance_share` is the share of the feed
    supply (evaluated candidate rows) the lexicon flagged as finance; accepted
    finance videos and their tickers come from rows that survived every gate.
    """
    now_ms = _as_int(now_ms if now_ms is not None else time.time() * 1000)
    days = max(0, _as_int(days))
    since = now_ms - days * 86_400_000
    window = [r for r in (rows or []) if isinstance(r, dict) and _as_int(r.get("t")) >= since]

    finance_rows = [r for r in window if r.get("finance")]
    accepted_finance = [r for r in finance_rows if r.get("accepted")]
    channels = {
        (_clean_str(r.get("channel_id")) or _clean_str(r.get("channel_name")).lower())
        for r in finance_rows
    } - {""}
    tickers = sorted({t for r in accepted_finance for t in _clean_tickers(r.get("tickers"))})
    videos = {_clean_str(r.get("video_id")) for r in accepted_finance} - {""}

    total = len(window)
    return {
        "window_days": days,
        "since": datetime.fromtimestamp(since / 1000, timezone.utc).isoformat(),
        "candidates": total,
        "finance_candidates": len(finance_rows),
        "finance_share": round(len(finance_rows) / total, 4) if total else 0.0,
        "distinct_finance_channels": len(channels),
        "accepted_finance_videos": len(videos),
        "distinct_tickers": len(tickers),
        "tickers": tickers,
        "scam_rejections": dict(
            sorted(Counter(r["scam_pattern"] for r in window if r.get("scam_pattern")).items())
        ),
        "rejections": dict(
            sorted(Counter(_clean_str(r.get("rejected")) for r in window if r.get("rejected")).items())
        ),
        "forms": dict(sorted(Counter(_clean_str(r.get("form")) for r in window).items())),
        "drip_modes": dict(
            sorted(Counter(_clean_str(r.get("drip_mode")) for r in window).items())
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Finance-feed yield from the Wallgarden discovery-candidate ledger (read-only)."
    )
    parser.add_argument("--days", type=int, default=14, help="window in days (default 14)")
    args = parser.parse_args(argv)
    if args.days < 0:
        parser.error("--days must be >= 0")
    try:
        rows = load_candidates(args.days)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(aggregate_feed(rows, args.days), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

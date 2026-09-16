"""
Unit tests for the sync-service merge logic — the most critical, subtle code in
the system (a wrong merge silently corrupts likes across every browser).

Runs with plain asserts so no pytest install is needed:
    python test_merge.py
...but the functions are also pytest-discoverable:
    pytest test_merge.py
"""

import os

# main.py requires MONGO_URI at import and constructs a MongoClient (lazy — it
# does not connect here), so hand it a dummy so we can import the pure mergers.
os.environ.setdefault("MONGO_URI", "mongodb://localhost:27017/?serverSelectionTimeoutMS=1")

from main import (  # noqa: E402
    _merge_lww_map,
    _merge_playlists,
    _merge_topic_signals,
    _merge_watched,
)


# ── ratings / queue: per-key last-write-wins ────────────────────────────────

def test_lww_newer_wins():
    base = {"A": {"r": 5, "t": 100}}
    inc = {"A": {"r": -5, "t": 200}}
    assert _merge_lww_map(base, inc)["A"] == {"r": -5, "t": 200}


def test_lww_stale_ignored():
    base = {"A": {"r": 5, "t": 100}}
    inc = {"A": {"r": 5, "t": 50}}  # older → must not overwrite
    assert _merge_lww_map(base, inc)["A"]["t"] == 100


def test_lww_tombstone_propagates():
    # unlike (r=0) / queue-removal (p=0) with a newer t must win
    base = {"A": {"r": 5, "t": 100}}
    inc = {"A": {"r": 0, "t": 200}}
    assert _merge_lww_map(base, inc)["A"]["r"] == 0

    baseq = {"V": {"p": 1, "t": 100}}
    incq = {"V": {"p": 0, "t": 200}}
    assert _merge_lww_map(baseq, incq)["V"]["p"] == 0


def test_lww_disjoint_keys_union():
    base = {"A": {"r": 5, "t": 1}}
    inc = {"B": {"r": 5, "t": 1}}
    out = _merge_lww_map(base, inc)
    assert set(out) == {"A", "B"}


def test_lww_equal_t_takes_incoming():
    base = {"A": {"r": 5, "t": 100}}
    inc = {"A": {"r": -5, "t": 100}}  # tie → incoming (>=)
    assert _merge_lww_map(base, inc)["A"]["r"] == -5


def test_lww_avoided_merges_by_timestamp():
    base = {"vid1": {"t": 100, "channelName": "ch1", "reason": "fyp_unclicked"}}
    inc = {"vid1": {"t": 200, "channelName": "ch1", "reason": "not_interested"}}
    merged = _merge_lww_map(base, inc)
    assert merged["vid1"]["t"] == 200
    assert merged["vid1"]["reason"] == "not_interested"


def test_lww_ignores_non_dict():
    base = {"A": {"r": 5, "t": 1}}
    assert _merge_lww_map(base, {"A": "garbage"})["A"] == {"r": 5, "t": 1}


def test_lww_handles_none():
    assert _merge_lww_map(None, None) == {}
    assert _merge_lww_map(None, {"A": {"r": 5, "t": 1}}) == {"A": {"r": 5, "t": 1}}


def test_lww_tolerates_legacy_list_shape():
    # v2 stored queue as a list; the new map merge must not crash on it
    assert _merge_lww_map([{"id": "x"}], {"V": {"p": 1, "t": 1}}) == {"V": {"p": 1, "t": 1}}


def test_playlists_tolerate_legacy_shape():
    # v2 stored playlists as {id: {videos: [...]}}; must not crash
    legacy = {"p1": {"name": "Old", "videos": [{"id": "a"}]}}
    inc = {"p2": {"name": "New", "t": 1, "videos": {}}}
    out = _merge_playlists(legacy, inc)
    assert "p2" in out


# ── watched: max timestamp union ────────────────────────────────────────────

def test_watched_keeps_max():
    assert _merge_watched({"A": 500}, {"A": 200})["A"] == 500
    assert _merge_watched({"A": 200}, {"A": 500})["A"] == 500
    assert _merge_watched({"A": 1}, {"B": 2}) == {"A": 1, "B": 2}


# ── playlists: nested LWW (meta + per-video) ────────────────────────────────

def test_playlist_video_removal_propagates():
    base = {"p1": {"name": "Fav", "t": 10, "videos": {"V": {"p": 1, "t": 10}}}}
    inc = {"p1": {"name": "Fav", "t": 10, "videos": {"V": {"p": 0, "t": 20}}}}
    assert _merge_playlists(base, inc)["p1"]["videos"]["V"]["p"] == 0


def test_playlist_deletion_propagates():
    base = {"p1": {"name": "Fav", "deleted": False, "t": 10, "videos": {}}}
    inc = {"p1": {"name": "Fav", "deleted": True, "t": 20, "videos": {}}}
    assert _merge_playlists(base, inc)["p1"]["deleted"] is True


def test_playlist_stale_delete_ignored():
    base = {"p1": {"name": "Fav", "deleted": False, "t": 30, "videos": {}}}
    inc = {"p1": {"name": "Fav", "deleted": True, "t": 20, "videos": {}}}  # older
    assert _merge_playlists(base, inc)["p1"]["deleted"] is False


def test_playlist_video_add_and_rename():
    base = {"p1": {"name": "Old", "t": 10, "videos": {"A": {"p": 1, "t": 10}}}}
    inc = {"p1": {"name": "New", "t": 20, "videos": {"B": {"p": 1, "t": 20}}}}
    out = _merge_playlists(base, inc)["p1"]
    assert out["name"] == "New"
    assert set(out["videos"]) == {"A", "B"}


def test_playlist_new_playlist_added():
    base = {"p1": {"name": "A", "t": 1, "videos": {}}}
    inc = {"p2": {"name": "B", "t": 1, "videos": {}}}
    assert set(_merge_playlists(base, inc)) == {"p1", "p2"}


# ── topicSignals: per-client high-water, NOT last-write-wins ────────────────
#
# These are the counters that decide when a topic has earned expansion. The
# whole point of the custom merger is that the two obvious implementations are
# both wrong: LWW loses a browser's progress, and sum inflates it on every
# 1.5s re-push of the same map.

def _total(merged, topic, kind="imp"):
    return sum(per.get(kind, 0) for per in merged[topic]["c"].values())


def test_signals_sum_across_browsers():
    """Chrome saw it 5x and Vivaldi 5x — the threshold of 10 must be reached."""
    chrome = {"kiln": {"t": 1, "c": {"cA": {"imp": 5}}, "f": {}}}
    vivaldi = {"kiln": {"t": 2, "c": {"cB": {"imp": 5}}, "f": {}}}
    merged = _merge_topic_signals(_merge_topic_signals({}, chrome), vivaldi)
    assert _total(merged, "kiln") == 10  # LWW would give 5


def test_signals_idempotent_under_republish():
    """The client re-pushes its whole map every 1.5s; sum() would inflate."""
    vivaldi = {"kiln": {"t": 2, "c": {"cB": {"imp": 5}}, "f": {}}}
    merged = _merge_topic_signals({}, vivaldi)
    for _ in range(5):
        merged = _merge_topic_signals(merged, vivaldi)
    assert _total(merged, "kiln") == 5  # sum would give 30


def test_signals_growth_lands():
    merged = _merge_topic_signals({}, {"k": {"t": 1, "c": {"cB": {"imp": 5}}, "f": {}}})
    merged = _merge_topic_signals(merged, {"k": {"t": 2, "c": {"cB": {"imp": 9}}, "f": {}}})
    assert _total(merged, "k") == 9


def test_signals_stale_lower_payload_cannot_reduce():
    """An out-of-order push from a browser that was behind must not roll back."""
    merged = _merge_topic_signals({}, {"k": {"t": 2, "c": {"cB": {"imp": 9}}, "f": {}}})
    merged = _merge_topic_signals(merged, {"k": {"t": 3, "c": {"cB": {"imp": 2}}, "f": {}}})
    assert _total(merged, "k") == 9


def test_signals_fired_marks_take_max():
    """A threshold already spent on one browser must not be spent again."""
    merged = _merge_topic_signals({}, {"k": {"t": 1, "c": {}, "f": {"imp": 10}}})
    merged = _merge_topic_signals(merged, {"k": {"t": 2, "c": {}, "f": {"imp": 3}}})
    assert merged["k"]["f"]["imp"] == 10


def test_signals_tolerate_garbage():
    assert _merge_topic_signals({}, {"x": "not a dict"}) == {}
    assert _merge_topic_signals({}, {"x": {"c": {"cA": "nope"}}})["x"]["c"] == {}


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✅ {fn.__name__}")
    print(f"\nAll {len(fns)} merge tests passed.")


if __name__ == "__main__":
    _run_all()

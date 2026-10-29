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
from brain_graph import (  # noqa: E402
    classify_music_video,
    extract_discriminating_facets,
    extract_music_likes_feed,
    ground_topics_algorithmically,
    is_rejected_by_facets,
    rank_brain_topics,
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


# ── brain_graph: discriminating facets, PPR + Thompson, algorithmic grounding ──

def test_vegan_bbq_extracts_vegan_and_protects_bbq():
    doc = {
        "ratings": {
            "v1": {
                "r": 5,
                "t": 1700000000000,
                "v": {"title": "Texas Brisket BBQ Smoking Guide", "discoveryTopic": "texas brisket bbq"},
            }
        }
    }
    res = extract_discriminating_facets("vegan bbq", doc=doc, now_ms=1700000000000)
    assert res["protectedAnchors"] == ["bbq"]
    assert "vegan" in res["rejectedFacets"]
    assert "bbq" not in res["rejectedFacets"]
    facets = res["rejectedFacets"]
    assert is_rejected_by_facets("vegan bbq", facets) == "vegan"
    assert is_rejected_by_facets("vegan ribs", facets) == "vegan"
    assert is_rejected_by_facets("plant-based brisket", facets) == "vegan"
    assert is_rejected_by_facets("seitan smoker", facets) == "vegan"
    assert is_rejected_by_facets("texas brisket bbq", facets) is None
    assert is_rejected_by_facets("offset smoker bbq", facets) is None


def test_rank_brain_topics_decays_stale_likes_and_excludes_ignored():
    now_ms = 1700000000000
    ninety_days_ago = now_ms - 90 * 86400 * 1000
    doc = {
        "ratings": {
            "v_stale": {
                "r": 5,
                "t": ninety_days_ago,
                "v": {"discoveryTopic": "oklo stock", "matchedTopics": ["oklo stock"]},
            },
            "v_fresh": {
                "r": 5,
                "t": now_ms - 86400 * 1000,
                "v": {"discoveryTopic": "ceramic glaze chemistry", "matchedTopics": ["ceramic glaze chemistry", "kiln firing"]},
            },
        },
        "mined": {
            "v_fresh": {"t": now_ms, "topics": ["ceramic glaze chemistry", "kiln glaze"]},
        },
        "topicSignals": {
            "oklo stock": {"t": now_ms, "c": {"cA": {"imp": 20, "play": 0, "open": 0}}, "f": {}},
            "ceramic glaze chemistry": {"t": now_ms, "c": {"cA": {"imp": 4, "play": 3, "open": 1}}, "f": {}},
            "ash glaze": {"t": now_ms, "c": {"cA": {"imp": 0, "play": 0, "open": 0}}, "f": {}},
        },
    }
    res = rank_brain_topics(doc, n=10, now_ms=now_ms, deterministic=True)
    rec_topics = [r["topic"] for r in res["recommendations"]]
    assert "oklo stock" not in rec_topics, "stale 90d single-like topic with 20 unplayed impressions must be excluded"
    assert rec_topics[0] == "ceramic glaze chemistry"
    frontier_topics = [r["topic"] for r in res["exploreFrontier"]]
    assert "ash glaze" in frontier_topics, "co-mined unshown topic should appear in exploreFrontier via PPR"


def test_ground_topics_algorithmically_classifies_real_dead_slop():
    verdicts = ground_topics_algorithmically([
        {
            "topic": "ceramic glaze chemistry",
            "results": [
                {"title": "Understanding Ceramic Glaze Chemistry", "channel": "Pottery Lab", "views": 15000, "year": 2025},
                {"title": "Ceramic Glaze Chemistry: Silica and Alumina", "channel": "Kiln Craft", "views": 8200, "year": 2024},
                {"title": "Glaze Chemistry Basics for Potters", "channel": "Earth Studio", "views": 24000, "year": 2025},
            ],
        },
        {
            "topic": "empty niche xyz",
            "results": [],
        },
        {
            "topic": "shocking clickbait",
            "results": [
                {"title": "YOU WON'T BELIEVE WHAT HAPPENED!!! GONE WRONG", "channel": "SlopCh", "views": 90000, "year": 2025},
                {"title": "TOP 10 INSANE SHOCKING MOMENTS EXPOSED!!!", "channel": "SlopCh2", "views": 50000, "year": 2025},
            ],
        },
    ])
    by_topic = {v["topic"]: v["verdict"] for v in verdicts}
    assert by_topic["ceramic glaze chemistry"] == "REAL"
    assert by_topic["empty niche xyz"] == "DEAD"
    assert by_topic["shocking clickbait"] == "SLOP"


def test_classify_topic_channel_is_music():
    item = classify_music_video("vid1", {
        "r": 5,
        "t": 1000,
        "v": {"title": "Weightless", "channelName": "Marconi Union - Topic", "duration": 300},
    })
    assert item["isMusic"] is True
    assert item["reason"] == "topic_or_ytm"
    assert item["isTopicChannel"] is True
    assert item["artist"] == "Marconi Union"
    assert item["artistKey"] == "marconi union"
    assert item["isDjMix"] is False


def test_classify_artist_dash_title_official_video():
    item = classify_music_video("vid2", {
        "r": 5,
        "t": 1000,
        "v": {"title": "Bonobo - Kerala (Official Video)", "channelName": "Bonobo", "duration": 230},
    })
    assert item["isMusic"] is True
    assert item["reason"] == "title_hint"
    assert item["artist"] == "Bonobo"
    assert item["title"] == "Kerala", item["title"]
    assert item["isDjMix"] is False


def test_classify_artist_dash_title_without_hint():
    item = classify_music_video("vid3", {
        "r": 5,
        "t": 1000,
        "v": {"title": "Khruangbin - August 10", "channelName": "Khruangbin", "duration": 250},
    })
    assert item["isMusic"] is True
    assert item["reason"] == "artist_dash_title"
    assert item["artist"] == "Khruangbin"
    assert item["title"] == "August 10"


def test_classify_rejects_tutorial():
    item = classify_music_video("vid4", {
        "r": 5,
        "t": 1000,
        "v": {"title": "How to make a ceramic mug", "channelName": "Pottery Lab", "duration": 900},
    })
    assert item["isMusic"] is False
    assert item["reason"] == "non_music_marker"


def test_classify_rejects_coding_vlog():
    item = classify_music_video("vid5", {
        "r": 5,
        "t": 1000,
        "v": {"title": "Building a Rust parser from scratch", "channelName": "Devlog", "duration": 1200},
    })
    assert item["isMusic"] is False
    assert item["reason"] == "non_music_marker"


def test_classify_detects_dj_mix_by_duration_and_title():
    long_item = classify_music_video("vid6", {
        "r": 5,
        "t": 1000,
        "v": {"title": "Bonobo - Late Night Tales", "channelName": "Bonobo", "duration": 3600},
    })
    assert long_item["isDjMix"] is True, "over 14 minutes is a mix"

    titled = classify_music_video("vid7", {
        "r": 5,
        "t": 1000,
        "v": {"title": "Kerri Chandler - Boiler Room Set", "channelName": "Kerri Chandler", "duration": 700},
    })
    assert titled["isDjMix"] is True, "Boiler Room in the title is a DJ mix"
    assert titled["isMusic"] is True


def test_classify_ytm_surface_and_credits():
    item = classify_music_video("vid8", {
        "r": 5,
        "t": 1000,
        "v": {
            "title": "Anything At All",
            "channelName": "Some Uploader",
            "duration": 200,
            "surface": "ytm",
            "musicCredits": {"song": "Redbone", "artist": "Childish Gambino", "album": "Awaken"},
        },
    })
    assert item["isMusic"] is True
    assert item["reason"] == "topic_or_ytm"
    assert item["artist"] == "Childish Gambino"
    assert item["title"] == "Redbone"


def test_extract_music_likes_feed_since_cursor_and_tombstones():
    doc = {
        "ratings": {
            "old": {"r": 5, "t": 100, "v": {"title": "Weightless", "channelName": "Marconi Union - Topic", "duration": 300}},
            "unliked": {"r": 0, "t": 200, "v": {"title": "Random clip", "channelName": "Someone", "duration": 60}},
            "tutorial": {"r": 5, "t": 300, "v": {"title": "How to glaze a bowl", "channelName": "Pottery Lab", "duration": 800}},
        },
    }
    feed = extract_music_likes_feed(doc, since=150)
    assert feed["count"] == 1, feed
    assert feed["items"][0]["videoId"] == "unliked"
    assert feed["items"][0]["rating"] == 0
    assert feed["cursor"] == 300

    # The tombstone can be suppressed when only live likes are wanted.
    no_tombstones = extract_music_likes_feed(doc, since=150, include_unliked=False)
    assert no_tombstones["count"] == 0

    # since=0 returns the music like, ordered by ratedAt.
    full = extract_music_likes_feed(doc)
    assert [it["videoId"] for it in full["items"]] == ["old", "unliked"]
    assert full["cursor"] == 300


def test_extract_music_likes_feed_tombstone_of_music_video():
    doc = {
        "ratings": {
            "song": {"r": 0, "t": 500, "v": {"title": "Kerala", "channelName": "Bonobo - Topic", "duration": 230}},
        },
    }
    feed = extract_music_likes_feed(doc)
    assert feed["count"] == 1
    assert feed["items"][0]["isMusic"] is True
    assert feed["items"][0]["rating"] == 0


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✅ {fn.__name__}")
    print(f"\nAll {len(fns)} merge tests passed.")


if __name__ == "__main__":
    _run_all()

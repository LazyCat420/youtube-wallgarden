"""
Unit tests for the feed-candidate ledger and its --days aggregate.

Pure functions only: no Mongo, no network. Runs with plain asserts so no
pytest install is needed:
    python3 test_feed_candidates.py
...and is pytest-discoverable too.
"""

from feed_candidates import aggregate_feed, normalize_row

DAY = 86_400_000
NOW = 1_800_000_000_000


def row(video_id, **over):
    base = {
        "video_id": video_id,
        "topic": "equities",
        "form": "broad",
        "channel_id": "",
        "channel_name": "",
        "title": "",
        "finance": False,
        "finance_trust": 0.0,
        "accepted": True,
        "rejected": None,
        "scam_pattern": None,
        "tickers": [],
        "drip_mode": "",
        "t": NOW - DAY,
    }
    base.update(over)
    return base


# ── normalize_row: untrusted browser input ─────────────────────────────────

def test_normalize_drops_a_row_without_video_id():
    assert normalize_row({"title": "no id"}) is None
    assert normalize_row({"video_id": "   "}) is None
    assert normalize_row("not a dict") is None


def test_normalize_clamps_and_types_fields():
    doc = normalize_row({
        "video_id": "v1",
        "title": "x" * 500,
        "finance": "yes",
        "finance_trust": 4.2,
        "accepted": 0,
        "tickers": ["aapl", "AAPL", "msft", 7, "!!"],
        "t": "123",
        "junk": "ignored",
    })
    assert doc["title"] == "x" * 240
    assert doc["finance"] is True
    assert doc["finance_trust"] == 1.0  # clamped into 0..1
    assert doc["accepted"] is False
    assert doc["tickers"] == ["AAPL", "MSFT"]  # upper, deduped, alnum only
    assert doc["t"] == 123
    assert "junk" not in doc


def test_normalize_caps_tickers():
    doc = normalize_row({"video_id": "v1", "tickers": [f"T{i}" for i in range(20)]})
    assert len(doc["tickers"]) == 8


# ── aggregate_feed: the --days yield ───────────────────────────────────────

def test_empty_window_is_zero_not_an_error():
    out = aggregate_feed([], 14, now_ms=NOW)
    assert out["candidates"] == 0
    assert out["finance_share"] == 0.0
    assert out["distinct_finance_channels"] == 0
    assert out["accepted_finance_videos"] == 0
    assert out["distinct_tickers"] == 0


def test_window_bounds_each_row():
    rows = [
        row("old", finance=True, t=NOW - 20 * DAY),
        row("in", finance=True, t=NOW - 2 * DAY),
    ]
    out = aggregate_feed(rows, 7, now_ms=NOW)
    assert out["candidates"] == 1
    assert out["finance_candidates"] == 1
    assert out["finance_share"] == 1.0


def test_finance_share_counts_supply_not_only_accepted():
    rows = [
        row("f1", finance=True, accepted=True, channel_id="c1", tickers=["AAPL"]),
        row("f2", finance=True, accepted=False, rejected="finance-scam",
            scam_pattern="finance-scam", channel_id="c2"),
        row("f3", finance=True, accepted=True, channel_id="c1", tickers=["MSFT"]),
        row("n1", finance=False, accepted=True, channel_id="c3"),
        row("n2", finance=False, accepted=False, rejected="low-views", channel_id="c4"),
    ]
    out = aggregate_feed(rows, 14, now_ms=NOW)
    assert out["candidates"] == 5
    assert out["finance_candidates"] == 3
    assert out["finance_share"] == 0.6
    assert out["distinct_finance_channels"] == 2  # c1 counted once, c2 once
    assert out["accepted_finance_videos"] == 2  # f1, f3
    assert out["tickers"] == ["AAPL", "MSFT"]
    assert out["distinct_tickers"] == 2
    assert out["scam_rejections"] == {"finance-scam": 1}
    assert out["rejections"] == {"finance-scam": 1, "low-views": 1}
    assert out["forms"] == {"broad": 5}


def test_channels_fall_back_to_name_and_ignore_empty_keys():
    rows = [
        row("f1", finance=True, channel_name="Market Desk"),
        row("f2", finance=True, channel_name="Market Desk"),
        row("f3", finance=True),
    ]
    out = aggregate_feed(rows, 14, now_ms=NOW)
    assert out["distinct_finance_channels"] == 1  # the name, not the empty key


def test_drip_modes_and_forms_are_separated():
    rows = [
        row("a", form="liked-channel-finance", drip_mode="finance"),
        row("b", form="broad", drip_mode="finance"),
        row("c", form="broad", drip_mode="overall"),
    ]
    out = aggregate_feed(rows, 14, now_ms=NOW)
    assert out["forms"] == {"broad": 2, "liked-channel-finance": 1}
    assert out["drip_modes"] == {"finance": 2, "overall": 1}


def test_tickers_only_from_accepted_finance_rows():
    rows = [
        row("f1", finance=True, accepted=True, tickers=["AAPL"]),
        row("f2", finance=True, accepted=False, rejected="finance-scam",
            scam_pattern="finance-scam", tickers=["SCAM"]),
        row("n1", finance=False, accepted=True, tickers=["NOTFIN"]),
    ]
    out = aggregate_feed(rows, 14, now_ms=NOW)
    assert out["tickers"] == ["AAPL"]
    assert out["distinct_tickers"] == 1


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"\n{len(tests)} feed-candidate tests passed")

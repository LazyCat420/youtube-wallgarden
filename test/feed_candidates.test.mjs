// Feed-candidate ledger: the discovery pipeline ships one row per evaluated
// candidate to POST /sync/feed/candidates so the finance arms are measurable
// server-side. This suite pins the row shape the aggregate depends on: form,
// finance flag, financeTrust origin, the pump gate's pattern string on the
// rejected half, and the drip arm. Instrumentation only — the ranked output
// must be identical with the ledger on.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const { get, state, fetchCalls, ctx } = boot();

const gate = get("gateAndRankDiscoveryVideos");
const policy = get("getTopicPolicy")("equities");
const flush = ctx.window.wgFlushFeedCandidates;
const financeTickers = get("financeTickers");
const now = Date.now();

// The user's own finance like on channel c2 earns it financeTrust 0.5.
state.ratingStates = {
    like1: { r: 5, t: now, v: { id: "like1", channelId: "c2", channelName: "Market Desk" } },
};
state.minedVideos = { like1: { t: now, topics: ["equities"] } };

console.log("Running Feed Candidate Ledger Tests...\n");

// 1. Ticker extraction is narrow: cashtags and parenthesised symbols only.
{
    assert.deepStrictEqual(plain(financeTickers("AAPL $MSFT and (NVDA) into earnings")), ["MSFT", "NVDA"]);
    assert.deepStrictEqual(plain(financeTickers("raku kiln firing (part 2)")), []);
    console.log("✅ tickers: $AAPL / (AAPL) shapes only");
}

// 2. Every evaluated candidate gets a row; rejections carry their reason.
{
    state.lastExploreDrip = { seed: "equities", mode: "finance", t: now, topics: ["equities"] };
    const videos = [
        {
            id: "scam1", title: "Bitcoin 100x guaranteed returns", channelName: "Pump Channel",
            channelId: "c1", viewCount: 500000, duration: 600, published: now - 2 * DAY,
            _form: "broad", _topic: "equities",
        },
        {
            id: "fin1", title: "$AAPL earnings breakdown and guidance", channelName: "Market Desk",
            channelId: "c2", viewCount: 200000, duration: 900, published: now - 3 * DAY,
            _form: "liked-channel-finance", _topic: "equities",
        },
        {
            id: "kiln1", title: "Raku kiln firing start to finish", channelName: "Kiln Works",
            channelId: "c3", viewCount: 120000, duration: 1200, published: now - 5 * DAY,
            _form: "depth", _topic: "kiln building",
        },
    ];
    const ranked = gate(videos, "equities", policy);
    assert.ok(ranked.some(v => v.id === "fin1"), "the finance candidate survives the pipeline");
    assert.ok(!ranked.some(v => v.id === "scam1"), "the pump title is rejected");

    const flushed = await flush();
    assert.strictEqual(flushed, 3, "one row per evaluated candidate, rejected included");
    const post = fetchCalls.find(c => c.url === "/sync/feed/candidates");
    assert.ok(post, "ledger rows posted to the sync service");
    assert.strictEqual(post.opts.method, "POST");
    const rows = JSON.parse(post.opts.body).rows;
    assert.strictEqual(rows.length, 3);

    const byId = Object.fromEntries(rows.map(r => [r.video_id, r]));
    const scam = byId.scam1;
    assert.strictEqual(scam.form, "broad");
    assert.strictEqual(scam.finance, true, "finance lexicon flags the pump title");
    assert.strictEqual(scam.accepted, false);
    assert.strictEqual(scam.rejected, "finance-scam");
    assert.strictEqual(scam.scam_pattern, "finance-scam", "the financeScamReason pattern is stored");
    assert.strictEqual(scam.finance_trust, 0, "a pump channel has no finance trust");
    assert.strictEqual(scam.drip_mode, "finance", "the drip arm is stamped");

    const fin = byId.fin1;
    assert.strictEqual(fin.form, "liked-channel-finance", "Option B form reaches the ledger");
    assert.strictEqual(fin.finance, true);
    assert.strictEqual(fin.accepted, true);
    assert.strictEqual(fin.rejected, null);
    assert.strictEqual(fin.finance_trust, 0.5, "financeTrust channel origin is stored");
    assert.deepStrictEqual(plain(fin.tickers), ["AAPL"]);

    const kiln = byId.kiln1;
    assert.strictEqual(kiln.finance, false);
    assert.strictEqual(kiln.accepted, true);
    assert.deepStrictEqual(plain(kiln.tickers), []);

    assert.deepStrictEqual(plain(ctx.window.wgFeedCandidates()), [], "the buffer is drained by the flush");
    console.log("✅ rows: form, finance, trust, scam pattern, tickers, drip arm");
}

// 3. The ledger is off the ranking path: the same input ranks the same.
{
    const mk = (id) => ({
        id, title: `${id} equities analysis`, channelName: "Chan " + id,
        channelId: "ch-" + id, viewCount: 250000, duration: 600, published: now - DAY,
        _form: "broad", _topic: "equities",
    });
    const first = gate([mk("a"), mk("b")], "equities", policy).map(v => v.id);
    await flush();
    const second = gate([mk("a"), mk("b")], "equities", policy).map(v => v.id);
    await flush();
    assert.deepStrictEqual(plain(first), plain(second), "ranked order is unchanged by instrumentation");
    console.log("✅ ranking unchanged");
}

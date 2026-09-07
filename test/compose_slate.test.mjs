// composeSlate: the pool is a reservoir, the slate is composed. Properties
// only — caps, era share, rank survival, determinism — no constant is pinned.
import fs from "node:fs";
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const { get, state, fetchCalls, ctx: vmctx } = boot();
const composeSlate = get("composeSlate");
const ERA_BUCKETS = plain(get("ERA_BUCKETS"));
const now = Date.UTC(2026, 8, 6);
const eraAge = { recent: 30, mid: 2 * 365, classic: 6 * 365, vintage: 14 * 365 };
let seq = 0;
const mk = (over = {}) => ({
  id: "v" + (seq++), title: "t", channelName: over.channel || "Chan" + (seq % 7),
  published: over.era ? now - eraAge[over.era] * DAY : (over.published === undefined ? now - 30 * DAY : over.published),
  _topic: over.topic || "topic" + (seq % 5), _rankScore: over.rel === undefined ? 10 : over.rel, ...over,
});
const eq = { recent: 0.25, mid: 0.25, classic: 0.25, vintage: 0.25 };
const base = { now, targetEra: eq };
const count = (slate, key) => slate.reduce((m, v) => { const k = v[key]; m[k] = (m[k] || 0) + 1; return m; }, {});

console.log("Running Slate Composition Tests...\n");

// 1. Channel cap holds when alternatives exist.
{
  const pool = [];
  for (let i = 0; i < 12; i++) pool.push(mk({ channel: "MegaChan", rel: 100, era: ERA_BUCKETS[i % 4], topic: "t" + i }));
  for (let i = 0; i < 30; i++) pool.push(mk({ channel: "Other" + i, rel: 1, era: ERA_BUCKETS[i % 4], topic: "u" + i }));
  const { slate } = composeSlate(pool, 12, base);
  assert.strictEqual(slate.length, 12);
  assert.ok((count(slate, "channelName").MegaChan || 0) <= 2, `MegaChan got ${count(slate, "channelName").MegaChan}`);
  console.log("✅ channel cap holds when alternatives exist");
}

// 2. Caps relax when nothing else exists — the slate still fills.
{
  const pool = Array.from({ length: 12 }, (_, i) => mk({ channel: "Only", topic: "only", era: ERA_BUCKETS[i % 4] }));
  const { slate } = composeSlate(pool, 12, base);
  assert.strictEqual(slate.length, 12);
  console.log("✅ caps relax when nothing else exists");
}

// 3. Topic cap holds when alternatives exist.
{
  const pool = [];
  for (let i = 0; i < 12; i++) pool.push(mk({ topic: "hot topic", rel: 100, era: ERA_BUCKETS[i % 4], channel: "c" + i }));
  for (let i = 0; i < 30; i++) pool.push(mk({ topic: "cold" + i, rel: 1, era: ERA_BUCKETS[i % 4], channel: "d" + i }));
  const { slate } = composeSlate(pool, 12, base);
  assert.ok((count(slate, "_topic")["hot topic"] || 0) <= 3);
  console.log("✅ topic cap holds when alternatives exist");
}

// 4. Era share tracks the target when supply exists (equal relevance).
{
  const pool = [];
  ERA_BUCKETS.forEach(e => { for (let i = 0; i < 10; i++) pool.push(mk({ era: e, channel: e + i, topic: e + "t" + i })); });
  const target = { recent: 0.5, mid: 0.25, classic: 0.25, vintage: 0 };
  const { slate, breakdown } = composeSlate(pool, 12, { ...base, targetEra: target });
  const eras = count(slate.map(v => ({ e: get("eraBucketOf")(v.published, now) })), "e");
  for (const b of ERA_BUCKETS) {
    const want = target[b] * 12;
    assert.ok(Math.abs((eras[b] || 0) - want) <= 1, `${b}: got ${eras[b] || 0}, wanted ~${want}`);
  }
  assert.ok(breakdown.kl < 0.05, `kl ${breakdown.kl}`);
  console.log("✅ era share tracks the target when supply exists");
}

// 5. Degrades gracefully: zero classic/vintage supply still fills the slate.
{
  const pool = Array.from({ length: 20 }, (_, i) => mk({ era: i % 2 ? "recent" : "mid", channel: "c" + i, topic: "t" + i }));
  const { slate, breakdown } = composeSlate(pool, 12, base);
  assert.strictEqual(slate.length, 12);
  assert.ok(!breakdown.era.classic && !breakdown.era.vintage);
  console.log("✅ degrades gracefully with missing eras");
}

// 6. Rank survives: same era/topic/channel, higher rank is chosen first.
{
  const pool = [mk({ rel: 1, channel: "Same", topic: "same", era: "mid" }), mk({ rel: 9, channel: "Same", topic: "same", era: "mid" }),
                mk({ rel: 5, channel: "Same", topic: "same", era: "mid" })];
  const { slate } = composeSlate(pool, 2, { ...base, caps: { channel: Infinity, topic: Infinity } });
  assert.deepStrictEqual(plain(slate.map(v => v._rankScore)), [9, 5]);
  console.log("✅ rank order survives within a bucket");
}

// 7. Undated rows compete as recent and never satisfy an older bucket.
{
  const pool = [];
  for (let i = 0; i < 12; i++) pool.push(mk({ published: null, channel: "u" + i, topic: "ut" + i }));
  for (let i = 0; i < 12; i++) pool.push(mk({ era: "vintage", channel: "w" + i, topic: "wt" + i }));
  const target = { recent: 0.5, mid: 0, classic: 0, vintage: 0.5 };
  const { slate, breakdown } = composeSlate(pool, 12, { ...base, targetEra: target });
  assert.strictEqual(breakdown.eraRaw.unknown, 12 - (breakdown.eraRaw.vintage || 0));
  assert.ok((breakdown.era.vintage || 0) <= 7 && (breakdown.era.vintage || 0) >= 5, JSON.stringify(breakdown.era));
  assert.ok(breakdown.era.recent > 0, "unknown rows were charged to recent");
  console.log("✅ undated rows are charged to recent, never to an older bucket");
}

// 8. Explore slot: a never-shown topic gets in even at low relevance.
{
  const pool = [];
  for (let i = 0; i < 30; i++) pool.push(mk({ rel: 50, topic: "seen" + (i % 10), channel: "c" + i, era: ERA_BUCKETS[i % 4] }));
  pool.push(mk({ rel: 1, topic: "never shown", channel: "newbie", era: "mid" }));
  const seen = new Set(Array.from({ length: 10 }, (_, i) => "seen" + i));
  const { slate } = composeSlate(pool, 12, { ...base, isUnexploredTopic: t => !seen.has(t) });
  assert.ok(slate.some(v => v._topic === "never shown"));
  const without = composeSlate(pool, 12, base).slate;
  assert.ok(!without.some(v => v._topic === "never shown"), "without the explore hook, relevance alone leaves it out");
  console.log("✅ explore slot admits an unshown topic");
}

// 9. Pure and deterministic; input not mutated.
{
  const pool = Array.from({ length: 40 }, (_, i) => mk({ era: ERA_BUCKETS[i % 4], rel: (i * 7) % 11 }));
  const before = JSON.stringify(pool);
  const a = plain(composeSlate(pool, 12, base).slate.map(v => v.id));
  const b = plain(composeSlate(pool, 12, base).slate.map(v => v.id));
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify(pool), before);
  assert.strictEqual(composeSlate([], 12, base).slate.length, 0);
  console.log("✅ pure, deterministic, non-mutating");
}

// 10. takeSlate removes what it picked from the pool.
{
  const takeSlate = get("takeSlate");
  const pool = Array.from({ length: 20 }, (_, i) => mk({ era: ERA_BUCKETS[i % 4] }));
  const got = takeSlate(pool, 5, base);
  assert.strictEqual(got.length, 5);
  assert.strictEqual(pool.length, 15);
  assert.ok(got.every(v => !pool.includes(v)));
  console.log("✅ takeSlate removes picked videos from the pool");
}

// 11. The four retrieval forms reach the scraper, exactly one carries sp,
//     and dates/description map through.
{
  const items = (form) => ({ items: [
    { video_id: form + "1", title: form + " one", channel: "Ch " + form, channel_id: "UC" + form, published_at: "2019-03-06T00:00:00", published_at_estimated: true, duration_secs: 600, view_count: 5000, description: "desc " + form },
    { video_id: form + "2", title: form + " two", channel: "Ch " + form, channel_id: "UC" + form, published_at: null, duration_secs: 700, view_count: 6000 },
  ] });
  fetchCalls.length = 0;
  vmctx.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    fetchCalls.push({ url, body });
    return { ok: true, json: async () => items(body.sp ? "recent" : body.sort === "views" ? "proven" : body.query.length > 8 ? "depth" : "broad") };
  };
  state.settings = { useYtdlp: true, semanticFilterEnabled: false, muteShorts: false };
  const videos = await get("fetchVideosForTopic")("kiln");
  const bodies = fetchCalls.filter(c => c.url === "/scraper/collect").map(c => c.body);
  assert.strictEqual(bodies.length, 4, `expected 4 scraper calls, got ${bodies.length}`);
  assert.strictEqual(bodies.filter(b => b.sp).length, 1, "exactly one form carries an sp token");
  assert.ok(bodies.every(b => b.require_transcript === false));
  assert.ok(bodies.every(b => (b.sp && !b.sort) || (!b.sp && b.sort)), "sp and sort are never sent together");
  const dated = videos.find(v => v.id === "recent1");
  const undated = videos.find(v => v.id === "recent2");
  assert.ok(dated && typeof dated.published === "number" && dated.publishedEstimated === true);
  assert.strictEqual(dated.description, "desc recent");
  assert.ok(undated && undated.published === null);
  assert.ok(videos.every(v => typeof v._rankScore === "number"), "every candidate is ranked");
  console.log("✅ four forms, one sp token, dates and description mapped");
}

// 12. Regression gate: the shuffle and the round-robin picker are gone.
{
  const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.ok(!/shuffleArray\(state\.smartFeedSuggestionPool\)/.test(src), "pool shuffle removed");
  assert.ok(!/function pickDiverseBatch/.test(src), "round-robin picker removed");
  assert.ok((src.match(/takeSlate\(/g) || []).length >= 3, "takeSlate wired at both draw sites");
  assert.ok(/"sp"|sp:/.test(src.slice(src.indexOf("const DISCOVERY_FORMS"))), "recent form carries sp");
  console.log("✅ regression gate: shuffle and round-robin gone, slate wired");
}

console.log("\nAll slate composition tests passed.");

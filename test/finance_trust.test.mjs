// Option B (finance-trust channel layer): trust from the user's own finance
// likes, the q lift, the larger supply budget for trusted channels, the 7-day
// shown cap, and the liked-channel-finance ledger tag.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const now = Date.now();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

const like = (channelId, channelName) => ({ r: 5, t: now, v: { channelId, channelName, title: "liked" } });

console.log("Running Finance Trust Tests...\n");

// 1. financeTrust: 0 without a finance like, 0.5 with one, 1 with ≥2; mined
// topics are the classifier, and the cache recomputes when they change.
{
  const { get, state } = boot();
  state.ratingStates = {
    a1: like("UCfin", "Fin Chan"),
    a2: like("UCfin", "Fin Chan"),
    a3: like("UCfin", "Fin Chan"),
    n1: like("UCwood", "Wood Chan"),
    h1: like("UChalf", "Half Chan"),
  };
  state.minedVideos = {
    a1: { t: now, topics: ["equities"] },
    a2: { t: now, topics: ["fomc"] },
    a3: { t: now, topics: ["valuation"] },
    n1: { t: now, topics: ["woodworking hand tools"] },
    h1: { t: now, topics: ["bitcoin"] },
  };
  const trust = get("buildChannelFinanceTrust")();
  assert.strictEqual(trust.get("UCfin").financeTrust, 1, "3 finance likes -> 1");
  assert.strictEqual(trust.get("UChalf").financeTrust, 0.5, "1 finance like -> 0.5");
  assert.strictEqual(trust.get("UCwood"), undefined, "no finance like -> absent/0");
  assert.strictEqual(get("financeTrustForChannel")("UCwood", "wood chan"), 0);
  assert.strictEqual(get("financeTrustForChannel")("", "fin chan"), 1, "name alias resolves");

  // A like whose mined topics are not finance never earns trust.
  state.minedVideos.h1 = { t: now, topics: ["budgeting for beginners"] };
  assert.strictEqual(get("financeTrustForChannel")("UChalf", "half chan"), 0.5,
    "budgeting is finance; trust unchanged");
  state.minedVideos.h1 = { t: now, topics: ["home cooking"] };
  assert.strictEqual(get("financeTrustForChannel")("UChalf", "half chan"), 0,
    "mined-topic change recomputes the cache");
  console.log("✅ financeTrust: 0 / 0.5 / 1, name alias, mined-topic recompute");
}

// 2. q lift: +0.10*trust folded into buildChannelQuality and
// channelQualityForVideo, capped at 1.
{
  const { get, state } = boot();
  state.ratingStates = { a1: like("UCfin", "Fin Chan"), a2: like("UCfin", "Fin Chan"), a3: like("UCfin", "Fin Chan") };
  state.minedVideos = {
    a1: { t: now, topics: ["equities"] },
    a2: { t: now, topics: ["fomc"] },
    a3: { t: now, topics: ["valuation"] },
  };
  state.feedMix = { shown: [] };
  const q = get("buildChannelQuality")();
  const rec = q.get("UCfin");
  assert.strictEqual(rec.financeTrust, 1);
  near(rec.baseQ, 0.35, "base unchanged (3 likes, no views/impressions)");
  near(rec.q, 0.35 + 0.10, "q = base + FINANCE_Q_BONUS*trust");

  const qv = get("channelQualityForVideo");
  const video = { id: "v", title: "earnings recap", channelName: "Fin Chan", channelId: "UCfin" };
  near(qv(video, { channelQuality: q }), 0.45, "per-video q carries the finance lift");

  // Cap: median 10M views + 3 likes + subs/verified already reach 1.0.
  state.smartFeedVideos = [1, 2, 3].map(i => ({ id: "m" + i, channelName: "Fin Chan", channelId: "UCfin", viewCount: 1e7 }));
  state.channelStats = { UCfin: { subs: 1e6, verified: true, at: now } };
  get("invalidateLikedChannelCache")();
  const capped = get("buildChannelQuality")().get("UCfin");
  near(capped.baseQ, 0.8, "base 0.45 views + 0.35 likes");
  near(capped.q, 1, "q capped at 1 despite the finance bonus");
  near(qv(video, { channelQuality: get("buildChannelQuality")() }), 1, "per-video q capped at 1");

  // Non-finance channel: q unchanged, no bonus.
  state.ratingStates.w1 = like("UCwood", "Wood Chan");
  state.minedVideos.w1 = { t: now, topics: ["woodworking hand tools"] };
  get("invalidateLikedChannelCache")();
  const wood = get("buildChannelQuality")().get("UCwood");
  assert.strictEqual(wood.financeTrust, 0);
  near(wood.q, wood.baseQ, "non-finance q is the plain base");
  console.log("✅ q lift: +0.10*trust, ±1 cap respected, non-finance unchanged");
}

// 3. Supply: finance channels get 5 channels x 8 uploads; others stay 3 x 6.
{
  const fin = ["UCf1", "UCf2", "UCf3", "UCf4", "UCf5", "UCf6"];
  const wood = ["UCw1", "UCw2", "UCw3", "UCw4", "UCw5"];
  const nameOf = id => (id.startsWith("UCf") ? "Fin " + id.slice(3) : "Wood " + id.slice(3));
  const calls = [];
  const { get, state } = boot({ fetch: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const cid = body && body.channels && body.channels[0];
    return { ok: true, json: async () => ({ items: [{
      video_id: cid + "-up", title: cid.startsWith("UCf") ? "quarterly results and guidance" : "hand tool restoration",
      channel: nameOf(cid), channel_id: cid, view_count: 500, duration_secs: 300, published_at: "2025-06-01",
    }] }) };
  } });
  state.ratingStates = {};
  state.minedVideos = {};
  [...fin, ...wood].forEach((cid, i) => {
    state.ratingStates["l" + i] = like(cid, nameOf(cid));
    state.minedVideos["l" + i] = { t: now, topics: [cid.startsWith("UCf") ? "equities" : "woodworking hand tools"] };
  });
  const added = await get("fetchLikedChannelUploads")();
  const collect = calls.filter(c => c.url === "/scraper/collect");
  const financeCalls = collect.filter(c => fin.includes(c.body.channels[0]));
  const woodCalls = collect.filter(c => wood.includes(c.body.channels[0]));
  assert.strictEqual(financeCalls.length, 5, "finance supply cap is 5 channels");
  assert.strictEqual(woodCalls.length, 3, "non-finance supply stays at 3 channels");
  financeCalls.forEach(c => assert.strictEqual(c.body.limit, 8, "finance channel fetches 8 uploads"));
  woodCalls.forEach(c => assert.strictEqual(c.body.limit, 6, "non-finance channel fetches 6 uploads"));
  assert.strictEqual(added.length, 8, "all selected uploads merged");
  const finRow = state.smartFeedSuggestionPool.find(v => fin.includes(v.channelId));
  const woodRow = state.smartFeedSuggestionPool.find(v => wood.includes(v.channelId));
  assert.strictEqual(finRow._form, "liked-channel-finance", "finance supply row tagged");
  assert.strictEqual(woodRow._form, "liked-channel", "non-finance row keeps its form");
  get("recordFeedShown")([finRow], "slate");
  assert.strictEqual(state.feedMix.shown[state.feedMix.shown.length - 1].form, "liked-channel-finance",
    "ledger separates the finance arm");
  console.log("✅ supply: finance 5x8, non-finance 3x6, _form tag reaches the ledger");
}

// 4. A channel shown >= 3 times in the last 7 days is skipped; older rows and
// other channels do not count.
{
  const calls = [];
  const { get, state } = boot({ fetch: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const cid = body.channels[0];
    return { ok: true, json: async () => ({ items: [{
      video_id: cid + "-up", title: "quarterly results and guidance", channel: "Fin " + cid.slice(3),
      channel_id: cid, view_count: 500, duration_secs: 300, published_at: "2025-06-01",
    }] }) };
  } });
  state.ratingStates = {
    a: like("UCA", "Fin A"), b: like("UCB", "Fin B"), c: like("UCC", "Fin C"),
  };
  state.minedVideos = {
    a: { t: now, topics: ["equities"] }, b: { t: now, topics: ["fomc"] }, c: { t: now, topics: ["valuation"] },
  };
  state.feedMix = { shown: [] };
  for (let i = 0; i < 3; i++) state.feedMix.shown.push(
    { id: "sa" + i, channel: "fin a", channelId: "UCA", form: "liked-channel-finance", mode: "slate", t: now - DAY });
  for (let i = 0; i < 3; i++) state.feedMix.shown.push(
    { id: "sc" + i, channel: "fin c", channelId: "UCC", form: "liked-channel-finance", mode: "slate", t: now - 8 * DAY });
  const added = await get("fetchLikedChannelUploads")();
  const ids = calls.filter(c => c.url === "/scraper/collect").map(c => c.body.channels[0]);
  assert.ok(!ids.includes("UCA"), "3 shown in 7 days -> channel skipped");
  assert.ok(ids.includes("UCB"), "unshown channel still supplies");
  assert.ok(ids.includes("UCC"), "rows older than 7 days do not count");
  assert.strictEqual(added.length, 2);
  console.log("✅ 7-day shown cap: >=3 skips the channel, stale rows ignored");
}

// 5. Non-finance path unchanged: no finance likes -> 3 channels x 6 uploads.
{
  const calls = [];
  const { get, state } = boot({ fetch: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const cid = body.channels[0];
    return { ok: true, json: async () => ({ items: [{
      video_id: cid + "-up", title: "hand tool restoration", channel: "Wood " + cid.slice(3),
      channel_id: cid, view_count: 500, duration_secs: 300, published_at: "2025-06-01",
    }] }) };
  } });
  state.ratingStates = {};
  state.minedVideos = {};
  ["UCw1", "UCw2", "UCw3", "UCw4", "UCw5"].forEach((cid, i) => {
    state.ratingStates["l" + i] = like(cid, "Wood " + cid.slice(3));
    state.minedVideos["l" + i] = { t: now, topics: ["woodworking hand tools"] };
  });
  const added = await get("fetchLikedChannelUploads")();
  const collect = calls.filter(c => c.url === "/scraper/collect");
  assert.strictEqual(collect.length, 3, "still 3 channels");
  collect.forEach(c => assert.strictEqual(c.body.limit, 6, "still 6 uploads"));
  assert.strictEqual(added.length, 3);
  added.forEach(v => assert.strictEqual(v._form, "liked-channel", "non-finance form unchanged"));
  console.log("✅ non-finance path: 3x6, form unchanged");
}

console.log("\nAll Finance Trust tests passed!\n");

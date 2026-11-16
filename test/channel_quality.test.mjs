// Phase B (plan/discovery_reset_and_channel_quality.md §5): the channel
// quality layer. q from the ledger, the fetch gates beside isSpamShapedVideo,
// the authority lift, and the cross-slate channel cap.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);
const now = Date.now();

console.log("Running Channel Quality Tests...\n");

// 1. buildChannelQuality: q from seeded likes/dislikes/impressions + median views.
{
  const { get, state } = boot();
  state.ratingStates = {
    lv1: { r: 5, t: now, v: { channelName: "Seed Channel", channelId: "UCseed" } },
    lv2: { r: 5, t: now, v: { channelName: "Seed Channel", channelId: "UCseed" } },
    lv3: { r: 5, t: now, v: { channelName: "Seed Channel", channelId: "UCseed" } },
    dv1: { r: 1, t: now, v: { channelName: "Bad Channel", channelId: "UCbad" } },
    dv2: { r: 0, t: now, v: { channelName: "Bad Channel", channelId: "UCbad" } },
    mv1: { r: 3, t: now, v: { channelName: "Mid Channel", channelId: "UCmid" } },
  };
  state.feedMix = { shown: [] };
  for (let i = 0; i < 8; i++) state.feedMix.shown.push(
    { id: "s" + i, era: "recent", topic: "t", channel: "seed channel", channelId: "UCseed", form: "broad", mode: "slate", t: now });
  for (let i = 0; i < 4; i++) state.feedMix.shown.push(
    { id: "m" + i, era: "recent", topic: "t", channel: "mid channel", channelId: "UCmid", form: "broad", mode: "slate", t: now });
  state.watchedHistory = { s3: now }; // one shown seed video later played
  state.smartFeedVideos = [
    { id: "v1", title: "v1", channelName: "Seed Channel", channelId: "UCseed", viewCount: 1000 },
    { id: "v2", title: "v2", channelName: "Seed Channel", channelId: "UCseed", viewCount: 10000 },
    { id: "v3", title: "v3", channelName: "Seed Channel", channelId: "UCseed", viewCount: 100000 },
  ];
  const q = get("buildChannelQuality")();
  const seed = q.get("UCseed");
  assert.ok(seed, "record keyed by channelId");
  assert.strictEqual(q.get("seed channel"), seed, "same record under the lowercased name");
  assert.strictEqual(seed.likes, 3);
  assert.strictEqual(seed.dislikes, 0);
  assert.strictEqual(seed.impressions, 8);
  assert.strictEqual(seed.plays, 1, "play joins watchedHistory by video id");
  assert.strictEqual(seed.medianViews, 10000, "median of the channel's pool viewCounts");
  const wantSeed = 0.45 * (Math.log10(10000) / 6.5) + 0.35 * 1 - 0.40 * (7 / 8);
  near(seed.q, wantSeed, "q = 0.45*log10(median)/6.5 + 0.35*likes/3 - 0.40*unengaged/8");

  const bad = q.get("UCbad");
  near(bad.q, -0.50, "two dislikes -> -0.5 with no views/likes/impressions");
  const mid = q.get("UCmid");
  near(mid.q, -0.40 * 0.5, "rating 3 counts as neither like nor dislike; 4 unengaged impressions");
  console.log("✅ q formula: likes, dislikes (r<=1 only), impressions/plays join, median views");
}

// 2. Empty state never throws; cache invalidates with the liked-channel cache.
{
  const { get, state } = boot();
  const q1 = get("buildChannelQuality")();
  assert.strictEqual(q1.size, 0, "empty state -> empty map");
  assert.strictEqual(typeof get("window").wgChannelQuality, "function", "exposed on window");
  state.ratingStates = { l1: { r: 5, t: now, v: { channelName: "Late Chan", channelId: "UClate" } } };
  const q2 = get("buildChannelQuality")();
  assert.strictEqual(q2.get("UClate"), undefined, "cached build predates the like");
  get("invalidateLikedChannelCache")();
  const q3 = get("buildChannelQuality")();
  assert.strictEqual(q3.get("UClate").likes, 1, "invalidated by invalidateLikedChannelCache()");
  console.log("✅ empty-state safe; cached; invalidated with the affinity cache");
}

// 3. B2 gates in the fetch filter: dislikes drop, unengaged drop, high-view
// demotion (score delta), and the absolute liked-channel exemption.
{
  const mkBoot = (extraStates) => {
    const items = [
      { video_id: "g1", title: "a solid joinery video", channel: "Grudge Channel", channel_id: "UCgrudge", view_count: 12000, duration_secs: 600, published_at: "2025-01-01" },
      { video_id: "g2", title: "another joinery practice", channel: "Neutral Channel", channel_id: "UCneutral", view_count: 12000, duration_secs: 600, published_at: "2025-01-01" },
      { video_id: "g3", title: "viral joinery spectacle", channel: "Viral Channel", channel_id: "UCviral", view_count: 6000000, duration_secs: 600, published_at: "2025-01-01" },
      { video_id: "g4", title: "clean joinery build", channel: "Clean Channel", channel_id: "UCclean", view_count: 12000, duration_secs: 600, published_at: "2025-01-01" },
    ];
    const { get, state } = boot({ fetch: async () => ({ ok: true, json: async () => ({ items }) }) });
    state.settings.useYtdlp = true;
    state.ratingStates = Object.assign({
      d1: { r: 1, t: now, v: { channelName: "Grudge Channel", channelId: "UCgrudge" } },
      d2: { r: 1, t: now, v: { channelName: "Grudge Channel", channelId: "UCgrudge" } },
    }, extraStates || {});
    state.feedMix = { shown: [] };
    for (let i = 0; i < 8; i++) state.feedMix.shown.push(
      { id: "n" + i, era: "recent", topic: "t", channel: "neutral channel", channelId: "UCneutral", form: "broad", mode: "slate", t: now });
    // Viral channel: >=3 pool videos ALL above 5M views, zero likes/plays.
    state.smartFeedSuggestionPool = [1, 2, 3].map(i => ({
      id: "p" + i, title: "pool viral " + i, channelName: "Viral Channel", channelId: "UCviral", viewCount: 6000000,
    }));
    return { get, state };
  };

  const { get, state } = mkBoot();
  const kept = await get("fetchVideosForTopic")("joinery");
  const ids = kept.map(v => v.id);
  assert.ok(!ids.includes("g1"), "channel with 2 dislikes is dropped");
  assert.ok(!ids.includes("g2"), "channel with 8 impressions and 0 plays is dropped");
  assert.ok(ids.includes("g3"), "high-view slop channel is demoted, not dropped");
  assert.ok(ids.includes("g4"), "clean channel survives");
  const g3 = kept.find(v => v.id === "g3");
  const g4 = kept.find(v => v.id === "g4");
  const base = get("getScoreAndMatches")({ id: "twin", title: "viral joinery spectacle", channelName: "Viral Channel", channelId: "UCviral" }).score;
  near(g3.score, base - 2.5, "channel-highview-demote subtracts 2.5 from score");
  near(g4.score, base, "control channel score untouched");
  assert.ok(state.feedMix.shown.length === 8, "gates do not touch the ledger");

  // Liked-channel exemption: one like on the disliked channel keeps its row.
  const ex = mkBoot({ like1: { r: 5, t: now, v: { channelName: "Grudge Channel", channelId: "UCgrudge" } } });
  const keptLiked = await ex.get("fetchVideosForTopic")("joinery");
  assert.ok(keptLiked.map(v => v.id).includes("g1"), "a liked channel is never dropped on channel history");
  console.log("✅ B2 gates: channel-dislikes, channel-unengaged, high-view demotion (-2.5), liked exemption");
}

// 4. B3 authority: +0.25*q via ctx.channelQuality, clamped to [0, 1]; live
// scraper fields preferred over the cached stats.
{
  const { get } = boot();
  const scoreDiscoveryVideo = get("scoreDiscoveryVideo");
  const video = (over) => Object.assign({ id: "x", title: "a joinery video", channelName: "Nice Channel", channelId: "UCnice", viewCount: 10000, duration: 600, published: now - 100 * DAY }, over);
  const ctxBase = { topic: "joinery", likedChannels: new Set(), likeCounts: {} };
  const a0 = scoreDiscoveryVideo(video(), ctxBase).breakdown.authority;
  near(a0, 0.35 * (Math.log10(10000) / 6.5), "baseline authority unchanged when ctx has no map");

  const rec = { channelId: "UCnice", name: "nice channel", baseQ: 0.6, subs: 200000, verified: true };
  const a1 = scoreDiscoveryVideo(video(), { ...ctxBase, channelQuality: new Map([["UCnice", rec]]) }).breakdown.authority;
  near(a1 - a0, 0.25 * Math.min(1, 0.6 + 0.15 + 0.05), "authority lifts by 0.25*q with the B5 bonus");

  // Live per-video fields beat the cached stats.
  const a2 = scoreDiscoveryVideo(video({ channelSubs: 10, channelVerified: false }), { ...ctxBase, channelQuality: new Map([["UCnice", rec]]) }).breakdown.authority;
  near(a2 - a0, 0.25 * 0.6, "video channelSubs/channelVerified override the cached record");

  const recBad = { channelId: "UCnice", name: "nice channel", baseQ: -0.9, subs: 0, verified: false };
  const a3 = scoreDiscoveryVideo(video(), { ...ctxBase, channelQuality: new Map([["UCnice", recBad]]) }).breakdown.authority;
  assert.strictEqual(a3, 0, "authority clamped at 0 (no negative authority)");
  console.log("✅ B3 authority: 0.25*q term, live-field override, [0,1] clamp");
}

// 5. buildRecentChannelCounts: raw 24 h counts by name and id; older ignored.
{
  const { get, state } = boot();
  state.feedMix = { shown: [
    { id: "a", channel: "chan a", channelId: "UCa", t: now },
    { id: "b", channel: "chan a", channelId: "UCa", t: now - 2 * 3600e3 },
    { id: "c", channel: "chan b", channelId: "UCb", t: now - 25 * 3600e3 },
  ] };
  const counts = plain(get("buildRecentChannelCounts")(now));
  assert.strictEqual(counts["chan a"], 2);
  assert.strictEqual(counts["UCa"], 2);
  assert.strictEqual(counts["chan b"], undefined, "rows past the 24 h horizon do not count");
  console.log("✅ buildRecentChannelCounts: raw per-channel 24 h counts");
}

// 6. Cross-slate cap: 3 videos per channel per 24 h, relaxing only when
// nothing else remains.
{
  const { get } = boot();
  const composeSlate = get("composeSlate");
  const mk = (id, ch, rank) => ({ id, title: "video " + id, channelName: ch, published: now - 100 * DAY, _rankScore: rank, discoveryTopic: "topic " + id });
  // relN normalizes over a FIXED 10-point span, so "clearly better" means 10+ rank points.
  const spam = [1, 2, 3, 4, 5].map(i => mk("s" + i, "Spam Chan", 20));
  const other = [1, 2, 3].map(i => mk("o" + i, "Other Chan", 9));
  const baseCtx = { now, temperature: 0, lambda: 0, caps: { channel: Infinity, topic: Infinity } };

  const capped = composeSlate([...spam, ...other], 6, { ...baseCtx, recentChannels: { "spam chan": 2 } });
  assert.strictEqual(capped.slate.length, 6);
  assert.strictEqual(capped.slate.filter(v => v.channelName === "Spam Chan").length, 3,
    "2 shown in the last 24h + 1 more, then the strict pass blocks the channel");

  const uncapped = composeSlate([...spam, ...other], 6, { ...baseCtx });
  assert.strictEqual(uncapped.slate.filter(v => v.channelName === "Spam Chan").length, 5,
    "without the prior the best-ranked channel fills the slate");

  const alone = composeSlate(spam.slice(0, 4), 4, { ...baseCtx, recentChannels: { "spam chan": 2 } });
  assert.strictEqual(alone.slate.length, 4, "cap relaxes when nothing else remains");
  console.log("✅ cross-slate cap: 3/channel/24h, relaxes only when alone");
}

// 7. recordFeedShown rows carry channelId (the join key for B1/B3).
{
  const { get, state } = boot();
  get("recordFeedShown")([{ id: "z", title: "z", channelName: "Zed", channelId: "UCzed", published: now, _topic: "t", viewCount: 5 }]);
  assert.strictEqual(state.feedMix.shown[0].channelId, "UCzed");
  assert.strictEqual(state.feedMix.shown[0].channel, "zed");
  console.log("✅ feedMix rows carry channel + channelId");
}

// 8. B4 fifth form: liked-channel uploads enter the pool pipeline.
{
  const calls = [];
  const item = { video_id: "up1", title: "fresh joinery upload", channel: "Grudge Channel", channel_id: "UCgrudge",
    view_count: 500, duration_secs: 300, published_at: "2025-06-01", channel_follower_count: 250000, channel_is_verified: true };
  const { get, state, store } = boot({ fetch: async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => ({ items: [item] }) };
  } });
  state.ratingStates = {
    lv1: { r: 5, t: now, v: { channelName: "Grudge Channel", channelId: "UCgrudge", title: "liked one" } },
    lv2: { r: 5, t: now, v: { channelName: "Grudge Channel", channelId: "UCgrudge", title: "liked two" } },
  };
  state.minedVideos = {
    lv1: { t: now, topics: ["woodworking hand tools"] },
    lv2: { t: now, topics: ["woodworking hand tools", "beekeeping basics"] },
  };
  const added = await get("fetchLikedChannelUploads")();
  assert.strictEqual(added.length, 1);
  const collect = calls.find(c => c.url === "/scraper/collect");
  assert.ok(collect, "POSTs /scraper/collect");
  assert.deepStrictEqual(collect.body.channels, ["UCgrudge"]);
  assert.strictEqual(collect.body.sort, "date");
  assert.strictEqual(collect.body.limit, 6);
  const row = state.smartFeedSuggestionPool.find(v => v.id === "up1");
  assert.ok(row, "merged into the suggestion pool");
  assert.strictEqual(row._form, "liked-channel");
  assert.strictEqual(row.discoveryTopic, "woodworking hand tools", "dominant mined topic of the channel's likes");
  assert.strictEqual(row.channelSubs, 250000, "scraper channel_follower_count mapped");
  assert.strictEqual(row.channelVerified, true, "scraper channel_is_verified mapped");
  assert.ok(state.likedChannelSupplyAt.UCgrudge, "per-channel 6h stamp set");
  assert.ok(store.get("wallgarden_default_liked_channel_supply_at"), "persisted");
  const second = await get("fetchLikedChannelUploads")();
  assert.strictEqual(second.length, 0, "6 h cache suppresses the rerun");
  assert.strictEqual(calls.filter(c => c.url === "/scraper/collect").length, 1);
  console.log("✅ B4 fetchLikedChannelUploads: channels POST shape, mined-topic, cache, pool merge");
}

// 9. B5 subscriber/verified parsing folds into q.
{
  const { get, state, store } = boot({ fetch: async () => ({
    ok: true,
    text: async () => "var ytInitialData = " + JSON.stringify({
      header: { c4TabbedHeaderRenderer: {
        subscriberCountText: { simpleText: "1.2M subscribers" },
        videoCountText: { runs: [{ text: "350 " }, { text: "videos" }] },
        badges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_VERIFIED" } }],
      } },
    }) + ";",
  }) });
  near(get("parseCountText")("1.2M subscribers"), 1200000, "1.2M -> 1200000");
  near(get("parseCountText")("1,234 videos"), 1234, "comma group");
  near(get("parseCountText")("52.3K subscribers"), 52300, "K multiplier");
  assert.strictEqual(get("parseCountText")("no digits here"), null);
  const updated = await get("fetchChannelStats")(["UCseed"]);
  assert.strictEqual(updated, 1);
  assert.strictEqual(state.channelStats.UCseed.subs, 1200000);
  assert.strictEqual(state.channelStats.UCseed.verified, true);
  assert.ok(store.get("wallgarden_default_channel_stats"), "persisted under channel_stats");
  // Fold into q: base 0.35 (3 likes) + 0.15 (>=100k subs) + 0.05 (verified).
  state.ratingStates = {
    lv1: { r: 5, t: now, v: { channelName: "Seed Channel", channelId: "UCseed" } },
    lv2: { r: 5, t: now, v: { channelName: "Seed Channel", channelId: "UCseed" } },
    lv3: { r: 5, t: now, v: { channelName: "Seed Channel", channelId: "UCseed" } },
  };
  get("invalidateLikedChannelCache")();
  const rec = get("buildChannelQuality")().get("UCseed");
  near(rec.q, Math.min(1, 0.35 + 0.15 + 0.05), "q = min(1, base + 0.15*(subs>=1e5) + 0.05*verified)");
  near(rec.baseQ, 0.35, "base kept separate for live-field overrides");
  // Second call within TTL: no refetch.
  const again = await get("fetchChannelStats")(["UCseed"]);
  assert.strictEqual(again, 0, "7 d TTL skips fresh records");
  console.log("✅ B5 fetchChannelStats: parse, cache, TTL, q fold");
}

console.log("\nAll channel quality tests passed.");

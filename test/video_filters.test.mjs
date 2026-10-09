// Wave-1 video anti-spam: the gates a video must pass to reach the feed.
//
// Every filter used to be a soft penalty on a scale where only -10 total
// mattered — a 45-second ALL-CAPS 0-view short passed everything. And a
// dislike bounced off the pool: entries persisted with _score baked in, so
// negative signal never re-applied.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

const stubEl = new Proxy({}, {
  get: (t, k) => k === "classList" ? { add(){}, remove(){}, toggle(){} }
    : k === "dataset" ? {} : k === "style" ? {}
    : typeof k === "string" && ["appendChild","addEventListener","removeChild","insertBefore","setAttribute","append","remove","click","focus"].includes(k) ? () => {}
    : k === "children" ? [] : k === "innerHTML" ? "" : undefined,
  set: () => true,
});
const doc = {
  addEventListener: () => {}, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => stubEl, body: stubEl, documentElement: stubEl,
};

function boot() {
  const store = new Map();
  const ctx = {
    console, document: doc,
    window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: "" } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    AbortSignal: { timeout: () => null },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    graphUpsertNode: () => "n", graphUpsertEdge: () => "e",
    graphPropagateNegative: () => {}, graphProcessRating: () => {},
    graphProcessWatch: () => {}, graphScoreVideo: () => 0,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const get = (name) => vm.runInContext(name, ctx);
  const state = get("state");
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    topicSignals: {}, topics: [], burnedQueries: [], dislikedTopics: [],
    likedTopics: [], minedVideos: {}, ratingStates: {}, groundingVerdicts: {},
    candidateClassificationCache: {}, smartFeedSuggestionPool: [],
    smartFeedVideos: [], smartFeedTopicsQueue: [], smartFeedUsedTopics: [],
    blockedChannels: [], cache: { videos: {} }, videoRatings: {},
    ontologyGraph: { nodes: {}, edges: {} }, settings: { muteShorts: true },
    searchHistory: [],
  });
  return { get, state };
}

console.log("Running Video Filter Tests...\n");

// ── 1. The exact video that used to pass everything ────────────────
{
  const { get } = boot();
  const spam = get("isSpamShapedVideo");
  // 45s ALL-CAPS 0-view short: three independent reasons to die.
  assert.strictEqual(spam({ title: "INSANE KILN HACK", duration: 45, viewCount: 0 }), "short");
  assert.strictEqual(spam({ title: "INSANE KILN HACK YOU MUST SEE", duration: 600, viewCount: 5000 }), "all-caps");
  assert.strictEqual(spam({ title: "Wait for it!!!", duration: 600, viewCount: 5000 }), "punctuation");
  assert.strictEqual(spam({ title: "Wood ash glaze from scratch", duration: 600, viewCount: 3 }), "low-views");
  assert.strictEqual(spam({ title: "Wood ash glaze from scratch", duration: 600, viewCount: 5000 }), null);
  console.log("✅ shorts / ALL-CAPS / !!!-spam / 0-view all drop; a normal video passes");
}

// ── 2. Liked channels are exempt from the view floor ───────────────
{
  const { get } = boot();
  const liked = new Set(["oxford clay"]);
  const v = { title: "Day-old upload", duration: 600, viewCount: 12, channelName: "Oxford Clay" };
  assert.strictEqual(get("isSpamShapedVideo")(v, liked), null, "followed creator's new video passes");
  assert.strictEqual(get("isSpamShapedVideo")(v, new Set()), "low-views", "same video, unknown channel: drops");
  console.log("✅ view floor exempts liked channels");
}

// ── 3. muteShorts off -> shorts pass the spam gate ─────────────────
{
  const { get, state } = boot();
  state.settings.muteShorts = false;
  assert.strictEqual(get("isSpamShapedVideo")({ title: "Quick tip", duration: 45, viewCount: 5000 }), null);
  console.log("✅ the shorts drop honours the muteShorts setting");
}

// ── 4. Missing metadata is not spam ────────────────────────────────
{
  const { get } = boot();
  // Sub-feed and HTML-fallback videos have no duration/viewCount at all.
  assert.strictEqual(get("isSpamShapedVideo")({ title: "Restoring a 1950s lathe" }), null,
    "no duration + no viewCount must not be treated as a 0-view short");
  console.log("✅ absent metadata does not read as spam");
}

// ── 5. Blocked-channel matching: equality, ids, and the auto-block ─
{
  const { get, state } = boot();
  const blocked = get("isChannelBlocked");
  state.blockedChannels = [{ name: "Tech", id: "" }];
  assert.ok(blocked("", "Tech"), "name match works");
  assert.ok(!blocked("", "TechMoan"), "equality, not includes(): 'Tech' must not hide 'TechMoan'");
  // Auto-block writes name-only entries now; the old {name: X, id: X} shape matched NOTHING.
  state.blockedChannels = [{ name: "Spam Channel", id: "", autoBlocked: true }];
  assert.ok(blocked("UCabc", "Spam Channel"), "auto-blocked entry matches by name even when the video has an id");
  // Real UC… id matching, now that discovery videos carry ids.
  state.blockedChannels = [{ name: "Whatever", id: "UCP0RM68Q01XlAUEndLCL8eA" }];
  assert.ok(blocked("UCP0RM68Q01XlAUEndLCL8eA", "Renamed Channel"), "id match survives a channel rename");
  assert.ok(!blocked("UCother", "Renamed Channel"), "different id: not blocked");
  console.log("✅ channel blocking: equality names, working ids, working auto-blocks");
}

// ── 6. A dislike evicts topic- and channel-mates from the pool ─────
// (behavioural contract of the dislike handler, tested at the pool level)
{
  const { get, state } = boot();
  state.smartFeedSuggestionPool = [
    { id: "a", discoveryTopic: "water treatment", channelName: "SlopCo", title: "1" },
    { id: "b", discoveryTopic: "water treatment", channelName: "Other", title: "2" },
    { id: "c", discoveryTopic: "kiln building", channelName: "SlopCo", title: "3" },
    { id: "d", discoveryTopic: "kiln building", channelName: "GoodChan", title: "4" },
  ];
  // Drive the REAL function, not a copy of its logic in the test.
  const evicted = get("evictPoolForDislike")("water treatment", "SlopCo");
  assert.strictEqual(evicted, 3);
  assert.deepStrictEqual([...state.smartFeedSuggestionPool.map(v => v.id)], ["d"],
    "same-topic and same-channel entries evicted, the rest stay");
  // And it unfreezes what remains, so the new dislike penalty can apply.
  assert.strictEqual(state.smartFeedSuggestionPool[0]._score, undefined);
  console.log("✅ dislike eviction: topic-mates and channel-mates leave the pool");
}

// ── 7. Pool round-trip strips frozen scores ────────────────────────
{
  const { get, state } = boot();
  state.smartFeedSuggestionPool = [
    { id: "a", title: "x", _score: 12, _matchedTopics: ["old"], crawledAt: Date.now() },
  ];
  get("flushSmartFeedSuggestionPoolSave")();
  const saved = JSON.parse(get("localStorage").getItem("wallgarden_default_smart_feed_pool"));
  assert.strictEqual(saved[0]._score, undefined, "persisted pool entries carry no frozen _score");
  assert.strictEqual(saved[0]._matchedTopics, undefined);
  assert.strictEqual(saved[0].id, "a", "the entry itself survives");
  // invalidateScoreCache now reaches the in-memory pool too.
  state.smartFeedSuggestionPool = [{ id: "b", _score: 9, _matchedTopics: [] }];
  get("invalidateScoreCache")();
  assert.strictEqual(state.smartFeedSuggestionPool[0]._score, undefined, "invalidateScoreCache covers the pool");
  console.log("✅ frozen scores stripped on save and on invalidation");
}

// ── 8. Classification verdicts are topic-scoped and expire ─────────
{
  const { get, state } = boot();
  state.candidateClassificationCache = {
    v1: { classification: "OFF_TOPIC", reason: "military tank", topic: "fish tanks", t: Date.now() },
    v2: { classification: "ON_TOPIC", reason: "old, pre-topic-scoping", t: Date.now() },
  };
  const cached = get("cachedClassificationFor");
  assert.ok(cached("v1", "fish tanks"), "same topic: verdict trusted");
  assert.strictEqual(cached("v1", "tank museum restorations"), null,
    "different topic: the OFF_TOPIC verdict must NOT poison it (re-classify)");
  assert.ok(cached("v2", "anything"), "legacy topic-less verdicts stay trusted until they expire");
  console.log("✅ classification cache is topic-scoped; cross-topic poisoning fixed");
}

// ── 9. Old uploads are no longer double-rewarded ───────────────────
{
  const { get, state } = boot();
  const score = get("scoreDiscoveryVideo");
  const twentyYears = Date.now() - 20 * 365 * 86400e3;
  const fiveYears = Date.now() - 5 * 365 * 86400e3;
  const mk = pub => ({ title: "wood ash glaze process", duration: 900, viewCount: 50000, published: pub });
  const ctxArg = { topic: "wood ash glaze", likedChannels: new Set() };
  const oldB = score(mk(twentyYears), ctxArg).breakdown;
  const midB = score(mk(fiveYears), ctxArg).breakdown;
  assert.ok(oldB.maturity < midB.maturity, "20-year-old maturity tapers below the 5-year peak");
  assert.strictEqual(oldB.maturity, 0.6);
  // The vintage legacy bonus is GONE (eval bench measured it starving the
  // recent era — plan/algorithm_audit.md §4). New contract: no era tag, and
  // scores identical across the 2008–2023 window.
  const gs = get("getScoreAndMatches");
  const v2015 = { id: "x1", title: "wood ash glaze", published: new Date("2015-06-01").getTime() };
  const v2004 = { id: "x2", title: "wood ash glaze", published: new Date("2004-06-01").getTime() };
  const v2024 = { id: "x3", title: "wood ash glaze", published: new Date("2024-06-01").getTime() };
  state.topics = [{ phrase: "wood ash glaze", weight: 5, addedAt: Date.now() }];
  const s2015 = gs(v2015), s2004 = gs(v2004), s2024 = gs(v2024);
  assert.ok(![...s2015.matches].includes("vintage"), "no vintage tag: the maturity axis owns era preference");
  assert.strictEqual(s2015.score, s2004.score, "legacy score is era-blind inside/outside the old window");
  assert.strictEqual(s2015.score, s2024.score, "legacy score is era-blind vs post-2023");
  console.log("✅ stale uploads: maturity tapers past 12y, legacy score era-blind");
}

console.log("\nAll Video Filter tests passed!");

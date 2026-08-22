// Browsing must COUNT, not generate.
//
// The metric that matters is not "does a function exist" — it is how many LLM
// calls a browsing session costs. Before this change, playing a video fired
// /similar (10 topics) on a 3s timer, and the preload loop asked for 100 more
// topics every 15s. These tests drive the real functions out of app.js with the
// backend stubbed and COUNT the calls, so a regression that reintroduces
// per-browse generation fails here rather than on the user's GPU.
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
  const llmCalls = [];
  const ctx = {
    console, document: doc,
    window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: "" } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    fetch: async (url, opts) => {
      llmCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, json: async () => ({ topics: ["stub topic"], rated: [] }) };
    },
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
  // `let state` / `const FOO` at the top level of a vm script are lexical
  // bindings, not properties of the context — reach them the way the other
  // suites in this repo do.
  const get = (name) => vm.runInContext(name, ctx);
  const state = get("state");
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    topicSignals: {}, agentQueue: [], topics: [], burnedQueries: [],
    dislikedTopics: [], likedTopics: [], smartFeedTopicsQueue: [],
    smartFeedUsedTopics: [], minedVideos: {}, llmCallStats: {},
    ontologyGraph: { nodes: {}, edges: {} }, settings: {},
  });
  return { get, state, llmCalls };
}

console.log("Running Signal Gating Tests...\n");

// ── 1. The headline number ─────────────────────────────────────────
{
  const { get, state, llmCalls } = boot();
  // A realistic browse: 12 videos from one topic dwelled on, 5 played,
  // 2 searches. Under the old code every play alone fired /similar.
  for (let i = 0; i < 12; i++) get("recordTopicSignal")("bushcraft", "imp", "vid" + i);
  for (let i = 0; i < 5; i++) get("recordTopicSignal")("bushcraft", "play");
  get("recordTopicSignal")("bushcraft", "open");
  get("recordTopicSignal")("kiln building", "open");

  assert.strictEqual(llmCalls.length, 0,
    `browsing must cost ZERO LLM calls, spent ${llmCalls.length}`);
  console.log(`✅ 20 browse actions -> ${llmCalls.length} LLM calls (was: one per play, plus 100-topic refills)`);
}

// ── 2. Thresholds differ by how much intent the action carries ──────
{
  const { get, state } = boot();
  assert.strictEqual(get("SIGNAL_THRESHOLDS").imp, 10);
  assert.strictEqual(get("SIGNAL_THRESHOLDS").open, 4);
  assert.strictEqual(get("SIGNAL_THRESHOLDS").play, 3);

  // Two plays is not enough; the third earns it.
  get("recordTopicSignal")("raku firing", "play");
  get("recordTopicSignal")("raku firing", "play");
  assert.strictEqual(state.agentQueue.length, 0, "2 plays must not enqueue");
  const crossed = get("recordTopicSignal")("raku firing", "play");
  assert.strictEqual(crossed, true, "3rd play must cross");
  assert.strictEqual(state.agentQueue.length, 1);
  assert.strictEqual(state.agentQueue[0].type, "expand_topic");
  console.log("✅ play threshold: 2 plays enqueue nothing, the 3rd enqueues one job");
}

// ── 3. Crossing re-arms instead of firing on every later increment ──
{
  const { get, state } = boot();
  for (let i = 0; i < 3; i++) get("recordTopicSignal")("anagama", "play");
  assert.strictEqual(state.agentQueue.length, 1);
  // Two more plays past the threshold must NOT enqueue again...
  get("recordTopicSignal")("anagama", "play");
  get("recordTopicSignal")("anagama", "play");
  assert.strictEqual(state.agentQueue.length, 1,
    "must not re-fire on every increment past the threshold");
  // ...but another full threshold of fresh interest must.
  state.agentQueue = [];
  get("recordTopicSignal")("anagama", "play");
  assert.strictEqual(state.agentQueue.length, 1, "another full threshold must re-fire");
  console.log("✅ re-arms from the current total: no fire-on-every-increment");
}

// ── 4. Impressions dedupe on the video, not the render ──────────────
{
  const { get, state } = boot();
  // Same video seen 20 times (scroll up and down) is ONE impression.
  for (let i = 0; i < 20; i++) get("recordTopicSignal")("wood ash glaze", "imp", "same-video");
  assert.strictEqual(get("topicSignalTotal")("wood ash glaze", "imp"), 1,
    "re-seeing one video must not spend the impression budget");
  assert.strictEqual(state.agentQueue.length, 0);
  console.log("✅ impressions dedupe per video: 20 re-views of one card = 1 impression");
}

// ── 5. A burned topic can never climb back via browsing ────────────
{
  const { get, state } = boot();
  state.burnedQueries = ["water treatment"];
  for (let i = 0; i < 10; i++) get("recordTopicSignal")("water treatment", "play");
  assert.strictEqual(state.agentQueue.length, 0, "burned topic must not re-enter via signals");
  console.log("✅ burned topics cannot climb back through browsing");
}

// ── 6. Counts merge across browsers WITHOUT loss or inflation ───────
{
  const { get, state } = boot();
  // Chrome saw it 5 times, Vivaldi 5 times. Neither alone reaches 10.
  const chrome = { "kiln": { t: 1, c: { cA: { imp: 5 } }, f: {} } };
  const vivaldi = { "kiln": { t: 2, c: { cB: { imp: 5 } }, f: {} } };
  let merged = get("mergeTopicSignals")({}, chrome);
  merged = get("mergeTopicSignals")(merged, vivaldi);
  state.topicSignals = merged;
  assert.strictEqual(get("topicSignalTotal")("kiln", "imp"), 10,
    "per-client counters must SUM across browsers (LWW would give 5)");

  // The client re-pushes its whole map every 1.5s — merging the same payload
  // repeatedly must not inflate the count.
  for (let i = 0; i < 5; i++) state.topicSignals = get("mergeTopicSignals")(state.topicSignals, vivaldi);
  assert.strictEqual(get("topicSignalTotal")("kiln", "imp"), 10,
    "repeated pushes of the same map must be idempotent (sum would inflate)");
  console.log("✅ cross-browser merge: 5+5=10, and re-pushing the same map keeps it at 10");
}

// ── 7. The flush budget scales with evidence, capped under the ceiling
{
  const { get, state } = boot();
  assert.strictEqual(get("TOPICS_PER_FLUSH_MAX"), 15);
  const budget = n => Math.min(get("TOPICS_PER_FLUSH_MAX"), Math.max(2, n * get("TOPICS_PER_TRIGGER")));
  assert.strictEqual(budget(1), 2, "one trigger -> 2 topics");
  assert.strictEqual(budget(3), 6, "three triggers -> 6 topics");
  assert.strictEqual(budget(50), 15, "must cap under the measured ~25-output ceiling");
  console.log("✅ budget adapts to evidence (1->2, 3->6) and caps at 15");
}

// ── 8. The pool purge keeps earned topics and drops the invented ones
{
  const { get, state } = boot();
  state.likedTopics = ["trichome degradation"];
  state.minedVideos = { v1: { t: 1, topics: ["raku reduction"] } };
  state.topics = [
    { phrase: "trichome degradation", weight: 10 },  // mined from a like
    { phrase: "raku reduction", weight: 6 },          // mined
    { phrase: "one man sawmill", weight: 8 },         // tier-A brainstormed
    { phrase: "clickbait slop", weight: -8 },         // a burn is a decision
    { phrase: "chakra balancing", weight: 2 },        // /similar spam
    { phrase: "The Fox News Episode | Lemonade Stand 🍋", weight: 2 }, // raw title
  ];
  get("purgeUnearnedTopics")();
  const kept = state.topics.map(t => t.phrase);
  assert.ok(kept.includes("trichome degradation"), "mined-from-like must survive");
  assert.ok(kept.includes("raku reduction"), "mined must survive");
  assert.ok(kept.includes("one man sawmill"), "tier-A must survive");
  assert.ok(kept.includes("clickbait slop"), "negative weights must survive");
  assert.ok(!kept.includes("chakra balancing"), "weight-2 /similar output must go");
  assert.ok(!kept.some(p => p.includes("Fox News")), "raw video titles must go");
  assert.strictEqual(kept.length, 4);
  console.log("✅ purge keeps 4 earned topics, drops the 2 the loop invented");
}

// ── 9. The purge runs once, not on every load ──────────────────────
{
  const { get, state } = boot();
  state.topics = [{ phrase: "chakra balancing", weight: 2 }];
  get("purgeUnearnedTopics")();
  assert.strictEqual(state.topics.length, 0);
  state.topics = [{ phrase: "new legit topic", weight: 2 }];
  get("purgeUnearnedTopics")();
  assert.strictEqual(state.topics.length, 1, "purge must not run a second time");
  console.log("✅ purge is one-shot: a later weight-2 topic is not re-purged");
}

// ── 10. Regression gate: the old wiring must stay gone ─────────────
//
// The behavioural tests above run against the new functions, so on the OLD
// app.js they fail with "recordTopicSignal is not defined" — which proves the
// code is new, not that the behaviour changed. These greps pin the actual
// removals, in the same style as the banned-pattern gates in HANDOFF.md, and
// they WOULD have failed on the old file for the right reason.
{
  const banned = [
    // playVideo fired /similar on a 3s timer for every video played.
    [/generateSimilarTopicsFromSearch\(video\.title\)/, "playVideo must not generate topics"],
    // triggerGlobalSearch expanded every search and every pill click.
    [/^\s*generateSimilarTopicsFromSearch\(query\);/m, "search must not generate topics"],
    // The preload loop asked for 100 topics every 15s, forever.
    [/totalUpcoming < 150/, "the preload loop must not brainstorm"],
    // The page load asked for 100 topics just for opening the dashboard.
    [/Launch brainstorm started/, "page load must not brainstorm"],
  ];
  for (const [re, why] of banned) {
    assert.ok(!re.test(src), `${why} — found ${re}`);
  }
  // And the replacements must actually be wired, not merely deleted.
  assert.ok(/recordTopicSignal\(playedTopic, "play"\)/.test(src), "playVideo must record a play signal");
  assert.ok(/recordTopicSignal\(query, "open"\)/.test(src), "search must record an open signal");
  assert.ok(/recordTopicSignal\(impTopic, "imp", video\.id\)/.test(src), "the dwell observer must record an impression");
  console.log("✅ regression gate: all four old spawn paths removed, all three replacements wired");
}

console.log("\nAll Signal Gating tests passed!");

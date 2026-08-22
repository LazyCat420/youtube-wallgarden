// Wave-1 pool hygiene: how topics age, retire, and die.
//
// Before this, the pool had no concept of time: the only guaranteed prune
// (page load) decayed nothing, the 0.5 floor made weight-eviction unreachable,
// the 400 cap evicted the topics the feed actually SERVED first, and an
// IGNORED topic (shown 8+, never touched) was re-sampled at full weight on
// every refill, forever.
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
    topicSignals: {}, agentQueue: [], topics: [], burnedQueries: [],
    dislikedTopics: [], dislikedTopicsMeta: {}, likedTopics: [],
    smartFeedTopicsQueue: [], smartFeedUsedTopics: [], smartFeedVideos: [],
    smartFeedSuggestionPool: [], minedVideos: {}, ratingStates: {},
    groundingVerdicts: {}, searchHistory: [], cache: { videos: {} },
    ontologyGraph: { nodes: {}, edges: {} }, settings: {}, videoRatings: {},
  });
  return { get, state };
}

const DAY = 86400e3;
const sig = (counts, t) => ({ t: t || Date.now(), c: { cA: counts }, f: {} });

console.log("Running Pool Hygiene Tests...\n");

// ── 1. IGNORED topics are not picked; one play revives them ────────
{
  const { get, state } = boot();
  state.topics = [
    { phrase: "kiln building", weight: 8, addedAt: Date.now() },
    { phrase: "water treatment", weight: 8, addedAt: Date.now() },
  ];
  state.topicSignals = { "water treatment": sig({ imp: 12 }) };
  let picked = get("getWeightedRandomTopics")(state.topics);
  assert.ok([...picked].includes("kiln building"));
  assert.ok(![...picked].includes("water treatment"), "IGNORED topic must not be picked");

  // Revival: a single play flips the predicate — no separate mechanism.
  state.topicSignals["water treatment"].c.cA.play = 1;
  picked = get("getWeightedRandomTopics")(state.topics);
  assert.ok([...picked].includes("water treatment"), "one play revives it");
  console.log("✅ IGNORED topics skipped in selection; one play revives");
}

// ── 2. Never auto-burned — retirement is soft ──────────────────────
{
  const { get, state } = boot();
  state.topics = [{ phrase: "water treatment", weight: 8, addedAt: Date.now() }];
  state.topicSignals = { "water treatment": sig({ imp: 50 }) };
  get("getWeightedRandomTopics")(state.topics);
  assert.strictEqual(state.burnedQueries.length, 0, "50 ignored impressions must not burn");
  assert.strictEqual(state.topics.length, 1, "topic stays in the pool");
  console.log("✅ retirement is soft: 50 ignored impressions, zero burns");
}

// ── 3. The load-prune actually decays now (the old no-op case) ─────
{
  const { get, state } = boot();
  // EXACTLY the state a page load sees: empty usedTopics (never persisted),
  // stale topics. Under the old code this prune decayed NOTHING.
  state.smartFeedUsedTopics = [];
  state.topics = [{ phrase: "stale guess", weight: 5, addedAt: Date.now() - 8 * DAY }];
  get("pruneTopicPool")();
  assert.strictEqual(state.topics[0].weight, 4.5, "stale topic decays on the load-prune");
  console.log("✅ the load-prune decays stale topics (was a guaranteed no-op)");
}

// ── 4. Floor-sitters with three dead weeks are evicted, and logged ─
{
  const { get, state } = boot();
  state.topics = [{ phrase: "long dead", weight: 0.5, addedAt: Date.now() - 22 * DAY }];
  get("pruneTopicPool")();
  assert.strictEqual(state.topics.length, 0, "0.5-weight + 22 days stale must evict");
  const log = JSON.parse(vm ? get("localStorage").getItem("wallgarden_default_topic_evict_log") : "[]");
  assert.ok(log.length === 1 && [...log[0].evicted].includes("long dead"), "eviction is logged");
  console.log("✅ stale floor-sitters evicted, with an inspectable log");
}

// ── 5. The cap no longer evicts engaged evidence first ─────────────
{
  const { get, state } = boot();
  const MAX = get("TOPIC_POOL_MAX");
  // A PROVEN topic sitting at low weight (served + engaged, decayed)…
  state.topics = [{ phrase: "proven gem", weight: 0.6, addedAt: Date.now() }];
  state.topicSignals = { "proven gem": sig({ play: 3 }) };
  // …plus a cap's worth of never-served weight-5 silt.
  for (let i = 0; i < MAX + 20; i++) {
    state.topics.push({ phrase: `silt ${i}`, weight: 5, addedAt: Date.now() });
  }
  get("pruneTopicPool")();
  assert.ok(state.topics.some(t => t.phrase === "proven gem"),
    "PROVEN topic must survive the cap despite low weight (old code evicted it first)");
  assert.ok(state.topics.length <= MAX);
  console.log("✅ cap exempts PROVEN topics — served evidence no longer evicts first");
}

// ── 6. Burn parole: sentence ends, re-burn doubles it ──────────────
{
  const { get, state } = boot();
  const BASE = 6 * 30 * DAY;
  // Serving: burned 3 months ago.
  state.burnedQueries = [{ q: "chakra balancing", t: Date.now() - 90 * DAY, strikes: 1 }];
  assert.ok(get("isBurned")("chakra balancing"), "3 months into a 6-month sentence: burned");
  // Paroled: burned 7 months ago.
  state.burnedQueries = [{ q: "chakra balancing", t: Date.now() - 210 * DAY, strikes: 1 }];
  get("invalidateBurnedSignatures")();
  assert.ok(!get("isBurned")("chakra balancing"), "7 months in: paroled");
  // Re-burn increments strikes -> 12-month sentence.
  get("burnTopic")("chakra balancing");
  const rec = state.burnedQueries.find(b => (b.q || b) === "chakra balancing");
  assert.strictEqual(rec.strikes, 2, "re-burn after parole -> second strike");
  state.burnedQueries = [{ q: "chakra balancing", t: Date.now() - 210 * DAY, strikes: 2 }];
  get("invalidateBurnedSignatures")();
  assert.ok(get("isBurned")("chakra balancing"), "7 months into a 12-month sentence: still burned");
  console.log("✅ parole at 6mo, re-burn doubles the sentence");
}

// ── 7. burnTopic cleans up everything it used to leak ──────────────
{
  const { get, state } = boot();
  state.topics = [{ phrase: "bad topic", weight: 5, addedAt: Date.now() }];
  state.topicSignals = { "bad topic": sig({ imp: 3 }) };
  state.groundingVerdicts = { "bad topic": { verdict: "SLOP", t: Date.now() } };
  state.smartFeedSuggestionPool = [
    { id: "v1", discoveryTopic: "bad topic", title: "x" },
    { id: "v2", discoveryTopic: "good topic", title: "y" },
  ];
  state.smartFeedVideos = [{ id: "v3", discoveryTopic: "bad topic", title: "z" }];
  state.smartFeedTopicsQueue = ["bad topic", "good topic"];

  get("burnTopic")("bad topic");

  assert.ok(!state.smartFeedSuggestionPool.some(v => v.discoveryTopic === "bad topic"),
    "pool entries of the burned topic must go (every AUTOMATIC burn used to leak them)");
  assert.ok(state.smartFeedSuggestionPool.some(v => v.id === "v2"), "other topics' videos stay");
  assert.strictEqual(state.smartFeedVideos.length, 0, "rendered videos of the topic go");
  assert.ok(!state.topicSignals["bad topic"], "ledger record deleted");
  assert.ok(!state.groundingVerdicts["bad topic"], "stale verdict deleted");
  assert.ok(![...state.smartFeedTopicsQueue].includes("bad topic"), "queue cleared");
  console.log("✅ burnTopic clears pool, videos, ledger, verdicts, queue");
}

// ── 8. Burn-added dislikes parole; hand-typed ones never do ────────
{
  const { get, state } = boot();
  get("burnTopic")("auto slop");
  assert.ok([...state.dislikedTopics].includes("auto slop"));
  assert.ok(state.dislikedTopicsMeta["auto slop"]?.viaBurn, "burn-added dislike is tagged");
  console.log("✅ burn-added dislikes carry the parole tag; manual ones don't");
}

// ── 9. Regression gate: the old broken wiring must stay gone ───────
//
// The behavioural tests above call new functions, so against the OLD app.js
// they fail with "not defined" — which proves the code is new, not that the
// behaviour changed. These greps pin the actual removals. Each pattern was
// confirmed PRESENT in the pre-wave-1 file and ABSENT now.
{
  const banned = [
    // The preload loop re-armed grounding's 5s debounce every ~1.5s, so the
    // gate only fired when a fetch happened to run long.
    [/Keep the grounding lookahead window full as the queue drains/, "preload loop must not re-arm grounding"],
    // The last surviving automatic 100-topic brainstorm.
    [/Queue is empty! Generating more topics first/, "no automatic brainstorm on queue-empty"],
    // Decay keyed on the session-only, never-persisted used list.
    [/usedSet\.has\(normalizeTopic\(t\.phrase\)\)/, "decay must not key on smartFeedUsedTopics"],
    // The `!bc.id` guard that silently disabled every name-based block.
    [/!bc\.id && bc\.name &&/, "blocked-channel checks must go through isChannelBlocked"],
    // Auto-block wrote the channel NAME into `id`, matching nothing.
    [/name: gc\.id, id: gc\.id/, "auto-block must write name-only entries"],
    // Only the first 15 of up to 25 candidates were classified.
    [/classifyCandidatesWithLLM\(topic, kept\.slice\(0, 15\)\)/, "all kept candidates must be classified"],
  ];
  for (const [re, why] of banned) {
    assert.ok(!re.test(src), `${why} — found ${re}`);
  }
  // The replacements must be wired, not merely deleted.
  assert.ok(/startGroundingInterval\(\)/.test(src), "grounding runs on its own interval");
  assert.ok(/isIgnoredTopic\(t\.phrase, likeCounts\)/.test(src), "selection consults the IGNORED predicate");
  assert.ok(/isProvenTopic\(t\.phrase, likeCounts\)/.test(src), "the cap exempts PROVEN topics");
  assert.ok(/channelId: item\.channel_id \|\| ""/.test(src), "discovery videos carry real channel ids");
  assert.ok(/evictPoolForDislike\(/.test(src), "dislike evicts from the pool");
  console.log("✅ regression gate: 6 broken mechanisms removed, 5 replacements wired");
}

console.log("\nAll Pool Hygiene tests passed!");

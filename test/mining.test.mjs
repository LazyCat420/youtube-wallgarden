// Exercise the liked-video mining loop and the grounding gate out of app.js,
// with the browser + backend stubbed. Pins the contract that likes become
// topics through FOUR sinks (pool, likedTopics, matchedTopics/graph, marker)
// and that mining is idempotent.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const src = fs.readFileSync(
  new URL("../app/app.js", import.meta.url), "utf8");

const stubEl = new Proxy({}, {
  get: (t, k) => k === "classList" ? { add(){}, remove(){}, toggle(){} }
    : k === "dataset" ? {}
    : k === "style" ? {}
    : typeof k === "string" && ["appendChild","addEventListener","removeChild","insertBefore","setAttribute","append","remove","click","focus"].includes(k) ? () => {}
    : k === "children" ? [] : k === "innerHTML" ? "" : undefined,
  set: () => true,
});
const doc = {
  addEventListener: () => {}, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => stubEl, body: stubEl, documentElement: stubEl,
};
const store = new Map();

// Scripted backend: each /api/wallgarden/extract-topics call pops the next
// canned response; everything else 404s.
const fetchLog = [];
let extractResponses = [];
const graphCalls = [];

const ctx = {
  console, document: doc,
  window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: "" } },
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async (url, opts) => {
    fetchLog.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url === "/api/wallgarden/extract-topics" && extractResponses.length) {
      const next = extractResponses.shift();
      return { ok: true, json: async () => next };
    }
    return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
  },
  IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
  AbortSignal: { timeout: () => null },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  graphUpsertNode: (g, label, type, d) => { graphCalls.push(["upsert", label, type, d]); return "n:" + label; },
  graphUpsertEdge: (g, s, t2, type, d) => { graphCalls.push(["edge", s, t2, type]); return "e"; },
  graphPropagateNegative: () => {},
  graphProcessRating: (g, video, delta) => { graphCalls.push(["rating", video.id, [...(video.matchedTopics || [])], delta]); },
  graphScoreVideo: () => 0,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const get = (name) => vm.runInContext(name, ctx);
const S = get("state");
const mineLikedVideosIntoTopics = get("mineLikedVideosIntoTopics");
const collectUnminedLikes = get("collectUnminedLikes");
const applyGroundingVerdict = get("applyGroundingVerdict");

const fresh = () => ({
  topics: [{ phrase: "existing topic", weight: 5 }],
  likedTopics: [], dislikedTopics: [], burnedQueries: [], searchHistory: [],
  smartFeedTopicsQueue: [], smartFeedUsedTopics: [],
  ontologyGraph: { nodes: {}, edges: {} },
  cache: { videos: {} }, smartFeedVideos: [], smartFeedSuggestionPool: [],
  minedVideos: {}, tasteProfile: null, groundingVerdicts: {},
  videoRatings: {}, likedVideos: [], settings: { groundingEnabled: true },
  ratingStates: {
    vid1: { r: 5, t: 100, v: { title: "I Built a Sawmill From an Old Bandsaw", channelName: "WoodWorkWes" } },
    vid2: { r: 5, t: 200, v: { title: "Restoring a 1950s Lathe", channelName: "ShopRescue" } },
    ghost: { r: 5, t: 300, v: { title: "Liked Video (Synced)", channelName: "YouTube Curation" } },
    dis1: { r: -5, t: 400, v: { title: "bad video", channelName: "X" } },
  },
});
const reset = (o) => {
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, o);
  graphCalls.length = 0;
  fetchLog.length = 0;
  store.clear();
};

// ── 1. mining feeds all four sinks ────────────────────────────────
reset(fresh());
// Pre-burn one topic the extractor will return: it must never enter.
S.burnedQueries.push("burned niche");
extractResponses = [{
  extractions: [
    { id: "vid1", topics: [
      { topic: "one man sawmill", tier: "A", weight: 8 },
      { topic: "burned niche", tier: "A", weight: 8 },
    ] },
    { id: "vid2", topics: [{ topic: "machine restoration", tier: "B", weight: 4 }] },
  ],
}];
await mineLikedVideosIntoTopics();

// Sink 1: topic pool with tier+2 weights
const pool = Object.fromEntries(S.topics.map(t => [t.phrase, t.weight]));
assert.strictEqual(pool["one man sawmill"], 10, "A-tier mined topic enters at 10");
assert.strictEqual(pool["machine restoration"], 6, "B-tier mined topic enters at 6");
assert.ok(!("burned niche" in pool), "burned topic never re-enters");
assert.ok(S.smartFeedTopicsQueue.includes("one man sawmill"), "mined topic queued");
// Sink 2: likedTopics gets A-tier only
assert.ok(S.likedTopics.includes("one man sawmill"), "A-tier lands in likedTopics");
assert.ok(!S.likedTopics.includes("machine restoration"), "B-tier stays out of likedTopics");
// Sink 3: matchedTopics backfilled WITHOUT touching t; graph rating fired
assert.deepStrictEqual([...S.ratingStates.vid1.v.matchedTopics], ["one man sawmill"]);
assert.strictEqual(S.ratingStates.vid1.t, 100, "t must NOT be bumped by enrichment");
const ratingCalls = graphCalls.filter(c => c[0] === "rating");
assert.strictEqual(ratingCalls.length, 2, "one graph rating per mined video");
assert.deepStrictEqual(ratingCalls[0][2], ["one man sawmill"]);
// Sink 4: idempotence markers (ghost placeholder + dislike untouched)
assert.ok(S.minedVideos.vid1 && S.minedVideos.vid2, "both likes marked mined");
assert.ok(!S.minedVideos.ghost && !S.minedVideos.dis1, "placeholder + dislike not mined");
console.log("✅ mining feeds pool/likedTopics/graph/marker, skips burned");

// ── 2. idempotent: second run makes no backend call ───────────────
extractResponses = [];
fetchLog.length = 0;
await mineLikedVideosIntoTopics();
assert.strictEqual(fetchLog.length, 0, "nothing unmined -> no fetch");
assert.strictEqual(collectUnminedLikes().length, 0);
console.log("✅ mining is idempotent");

// ── 3. chunking respects the 8-video ceiling ──────────────────────
{
  const many = fresh();
  many.ratingStates = {};
  for (let i = 0; i < 11; i++) {
    many.ratingStates["v" + i] = { r: 5, t: i, v: { title: "video " + i, channelName: "C" + i } };
  }
  reset(many);
  extractResponses = [{ extractions: [] }, { extractions: [] }];
  await mineLikedVideosIntoTopics();
  const calls = fetchLog.filter(f => f.url === "/api/wallgarden/extract-topics");
  assert.strictEqual(calls.length, 2, "11 likes -> 2 chunks");
  assert.strictEqual(calls[0].body.videos.length, 8, "first chunk is 8");
  assert.strictEqual(calls[1].body.videos.length, 3, "second chunk is 3");
  // Failed extraction leaves them unmined for a later retry
  assert.strictEqual(collectUnminedLikes().length, 11, "no extraction -> still unmined");
  console.log("✅ mining chunks at 8 and leaves failures unmined");
}

// ── 4. grounding verdicts: demote, then burn on second strike ─────
reset(fresh());
S.topics.push({ phrase: "hazard analysis", weight: 6 });
S.smartFeedTopicsQueue = ["hazard analysis", "one man sawmill"];

applyGroundingVerdict("hazard analysis", "SLOP");
assert.ok(!S.smartFeedTopicsQueue.includes("hazard analysis"), "SLOP pulled from queue");
assert.strictEqual(S.topics.find(t => t.phrase === "hazard analysis").weight, 0.5, "first strike demotes");
assert.strictEqual(S.groundingVerdicts["hazard analysis"].verdict, "SLOP");

applyGroundingVerdict("hazard analysis", "SLOP");
assert.ok(!S.topics.some(t => t.phrase === "hazard analysis"), "second strike burns");
assert.ok(S.burnedQueries.includes("hazard analysis"), "burn recorded");
console.log("✅ grounding SLOP: demote first, burn on second strike");

// ── 5. grounding REAL: evidence bonus ─────────────────────────────
reset(fresh());
S.topics.push({ phrase: "one man sawmill", weight: 8 });
applyGroundingVerdict("one man sawmill", "REAL");
assert.strictEqual(S.topics.find(t => t.phrase === "one man sawmill").weight, 10, "REAL adds +2");
console.log("✅ grounding REAL: +2 evidence bonus");

console.log("\nAll mining tests passed.");

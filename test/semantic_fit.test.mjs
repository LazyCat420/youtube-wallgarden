// Comprehensive tests for intent-aware retrieval, novelty rejection,
// and semantic candidate classification gating in YouTube Wallgarden.
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

const ctx = {
  console, document: doc,
  window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: "" } },
  setTimeout, clearTimeout, setInterval,
  clearInterval, fetch: async () => ({ ok: false, json: async () => ({}) }),
  IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
  AbortSignal: { timeout: () => null },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  graphUpsertNode: () => "n:x",
  graphPropagateNegative: () => {},
  graphScoreVideo: () => 0,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const get = (name) => vm.runInContext(name, ctx);
const S = get("state");
const scoreDiscoveryVideo = get("scoreDiscoveryVideo");
const getTopicPolicy = get("getTopicPolicy");

const DAY = 86400e3;

console.log("Running Semantic Fit & Novelty Rejection Tests...\n");

// ── 1. The LEGO Fish-Tank Regression ──────────────────────────────
// A 15M-view LEGO fish tank video must score significantly below a
// 150k-view genuine aquascaping tutorial for the topic "fish tanks".
{
  const legoFishTank = {
    id: "lego_tank_1",
    title: "I Made a Functioning Fish Tank Entirely From LEGO",
    channelName: "BrickMaster",
    published: Date.now() - 500 * DAY, // mature (~1.5 years old)
    duration: 1200,                    // 20 min
    viewCount: 15000000,               // 15M views
    _fetchRank: 0,
  };

  const realAquariumGuide = {
    id: "real_tank_1",
    title: "Planted Aquarium Aquascaping Setup & Filtration Guide",
    channelName: "GreenAqua",
    published: Date.now() - 300 * DAY, // mature (~10 months old)
    duration: 1100,                    // 18 min
    viewCount: 150000,                 // 150k views
    _fetchRank: 2,
  };

  const ctxFishTanks = { topic: "fish tanks", likedChannels: new Set() };
  const legoScore = scoreDiscoveryVideo(legoFishTank, ctxFishTanks).score;
  const realScore = scoreDiscoveryVideo(realAquariumGuide, ctxFishTanks).score;

  assert.ok(
    realScore > legoScore,
    `Real aquarium guide (${realScore}) must outrank 15M-view LEGO fish tank (${legoScore})`
  );
  console.log(`✅ [Regression] Real aquarium (${realScore.toFixed(2)}) outranks viral LEGO build (${legoScore.toFixed(2)})`);
}

// ── 2. Explicit Policy Exclusion Filtering ────────────────────────
// When a topic has custom excluded facets, any video title containing
// those facets receives severe penalty.
{
  S.topicPolicies["woodworking"] = {
    phrase: "woodworking",
    intent: "traditional hand tool woodworking and joinery",
    includeFacets: ["joinery", "hand plane", "dovetail", "timber framing"],
    excludeFacets: ["resin table", "epoxy", "cnc router"],
  };

  const resinTable = {
    id: "resin_1",
    title: "I Poured 50 Gallons of Glowing Epoxy Resin on Wood Table",
    channelName: "ViralDIY",
    published: Date.now() - 200 * DAY,
    duration: 900,
    viewCount: 8000000,
    _fetchRank: 0,
  };

  const handJoinery = {
    id: "joinery_1",
    title: "Traditional Japanese Hand Tool Woodworking & Dovetail Joinery",
    channelName: "KannaWood",
    published: Date.now() - 200 * DAY,
    duration: 900,
    viewCount: 80000,
    _fetchRank: 1,
  };

  const ctxWood = { topic: "woodworking", likedChannels: new Set() };
  const resinScore = scoreDiscoveryVideo(resinTable, ctxWood).score;
  const joineryScore = scoreDiscoveryVideo(handJoinery, ctxWood).score;

  assert.ok(
    joineryScore > resinScore,
    `Hand joinery (${joineryScore}) must outrank excluded epoxy resin table (${resinScore})`
  );
  console.log(`✅ [Policy Exclusions] Excluded facet matches (epoxy resin) penalized heavily`);
}

// ── 3. Semantic Classification Priority ───────────────────────────
// Videos classified as ON_TOPIC must strictly beat NOVELTY and OFF_TOPIC.
{
  const onTopicVideo = {
    id: "on_1",
    title: "Modular Synthesis Patch Design Explained",
    _classification: "ON_TOPIC",
    duration: 600,
    viewCount: 50000,
  };

  const noveltyVideo = {
    id: "nov_1",
    title: "I Built a Giant Playable Synth Out of Cardboard and Lasers",
    _classification: "NOVELTY",
    duration: 600,
    viewCount: 5000000,
  };

  const offTopicVideo = {
    id: "off_1",
    title: "Corporate Merger and Synthesis of Business Assets",
    _classification: "OFF_TOPIC",
    duration: 600,
    viewCount: 100000,
  };

  const ctxSynth = { topic: "synthesis", likedChannels: new Set() };
  const onScore = scoreDiscoveryVideo(onTopicVideo, ctxSynth).score;
  const novScore = scoreDiscoveryVideo(noveltyVideo, ctxSynth).score;
  const offScore = scoreDiscoveryVideo(offTopicVideo, ctxSynth).score;

  assert.ok(onScore > novScore, "ON_TOPIC must outrank NOVELTY");
  assert.ok(onScore > offScore, "ON_TOPIC must outrank OFF_TOPIC");
  console.log(`✅ [Classification] ON_TOPIC (${onScore.toFixed(2)}) > NOVELTY (${novScore.toFixed(2)}) > OFF_TOPIC (${offScore.toFixed(2)})`);
}

// ── 4. Built-in Topic Policies Loaded Correctly ───────────────────
{
  const fishPolicy = getTopicPolicy("fish tanks");
  assert.strictEqual(fishPolicy.scope, "broad");
  assert.ok(fishPolicy.includeFacets.includes("aquascaping"));
  assert.ok(fishPolicy.excludeFacets.includes("lego"));

  const synthPolicy = getTopicPolicy("synthesis");
  assert.ok(synthPolicy.includeFacets.includes("modular synth"));
  assert.ok(synthPolicy.excludeFacets.includes("corporate merger"));
  console.log("✅ [Policy Retrieval] Built-in starter policies resolve correctly");
}

console.log("\nAll Semantic Fit & Novelty Rejection tests passed!\n");

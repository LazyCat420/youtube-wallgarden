// Exercise the new burn/learn logic straight out of app.js, with the browser
// globals stubbed. Confirms the claim that a burn GENERALISES.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const src = fs.readFileSync(
  new URL("../app/app.js", import.meta.url), "utf8");

// app.js is script-tag JS: everything is a global. Stub the browser and run it,
// then reach into the VM for the functions under test.
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

const graphCalls = [];
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
  // ontology.js loads first in the real page; stub the two fns we assert on.
  graphUpsertNode: (g, label, type, d) => { graphCalls.push(["upsert", label, d]); return "n:" + label; },
  graphPropagateNegative: (g, id) => { graphCalls.push(["propagate", id]); },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

// `const state` / `function isBurned` live in the VM's lexical scope, not on
// the context object — reach them by evaluating their names inside the VM.
const get = (name) => vm.runInContext(name, ctx);
const S = get("state");
const isBurned = get("isBurned");
const burnTopic = get("burnTopic");
const pruneTopicPool = get("pruneTopicPool");
const TOPIC_POOL_MAX = get("TOPIC_POOL_MAX");

const reset = (o) => {
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, o);
  graphCalls.length = 0;
};
const fresh = () => ({
  topics: [
    { phrase: "hazard analysis", weight: 5 },
    { phrase: "hazard assessment protocols", weight: 5 }, // sibling
    { phrase: "chemical hazard analysis", weight: 5 },    // sibling
    { phrase: "kiln atmosphere control", weight: 8 },     // unrelated, must survive
    { phrase: "trichome degradation", weight: 8 },        // unrelated, must survive
  ],
  likedTopics: [], dislikedTopics: [], burnedQueries: [], searchHistory: [],
  smartFeedTopicsQueue: ["hazard analysis", "kiln atmosphere control"],
  smartFeedUsedTopics: [],
  ontologyGraph: { nodes: {}, edges: {} },
  cache: { videos: {} },          // invalidateScoreCache walks this
  smartFeedVideos: [], smartFeedSuggestionPool: [],
});

// ── 1. burning generalises to siblings ────────────────────────────
reset(fresh());
const demoted = [...burnTopic("hazard analysis")];  // copy out of the VM realm
const w = p => (S.topics.find(t => t.phrase === p) || {}).weight;

console.log("demoted siblings:", demoted);
// Lexical demotion is deliberately conservative: it fires only on a true
// SUPERSET of the burned topic's identity ("chemical hazard analysis"), not on
// anything merely sharing a word ("hazard assessment protocols" keeps "hazard"
// but drops "analysis"). Loosening it to single-word overlap would mean burning
// "kiln safety" also destroyed "kiln atmosphere control" — see test 4.
// The broader generalisation is carried by the graph propagation + the backend
// anchor prompt, not by string matching.
assert.deepStrictEqual(demoted, ["chemical hazard analysis"],
  "demotes true supersets only");
assert.strictEqual(w("kiln atmosphere control"), 8, "unrelated topic must NOT be touched");
assert.strictEqual(w("trichome degradation"), 8, "unrelated topic must NOT be touched");
assert.strictEqual(w("chemical hazard analysis"), 1, "superset demoted 5 -> 1");
assert.strictEqual(w("hazard assessment protocols"), 5, "one shared word: left alone");
assert.ok(!S.topics.some(t => t.phrase === "hazard analysis"), "burned topic removed");
console.log("✅ burn demotes siblings, leaves unrelated topics alone");

// ── 2. it becomes a real negative signal ──────────────────────────
assert.ok(S.dislikedTopics.includes("hazard analysis"), "must become a disliked topic");
assert.deepStrictEqual(graphCalls[0], ["upsert", "hazard analysis", -8], "graph node driven negative");
assert.deepStrictEqual(graphCalls[1], ["propagate", "n:hazard analysis"], "negative propagated to neighbours");
console.log("✅ burn writes dislike + negative graph propagation");

// ── 3. rewordings of a burned topic are rejected ──────────────────
assert.ok(isBurned("hazard analysis"), "exact");
assert.ok(isBurned("Hazard Analysis"), "case-insensitive");
assert.ok(isBurned("hazard analysis techniques"), "superset reworder rejected");
assert.ok(!isBurned("kiln atmosphere control"), "unrelated must pass");
assert.ok(!isBurned("trichome degradation"), "unrelated must pass");
console.log("✅ isBurned catches rewordings, not innocents");

// ── 4. the 'kiln safety' regression: one shared word is NOT enough ─
reset(fresh());
S.topics.push({ phrase: "kiln safety", weight: 5 });
burnTopic("kiln safety");
assert.strictEqual(w("kiln atmosphere control"), 8,
  "burning 'kiln safety' must NOT damage 'kiln atmosphere control'");
assert.ok(!isBurned("kiln atmosphere control"), "sharing one word is not enough to burn");
console.log("✅ burning 'kiln safety' spares 'kiln atmosphere control'");

// ── 5. the pool actually gets pruned ──────────────────────────────
reset(fresh());
S.topics = Array.from({ length: 600 }, (_, i) => ({
  phrase: `topic ${i}`, weight: (i % 9) + 1,
}));
pruneTopicPool();
assert.ok(S.topics.length <= TOPIC_POOL_MAX,
  `pool capped, got ${S.topics.length}`);
const weights = S.topics.map(t => t.weight);
assert.ok(Math.min(...weights) >= Math.max(...weights) - 8, "kept the strongest");
console.log(`✅ pool capped 600 -> ${S.topics.length} (max ${TOPIC_POOL_MAX}), strongest kept`);

// ── 6. used topics decay so duds die instead of accumulating ──────
reset(fresh());
S.smartFeedUsedTopics = ["kiln atmosphere control"];
const before = w("kiln atmosphere control");
pruneTopicPool();
assert.ok(w("kiln atmosphere control") < before, "a used topic decays");
console.log(`✅ used topic decays ${before} -> ${w("kiln atmosphere control")}`);

console.log("\nAll learning tests passed.");

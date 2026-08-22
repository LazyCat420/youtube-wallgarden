// Derivation of MEASURED outcomes from the signal ledger.
//
// The valuable class is `ignored`: topics a previous run of this same prompt
// produced, that the user was shown again and again and never touched. The user
// never rejected them by hand, so they appear in no blacklist — only the
// counters know they failed. These tests pin that definition, because loosening
// it turns the block into noise and tightening it makes it always empty.
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
    smartFeedUsedTopics: [], smartFeedTopicsQueue: [], queue: [],
    ontologyGraph: { nodes: {}, edges: {} }, settings: {}, searchHistory: [],
  });
  return { get, state, ctx };
}

/** Build a ledger entry with the given per-kind counts. */
const sig = (counts) => ({ t: 1, c: { cA: counts }, f: {} });

console.log("Running Topic Outcome Tests...\n");

// ── 1. A topic the user played repeatedly is PROVEN ────────────────
{
  const { get, state } = boot();
  state.topicSignals = { "one man sawmill": sig({ imp: 6, play: 4 }) };
  const o = get("buildTopicOutcomes")();
  assert.strictEqual(o.proven.length, 1);
  assert.strictEqual(o.proven[0].t, "one man sawmill");
  assert.strictEqual(o.proven[0].plays, 4);
  console.log("✅ repeatedly played -> proven");
}

// ── 2. Shown a lot, never touched, is IGNORED ──────────────────────
{
  const { get, state } = boot();
  state.topicSignals = { "water treatment": sig({ imp: 12 }) };
  const o = get("buildTopicOutcomes")();
  assert.strictEqual(o.ignored.length, 1);
  assert.strictEqual(o.ignored[0].t, "water treatment");
  assert.strictEqual(o.ignored[0].shown, 12);
  assert.strictEqual(o.proven.length, 0);
  console.log("✅ shown 12x, never played -> ignored (the MEASURED failure)");
}

// ── 3. One click rescues it from the ignored list ──────────────────
{
  const { get, state } = boot();
  state.topicSignals = { "water treatment": sig({ imp: 12, open: 1 }) };
  const o = get("buildTopicOutcomes")();
  assert.strictEqual(o.ignored.length, 0, "any deliberate action must clear the ignored verdict");
  console.log("✅ a single open clears the ignored verdict — it is not a shown-count blacklist");
}

// ── 4. Not enough impressions is not a verdict ─────────────────────
{
  const { get, state } = boot();
  state.topicSignals = { "raku firing": sig({ imp: 3 }) };
  const o = get("buildTopicOutcomes")();
  assert.strictEqual(o.ignored.length, 0, "3 impressions is not evidence of failure");
  assert.strictEqual(o.proven.length, 0);
  console.log("✅ 3 impressions yields no verdict either way");
}

// ── 5. A like proves a topic even with no browsing signal ──────────
{
  const { get, state } = boot();
  state.ratingStates = {
    v1: { r: 5, t: 1, v: { id: "v1", title: "Ash glaze", matchedTopics: ["wood ash glaze"] } },
    v2: { r: 5, t: 2, v: { id: "v2", title: "More ash", discoveryTopic: "wood ash glaze" } },
    v3: { r: -5, t: 3, v: { id: "v3", title: "nope", matchedTopics: ["wood ash glaze"] } },
  };
  const o = get("buildTopicOutcomes")();
  const p = o.proven.find(x => x.t === "wood ash glaze");
  assert.ok(p, "a liked topic must appear as proven");
  assert.strictEqual(p.likes, 2, "dislikes must not count as likes");
  console.log("✅ likes attribute to topics (2 likes, dislike excluded)");
}

// ── 6. Burned topics stay out of both lists ────────────────────────
{
  const { get, state } = boot();
  state.burnedQueries = ["water treatment"];
  state.topicSignals = { "water treatment": sig({ imp: 20 }) };
  const o = get("buildTopicOutcomes")();
  assert.strictEqual(o.ignored.length, 0, "burnedQueries already carries it — don't say it twice");
  console.log("✅ burned topics excluded (burnedQueries already covers them)");
}

// ── 7. Grounding SLOP verdicts are recycled, not discarded ─────────
{
  const { get, state } = boot();
  state.groundingVerdicts = {
    "hazard analysis": { verdict: "SLOP", t: 2 },
    "one man sawmill": { verdict: "REAL", t: 3 },
    "dead thing": { verdict: "DEAD", t: 1 },
  };
  const o = get("buildTopicOutcomes")();
  // Copy out of the VM realm first — a vm-realm Array is not reference-equal
  // to a host Array, which deepStrictEqual checks. Same trap as mining.test.mjs.
  assert.deepStrictEqual([...o.slop].sort(), ["dead thing", "hazard analysis"]);
  console.log("✅ SLOP/DEAD verdicts recycled into the prompt; REAL excluded");
}

// ── 8. The block is withheld until there is enough evidence ────────
{
  const { get, state } = boot();
  state.topicSignals = { "a": sig({ imp: 12 }) };
  let o = get("buildTopicOutcomes")();
  assert.strictEqual(get("hasUsableOutcomes")(o), false, "1 item is not evidence");

  state.topicSignals = { a: sig({ imp: 12 }), b: sig({ imp: 12 }), c: sig({ imp: 12 }) };
  o = get("buildTopicOutcomes")();
  assert.strictEqual(get("hasUsableOutcomes")(o), true, "3 items clears the bar");
  console.log("✅ withheld below 3 items, sent at 3 — a new account gets the plain prompt");
}

// ── 9. failedExamples stops duplicating burnedQueries ──────────────
{
  const { get, state } = boot();
  state.burnedQueries = ["burn one", "burn two"];
  state.topicSignals = { a: sig({ imp: 12 }), b: sig({ imp: 12 }), c: sig({ imp: 12 }) };
  const c = get("buildOutcomeContext")();
  assert.strictEqual(c.promptVariant, "stats");
  assert.ok(!c.failedExamples.includes("burn one"),
    "failedExamples must carry MEASURED failures, not a copy of burnedQueries");
  assert.deepStrictEqual([...c.failedExamples].sort(), ["a", "b", "c"]);
  console.log("✅ failedExamples now carries measured-ignored, not a copy of burnedQueries");
}

// ── 10. The toggle actually switches arms, and stamps provenance ───
{
  const { get, state } = boot();
  state.burnedQueries = ["burn one", "burn two"];
  state.topicSignals = { a: sig({ imp: 12 }), b: sig({ imp: 12 }), c: sig({ imp: 12 }) };

  state.settings.statsPromptEnabled = true;
  let c = get("buildOutcomeContext")();
  assert.strictEqual(c.promptVariant, "stats");
  assert.ok(c.topicOutcomes, "stats arm must carry the outcomes");

  state.settings.statsPromptEnabled = false;
  c = get("buildOutcomeContext")();
  assert.strictEqual(c.promptVariant, "flat");
  assert.strictEqual(c.topicOutcomes, undefined, "flat arm must send NO outcomes");
  assert.deepStrictEqual([...c.failedExamples], ["burn one", "burn two"]);
  console.log("✅ toggle switches arms cleanly — the A/B is actually runnable");
}

// ── 11. The context still carries everything it did before ─────────
{
  const { get, state } = boot();
  state.topics = [{ phrase: "ceramics", weight: 8 }];
  const ctx = get("buildLlmContext")();
  for (const k of ["interests", "disliked", "recentUsed", "burnedQueries", "searches",
                   "likedVideos", "watchlist", "likedClusters", "failedExamples"]) {
    assert.ok(k in ctx, `buildLlmContext must still provide ${k}`);
  }
  console.log("✅ existing context fields all intact — the block is additive");
}

console.log("\nAll Topic Outcome tests passed!");

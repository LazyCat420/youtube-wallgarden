// Phase A3 anti-stickiness (plan §4.3-4.4): near-duplicate collapse at every
// insert site, and the daily explore drip from the top like-mined seed.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const now = Date.now();

console.log("Running Topic Dedupe Tests...\n");

// 1. findNearDuplicateTopic: Jaccard >= 0.8, cluster guard, negatives.
{
  const { get, state } = boot();
  const fnd = get("findNearDuplicateTopic");
  state.topics = [
    { phrase: "woodworking hand tools", weight: 10, origin: "like-mined" },
    { phrase: "pottery wheel throwing", weight: 5, origin: "brainstorm", cluster: "ceramics" },
  ];
  assert.strictEqual(fnd("Hand Woodworking Tools").phrase, "woodworking hand tools",
    "token-set Jaccard 1.0 across word order and case");
  assert.strictEqual(fnd("wheel pottery throwing").phrase, "pottery wheel throwing",
    "no cluster on the incoming phrase -> compare globally");
  assert.strictEqual(fnd("wheel pottery throwing", { cluster: "metals" }), null,
    "both carry a cluster and they differ -> not a duplicate");
  assert.strictEqual(fnd("wheel pottery throwing", { cluster: "ceramics" }).phrase, "pottery wheel throwing",
    "same cluster still matches");
  assert.strictEqual(fnd("cast iron skillet care"), null, "unrelated phrase is not a duplicate");
  assert.strictEqual(fnd("the a an of"), null, "stopword-only signature never matches");

  const neg = boot();
  neg.state.topics = [{ phrase: "woodworking tools", weight: -3, origin: "brainstorm" }];
  assert.strictEqual(neg.get("findNearDuplicateTopic")("woodworking tools"), null,
    "negatives are user decisions — never merge into them");
  console.log("✅ findNearDuplicateTopic: Jaccard, cluster guard, negative guard");
}

// 2. Brainstorm insert site: near-duplicate merges into the like-mined
// survivor (weight max, origin never downgraded); novel topics still land.
{
  const { get, state, ctx } = boot({ fetch: async () => ({
    ok: true,
    json: async () => ({ rated: [
      { topic: "Hand Woodworking Tools", weight: 9 },
      { topic: "Beekeeping Basics", weight: 7 },
    ] }),
  }) });
  ctx.document.getElementById = () => ({ textContent: "", classList: { add() {}, remove() {}, toggle() {} }, style: {}, dataset: {}, appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {} });
  ctx.setTimeout = () => 0;
  const survivorAddedAt = now - 86400e3;
  state.topics = [{ phrase: "woodworking hand tools", weight: 12, origin: "like-mined", addedAt: survivorAddedAt, role: "core", bornRole: "core" }];
  state.brainstormLoading = false;
  await get("generateBrainstormTopics")(true, 1);

  assert.strictEqual(state.topics.length, 2, "no second string for the lookalike");
  const survivor = state.topics.find(t => t.phrase === "woodworking hand tools");
  assert.strictEqual(survivor.weight, 12, "weight = max(existing, brainstorm insert)");
  assert.strictEqual(survivor.origin, "like-mined", "earned origin never downgraded to brainstorm");
  assert.ok(survivor.addedAt > survivorAddedAt, "addedAt refreshed (field existed)");
  assert.ok(!("lastSeenAt" in survivor), "no lastSeenAt invented on a record that lacked it");
  const novel = state.topics.find(t => t.phrase === "beekeeping basics");
  assert.ok(novel && novel.origin === "brainstorm", "a genuinely new topic still enters");
  assert.strictEqual(novel.weight, 6, "capped at BRAINSTORM_WEIGHT_CAP");
  assert.ok(state.smartFeedTopicsQueue.includes("woodworking hand tools"), "queue targets the survivor");
  console.log("✅ brainstorm insert collapses into the like-mined survivor");
}

// 3. Mined near-duplicate promotion: the survivor becomes like-mined core and
// minedVideos records the EXISTING phrase so replay dedupes the same way.
{
  const { get, state } = boot();
  state.topics = [{ phrase: "woodworking hand tools", weight: 4, origin: "brainstorm", addedAt: now, role: "adjacent", bornRole: "adjacent" }];
  state.ratingStates = { vid1: { r: 5, t: now, v: { title: "My favourite build", matchedTopics: [], discoveryTopic: "woodworking hand tools" } } };
  const added = get("applyMinedTopics")("vid1", [{ topic: "Hand Woodworking Tools", tier: "A" }]);
  assert.strictEqual(added, 0, "no second topic inserted");
  assert.strictEqual(state.topics.length, 1);
  const promoted = state.topics[0];
  assert.strictEqual(promoted.origin, "like-mined", "mined phrase promotes the survivor");
  assert.strictEqual(promoted.role, "core");
  assert.strictEqual(promoted.bornRole, "core");
  assert.strictEqual(promoted.weight, 10, "max(existing 4, mined A weight 10)");
  assert.deepStrictEqual(plain(state.minedVideos.vid1.topics), ["woodworking hand tools"],
    "minedVideos stores the EXISTING phrase -> replay dedupes");
  assert.ok(state.likedTopics.includes("woodworking hand tools"), "A-tier lands in likedTopics under the survivor phrase");
  assert.ok(state.smartFeedTopicsQueue.includes("woodworking hand tools"));

  // Replay the same extraction: exact match now, still one topic.
  const again = get("applyMinedTopics")("vid1", [{ topic: "Hand Woodworking Tools", tier: "A" }]);
  assert.strictEqual(again, 0);
  assert.strictEqual(state.topics.length, 1, "replay dedupes to the same single string");
  console.log("✅ mined near-duplicate promotes the survivor; replay stays deduped");
}

// 4. Hand-add merge contract: hand wins generated origins, never an earned one.
{
  const { get, state } = boot();
  const gen = { phrase: "beekeeping basics", weight: 3, origin: "brainstorm" };
  const like = { phrase: "sourdough baking", weight: 12, origin: "like-mined" };
  state.topics = [gen, like];
  get("mergeNearDuplicateTopic")(gen, { phrase: "beehive keeping basics", weight: 7, origin: "hand" });
  assert.strictEqual(gen.origin, "hand", "hand wins over a generated origin");
  assert.strictEqual(gen.weight, 7, "weight max");
  get("mergeNearDuplicateTopic")(gen, { phrase: "bee hive management", weight: 4, origin: "brainstorm" });
  assert.strictEqual(gen.origin, "hand", "generated never downgrades an earned origin");
  assert.strictEqual(gen.weight, 7, "weight never lowers");
  get("mergeNearDuplicateTopic")(like, { phrase: "sourdough starter care", weight: 16, origin: "brainstorm" });
  assert.strictEqual(like.origin, "like-mined", "like-mined survives a brainstorm merge");
  assert.strictEqual(like.weight, 16, "max wins regardless of origin direction");
  assert.ok(!("lastSeenAt" in gen) && !("lastSeenAt" in like), "lastSeenAt only refreshed when already present");
  console.log("✅ mergeNearDuplicateTopic origin/weight rules");
}

// 5. Explore drip: once per 24 h, needs a like-mined seed, offline-safe,
// never throws, children born explore/seed.
{
  const calls = [];
  const { get, state, ctx, store } = boot({ fetch: async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => ({ topics: ["woodworking finishing techniques"] }) };
  } });
  ctx.setTimeout = () => 0;
  // Keep the pool full so generateTopicsForSeeds' preload kick is a no-op.
  state.smartFeedSuggestionPool = Array.from({ length: 200 }, (_, i) => ({ id: "pool" + i }));

  const drip = get("maybeRunExploreDrip");

  // No like-mined seed -> no-op (and no 24 h stamp burned).
  state.topics = [{ phrase: "beekeeping basics", weight: 5, origin: "brainstorm" }];
  assert.strictEqual(await drip(), false, "no seed -> no-op");
  assert.strictEqual(calls.filter(c => c.url.includes("/similar")).length, 0, "no LLM call without a seed");
  assert.ok(!state.exploreDripAt, "stamp only set when the drip actually ran");

  // Offline -> skip even with a seed.
  state.topics.push({ phrase: "woodworking hand tools", weight: 12, origin: "like-mined", addedAt: now, role: "core", bornRole: "core" });
  ctx.navigator = { onLine: false };
  assert.strictEqual(await drip(), false, "offline -> skip");
  assert.strictEqual(calls.filter(c => c.url.includes("/similar")).length, 0);
  delete ctx.navigator;

  // Runs: strongest like-mined seed, 3-topic budget, children born explore.
  state.topics.push({ phrase: "tiny seed", weight: 6, origin: "like-mined", addedAt: now });
  assert.strictEqual(await drip(), true, "runs with a like-mined seed");
  const call = calls.find(c => c.url.includes("/similar"));
  assert.ok(call, "POSTs /api/wallgarden/similar");
  assert.deepStrictEqual(call.body.seeds, ["woodworking hand tools"], "highest-weight like-mined topic seeds the batch");
  assert.strictEqual(call.body.numTopics, 3, "budget of 3");
  const child = state.topics.find(t => t.phrase === "woodworking finishing techniques");
  assert.ok(child, "lateral topic inserted");
  assert.strictEqual(child.origin, "seed");
  assert.strictEqual(child.bornRole, "explore");
  assert.strictEqual(child.role, "explore");
  assert.strictEqual(child.parent, "woodworking hand tools");
  assert.ok(state.exploreDripAt > 0, "24 h stamp set");
  assert.ok(store.get("wallgarden_default_explore_drip_at"), "stamp persisted (explore_drip_at)");

  // Immediate second call -> gated by the 24 h stamp.
  assert.strictEqual(await drip(), false, "once per 24 h");
  assert.strictEqual(calls.filter(c => c.url.includes("/similar")).length, 1);

  // Yesterday's stamp -> runs again.
  state.exploreDripAt = now - 25 * 3600e3;
  assert.strictEqual(await drip(), true, "runs again after 24 h");

  // Backend down -> returns false, never throws into the caller.
  state.exploreDripAt = 0;
  const failing = boot({ fetch: async () => { throw new Error("backend down"); } });
  failing.ctx.setTimeout = () => 0;
  failing.state.smartFeedSuggestionPool = Array.from({ length: 200 }, (_, i) => ({ id: "pool" + i }));
  failing.state.topics = [{ phrase: "woodworking hand tools", weight: 12, origin: "like-mined", addedAt: now }];
  assert.strictEqual(await failing.get("maybeRunExploreDrip")(), false, "failure is swallowed");
  console.log("✅ explore drip: seed choice, explore/seed children, 24 h gate, offline + failure safety");
}

console.log("\nAll topic dedupe tests passed.");

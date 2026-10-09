// Topic roles and the composed queue. Before this the queue was the whole
// positive pool in a weighted shuffle, drained before refilling — weight
// decided WHEN a topic was fetched, never WHETHER. Properties, not constants.
import fs from "node:fs";
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const now = Date.now();

function fresh() {
  const b = boot();
  b.get("getClientId"); // make sure the helper exists before signals are recorded
  return b;
}
const sig = (counts) => ({ t: now, c: { cA: counts }, f: {} });
const topic = (phrase, over = {}) => ({ phrase, weight: 5, addedAt: now, ...over });
const count = (list, key) => list.reduce((m, x) => { m[x[key]] = (m[x[key]] || 0) + 1; return m; }, {});

console.log("Running Topic Queue Tests...\n");

// 1. Quotas with supply: core > adjacent > explore, core the majority, exact size.
{
  const { get, state } = fresh();
  state.topics = [];
  for (let i = 0; i < 30; i++) state.topics.push(topic("core " + i, { role: "core" }));
  for (let i = 0; i < 30; i++) state.topics.push(topic("adj " + i, { role: "adjacent" }));
  for (let i = 0; i < 30; i++) state.topics.push(topic("exp " + i, { role: "explore" }));
  const q = plain(get("composeTopicQueue")(state.topics, 20));
  assert.strictEqual(q.length, 20);
  const roles = count(q.map(p => ({ r: p.split(" ")[0] })), "r");
  assert.ok(roles.core > roles.adj && roles.adj > roles.exp, JSON.stringify(roles));
  assert.ok(roles.core >= 10, "core is at least half");
  assert.ok(new Set(q).size === q.length, "no duplicates");
  console.log("✅ role quotas honoured when supply exists");
}

// 2. Degrades: no explore topics -> the slate still fills.
{
  const { get, state } = fresh();
  state.topics = [];
  for (let i = 0; i < 8; i++) state.topics.push(topic("core " + i, { role: "core" }));
  for (let i = 0; i < 8; i++) state.topics.push(topic("adj " + i, { role: "adjacent" }));
  const q = plain(get("composeTopicQueue")(state.topics, 12));
  assert.strictEqual(q.length, 12);
  const tiny = plain(get("composeTopicQueue")([topic("only one", { role: "adjacent" })], 30));
  assert.deepStrictEqual(tiny, ["only one"]);
  console.log("✅ degrades gracefully with missing roles or a tiny pool");
}

// 3. Never burned, never IGNORED, never weight <= 0.
{
  const { get, state } = fresh();
  state.topics = [
    topic("good one", { role: "core" }),
    topic("burned one", { role: "core" }),
    topic("ignored one", { role: "core" }),
    topic("dead one", { role: "core", weight: 0 }),
    topic("negative one", { role: "core", weight: -10 }),
  ];
  state.burnedQueries = [{ q: "burned one", t: now, strikes: 1 }];
  state.topicSignals = { "ignored one": sig({ imp: 12 }) };
  const q = plain(get("composeTopicQueue")(state.topics, 30));
  assert.deepStrictEqual(q, ["good one"]);
  console.log("✅ burned / ignored / non-positive topics are never queued");
}

// 4. Graduation: one play flips explore -> core and keeps bornRole.
{
  const { get, state } = fresh();
  state.topics = [topic("wild leap", { role: "explore", bornRole: "explore" })];
  get("recordTopicSignal")("wild leap", "play");
  const t = plain(state.topics[0]);
  assert.strictEqual(t.role, "core");
  assert.strictEqual(t.bornRole, "explore");
  assert.ok(t.graduatedAt > 0);
  // a second play changes nothing
  const before = t.graduatedAt;
  get("recordTopicSignal")("wild leap", "play");
  assert.strictEqual(state.topics[0].graduatedAt, before);
  console.log("✅ a play graduates explore -> core; bornRole survives");
}

// 5. Calibration: 70/30 like share across two clusters -> core slots follow it.
{
  const { get, state } = fresh();
  // Liked videos: 7 in channel A ("kilns"), 3 in channel B ("synths"); mined topics name the clusters.
  state.ratingStates = {};
  state.minedVideos = {};
  state.likedVideos = [];
  const like = (id, ch, t) => {
    state.likedVideos.push({ id, title: "v " + id, channelName: ch, published: now - 30 * DAY });
    state.ratingStates[id] = { r: 5, t: now, v: { id, title: "v " + id, channelName: ch, published: now - 30 * DAY } };
    state.minedVideos[id] = { t: now, topics: [t] };
  };
  for (let i = 0; i < 7; i++) like("a" + i, "Kiln Channel", "kiln building");
  for (let i = 0; i < 3; i++) like("b" + i, "Synth Channel", "eurorack patching");
  const idx = get("buildClusterIndex")();
  const share = plain(idx.share);
  const names = Object.keys(share);
  assert.strictEqual(names.length, 2, JSON.stringify(share));
  const big = names.find(n => share[n] > 0.5);
  assert.ok(big, "one cluster holds the majority of likes");
  // 20 core topics per cluster, distinguishable by the cluster stamp
  state.topics = [];
  for (let i = 0; i < 20; i++) state.topics.push(topic("kiln topic " + i, { role: "core", cluster: big }));
  const small = names.find(n => n !== big);
  for (let i = 0; i < 20; i++) state.topics.push(topic("synth topic " + i, { role: "core", cluster: small }));
  const q = plain(get("composeTopicQueue")(state.topics, 10));
  const kiln = q.filter(p => p.startsWith("kiln")).length;
  // Shortfall in any role fills from core, so the majority cluster can
  // legitimately receive up to 9 of 10 — only a minority outcome is wrong.
  assert.ok(kiln >= 5 && kiln <= 9, `majority cluster got ${kiln} of 10 core slots`);
  console.log("✅ core slots calibrated to like share across clusters");
}

// 6. Explore expiry vs adjacent soft retirement in pruneTopicPool.
{
  const { get, state } = fresh();
  state.topics = [
    topic("failed experiment", { role: "explore", bornRole: "explore", weight: 6 }),
    topic("quiet adjacent", { role: "adjacent", weight: 6 }),
  ];
  state.topicSignals = { "failed experiment": sig({ imp: 9 }), "quiet adjacent": sig({ imp: 9 }) };
  get("pruneTopicPool")();
  const byPhrase = Object.fromEntries(state.topics.map(t => [t.phrase, t.weight]));
  assert.ok(byPhrase["failed experiment"] <= 0.5, "ignored explore topic drops to the floor");
  assert.strictEqual(byPhrase["quiet adjacent"], 6, "adjacent keeps soft retirement only");
  const q = plain(get("composeTopicQueue")(state.topics, 30));
  assert.ok(!q.includes("failed experiment") && !q.includes("quiet adjacent"), "both ignored topics stay out of the slate");
  console.log("✅ explore expiry is hard, adjacent retirement stays soft");
}

// 7. Adaptive explore share: hit-rate above target raises it, within the band.
{
  const { get, state } = fresh();
  state.topics = [];
  for (let i = 0; i < 8; i++) state.topics.push(topic("hit " + i, { role: "core", bornRole: "explore", graduatedAt: now }));
  for (let i = 0; i < 4; i++) state.topics.push(topic("miss " + i, { role: "explore", bornRole: "explore", weight: 0.5 }));
  const likeCounts = get("buildTopicLikeCounts")();
  const a = plain(get("adaptiveExploreShare")(state.topics, likeCounts));
  assert.strictEqual(a.hits, 8); assert.strictEqual(a.expired, 4);
  assert.ok(a.adapted);
  const QUEUE_COMPOSE = plain(get("QUEUE_COMPOSE"));
  assert.ok(a.share > QUEUE_COMPOSE.mix.explore && a.share <= QUEUE_COMPOSE.exploreBand[1]);
  const few = plain(get("adaptiveExploreShare")(state.topics.slice(0, 3), likeCounts));
  assert.ok(!few.adapted && few.share === QUEUE_COMPOSE.mix.explore, "too few resolved -> default share");
  console.log("✅ explore share adapts to the measured hit-rate inside its band");
}

// 8. Legacy topics derive a role and never eat the explore budget.
{
  const { get, state } = fresh();
  const likeCounts = {};
  assert.strictEqual(get("topicRole")(topic("old mined", { weight: 10 }), likeCounts), "core");
  assert.strictEqual(get("topicRole")(topic("old similar", { weight: 4 }), likeCounts), "adjacent");
  assert.strictEqual(get("topicRole")(topic("stamped", { role: "explore" }), likeCounts), "explore");
  state.topics = [];
  for (let i = 0; i < 20; i++) state.topics.push(topic("legacy " + i, { weight: 4 }));
  const q = plain(get("composeTopicQueue")(state.topics, 10));
  assert.strictEqual(q.length, 10);
  console.log("✅ legacy topics derive core/adjacent, never explore");
}

// 9. Fetch hint scales with role.
{
  const { get, state } = fresh();
  state.topics = [topic("core t", { role: "core" }), topic("exp t", { role: "explore" })];
  const c = get("topicFetchHint")("core t"), e = get("topicFetchHint")("exp t");
  assert.ok(c.fetchBudget > e.fetchBudget);
  assert.strictEqual(get("topicFetchHint")("unknown t").role, "adjacent");
  console.log("✅ fetch budget follows the role");
}

// 10. wgTopicMix reports the explore hit-rate from the ledger.
{
  const { get, state } = fresh();
  state.topics = [
    topic("g", { role: "core", bornRole: "explore", graduatedAt: now }),
    topic("x1", { role: "explore", bornRole: "explore", weight: 0.5 }),
    topic("x2", { role: "explore", bornRole: "explore", weight: 0.5 }),
  ];
  const origTable = console.table; console.table = () => {};
  const origLog = console.log; console.log = () => {};
  let rep;
  try { rep = plain(get("window").wgTopicMix()); } finally { console.table = origTable; console.log = origLog; }
  assert.strictEqual(rep.explore.hits, 1); assert.strictEqual(rep.explore.expired, 2);
  console.log("✅ wgTopicMix: 1 graduated + 2 expired -> hit-rate 1/3");
}

// 11. Regression gate: the whole-pool refill is gone, the composer is wired, brainstorm stamps src.
{
  const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.ok(!/getWeightedRandomTopics\(state\.topics\)\.filter\(t => !isBurned\(t\)\)/.test(src), "old refill expression removed");
  assert.ok((src.match(/composeTopicQueue\(state\.topics\)/g) || []).length >= 3, "composer wired at all three refill sites");
  const brainstormPush = src.slice(src.indexOf("async function generateBrainstormTopics"), src.indexOf("async function generateTopicsForSeeds"));
  assert.ok(/src: _lastContextVariant/.test(brainstormPush), "brainstorm birth site stamps src");
  assert.ok(/ctx\.numTopics = 60/.test(brainstormPush), "brainstorm asks for 60");
  console.log("✅ regression gate: refill replaced, composer wired, stamps present");
}

console.log("\nAll topic queue tests passed.");

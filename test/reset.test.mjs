// Discovery reset + topic provenance. The reset must keep every like-earned
// topic and drop the generated guesses; provenance must stop a brainstorm batch
// from taking core seats, and play-proven evidence must expire.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const now = Date.now();
const DAY = 86400e3;
const like = (id, extra) => ({ r: 5, t: now, v: { id, title: id, ...extra } });

console.log("Running Discovery Reset Tests...\n");

// 1. Reset keeps likes/mined/hand/played, drops generated guesses.
{
  const { get, state, store } = boot();
  state.ratingStates = { v1: like("v1", { matchedTopics: ["kiln building"] }) };
  state.minedVideos = { v1: { t: now, topics: ["raku firing"], tiers: { "raku firing": "A" } } };
  state.likedTopics = ["raku firing"];
  state.topics = [
    { phrase: "raku firing", weight: 5, addedAt: now, origin: "brainstorm" },
    { phrase: "kiln building", weight: 4, addedAt: now, origin: "brainstorm" },
    { phrase: "old guess", weight: 6, addedAt: now, origin: "brainstorm" },
    { phrase: "hand pick", weight: 5, addedAt: now, origin: "hand" },
    { phrase: "played once", weight: 4, addedAt: now, origin: "brainstorm" },
  ];
  state.topicSignals = {
    "played once": { t: now, c: { cA: { play: 2 } }, f: {}, lastPlayAt: now },
    "old guess": { t: now, c: { cA: { imp: 12 } }, f: {} },
  };
  state.smartFeedSuggestionPool = [{ id: "poolvid" }];
  state.smartFeedTopicsQueue = ["old guess"];
  state.feedMix = { shown: [{ t: now, topic: "old guess" }] };

  const r = plain(get("resetDiscoveryFeed")({ keepLikes: true }));
  const phrases = plain(state.topics.map(t => t.phrase)).sort();
  assert.deepStrictEqual(phrases, ["hand pick", "kiln building", "played once", "raku firing"].sort(),
    "only earned topics survive");
  assert.strictEqual(r.before, 5);
  assert.strictEqual(r.after, 4);
  assert.deepStrictEqual(plain(r.dropped), ["old guess"]);

  const raku = state.topics.find(t => t.phrase === "raku firing");
  assert.strictEqual(raku.origin, "like-mined");
  assert.strictEqual(raku.role, "core");
  assert.ok(raku.weight >= 10, `like-mined reset weight must stay in the like band, got ${raku.weight}`);
  assert.strictEqual(state.topics.find(t => t.phrase === "hand pick").origin, "hand");

  assert.deepStrictEqual(plain(state.topicSignals), {}, "signal ledger is cleared");
  assert.deepStrictEqual(plain(state.smartFeedSuggestionPool), [], "pool is cleared");
  assert.deepStrictEqual(plain(state.feedMix.shown), [], "feed-mix ledger is cleared");
  assert.ok(state.smartFeedTopicsQueue.every(p => !p.includes("old guess")), "queue is rebuilt from earned topics");
  assert.ok(state.resetAt > 0, "reset stamps a resetAt epoch");
  assert.strictEqual(JSON.parse(store.get("wallgarden_default_reset_at")), state.resetAt, "resetAt is persisted");
  const log = JSON.parse(store.get("wallgarden_default_topic_purge_log"));
  assert.strictEqual(log.reset, true);
  console.log("✅ reset keeps earned topics, drops guesses, clears the ledger");
}

// 2. Reset preserves likes, mined topics, burns and decisions.
{
  const { get, state } = boot();
  state.ratingStates = { v1: like("v1"), v2: { r: -5, t: now, v: { id: "v2", title: "nope" } } };
  state.minedVideos = { v1: { t: now, topics: ["kiln building"], tiers: { "kiln building": "A" } } };
  state.burnedQueries = [{ q: "prank", t: now, strikes: 1 }];
  state.dislikedTopics = ["asmr"];
  state.blockedChannels = [{ name: "Spam Co" }];
  state.avoidedVideos = { avoidme: { t: now, channelName: "X", title: "y", reason: "skipped" } };
  state.topics = [{ phrase: "kiln building", weight: 4, addedAt: now, origin: "brainstorm" }];

  get("resetDiscoveryFeed")({ keepLikes: true });
  assert.ok(state.ratingStates.v1 && state.ratingStates.v1.r === 5, "likes survive");
  assert.ok(state.ratingStates.v2 && state.ratingStates.v2.r === -5, "dislikes survive");
  assert.deepStrictEqual(plain(state.minedVideos.v1.topics), ["kiln building"], "mined topics survive");
  assert.strictEqual(state.burnedQueries.length, 1, "burns survive");
  assert.deepStrictEqual(plain(state.dislikedTopics), ["asmr"]);
  assert.deepStrictEqual(plain(state.blockedChannels), [{ name: "Spam Co" }]);
  assert.ok(state.avoidedVideos.avoidme, "avoided videos survive");
  console.log("✅ reset never touches likes, mined topics or explicit decisions");
}

// 3. Provenance: generated topics never take core; like-mined do.
{
  const { get } = boot();
  const role = get("topicRole");
  assert.strictEqual(role({ phrase: "guess", weight: 8, origin: "brainstorm", role: "core" }, {}), "adjacent",
    "a brainstorm topic cannot be core even when the backend labelled it core");
  assert.strictEqual(role({ phrase: "seed kid", weight: 6, origin: "seed", role: "core" }, {}), "adjacent");
  assert.strictEqual(role({ phrase: "seed kid", weight: 6, origin: "seed", role: "explore" }, {}), "explore");
  assert.strictEqual(role({ phrase: "liked", weight: 10, origin: "like-mined", role: "core" }, {}), "core");
  assert.strictEqual(role({ phrase: "legacy", weight: 10 }, {}), "core", "legacy weight>=10 still derives core");
  console.log("✅ generated topics are capped at adjacent; like-earned stay core");
}

// 4. Mining weights: like-mined beats the brainstorm cap, remote replay keeps tier.
{
  const { get, state } = boot();
  state.smartFeedTopicsQueue = [];
  get("applyMinedTopics")("vidA", [{ topic: "raku firing", tier: "A", weight: 8 }]);
  get("applyMinedTopics")("vidB", [{ topic: "ash glaze", tier: "B", weight: 4 }]);
  const a = state.topics.find(t => t.phrase === "raku firing");
  const b = state.topics.find(t => t.phrase === "ash glaze");
  assert.strictEqual(a.origin, "like-mined");
  assert.strictEqual(a.weight, 10);
  assert.strictEqual(b.weight, 9);
  assert.ok(a.weight > 6 && b.weight > 6, "both tiers outrank the brainstorm cap");
  assert.deepStrictEqual(plain(state.minedVideos.vidA.tiers), { "raku firing": "A" }, "tiers are persisted for replay");

  // Remote replay path: applyMinedTopics with the stored tier must not fall to B/4.
  state.topics = [];
  get("applyMinedTopics")("vidC", [{ topic: "kiln building", tier: "A", weight: 8 }], { quiet: true });
  assert.strictEqual(state.topics.find(t => t.phrase === "kiln building").weight, 10);
  console.log("✅ mined weights sit above the brainstorm cap and tiers survive sync");
}

// 5. A fresh like drops pending brainstorm entries and fronts the mined topic.
{
  const { get, state } = boot();
  state.topics = [
    { phrase: "old guess", weight: 6, addedAt: now, origin: "brainstorm" },
    { phrase: "raku firing", weight: 6, addedAt: now, origin: "brainstorm" },
  ];
  state.smartFeedTopicsQueue = ["old guess", "raku firing"];
  get("applyMinedTopics")("vidA", [{ topic: "raku firing", tier: "A", weight: 8 }]);
  assert.strictEqual(state.smartFeedTopicsQueue[0], "raku firing", "mined topic is fronted");
  assert.ok(!state.smartFeedTopicsQueue.includes("old guess"), "pending brainstorm guess is dropped");
  console.log("✅ a like invalidates the pending guess tail");
}

// 6. Play-proven expires after 90 days; a recent play still proves.
{
  const { get, state } = boot();
  state.topicSignals = {
    "one man sawmill": { t: now, c: { cA: { play: 2 } }, f: {}, lastPlayAt: now - 120 * DAY },
    "wood ash glaze": { t: now, c: { cA: { play: 2 } }, f: {}, lastPlayAt: now - 10 * DAY },
  };
  assert.strictEqual(get("isProvenTopic")("one man sawmill", {}), false, "old plays stop proving a topic");
  assert.strictEqual(get("isProvenTopic")("wood ash glaze", {}), true, "recent plays still prove it");
  console.log("✅ play-proven evidence expires; it is no longer permanent");
}

// 7. Half of the core band is reserved for like-earned topics.
{
  const { get, state } = boot();
  state.topics = [];
  for (let i = 0; i < 6; i++) state.topics.push({ phrase: "liked " + i, weight: 10, addedAt: now, origin: "like-mined", role: "core" });
  for (let i = 0; i < 6; i++) state.topics.push({ phrase: "engaged " + i, weight: 8, addedAt: now, origin: "engaged", role: "core" });
  for (let i = 0; i < 10; i++) state.topics.push({ phrase: "adj " + i, weight: 6, addedAt: now, origin: "brainstorm", role: "adjacent" });
  const q = plain(get("composeTopicQueue")(state.topics, 20));
  const likedCount = q.filter(p => p.startsWith("liked ")).length;
  const coreCount = q.filter(p => p.startsWith("liked ") || p.startsWith("engaged ")).length;
  assert.ok(coreCount >= 10, `core band still majority, got ${coreCount}`);
  assert.ok(likedCount >= Math.ceil(coreCount / 2), `liked fills at least half of core, got ${likedCount}/${coreCount}`);
  console.log("✅ like-earned topics get at least half the core slots");
}

console.log("\nAll Discovery Reset tests passed.");

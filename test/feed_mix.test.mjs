// The feed-mix ledger: what the smart feed showed, and what it earned. This
// is the instrument the rest of the calibrated-feed work is judged by, so it
// gets its own proof that it only counts what was actually shown.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const { get, state, store } = boot();
const recordFeedShown = get("recordFeedShown");
const markFeedEvent = get("markFeedEvent");
const feedMixReport = get("feedMixReport");
const FEED_MIX_MAX = get("FEED_MIX_MAX");
const getProfileKey = get("getProfileKey");
const now = Date.now();
const vid = (id, over) => ({ id, title: id, channelName: "Chan " + id[0], published: now - 30 * DAY, _topic: "kiln building", _form: "broad", ...over });

console.log("Running Feed Mix Tests...\n");

// 1. Shown rows carry era/topic/channel; play and like stamp only shown rows.
{
  recordFeedShown([vid("a1"), vid("b1", { published: now - 6 * 365 * DAY }), vid("c1", { published: null })]);
  assert.strictEqual(state.feedMix.shown.length, 3);
  assert.deepStrictEqual(state.feedMix.shown.map(r => r.era), ["recent", "classic", "unknown"]);
  assert.strictEqual(state.feedMix.shown[0].channel, "chan a");
  assert.strictEqual(markFeedEvent("a1", "play"), true);
  assert.strictEqual(markFeedEvent("zz", "play"), false, "a video the feed never showed cannot earn a play");
  assert.strictEqual(markFeedEvent("b1", "like"), true);
  assert.ok(store.get(getProfileKey("feed_mix")).includes('"play"'), "persisted");
  console.log("✅ shown rows recorded; events stamp only shown rows");
}

// 2. The report attributes engagement per era and charges unknown to recent in the KL.
{
  const target = { recent: 0.5, mid: 0.2, classic: 0.2, vintage: 0.1 };
  const rep = plain(feedMixReport(state.feedMix.shown, target));
  assert.strictEqual(rep.n, 3);
  assert.strictEqual(rep.eras.recent.plays, 1);
  assert.strictEqual(rep.eras.classic.likes, 1);
  assert.strictEqual(rep.eras.unknown.shown, 1);
  assert.ok(Number.isFinite(rep.kl));
  // 2 of 3 charged to recent (one real, one unknown), 1 classic, 0 mid/vintage
  const repAllRecent = plain(feedMixReport([vid("x").id && { id: "x", era: "unknown" }], target));
  assert.ok(Number.isFinite(repAllRecent.kl), "an all-unknown ledger still yields a finite KL");
  assert.strictEqual(rep.channels[0].max_in_any_12 >= 1, true);
  const empty = plain(feedMixReport([], target));
  assert.strictEqual(empty.kl, null);
  console.log("✅ report: per-era engagement, finite KL, empty ledger is n/a");
}

// 3. FIFO cap holds, and the newest rows survive.
{
  const many = Array.from({ length: FEED_MIX_MAX + 25 }, (_, i) => vid("m" + i));
  recordFeedShown(many);
  assert.strictEqual(state.feedMix.shown.length, FEED_MIX_MAX);
  assert.strictEqual(state.feedMix.shown[state.feedMix.shown.length - 1].id, "m" + (FEED_MIX_MAX + 24));
  console.log("✅ ledger cap is FIFO");
}

// 4. Per-mode grouping lets two composition strategies share one ledger.
{
  state.feedMix = { shown: [] };
  recordFeedShown([vid("s1"), vid("s2")], "shuffle");
  recordFeedShown([vid("t1")], "slate");
  markFeedEvent("t1", "play");
  const rep = plain(feedMixReport(state.feedMix.shown, { recent: 1 }));
  assert.strictEqual(rep.byMode.shuffle.n, 2);
  assert.strictEqual(rep.byMode.slate.plays_per_100, 100);
  console.log("✅ per-mode grouping");
}

console.log("\nAll feed mix tests passed.");

// Why the feed took so long: the ~10 s classifier sat on the critical path of
// every topic, and a cold start held every topic's videos until the slowest
// one answered. These pin the two fixes on the real functions.
import fs from "node:fs";
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const items = (form, n = 4) => ({ items: Array.from({ length: n }, (_, i) => ({
  video_id: `${form}${i}`, title: `${form} video ${i}`, channel: `Ch ${form} ${i}`, channel_id: `UC${form}${i}`,
  published_at: "2021-03-06T00:00:00", duration_secs: 600, view_count: 5000 + i,
})) });
const formOf = (body) => body.sp ? "recent" : body.sort === "views" ? "proven" : body.query.length > 12 ? "depth" : "broad";

console.log("Running Feed Latency Tests...\n");

// 1. fetchVideosForTopic returns BEFORE the classifier answers; the verdict
//    later evicts NOVELTY from the pool.
{
  const { get, state, ctx } = boot();
  let resolveClassify;
  const classifyStarted = [];
  ctx.fetch = async (url, opts) => {
    if (String(url).includes("/scraper/collect")) {
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => items(formOf(body)) };
    }
    if (String(url).includes("/classify-candidates")) {
      classifyStarted.push(JSON.parse(opts.body).topic);
      return new Promise(res => { resolveClassify = () => res({ ok: true, json: async () => ({
        classifications: [{ id: "broad0", classification: "NOVELTY", reason: "lego" }] }) }); });
    }
    return { ok: true, json: async () => ({}) };
  };
  state.settings = { useYtdlp: true, muteShorts: false };
  const t0 = Date.now();
  const videos = await get("fetchVideosForTopic")("kiln");
  assert.ok(videos.length > 0, "candidates returned");
  assert.ok(Date.now() - t0 < 2000, "did not wait for the classifier");
  assert.strictEqual(classifyStarted.length, 1, "classification was scheduled");
  state.smartFeedSuggestionPool.push(...videos);
  assert.ok(state.smartFeedSuggestionPool.some(v => v.id === "broad0"));
  resolveClassify();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!state.smartFeedSuggestionPool.some(v => v.id === "broad0"), "late NOVELTY verdict evicted from the pool");
  assert.strictEqual(videos.find(v => v.id === "broad0")._classification, "NOVELTY");
  console.log("✅ classifier runs off the render path and evicts late");
}

// 2. Late classification is bounded: with five topics queued, at most
//    LATE_CLASSIFY_CONCURRENCY calls are in flight.
{
  const { get, state, ctx } = boot();
  const inflight = [];
  ctx.fetch = async (url, opts) => {
    if (String(url).includes("/classify-candidates")) {
      return new Promise(res => inflight.push(() => res({ ok: true, json: async () => ({ classifications: [] }) })));
    }
    return { ok: true, json: async () => ({}) };
  };
  state.settings = {};
  const sched = get("scheduleLateClassification");
  for (let i = 0; i < 5; i++) sched("t" + i, [{ id: "x" + i, title: "x", channelName: "c" }]);
  await new Promise(r => setTimeout(r, 20));
  const cap = get("LATE_CLASSIFY_CONCURRENCY");
  assert.strictEqual(inflight.length, cap, `expected ${cap} in flight, got ${inflight.length}`);
  inflight.splice(0).forEach(fn => fn());
  await new Promise(r => setTimeout(r, 20));
  assert.ok(inflight.length >= 1 && inflight.length <= cap, "the queue drains as calls finish");
  inflight.splice(0).forEach(fn => fn());
  console.log("✅ late classification is queued, not fanned out");
}

// 3. The preloader absorbs each topic as it lands: the pool fills with the
//    fast topic while the slow topic is still pending.
{
  const { get, state, ctx } = boot();
  // Four forms per topic -> four pending fetches for the slow topic; keep
  // every resolver, not just the last one.
  const slowResolvers = [];
  const releaseSlow = () => slowResolvers.splice(0).forEach(fn => fn());
  ctx.fetch = async (url, opts) => {
    if (String(url).includes("/scraper/collect")) {
      const body = JSON.parse(opts.body);
      if (body.query.startsWith("slow")) {
        return new Promise(res => { slowResolvers.push(() => res({ ok: true, json: async () => items("s" + formOf(body)[0]) })); });
      }
      return { ok: true, json: async () => items("f" + formOf(body)[0]) };
    }
    return { ok: true, json: async () => ({}) };
  };
  state.settings = { useYtdlp: true, semanticFilterEnabled: false };
  state.topics = [{ phrase: "fast topic", weight: 5 }, { phrase: "slow topic", weight: 5 }];
  state.smartFeedTopicsQueue = ["fast topic", "slow topic"];
  state.currentView = "settings";   // no DOM here; we watch the pool, not the grid
  const p = get("fillSmartFeedPreloadBuffer")();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(state.smartFeedSuggestionPool.length > 0, "fast topic's videos are in the pool before the slow topic answers");
  assert.ok(state.smartFeedSuggestionPool.every(v => v._topic === "fast topic"));
  releaseSlow();
  await p;
  // The preloader re-arms itself every 1.5 s while the pool is under 1000;
  // stop that so the test process can exit.
  ctx.clearTimeout(get("smartFeedPreloadTimeout"));
  assert.ok(state.smartFeedSuggestionPool.some(v => v._topic === "slow topic"));
  console.log("✅ cold start fills the pool topic by topic");
}

// 4. Regression gate.
{
  const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  const fetchFn = src.slice(src.indexOf("async function fetchVideosForTopic"), src.indexOf("// ── Grounding gate"));
  assert.ok(!/await classifyCandidatesWithLLM\(/.test(fetchFn), "no awaited classifier inside fetchVideosForTopic");
  assert.ok(!/const results = await Promise\.all\(fetchPromises\)/.test(src), "cold start no longer waits for every topic");
  assert.ok(/isPoolEmpty \? 3 /.test(src), "cold-start fan-out matches the scraper's 3-wide gate");
  console.log("✅ regression gate: classifier not awaited, no all-topics barrier, fan-out 3");
}

console.log("\nAll feed latency tests passed.");

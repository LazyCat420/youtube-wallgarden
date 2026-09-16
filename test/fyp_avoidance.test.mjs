// Unit tests for YouTube FYP Avoidance & Extension Feedback Loop:
// - Recording unclicked FYP suggestions into avoidedVideos state
// - isAvoidedVideo gate dropping suggestions seen on YouTube but unclicked
// - Merging avoided suggestions from extension WG_EXT_SYNC
// - Explicit NOT_INTERESTED events immediately blacklisting the video and demoting topic
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

function bootHarness() {
  const store = new Map();
  const ctx = {
    console,
    document: {
      body: { classList: { add(){}, remove(){}, contains: () => false }, style: {} },
      documentElement: { style: {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    window: {
      location: { href: "" },
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {}
    },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    graphUpsertNode: () => "n",
    graphUpsertEdge: () => "e",
    graphPropagateNegative: () => {},
    graphProcessRating: () => {},
    graphProcessWatch: () => {},
    graphScoreVideo: () => 0
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  const get = (name) => vm.runInContext(name, ctx);
  const state = get("state");
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    avoidedVideos: {},
    likedVideos: [],
    videoRatings: {},
    topics: [],
    blockedChannels: [],
    smartFeedSuggestionPool: [],
    smartFeedVideos: [],
    settings: { muteShorts: true }
  });

  return { get, state, ctx };
}

console.log("Running FYP Avoidance & Extension Feedback Tests...\n");

// 1. isAvoidedVideo gate
{
  const { get, state } = bootHarness();
  const isAvoidedVideo = get("isAvoidedVideo");
  assert.ok(typeof isAvoidedVideo === "function", "isAvoidedVideo must be defined");

  state.avoidedVideos = {
    "vid_avoid_1": { t: Date.now(), reason: "fyp_unclicked" }
  };

  assert.strictEqual(isAvoidedVideo({ id: "vid_avoid_1" }), "fyp-avoided", "Avoided video is dropped");
  assert.strictEqual(isAvoidedVideo({ id: "vid_fresh" }), null, "Non-avoided video passes");
  console.log("✅ isAvoidedVideo drops videos marked as skipped/avoided on YouTube");
}

// 2. WG_EXT_SYNC message processing for FYP_AVOID_BATCH
{
  const { get, state, ctx } = bootHarness();
  const onSyncEvent = get("handleExtensionSyncEvent");
  assert.ok(typeof onSyncEvent === "function", "handleExtensionSyncEvent must be defined");

  // Extension sends batch of unclicked FYP suggestions
  onSyncEvent({
    action: "FYP_AVOID_BATCH",
    items: [
      { videoId: "fyp_skip_1", title: "Clickbait Title", channelName: "Viral Channel" },
      { videoId: "fyp_skip_2", title: "Uninteresting Video", channelName: "Other Channel" }
    ]
  });

  assert.ok(state.avoidedVideos["fyp_skip_1"], "fyp_skip_1 is recorded in avoidedVideos");
  assert.ok(state.avoidedVideos["fyp_skip_2"], "fyp_skip_2 is recorded in avoidedVideos");
  console.log("✅ FYP_AVOID_BATCH records unclicked YouTube suggestions in avoidedVideos");
}

// 3. Explicit NOT_INTERESTED event records avoidance and evicts from pool
{
  const { get, state } = bootHarness();
  const onSyncEvent = get("handleExtensionSyncEvent");

  state.smartFeedVideos = [
    { id: "vid_to_reject", title: "Spammy Video" },
    { id: "vid_to_keep", title: "Keep Video" }
  ];

  onSyncEvent({
    action: "NOT_INTERESTED",
    videoId: "vid_to_reject",
    channelName: "Spammer"
  });

  assert.ok(state.avoidedVideos["vid_to_reject"], "vid_to_reject is recorded in avoidedVideos");
  assert.strictEqual(state.videoRatings["vid_to_reject"], -5, "NOT_INTERESTED sets negative rating");
  assert.ok(!state.smartFeedVideos.some(v => v.id === "vid_to_reject"), "Rejected video evicted from feed");
  console.log("✅ NOT_INTERESTED immediately evicts video and sets negative rating");
}

console.log("\nAll FYP Avoidance & Extension Feedback tests passed!");

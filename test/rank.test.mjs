// Exercise the discovery ranking pipeline straight out of app.js, with the
// browser globals stubbed. Pins the claim that the feed now RANKS candidates
// instead of taking whatever arrived first.
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
const getScoreAndMatches = get("getScoreAndMatches");
const getLikedChannelAffinity = get("getLikedChannelAffinity");
const invalidateLikedChannelCache = get("invalidateLikedChannelCache");
const getRecentLikedVideos = get("getRecentLikedVideos");
const parseYtViewsText = get("parseYtViewsText");
const parseYtDurationText = get("parseYtDurationText");

const DAY = 86400e3;
const base = (over) => ({
  id: "v" + Math.random().toString(36).slice(2, 8),
  title: "quiet workshop build, start to finish",
  channelName: "SomeChannel",
  published: Date.now() - 400 * DAY,
  duration: 900,           // 15 min
  viewCount: 250000,
  _fetchRank: 0,
  ...over,
});
const ctx0 = { topic: "workshop build", likedChannels: new Set() };

// ── 1. Shorts score below a 15-min video ──────────────────────────
{
  const long = scoreDiscoveryVideo(base({}), ctx0).score;
  const short = scoreDiscoveryVideo(base({ duration: 45 }), ctx0).score;
  assert.ok(short < long, `short (${short}) must score below long-form (${long})`);
  console.log("✅ Shorts score below 15-min video");
}

// ── 2. clickbait styling is penalized ─────────────────────────────
{
  const clean = scoreDiscoveryVideo(base({}), ctx0).score;
  const bait = scoreDiscoveryVideo(base({ title: "INSANE WORKSHOP BUILD!!! you won't believe it" }), ctx0).score;
  assert.ok(bait < clean, "clickbait must score lower");
  console.log("✅ clickbait penalized");
}

// ── 3. liked channel outranks unknown at equal signals ────────────
{
  const liked = scoreDiscoveryVideo(base({ channelName: "FaveMaker" }),
    { topic: "workshop build", likedChannels: new Set(["favemaker"]) }).score;
  const unknown = scoreDiscoveryVideo(base({ channelName: "Rando" }),
    { topic: "workshop build", likedChannels: new Set(["favemaker"]) }).score;
  assert.ok(liked > unknown, "liked channel must outrank unknown");
  console.log("✅ liked channel outranks unknown");
}

// ── 4. week-old upload scores below a proven 1-year video ─────────
{
  const proven = scoreDiscoveryVideo(base({}), ctx0).score;
  const fresh = scoreDiscoveryVideo(base({ published: Date.now() - 2 * DAY }), ctx0).score;
  assert.ok(fresh < proven, "brand-new upload must score below proven video");
  console.log("✅ maturity favors proven over week-old");
}

// ── 5. rating override: +25 like / -50 dislike in getScoreAndMatches ─
{
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, {
    topics: [], dislikedTopics: [], blockedChannels: [],
    videoRatings: { likedvid: 5, dislikedvid: -5 },
    ratingStates: {}, cache: { videos: {} }, smartFeedVideos: [],
    ontologyGraph: null,
  });
  invalidateLikedChannelCache();
  const neutral = getScoreAndMatches({ id: "plainvid", title: "some video" });
  const liked = getScoreAndMatches({ id: "likedvid", title: "some video" });
  const disliked = getScoreAndMatches({ id: "dislikedvid", title: "some video" });
  assert.strictEqual(liked.score - neutral.score, 25, "+25 for a liked video");
  assert.strictEqual(disliked.score - neutral.score, -50, "-50 for a disliked video");
  assert.ok(liked.matches.includes("user-liked"), "audit marker present");
  console.log("✅ explicit rating override (+25 / -50)");
}

// ── 6. liked-channel affinity bonus, capped, keyed by name ────────
{
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, {
    topics: [], dislikedTopics: [], blockedChannels: [],
    videoRatings: {}, cache: { videos: {} }, smartFeedVideos: [],
    ontologyGraph: null,
    ratingStates: {
      a: { r: 5, t: 1, v: { title: "x", channelName: "FaveMaker" } },
      b: { r: 5, t: 2, v: { title: "y", channelName: "FaveMaker" } },
      c: { r: 5, t: 3, v: { title: "z", channelName: "FaveMaker" } },
      d: { r: 5, t: 4, v: { title: "w", channelName: "FaveMaker" } }, // 4 likes -> cap
      e: { r: -5, t: 5, v: { title: "q", channelName: "BadChan" } },
    },
  });
  invalidateLikedChannelCache();
  assert.strictEqual(getLikedChannelAffinity().get("favemaker"), 4);
  assert.strictEqual(getLikedChannelAffinity().get("badchan"), undefined, "dislikes don't count");
  const fave = getScoreAndMatches({ id: "n1", title: "some video", channelName: "FaveMaker" });
  const rando = getScoreAndMatches({ id: "n2", title: "some video", channelName: "Rando" });
  assert.strictEqual(fave.score - rando.score, 9, "bonus caps at 9 (3 per like)");
  assert.ok(fave.matches.includes("liked-channel"));
  console.log("✅ liked-channel affinity (capped at 9, by name)");
}

// ── 7. getRecentLikedVideos: time order, placeholders skipped ─────
{
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, {
    likedVideos: [],
    ratingStates: {
      old: { r: 5, t: 100, v: { title: "old like", channelName: "A" } },
      newest: { r: 5, t: 300, v: { title: "newest like", channelName: "B" } },
      mid: { r: 5, t: 200, v: { title: "mid like", channelName: "C" } },
      ghost: { r: 5, t: 400, v: { title: "Liked Video (Synced)", channelName: "YouTube Curation" } },
      dis: { r: -5, t: 500, v: { title: "disliked", channelName: "D" } },
    },
  });
  const recent = [...getRecentLikedVideos(2)]; // copy out of the VM realm
  assert.deepStrictEqual(recent.map(v => v.title), ["newest like", "mid like"],
    "newest first, placeholder + dislike skipped");
  console.log("✅ getRecentLikedVideos is time-ordered and skips placeholders");
}

// ── 8. renderer-string parsers ────────────────────────────────────
{
  assert.strictEqual(parseYtViewsText("1.2M views"), 1200000);
  assert.strictEqual(parseYtViewsText("523 views"), 523);
  assert.strictEqual(parseYtViewsText(null), null);
  assert.strictEqual(parseYtDurationText("12:34"), 754);
  assert.strictEqual(parseYtDurationText("1:02:03"), 3723);
  assert.strictEqual(parseYtDurationText(""), null);
  console.log("✅ views/duration text parsers");
}

console.log("\nAll ranking tests passed.");

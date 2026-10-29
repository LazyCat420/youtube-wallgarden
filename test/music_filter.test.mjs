// Unit tests for Music Feed:
// - isDjMixOrCompilation binary gate:
//   - Drops long duration videos (> 14 min) as mixes/compilations
//   - Drops titles containing DJ sets, live sets, full mixes, compilations, boiler room, etc.
//   - Passes standard artist songs, official audio, lyric videos, and artist - Topic releases
// - Music recommendation seeds extracted from liked music videos & music topics
// - scoreMusicVideo favors authentic artist tracks and user-liked artists
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
    likedVideos: [],
    videoRatings: {},
    topics: [],
    blockedChannels: [],
    musicFeedVideos: [],
    musicFeedSuggestionPool: [],
    settings: { muteShorts: true }
  });

  return { get, state };
}

console.log("Running Music Feed & Anti-DJ Mix Filter Tests...\n");

// 1. isDjMixOrCompilation rejects mixes, sets, and compilations
{
  const { get } = bootHarness();
  const isDjMixOrCompilation = get("isDjMixOrCompilation");
  assert.ok(typeof isDjMixOrCompilation === "function", "isDjMixOrCompilation must be defined");

  // Duration over 14 minutes (840s)
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Great Track", duration: 900 }),
    "mix-duration",
    "Track over 14m is rejected as a mix/compilation"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Deep House Session", duration: 3600 }),
    "mix-duration",
    "1-hour session is rejected as a mix"
  );

  // Keyword patterns in titles
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Summer Vibes 2026 Full DJ Mix", duration: 600 }),
    "dj-mix-title",
    "Full DJ Mix title is rejected"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Artist Name - Live at Boiler Room Berlin", duration: 700 }),
    "dj-mix-title",
    "Boiler Room set is rejected"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Best 90s Dance Hits MegaMix Vol. 2", duration: 500 }),
    "dj-mix-title",
    "Megamix compilation is rejected"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Continuous Club Mix 2026", duration: 400 }),
    "dj-mix-title",
    "Continuous club mix is rejected"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Lofi Hip Hop Mix - Beats to Relax/Study to", duration: 600 }),
    "dj-mix-title",
    "Lofi mix compilation is rejected"
  );

  console.log("✅ isDjMixOrCompilation rejects duration > 14m and mix/set/compilation keywords");
}

// 2. isDjMixOrCompilation passes authentic artist songs
{
  const { get } = bootHarness();
  const isDjMixOrCompilation = get("isDjMixOrCompilation");

  // Standard artist singles
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Daft Punk - One More Time (Official Audio)", duration: 320 }),
    null,
    "Official Audio passes"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "The Weeknd - Blinding Lights (Official Music Video)", duration: 260 }),
    null,
    "Official Music Video passes"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Aphex Twin - Alberto Balsalm", duration: 311 }),
    null,
    "Standard artist song passes"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Radiohead - Weird Fishes/Arpeggi (Lyric Video)", duration: 318 }),
    null,
    "Lyric Video passes"
  );
  assert.strictEqual(
    isDjMixOrCompilation({ title: "Tycho - Awake", channelName: "Tycho - Topic", duration: 283 }),
    null,
    "Artist - Topic track passes"
  );

  console.log("✅ isDjMixOrCompilation passes authentic artist songs and official releases");
}

// 3. Extracting music seeds from liked videos & topics
{
  const { get, state } = bootHarness();
  const getMusicSeeds = get("getMusicSeeds");
  assert.ok(typeof getMusicSeeds === "function", "getMusicSeeds must be defined");

  state.likedVideos = [
    { id: "v1", title: "Bonobo - Kerala (Official Video)", channelName: "Bonobo" },
    { id: "v2", title: "Wood Ash Glaze Tutorial", channelName: "Pottery Master" }, // Non-music
    { id: "v3", title: "Four Tet - Baby", channelName: "Four Tet - Topic" }
  ];
  state.topics = [
    { phrase: "synthwave", weight: 5 },
    { phrase: "ceramic kiln firing", weight: 8 }, // Non-music
    { phrase: "ambient electronic", weight: 6 }
  ];

  const seeds = getMusicSeeds();
  assert.ok(seeds.artists.includes("bonobo") || seeds.artists.includes("four tet"), "Extracts liked music artists");
  assert.ok(seeds.genres.includes("synthwave") || seeds.genres.includes("ambient electronic"), "Extracts music genres");
  assert.ok(!seeds.genres.includes("ceramic kiln firing"), "Non-music topics excluded from music seeds");
  console.log("✅ getMusicSeeds derives artist and genre seeds from user curation");
}

// 4. Rejects non-music hyphenated video titles & integrates music-player seeds
{
  const { get, state } = bootHarness();
  const getMusicSeeds = get("getMusicSeeds");
  state.likedVideos = [
    { id: "m1", title: "How Slipcasting Works - Ceramic Process", channelName: "Pottery Studio" },
    { id: "m2", title: "Soil Biology Impact on Plant Nutrition - John Kempf", channelName: "Regen Ag" },
    { id: "m3", title: "A Coupla Fat Guys Cooking Show - Episode 4", channelName: "Cooking Channel" },
  ];
  state.musicPlayerSeeds = {
    artists: ["télépopmusik", " massive attack "],
    tracks: [{ artist: "télépopmusik", title: "Breathe", videoId: "abc123" }],
    blockedArtists: ["blocked band"],
    updatedAt: Date.now()
  };
  const seeds = getMusicSeeds();
  assert.ok(seeds.artists.includes("télépopmusik"), "Includes music-player favorite artist");
  assert.ok(seeds.artists.includes("massive attack"), "Includes trimmed music-player artist");
  assert.ok(!seeds.artists.some(a => a.includes("slipcasting") || a.includes("soil biology") || a.includes("cooking show")),
    "Non-music hyphenated video titles must never become music artist seeds");
  const queries = [...get("getMusicQueryList")()];
  assert.ok(queries.some(q => q.includes("télépopmusik")), "Music query list includes music-player artists");
  assert.ok(!queries.some(q => q.includes("slipcasting") || q.includes("soil biology")), "Music query list excludes non-music titles");
  console.log("✅ music-player seeds integrated and non-music hyphenated titles rejected");
}

// 5. Extension background: music metadata survives slimVideo + LIKED_SYNC_BATCH
{
  const bgSrc = fs.readFileSync(new URL("../extension/scripts/background.js", import.meta.url), "utf8");

  function bootBackgroundHarness() {
    const ctx = {
      console,
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      chrome: {
        storage: {
          local: {
            get: async () => ({}),
            set: async () => {}
          }
        },
        action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
        runtime: {
          onStartup: { addListener: () => {} },
          onInstalled: { addListener: () => {} },
          onMessage: { addListener: () => {} }
        },
        tabs: { query: () => {}, sendMessage: async () => {} }
      }
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(bgSrc, ctx);
    return { get: (name) => vm.runInContext(name, ctx) };
  }

  const { get } = bootBackgroundHarness();
  const slimVideo = get("slimVideo");
  const buildSyncFields = get("buildSyncFields");
  assert.ok(typeof slimVideo === "function", "slimVideo must be defined");
  assert.ok(typeof buildSyncFields === "function", "buildSyncFields must be defined");

  // Music classification inputs must not be dropped on the way to the server.
  const slim = slimVideo({
    videoId: "abc12345678",
    title: "Kerala",
    channelName: "Bonobo - Topic",
    duration: 230,
    isTopicChannel: true,
    surface: "ytm",
    musicCredits: { song: "Kerala", artist: "Bonobo", album: "Migration" },
    src: "ll_playlist"
  });
  assert.strictEqual(slim.isTopicChannel, true, "isTopicChannel preserved");
  assert.strictEqual(slim.surface, "ytm", "surface preserved");
  assert.deepStrictEqual(slim.musicCredits, { song: "Kerala", artist: "Bonobo", album: "Migration" },
    "musicCredits preserved");
  assert.strictEqual(slim.src, "ll_playlist", "src preserved");

  // Absent metadata falls back to the watch-page defaults, not undefined.
  const plain = slimVideo({ videoId: "def12345678", title: "Some Video" });
  assert.strictEqual(plain.isTopicChannel, false);
  assert.strictEqual(plain.surface, "watch");
  assert.strictEqual(plain.musicCredits, null);
  assert.strictEqual(plain.src, null);

  // The Liked Videos playlist batch becomes r=5 ratings with full metadata.
  const fields = buildSyncFields({
    action: "LIKED_SYNC_BATCH",
    syncedAt: 1700000000000,
    videos: [
      { id: "abc12345678", title: "Kerala", channelName: "Bonobo - Topic", duration: 230,
        isTopicChannel: true, src: "ll_playlist",
        thumbnailUrl: "https://i.ytimg.com/vi/abc12345678/hqdefault.jpg" },
      { id: "xyz12345678", title: "Weird Fishes", channelName: "Radiohead", duration: 318,
        isTopicChannel: false, src: "ll_playlist" },
      { title: "no id — must be skipped" }
    ]
  });
  assert.ok(fields && fields.ratings, "batch produces ratings");
  assert.deepStrictEqual(Object.keys(fields.ratings).sort(), ["abc12345678", "xyz12345678"],
    "only rows with an id land");
  assert.strictEqual(fields.ratings.abc12345678.r, 5, "playlist rows are likes");
  assert.strictEqual(fields.ratings.abc12345678.t, 1700000000000, "batch timestamp applied");
  assert.strictEqual(fields.ratings.abc12345678.v.isTopicChannel, true, "batch keeps isTopicChannel");
  assert.strictEqual(fields.ratings.abc12345678.v.src, "ll_playlist", "batch keeps src");
  assert.strictEqual(fields.ratings.abc12345678.v.id, "abc12345678", "batch keeps the id");
  assert.strictEqual(fields.ratings.xyz12345678.v.surface, "watch", "batch defaults surface");

  // An empty scrape must not send an empty ratings map.
  assert.strictEqual(buildSyncFields({ action: "LIKED_SYNC_BATCH", videos: [] }), null);

  // A plain like keeps the music fields too.
  const likeFields = buildSyncFields({
    action: "LIKE",
    videoId: "abc12345678",
    syncedAt: 5,
    title: "Kerala",
    channelName: "Bonobo - Topic",
    isTopicChannel: true,
    surface: "ytm"
  });
  assert.strictEqual(likeFields.ratings.abc12345678.r, 5);
  assert.strictEqual(likeFields.ratings.abc12345678.v.surface, "ytm");
  assert.strictEqual(likeFields.ratings.abc12345678.v.isTopicChannel, true);

  console.log("✅ LIKED_SYNC_BATCH builds ratings and slimVideo preserves music metadata");
}

console.log("\nAll Music Feed & Anti-DJ Mix Filter tests passed!");

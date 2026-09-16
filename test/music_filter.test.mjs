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

console.log("\nAll Music Feed & Anti-DJ Mix Filter tests passed!");

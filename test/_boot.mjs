// Shared node:vm boot for app.js tests: the browser globals stubbed, state
// reset to a bare profile. Copied from pool_hygiene.test.mjs so new suites do
// not each carry their own drifting copy.
import fs from "node:fs";
import vm from "node:vm";

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

export function boot(overrides = {}) {
  const store = new Map();
  const fetchCalls = [];
  const ctx = {
    console, document: doc,
    window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: "" } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    fetch: overrides.fetch || (async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, json: async () => ({}) }; }),
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    AbortSignal: { timeout: () => null },
    AbortController: class { constructor(){ this.signal = {}; } abort(){} },
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
    topicSignals: {}, agentQueue: [], topics: [], burnedQueries: [],
    dislikedTopics: [], dislikedTopicsMeta: {}, likedTopics: [],
    smartFeedTopicsQueue: [], smartFeedUsedTopics: [], smartFeedVideos: [],
    smartFeedSuggestionPool: [], minedVideos: {}, ratingStates: {},
    groundingVerdicts: {}, searchHistory: [], cache: { videos: {} },
    ontologyGraph: { nodes: {}, edges: {} }, settings: {}, videoRatings: {},
    feedMix: { shown: [] }, blockedChannels: [], watchedHistory: {},
    candidateClassificationCache: {}, topicPolicies: {}, likedVideos: [],
  });
  return { get, state, store, fetchCalls, ctx };
}

// Copy a VM-realm value into this realm so deepStrictEqual compares shapes,
// not prototypes.
export const plain = (v) => JSON.parse(JSON.stringify(v));

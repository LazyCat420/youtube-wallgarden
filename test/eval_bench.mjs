// eval_bench.mjs — offline quality benchmark over the real composers.
// Replays a synthetic session through takeSlate in the booted app VM,
// replenishing the pool the way the preloader does, and asserts floors on
// the beyond-accuracy metric set (coverage, exposure Gini, intra-list
// diversity, max run, calibration KL, novelty share). A regression here is
// an algorithm degradation; the printed scorecard is the diagnosis.
// See plan/algorithm_audit.md §4.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const { get, state } = boot();
const takeSlate = get("takeSlate");
const recordFeedShown = get("recordFeedShown");
const eraBucketOf = get("eraBucketOf");
const ERA_BUCKETS = plain(get("ERA_BUCKETS"));
const ERA_TARGET_MIX = plain(get("ERA_TARGET_MIX")) || { recent: 0.35, mid: 0.35, classic: 0.25, vintage: 0.05 };

const now = Date.UTC(2026, 9, 9);
const DAY = 86400e3;
const eraAge = { recent: 30, mid: 2 * 365, classic: 6 * 365, vintage: 14 * 365 };
// Era supply MATCHES the target mix, so the KL floor measures composition
// quality, not supply mismatch — the composer cannot invent vintage videos.
function eraFor(i) {
  const r = (i * 2654435761) % 1000 / 1000;
  let acc = 0;
  for (const b of ERA_BUCKETS) { acc += ERA_TARGET_MIX[b] || 0; if (r < acc) return b; }
  return "recent";
}
let seq = 0;
const mk = (topic, rel) => ({
  id: "v" + (seq++), title: "t",
  channelName: "Ch" + (seq % 40),
  published: now - eraAge[eraFor(seq)] * DAY,
  _topic: topic, _rankScore: rel,
});

// Session fixture: 20 topics; "dominant" is a strong interest (2x rank). The
// preloader keeps ~8 videos per topic alive, so replenish after each slate.
const TOPICS = ["dominant", ...Array.from({ length: 19 }, (_, i) => "topic" + i)];
const PER_TOPIC = 8;
const pool = [];
const count = t => pool.reduce((n, v) => n + (v._topic === t), 0);
function replenish() {
  TOPICS.forEach(t => { for (let i = count(t); i < PER_TOPIC; i++) pool.push(mk(t, t === "dominant" ? 100 : 40)); });
}
replenish();
state.feedMix = { shown: [] };

const shownTopics = {};
let maxRun = 0, ildSum = 0, slates = 0, novelSlates = 0;
const seenTopics = new Set();
let prevTopic = null, run = 0;
const eraCounts = {};
for (let b = 0; b < 12; b++) {
  if (pool.length < 12) replenish();
  const slate = takeSlate(pool, 12);
  if (!slate.length) { replenish(); continue; }
  recordFeedShown(slate, "slate");
  slates++;
  const topics = slate.map(v => v._topic);
  const ledgerTopics = new Set(state.feedMix.shown.slice(0, state.feedMix.shown.length - topics.length).map(r => r.topic));
  if (topics.some(t => !ledgerTopics.has(t) && !seenTopics.has(t))) novelSlates++;
  topics.forEach(t => { seenTopics.add(t); shownTopics[t] = (shownTopics[t] || 0) + 1; });
  ildSum += new Set(topics).size / topics.length;
  for (let i = 0; i < topics.length; i++) {
    run = topics[i] === prevTopic ? run + 1 : 1;
    prevTopic = topics[i];
    maxRun = Math.max(maxRun, run);
  }
  slate.forEach(v => { const e = eraBucketOf(v.published, now); eraCounts[e] = (eraCounts[e] || 0) + 1; });
  replenish();
}

const totalShown = Object.values(shownTopics).reduce((a, b) => a + b, 0);
const metrics = {
  coverage: seenTopics.size / TOPICS.length,
  gini: (() => {
    const xs = Object.values(shownTopics).sort((a, b) => a - b);
    let cum = 0; xs.forEach((x, i) => { cum += (i + 1) * x; });
    return (2 * cum) / (totalShown * xs.length) - (xs.length + 1) / xs.length;
  })(),
  ild: ildSum / slates,
  maxRun,
  noveltyShare: novelSlates / slates,
  kl: (() => {
    const n = totalShown;
    return ERA_BUCKETS.reduce((s, b) => {
      const pi = Math.max(ERA_TARGET_MIX[b] || 0, 1e-4);
      const qi = Math.max((eraCounts[b] || 0) / n, 1e-4);
      return s + pi * Math.log(pi / qi);
    }, 0);
  })(),
};

const FLOORS = { coverage: 0.5, giniMax: 0.6, ild: 0.6, maxRunMax: 4, kl: 0.1, noveltyShare: 0.1 };
// noveltyShare floor is low because the fixture has a finite topic set: once
// every topic has been shown, novelty can only come from new supply, which
// today is the explore slot. Raise it when the explore drip (audit §3.5) lands.
const card = (k, v, ok) => `${ok ? "✅" : "❌"} ${k.padEnd(14)} ${typeof v === "number" ? v.toFixed(3) : v}`;
console.log("── Eval bench scorecard ──");
console.log(card("coverage", metrics.coverage, metrics.coverage >= FLOORS.coverage));
console.log(card("gini (<=)", metrics.gini, metrics.gini <= FLOORS.giniMax));
console.log(card("ILD", metrics.ild, metrics.ild >= FLOORS.ild));
console.log(card("max run (<=)", metrics.maxRun, metrics.maxRun <= FLOORS.maxRunMax));
console.log(card("era KL (<=)", metrics.kl, metrics.kl <= FLOORS.kl));
console.log(card("novelty", metrics.noveltyShare, metrics.noveltyShare >= FLOORS.noveltyShare));

assert.ok(metrics.coverage >= FLOORS.coverage, `coverage degraded: ${metrics.coverage}`);
assert.ok(metrics.gini <= FLOORS.giniMax, `exposure concentration degraded: ${metrics.gini}`);
assert.ok(metrics.ild >= FLOORS.ild, `intra-list diversity degraded: ${metrics.ild}`);
assert.ok(metrics.maxRun <= FLOORS.maxRunMax, `same-topic runs degraded: ${metrics.maxRun}`);
assert.ok(metrics.kl <= FLOORS.kl, `era calibration degraded: ${metrics.kl}`);
assert.ok(metrics.noveltyShare >= FLOORS.noveltyShare, `novelty share degraded: ${metrics.noveltyShare}`);
console.log("\nEval bench passed — no degradation.");

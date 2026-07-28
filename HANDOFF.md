# Handoff — likes → topics engine + ranked discovery (2026-07-27)

Commit `cd6b57b` (this repo) + `lazy-agent-service@5f1ab29` + `trading-service@038d365,652cdf9`
(scraper source). All three containers deployed to synology and live-verified.

## Why

54 accumulated likes were barely influencing anything:
- Only the **last 15 liked titles** reached the topic brainstormer — and after a
  sync merge not even the recent 15 (`_wgRebuildFromRatingStates` rebuilt
  `likedVideos` in Mongo key order; `slice(-15)` was an arbitrary 15 of 54).
- **Liking never created a topic.** The graph only reinforced the topic that
  *surfaced* a video; extension-synced likes had no `matchedTopics` → zero
  CO_LIKED edges; `state.likedTopics` (the graph-discovery seed) was only
  written by a manual settings input.
- Discovery pulled bland literal videos: the `before:/after:` "era" operators
  are **Google syntax that YouTube ignores**, every fetch was `sort:"date"`
  (newest-first = slop filter), and there was **no ranking** — the pool was
  shuffled, viewCount/duration discarded, and the "Explicit user rating
  override" comment at the scorer had no code under it.
- Bonus trap found during verification: the scraper's `use_ddg_first` shortcut
  sent transcript-less searches to **DuckDuckGo first, which cannot honor any
  sort** — an explicit sort silently degraded whenever DDG succeeded.

## What shipped

**Phase 0 — correctness.** `getRecentLikedVideos()` derives recent likes from
timestamped `ratingStates` (newest first, sync placeholders skipped); the
browse path switched date → relevance.

**Discovery fetch + ranking (app.js).** `fetchVideosForTopic` now fires three
real query forms — `broad` (raw topic, relevance) + `depth` (topic + qualifier
like "full process", relevance) + `proven` (view-count sort) — and ranks all
candidates with `scoreDiscoveryVideo`, a pure 4-axis port of the benchmarked
HTML-Notes heuristic (intent/authority/maturity/watchability; freshness
deliberately inverted: 90d–8y = 1.0, <7d = 0.3, Shorts = 0.15). Ranked
best-first before the 8-per-topic cap; `shuffleArray` stays for presentation
only. Liked-channel affinity (`getLikedChannelAffinity`, keyed by channel
*name* — discovery videos carry no channelId) + the previously-empty rating
override (+25 like / −50 dislike). Old date-sorted pool flushed once via
`pool_version`. The HTML fallback now parses views/duration/age so it isn't
signal-blind.

**Likes → topics mining.** `mineLikedVideosIntoTopics()` sends unmined likes
to `POST /api/wallgarden/extract-topics` (8 videos × ≤3 topics = ≤24 per call,
under the measured 25-topic output ceiling) and feeds four sinks:
1. topic pool at tier+2 (mined A=10 outranks brainstormed A=8),
2. `likedTopics` (A-tier, cap 60) — **revives the dead graph-discovery seed**,
3. `matchedTopics` backfill **without bumping the LWW `t`** + `graphProcessRating`
   → CO_LIKED edges finally form for extension likes,
4. `minedVideos` marker → idempotent; failed chunks stay unmined and retry.
Triggers: load+8s, 30s-debounced from `saveLikedVideos` (covers card/sidebar/
sync-rebuild paths).

**Taste profile + clusters.** `refreshTasteProfile()` → `POST
/api/wallgarden/taste-profile` over ALL likes (regen at 5+ new likes or 7 days)
→ ≤120-word profile + named clusters. `buildLikedClusters()` groups likes
(channel ≥2 likes seeds; singletons fold by shared mined topics) and each
brainstorm batch expands a DIFFERENT cluster; burned topics ride along as
shape-negative few-shots; umbrella-word ban added to the shared anchor block.
`/brainstorm` and `/similar` response shapes unchanged for old clients.

**Grounding gate.** `groundNextQueuedTopics()` looks ahead 5 queue topics, runs
one relevance search each, and `POST /api/wallgarden/judge-topics` verdicts
them from the *actual result titles*: REAL → +2 weight; SLOP/DEAD → pulled
from the queue + demoted to 0.5, **burned only on a second strike**. Fail-open
(missing verdicts = MIXED), 30-day verdict cache, settings toggle ("Grounding
Gate for Topics"). Live: "one man sawmill" → REAL, "water treatment" → SLOP.

**Sync.** `SYNC_FIELDS` += `mined` (per-video LWW) + `profile` (LWW on
`generatedAt`). A second browser replays remote extractions into its own pool
with zero LLM calls.

**Scraper (source of truth = `trading-service/app/scraper` — `scraper-service/app/`
is a gitignored build copy; committing there commits nothing).** `sort:"views"`
→ `sp=CAMSAhAB`; raw `sp` pass-through param; explicit relevance/views/sp now
bypass DDG-first.

## Live verification (deployed stack, real data)

- Headless browser against :8007 mined **41/54 likes → 78 new topics** in one
  pass ("slipcasting", "hide tanning", "riparium aquarium", "drying kinetics",
  "home barista techniques"…), built 78 Topic nodes + 78 CO_LIKED edges,
  generated a 5-cluster taste profile (Technical Deep Dives / Botanical &
  Terpene Science / Tactile Craft & Homesteading / Culinary Mastery & BBQ /
  Geopolitics & Market Intelligence), and the gate pulled "financial thriller
  soundtracks" as SLOP mid-run. `mined` (41) + `profile` confirmed in the Mongo
  sync doc — every browser inherits them.
- Scraper curls: views-sort returns multi-million-view classics; zero DDG log
  lines for relevance/views after the bypass fix.
- `npm test` (learn + comment-filter + **rank.test.mjs**(8) + **mining.test.mjs**(5)),
  smoke 12/12, backend vitest 500/500 (14 new), `tsc --noEmit` clean.

## Notes / not done

- 13 of 54 likes returned no usable extraction in the E2E pass; they stay
  unmined and retry on each dashboard load (idempotent).
- LLM rerank of *videos* (benchmark strategy B) is designed but deferred:
  trigger when a topic's heuristic top-8 mean `_rankScore` is low, via a new
  `/wallgarden/rerank`. Supersedes `plan/llm_filtering_plan.md`.
- `/suggest/` nginx autocomplete pre-filter (phase 5b) not wired — only add if
  the gate feels slow.
- `DISCOVERY_WEIGHTS` is a code const; expose in settings only if tuning
  becomes a habit.

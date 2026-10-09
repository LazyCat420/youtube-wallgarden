# Calibrated feed — from random topics + random videos to a composed slate

Status: **Phases 1–4 shipped 2026-09-06.** Everything below is live; the
measurements that judge it need a week of ledger — see *How to judge it*.

## The problem, as measured

The smart feed was "random topics pulling random videos". Five mechanisms
compounded, each reasonable on its own:

| # | where | what was actually happening |
|---|---|---|
| V1 | scraper `youtube_collector.py` | **Every discovery video was undated.** Live: 5/5 `published_at: null`. The date repair was gated on `require_transcript`, which the feed never sets; flat search entries carry no date. The maturity axis read its default on every row; the vintage bonus and viral penalty never fired. |
| V2 | `fillSmartFeedPreloadBuffer` | The ranked top-8 per topic was pushed into the pool and the **whole pool was shuffled**. `_rankScore` was never read again. `pickDiverseBatch` round-robined one video per topic in shuffled topic order. Score was a gate, never an order. No channel cap, no era logic (the "era diversity" comment described query-form interleaving). |
| V3 | `fetchVideosForTopic` | Three forms: relevance, relevance + a RANDOM qualifier, and `sort:"views"`. Never an `sp` token. YouTube removed sort-by-upload-date in Jan 2026, so the scraper's date branch silently returns relevance order; "views" is now blended popularity (40M-view log-cabin builds for "one man sawmill"). |
| T1 | backend `BRAINSTORM_SYSTEM_PROMPT` | Quota 25 adjacent / 40 lateral / 25 wildcard / 10 time-shift: **75% of every batch is told to leave the user's scene**, at temperature 0.90–1.05, each batch seeing ONE liked cluster. `rateTopics` grades anchoring with no user context — an on-anchor, off-taste topic rates A. `/similar` output enters ungraded; its `seeds[]` and `failedExamples` never reach the model. |
| T2 | `getWeightedRandomTopics` | An A-Res weighted SHUFFLE of the whole positive pool; the queue is drained fully before refilling. Weight decides WHEN a topic is fetched, never WHETHER. A weight-10 mined topic and a weight-4 ungraded one both get 8 videos. |

## What shipped

### Phase 1 — scraper (`trading-service` → `scraper-service`)
`--extractor-args youtubetab:approximate_date` on the yt-dlp subprocess.
Every flat search entry now carries `upload_date` (month/year real,
day-of-month = today's) and a description snippet. New fields:
`description` (≤200 chars) and `published_at_estimated`. Undated stays null.
Chapter 116 in trading-client's documentation has the measurement.

### Phase 2 — dates, era buckets, the instrument (this repo)
- `eraBucketOf`: recent <1y / mid 1–4y / classic 4–10y / vintage >10y, with a
  10-day tolerance because "N years ago" lands exactly on the edge. Undated =
  `unknown`, a clock that starts now.
- `deriveEraPrior`: Steck's p(era | user) from dated likes, smoothed toward
  `ERA_TARGET_MIX` (35/35/25/5). Equals the default with no dated likes.
- Feed-mix ledger (`state.feedMix`, local, FIFO 600): every rendered batch
  with era / topic / channel / composition mode; play and like stamp the row.
  **`wgFeedMix()`** prints shown share vs target per era, plays and likes per
  100 shown, KL(target ‖ shown), top topics and channels with their
  max-in-any-12 count, and a per-mode split. **`wgEraPrior()`** prints the prior.
- Pool version 3 flushes the undated pool. Smart-feed sort dropdown removed
  (that branch never read it).

### Phase 3 — era-aware retrieval and a composed slate (this repo)
Four forms per topic (`DISCOVERY_FORMS`):

| form | request | why |
|---|---|---|
| recent | `sp: CAMSBAgFEAE=` (popularity + this year + video) | the one era YouTube can be ASKED for |
| broad | relevance | any era, bucketed by date |
| depth | relevance on topic + facet/qualifier | intent precision |
| proven | popularity | the only supply of classic/vintage |

`sp` tokens (protobuf; verified against the repo's own `CAMSAhAB`):
today `EgQIAhAB` · week `EgQIAxAB` · month `EgQIBBAB` · year `EgQIBRAB`;
with popularity: `CAMSBAgCEAE=` / `CAMSBAgDEAE=` / `CAMSBAgEEAE=` / `CAMSBAgFEAE=`.

`rankScoreFor(v, ctx)` is the one rank scale (discovery axes ×10 + classifier
bonus + clamped legacy score × 0.4), recomputed at composition time from
current preferences.

`composeSlate(pool, n, ctx)` — pure, deterministic. Each slot takes the
candidate maximising `(1−λ)·rel − λ·KL(p ‖ q_with_candidate) − penalty·repeats`
(λ = 0.6, β = 0.01 smoothing, repeat penalty 0.08) under caps of 2 per channel
and 3 per topic per 12 (relaxed only when nothing else remains). One explore
slot mid-slate takes the best candidate from a topic never shown. Undated rows
compete as `recent` and can never satisfy an older bucket. `takeSlate` is the
mutate-and-return wrapper at both draw sites; the pool shuffle and
`pickDiverseBatch` are deleted. The per-topic keep of 8 is itself a small
composed slate (channel cap 2, no topic cap).

Cold-start fan-out lowered 6 → 4 topics so peak scraper concurrency stays
flat (18 → 16 subprocesses).

## How to judge it

Not "does it look better" — this repo has learned that lesson twice. Read
`wgFeedMix()` after a few days of browsing:

- **era**: shown share per bucket vs target, KL below what the `shuffle`
  mode rows show; plays per 100 shown per era not worse.
- **channels**: no channel's `max_in_any_12` above 2 unless the pool was
  starved.
- **per-mode**: rows stamped `shuffle` (before 2026-09-06) vs `slate`.

If classic/vintage starve (shown well under target for a day), the lever is a
year-decorated backfill query (`"${topic} 2016"`), deliberately not built
until the instrument says it is needed.

## Verification
```bash
npm test            # 13 suites incl. era_bucket, feed_mix, compose_slate
npm run build && npm run test:smoke
# console: WG_DEBUG=1; wgFeedMix(); wgEraPrior()
```

## Phase 4 — topic roles, FIT, the composed queue (shipped)

Backend (`lazy-agent-service`): roles are decided per BATCH by
`planBrainstormBatches` — one blended CORE batch that sees every liked cluster
at temperature 0.6, ADJACENT batches allocated across clusters by like share,
one small EXPLORE batch at 0.9. `rateTopics` asks FIT (HIGH/MED/LOW) next to
ANCHORING when given the taste profile and liked titles; weight = f(tier,
fit); LOW fit is dropped unless the role is explore; a topic the rater never
graded gets weight 2, not B's 4. `/similar` sees every seed strongest-first
and the failed-shape line, asks 60/30/10 adjacency-first, and is rated.
`rateFit: false` (Settings toggle `fitRatingEnabled`, default on) is the
control arm; `promptVariant` is forwarded and echoed.

Client (this repo): every topic carries `role` (core / adjacent / explore),
`bornRole`, `cluster`, `fit`, `tier`, `gen`. `composeTopicQueue` replaces the
whole-pool shuffle: 30-topic slates at 60/25/15, core calibrated across liked
clusters by like share (`buildClusterIndex`), sampling by weight times
recency-of-success, an explore share that adapts to its measured hit-rate
inside [5%, 25%] once ten explore topics have resolved. A play or a like
graduates explore/adjacent to core; an explore topic that becomes IGNORED
drops to the floor and is evicted after 21 days. Brainstorm asks for 60.
Fetch limits scale with the role's budget (10 / 8 / 5). `wgTopicMix()` prints
topics by role with engaged % of shown, core fetched share vs like share per
cluster, explore hit-rate and share, and per-arm (v1 / v2 / v2-nofit) tier-A
and engaged %.

Acceptance (evaluate after ≥ 7 days of ledger AND ≥ 20 shown topics per
role): core engaged % ≥ 1.5× the pre-change overall; explore hit-rate ≥ 10%
(the band lowers the share on its own; < 5% after two weeks → set
`mix.explore` to 0.10); the largest cluster's fetched core share within ±15
points of its like share; `v2` vs `v2-nofit` engaged % within noise at n ≥ 20
per arm → delete the FIT rubric. No prompt edits before that horizon.

## Post-judgement fix — cross-slate memory (2026-10-09)

User-visible symptom: the same topic 10–20 videos in a row. The slate's caps
and repeat penalty knew only their own 12 — a dominant topic won its 3 slots
in *every* consecutive batch, and when the pool starved the `scan(false)`
fallback discarded the caps outright. `composeSlate` now seeds its counts with
decayed recent-shown weights from the feed-mix ledger (`o.recent`, 15-minute
horizon, last 60 rows), and the relaxed scan penalises over-cap candidates
(`overCapPenalty: 5`) so a flooded pool degrades to "mostly the dominant
topic", never "only it". Breakdown.topic/channel report this-slate counts
only. Tests 13–15 in test/compose_slate.test.mjs.

Also: the pre-existing topic_queue calibration flake (shortfall path can give
the majority cluster 9 of 10) is admitted by the assertion now.

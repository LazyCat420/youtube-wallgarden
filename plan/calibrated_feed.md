# Calibrated feed — from random topics + random videos to a composed slate

Status: **Phases 1–3 shipped 2026-09-06.** Phase 4 (topic roles, fit rating,
calibrated topic queue) is designed, not built — see the end.

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

## Phase 4 — designed, not built: topic roles, fit, calibrated queue

Backend: roles decided per BATCH (one blended CORE batch that sees all
clusters at temperature 0.6, ADJACENT batches allocated across clusters by
like share, one small EXPLORE batch), a FIT rubric (HIGH/MED/LOW given the
taste profile) next to ANCHORING with `rateFit:false` as the control arm,
`/similar` adjacency-first with all seeds and the failed-examples line
rendered, `promptVariant` forwarded, grounding evidence carrying views and
years. Client: topics stamped `role/bornRole/cluster/fit/gen`,
`composeTopicQueue` (30-topic slates, 60/25/15 core/adjacent/explore with the
explore share adapting to its measured hit-rate, core calibrated across
clusters by like share), explore topics graduate on a play or like and expire
when IGNORED, `wgTopicMix()`. The full design with line anchors is in the
session plan file; acceptance needs ≥7 days of ledger and ≥20 shown topics
per role before any prompt is edited again.

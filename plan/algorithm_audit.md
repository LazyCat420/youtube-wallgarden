# Algorithm audit — what works, what degrades, and the benchmark that catches it

Date: 2026-10-09. Sources: the code as it stands on `master`, the generation
pipeline in `lazy-agent-service/src/services/wallgarden/WallgardenService.ts`
(scouted 2026-10-09), and the recommender-systems literature cited inline.

## 1. What's working (mapped to the literature)

| Mechanism | Literature | Status |
|---|---|---|
| Era-calibrated slate composition | Steck, *Calibrated Recommendations* (RecSys 2018, [10.1145/3240323.3240372](https://dl.acm.org/doi/10.1145/3240323.3240372)); survey: [10.1145/3789266](https://dl.acm.org/doi/10.1145/3789266) | **Working.** `composeSlate` maximises `(1−λ)·rel − λ·KL(p‖q)`; tests pin the KL. |
| Role quotas (core/adjacent/explore) | Explore/exploit bandits; YouTube's satisfaction-weighted ranking (Covington et al. 2016) | **Working structurally.** 60/25/15 with adaptive explore share inside [5%, 25%]. |
| Negative feedback that generalises | — | **Working.** Burns take siblings down, parole after 6 months; dislikes penalise ranking. |
| Cross-slate memory | Session-aware re-ranking | **Shipped 2026-10-09.** 15-min decayed ledger seeds caps+penalty. |
| Cold-start diversity gate | — | **Shipped 2026-10-09.** First batch never composes from a one-topic pool. |
| Pool hygiene | — | **Working.** 7-day decay, 21-day eviction, hard cap, purge logs. |
| Signal-gated generation | — | **Working as designed** (thresholds imp 10 / open 4 / play 3), but see §2.3. |
| Grounding gate | — | **Working.** Topics judged by their actual YouTube results before spend. |

## 2. What's not working / where it degrades

### 2.1 No semantic distance — branching is an accident
**The user-visible "too circular" complaint is structural.** Topics are raw
strings; there is no embedding, no taxonomy, no distance metric anywhere in
either repo. The generation side (scouted) has **no mechanism forcing new
topics away from the existing pool**: dedup is `Set` within a single
brainstorm call only. Two calls can produce "kiln building" and "kiln build
technique" forever — same cluster, new strings, zero new information. The
ontology graph exists but only *injects neighbours* (capped 2/queue) — it
never measures how far a candidate is from what the pool already covers.

**Lever (top priority):** embed topics once (cheap model, cached) and
enforce `min_distance(candidate, pool)` per role: adjacent ≥ 0.3, explore ≥
0.6 cosine distance. This single change converts "more strings" into actual
coverage growth. Serendipity without a representation is luck (cf.
*Kotkov et al.*, serendipity surveys; *Kunaver & Požrl* 2017 diversity
survey, [10.1145/2926720](https://dl.acm.org/doi/10.1145/2926720)).

### 2.2 Single supply source — every video is a topic search hit
`fetchVideosForTopic` is the only producer. Channel RSS sync, Reddit
subscription feeds (both already implemented for the subscription view),
and trending sources never enter the smart-feed pool. The feed can only be
as diverse as topic-search results are. Peppering the pool from liked
channels' RSS + `r/<sub>` hot + a popularity form is mostly *wiring*, since
the fetchers exist.

### 2.3 Generation is starved by its own gating
New topics require crossing a signal threshold — but the pool a new browser
starts with only shrinks (decay/eviction). Cold-start and quiet sessions
get no new lateral ideas because nothing crosses `imp: 10` when the feed
repeats the same 5 topics. Threshold-gating is right for *expansion of an
active interest*; it is wrong as the only path to *new* topics. The
explored-but-ignored explore topics die in 21 days while core dominates
60% of every queue.

**Lever:** a small periodic explore drip (e.g. 1 lateral batch/day, uncoupled
from signals), or raise the explore band floor when `resolved < N`.

### 2.4 The rank scale mixes incompatible units
`rankScoreFor = axis.score*10 + classificationBonus + clamp(legacy,±15)*0.4`.
`axis.score` is a heuristic composite (recency, channel affinity, form rank);
`legacy` is a keyword match score. No calibration, no per-axis weighting
learned from outcomes — and the outcome data to learn it **already exists**
(`state.feedMix`, `topicSignals`, `minedVideos`). Until axes are fit to
plays/likes (even logistic regression on the ledger), rank ordering is
folklore.

### 2.5 Search path degraded silently (fixed 2026-10-09, commit 84a9a49)
The yt-dlp search stream aborted at 15s inside the scraper's own 25s window,
falling back to an HTML scraper with a double-encoded `sp` token — the
"search returns 1–2 videos" report. Now 30s; drops are counted in
`wgSearchDrops()`.

### 2.6 No evaluation loop
The repo measures *composition* (`wgFeedMix`, `wgTopicMix`) but has no
benchmark that fails when quality degrades. Every prior regression
(one-topic walls, undated pool, spam floods) was found by a human
after weeks. §4 fixes this.

## 3. Top 10 improvement levers, ranked by (impact ÷ effort)

1. **Topic embeddings + min-distance generation** (§2.1) — kills circularity at the root. *(lazy-agent-service + client cache)*
2. **Offline eval benchmark as a test** (§4, done here) — you cannot tune what you can't regress.
3. **Multi-source supply: channel RSS, Reddit, trending into the pool** (§2.2) — mostly wiring; sources carry `_source` tags so a dislike kills the route, not the topic.
4. **Fit rank axes to the outcome ledger** (§2.4) — logistic regression over `feedMix.shown` → plays/likes; ship as new axis weights behind an arm tag.
5. **Explore drip independent of signals** (§2.3) — guarantees the pool keeps growing.
6. **Serendipity metric + target** — measure "liked videos that were ≥0.6 from the pool at show time"; aim > 10%.
7. **DPP instead of the repeat penalty** for slate diversity (*Chen et al. 2018, Fast Greedy MAP DPP*, [1905.06589 survey](https://ar5iv.labs.arxiv.org/html/1905.06589)) — better than additive penalties once topic vectors exist; skip until #1 lands.
8. **Query-form coverage for long-tail topics** — the 4 discovery forms are tuned for popular topics; sparse topics return the same top-8 every cycle. Add an offset/cursor so re-fetches page deeper.
9. **Popularity-bias correction** — `proven` form floods famous channels; cap channel exposure at pool level, not just slate level.
10. **Watch-party signal**: `imp` without dwell-quality is weak evidence; record dwell seconds and weight thresholds by it.

## 4. Eval benchmark (implemented: `test/eval_bench.mjs`)

Offline metrics computed by replaying the real composers (`composeSlate`,
`composeTopicQueue`) over synthetic sessions in the booted app VM — the
standard beyond-accuracy set (*Jannach et al., RecSys 2010, coverage &
serendipity*; *Zhang et al., rank-aware novelty/diversity*,
[10.1145/2043932.2043955](https://dl.acm.org/doi/10.1145/2043932.2043955)):

| Metric | Definition | Floor (fails CI below) |
|---|---|---|
| Topic coverage | distinct topics shown ÷ pool topics | ≥ 0.5 |
| Exposure Gini | concentration of slate slots per topic | ≤ 0.6 |
| Intra-list diversity | mean per-slate distinct topics / slate size | ≥ 0.6 |
| Max run | longest same-topic streak across consecutive slates | ≤ 4 |
| Calibration KL | era share vs target (Steck) | ≤ 0.1 |
| Novelty share | slates containing a never-shown topic | ≥ 0.5 |

A regression in any of these — from a prompt change, a weight change, a new
form, a scoring edit — fails `npm test` with the metric printed. That is the
degradation tripwire the repo has been missing. Run it standalone:
`node test/eval_bench.mjs`.

## 5. How to judge the live system

Existing instruments stay authoritative: `wgFeedMix()` (era KL, plays/100
shown, max-in-any-12), `wgTopicMix()` (role engagement, explore hit-rate),
plus `wgSearchDrops()` (new). The bench catches *structural* regressions
offline; the ledger instruments catch *fit* regressions online. Both must
move together after any algorithm change.

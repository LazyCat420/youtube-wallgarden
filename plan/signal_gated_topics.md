# Signal-gated topics — blueprint

Status: **Phases 1, 2 and Wave 1 all shipped 2026-08-22.**
Phase 2's *effect* is **unproven** — see *First measurement* below, which found
no difference. The instrument to settle it is in place.

## The problem

Browsing was treated as a request for topics. Three mechanisms compounded:

| mechanism | cost |
|---|---|
| `playVideo` → 3s timer → `/similar` at `numTopics: 10` | ~10 topics **per video played**, no in-flight guard, timer never cleared — 5 quick clicks = 5 concurrent calls |
| the same path pushed the raw **video title** into `state.topics` at weight 2 | the pool filled with things like `"The Fox News Episode \| Lemonade Stand 🍋"` |
| `fillSmartFeedPreloadBuffer` self-recursed every **1.5s** while the video pool was under 1000, re-checking a gate that brainstormed 100 topics every 15s | ~**400 topics/min produced vs ~40/min consumed**, at **8 LLM calls** per brainstorm (4 generate + 4 rate) |

Plus a 100-topic brainstorm on every page load, and up to 6 concurrent
`/classify-candidates` calls per 1.5s tick.

The user's summary was exact: *"browsing doesn't mean I like it… it's very
sensitive right now."*

## The principle

**Browsing counts. It does not generate.**

Interest accumulates in a ledger. Topics are generated only when a counter
crosses a threshold, or on an outright like — and then only in one batched
request, spent while the user is idle.

## Phase 1 — what shipped

### 1. The signal ledger (`state.topicSignals`)

Thresholds are tiered by how much intent the action carries:

| signal | what it means | threshold |
|---|---|---|
| `imp` | a video from this topic held the viewport 5s (reuses the existing dwell observer) | **10** |
| `open` | searched it, or clicked its suggestion pill | **4** |
| `play` | actually played a video that came from it | **3** |

`recordTopicSignal(topic, kind, dedupeKey)` increments and, on crossing,
enqueues one job. Two details that matter:

- **Impressions dedupe on the video id.** Without it, scrolling one topic's
  eight cards past the viewport spends eight of the ten impressions the
  threshold is meant to represent. Ten impressions now means ten *different*
  videos.
- **Crossing re-arms from the current total** (`rec.f[kind] = total`), so the
  4th, 5th and 6th play do not each enqueue again; another full threshold of
  fresh interest is required.

A burned or disliked topic can never climb back through browsing.

### 2. Cross-browser counters that neither lose nor inflate

Every other synced field uses per-key last-write-wins. **LWW is wrong here**:
Chrome sees a topic 5 times and Vivaldi 5 times, and whole-record LWW discards
one of them on every push — the threshold of 10 is never reached. **Sum is
wrong in the other direction**: the client re-pushes its entire map on a 1.5s
debounce, so summing inflates the count on every push.

So each browser owns a sub-counter and the merge takes the **max per
(topic, clientId, kind)** — monotonic, therefore lossless *and* idempotent. The
effective total is the sum across clients, taken at read time by
`topicSignalTotal()`. `_merge_topic_signals` in `sync-service/main.py` mirrors
this server-side; `topicSignals` is now in `SYNC_FIELDS`.

### 3. The checklist (`state.agentQueue`)

Jobs accumulate and are spent in one pass. A flush requires **all** of:
a non-empty queue, **25s of user idleness**, and **60s since the last flush**.
So it never interrupts active browsing, and one flush carries everything
pending.

Budget scales with evidence, not with elapsed time:
`min(15, max(2, jobs × 2))` — one like costs ~2 topics, a long session's worth
of signal costs at most 15. The cap sits under the measured ~25-item output
ceiling; `/similar` is a **single un-batched call** on the backend, so unlike
brainstorm it has no fan-out to rescue an over-long request that bails
mid-array.

"Brainstorm More" spends the checklist first and only falls back to a cold
brainstorm when nothing is pending.

### 4. Removals

- `playVideo` and `triggerGlobalSearch` no longer generate — they record.
- No brainstorm inside the preload loop; it fetches videos for topics that
  already earned their place. An empty queue toasts instead of spending.
- No page-load brainstorm. Mining unmined likes survives — it converts a "yes"
  the user already gave rather than inventing anything.
- `generateSimilarTopicsFromSearch` → `generateTopicsForSeeds`, which also
  fixes two latent bugs on that path: it used `burnedQueries.includes()`
  (raw substring, so burns never generalised) and compared un-normalised
  phrases (so a Title-Case reply duplicated a pool entry).

### 5. One-time pool purge

`purgeUnearnedTopics()` keeps what was earned — mined-from-a-like (10/6),
hand-added, tier-A (8), and every negative weight (a burn is a decision) — and
drops weight-≤2 `/similar` output and anything shaped like a raw video title.
Runs once, guarded by `topic_purge_version`, and writes `topic_purge_log` with
the full list of what went, so it can be inspected rather than trusted.

### 6. Instrumentation

There was **no historical baseline** — the container's logs reset on deploy and
prism's per-project stats need auth. So the counter *is* the measurement:
`countedFetch` wraps all six wallgarden LLM endpoints; read it in the console
with `wgCallStats()`, reset with `wgResetCallStats()`.

## Phase 2 — the statistics package (shipped, effect unproven)

The finding that motivates it: **nothing about outcomes ever reaches the
model.** Grounding verdicts (REAL/MIXED/SLOP) are computed and thrown away.
Tier ratings are returned and never fed back. `failedExamples` is currently a
duplicate subset of `burnedQueries` — the one field with real instructional
leverage ("study their SHAPE") is fed redundant data.

Input scaling is known-safe: `generateTasteProfile` already sends up to 300
liked videos in one call, and a brainstorm batch uses **~3% of the Jetson's
65,536-token window**. The binding constraint is the output array (~25 items),
not the input.

So the package is cheap to send and should carry outcomes, not more lists:

- per topic: tier awarded, grounding verdict, videos yielded, **likes yielded**,
  impressions with no engagement;
- positive few-shots — topics that led to actual likes, with counts;
- negative few-shots — topics with many impressions and zero engagement. These
  are *different data* from `burnedQueries`, which is what that slot needs.

The ledger from Phase 1 is exactly the substrate for this, which is why it
ships first.

### What shipped

`buildTopicOutcomes()` (client) derives three classes and
`buildOutcomesBlock()` (backend) renders them into the brainstorm and similar
prompts:

- **PROVEN** — liked, or played 2+ times.
- **IGNORED** — shown 8+ times with zero plays, zero opens, zero likes.
- **SLOP** — SLOP/DEAD grounding verdicts, previously computed and discarded.

IGNORED is the half that justifies the tokens: those topics were produced by a
previous run of this same prompt, surfaced repeatedly, and never touched. The
user never rejected them by hand, so they are in no blacklist — only the
counters know. A single open or play clears the verdict, so it is an engagement
signal and not a shown-count blacklist.

`failedExamples` now carries those measured failures instead of a duplicate
slice of `burnedQueries`. The block is withheld below 3 measured items, so a
fresh account gets exactly the prompt it got before. `/similar` also stopped
dropping `failedExamples`, which it had destructured away since it was written.

### Built to be disprovable

- Settings toggle: **Use measured outcomes in prompts** — switches arms on one
  account.
- Every generated topic is stamped `src: "stats" | "flat"`. Without that stamp
  the arms could never be compared on outcomes — the same failure as
  `agent_skills`, where 145 versions joined 0 outcome rows.
- `wgPromptAB()` scores both arms on tier-A rate and on engagement. Engagement
  is rated over topics actually **shown**, not over topics produced, so an arm
  is not punished for being more prolific. It prints n and says when n is too
  small to mean anything.
- `wgOutcomes()` prints what the model is currently being told.

### First measurement — no difference found

Three paired runs against the live Jetson, same seeds, 10 topics per run,
synthetic outcomes (the real ledger is still filling):

| arm | n | filler-shaped | tier-A |
|---|---|---|---|
| flat  | 30 | 3 (10%) | 29 (96%) |
| stats | 30 | 3 (10%) | 28 (93%) |

"Filler-shaped" greps the prompt's own banned vocabulary (techniques, basics,
guide, studies, analysis, methods, …). **Within noise on both metrics.**

The first pair looked better for the stats arm by eye — tighter phrases, fewer
"-techniques" endings — and that impression did not survive n=30. Worth
recording as exactly the thing this repo keeps relearning.

Three caveats, none of which rescue the result:
- the outcomes were **synthetic**; real accumulated ones may behave differently;
- tier-A rate is a **proxy**. The metric that matters is whether the user plays
  the topics, which needs the counters to fill;
- one seed pair, n=30 per arm.

So: shipped, mechanically verified, cheap (<1k tokens, withheld when empty),
and **not yet shown to help**. Re-run `wgPromptAB()` once both arms have ~20
topics with real engagement behind them.

### How Phase 2 must be judged

Not "does it work?" but **"does it beat the free signal already on the desk?"**
The free baseline is today's flat context (interests, liked titles, taste
profile). Same seeds, with-stats vs without, scored on tier-A rate and grounding
REAL rate.

This scepticism is earned: an embedding gate was tried on this exact problem and
scored **26% precision — worse than useless**, while a second cheap LLM pass
lifted tier-A from 43% to 71%. Assume nothing.

Let the counters accumulate for about a week first. Editing faster than the
measurement horizon makes the change unfalsifiable.

## Verification

```bash
npm test            # includes test/signal_gating.test.mjs (10 checks)
npm run test:merge  # sync-service mergers, 21 checks
npm run build && npm run test:smoke
```

The behavioural tests run against the new functions, so on the old file they
fail with "recordTopicSignal is not defined" — which proves the code is new,
not that the behaviour changed. Test 10 is the honest gate: it greps for the
four old spawn paths, and **all four were confirmed present in the old file and
absent in the new one**.

Live check after deploy: open the dashboard, `wgResetCallStats()`, browse
without liking anything for a few minutes, then `wgCallStats()`. Expect **0**
topic-generating calls; previously this was ~8 per 15s plus one per video
played.


---

# Wave 1 — pool hygiene + video anti-spam (shipped 2026-08-22)

`youtube-wallgarden@a31094d` + `trading-service@5513c31` (scraper). Both
deployed and live-verified.

Phases 1-2 fixed how topics are BORN. Two audits found the remaining rot was
in how they DIE and how videos are filtered.

## The pool had no concept of time

Every ageing mechanism was dead or inverted:

| mechanism | state before |
|---|---|
| decay | keyed on `smartFeedUsedTopics` — **never persisted**, reset on nav. The one prune guaranteed to run (page load) decayed *nothing*, every time |
| weight eviction | `Math.max(0.5, …)` floor made the `weight !== 0` filter unreachable |
| the 400 cap | decay only touched **served** topics, so the cap's tail was the engaged ones. Never-served silt at birth weight 5 outlived evidence at 0.5 |
| `addedAt` | written at four sites, **read nowhere** |
| `topicSignals` | fed the prompt and a console tool. IGNORED topics were re-sampled at full weight forever |

Now: decay keys on wall-clock staleness (7d), eviction at the floor after 21
dead days with a `topic_evict_log`, and the cap exempts PROVEN topics. Unknown
age means "clock starts now" — the existing suite caught that footgun.

Selection skips IGNORED topics via a predicate **shared** with
`buildTopicOutcomes` so the two cannot drift. Retirement is soft: one open,
play or like flips the predicate and the topic is back. Never auto-burns.

## Burns are sentences now

6 months, doubling on re-burn after parole. Records are `{q,t,strikes}`;
readers tolerate the legacy bare-string shape. Dislikes added *by* a burn are
tagged and parole with it; hand-typed ones stay permanent.

## Phase 1 had starved the grounding gate

`scheduleGrounding` is a debounce, and the preload loop re-armed its 5s timer
every ~1.5s — so the gate fired only when a fetch happened to run past ~3.5s.
A race, not a cadence. It now runs on its own 90s interval.

SLOP/DEAD verdicts cache **7d**, not 30d. That is what makes
burn-on-second-strike reachable at all: the candidate filter skips any topic
holding a verdict, so a flat 30d cache meant a first strike could not be
re-judged for a month. `MIXED` was a documented verdict with no branch.

**Cost note:** the gate genuinely runs now, which it previously did not. It is
self-limiting (it returns early once queued topics all hold verdicts) but a
large unjudged pool will trickle ~5 topics per 90s until it catches up.

## burnTopic leaked

Pool videos, rendered videos, ledger records and grounding verdicts all
survived a burn, because the cleanup was open-coded in the **manual** nuke path
only — so every *automatic* burn left up to 8 videos of the burned topic in the
persisted pool. That cleanup moved into `burnTopic`. Both queue-refill sites
got the `isBurned` filter only `initSmartFeed` had, and the last automatic
100-topic brainstorm (unreachable behind a double guard, one edit from
resurrection) is deleted.

Removing a topic from the **liked** list called `nukeDiscoverTopic` — "I'm less
into this" recorded as "never again, and demote every sibling". Fixed.

## Video anti-spam

Every filter was a soft penalty on a scale where only -10 mattered: a 45s
ALL-CAPS 0-view short passed everything. `isSpamShapedVideo` is a binary gate
running before scoring and before the classifier spends a call — shorts (so
`muteShorts` finally applies to the smart feed, having been enforced at four
render sites, none of them the main discovery surface), the extension's proven
ALL-CAPS/`!!!` thresholds (which until now only protected youtube.com), and a
<100-view floor exempting liked channels.

**Measured on a live 25-item batch: 8 dropped (all genuinely 16-48s shorts),
17 reached the classifier.** The view floor did not fire in that sample — it
is the least-exercised rule and the most likely to need retuning.

Discovery videos hardcoded `channelId: ""` at four sites because the scraper
dropped it. Fixed upstream (`YouTubeVideo.channel_id`); **live coverage is now
25/25**. Auto-blocking was separately dead: `graphGetDislikedChannels` returns
the channel NAME in `id` (its comment says otherwise), `syncFeeds` wrote it
into both fields, and the `!bc.id` guard then rejected it at all seven filter
sites. Those seven copies are now one `isChannelBlocked` matching names by
**equality** — blocking "Tech" used to hide every channel containing "tech".

Only 15 of up to 25 candidates were classified; the rest sailed past the
NOVELTY/OFF_TOPIC drop unlabelled. Now all of them. The verdict cache was keyed
on video id with no TTL, so one OFF_TOPIC verdict for topic A poisoned that
video for every other topic forever — now topic-scoped, 30d TTL.

A dislike bounced off the pool: entries persisted with `_score` baked in, so
the -15 and -50 penalties never applied to up to 1000 queued videos for 14
days. `evictPoolForDislike` drops topic- and channel-mates and unfreezes the
rest; both dislike buttons call it.

Old uploads were double-rewarded (maturity 0.85 **and** +3 vintage). Maturity
tapers to 0.6 past 12 years; vintage is +1, bounded to 2008-2023.

## Verification

67 checks across 9 suites, 21 merge tests, build, smoke 12/12. The new suites
drive the real functions — `evictPoolForDislike` was extracted specifically so
its test stopped re-implementing it. The behavioural tests fail on the old file
with "not defined", so a regression gate greps the six removed mechanisms; all
six were confirmed **present in the old file and absent now**. Two existing
tests pinned contracts this change deliberately breaks and were rewritten.

## Wave 2 (not built)

Near-duplicate signature merge on add — `topicSignature`/subset machinery
exists but is burn-only, and near-dups **split the ledger counters**, which
suppresses the very thresholds meant to detect them. Channel reputation
(now possible: discovery has real ids). Graph node decay — node weights never
decay, so `n.weight > 3` re-injects pool-evicted topics into prompts forever,
and graph-injected queue topics bypass pool hygiene entirely. Sub-feed quality
filtering (`syncFeeds` requests no duration/views at all).

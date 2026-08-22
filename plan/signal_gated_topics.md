# Signal-gated topics — blueprint

Status: **Phase 1 shipped 2026-08-22.** Phase 2 (statistics package) designed
below, not yet built — deliberately, see *Sequencing*.

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

## Phase 2 — the statistics package (designed, not built)

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

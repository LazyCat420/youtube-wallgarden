# Discovery feed: reset, like dominance, channel quality

Date: 2026-11-15. Audit of `app/app.js` (12010 lines), `sync-service/brain_graph.py`
(719), `sync-service/main.py` (339), `extension/scripts/*` as they stand on
`master`. Line numbers are the current file.

**Status 2026-11-15:** Phases A1 (reset + `resetAt` tombstone), A2 (like dominance:
provenance, weights, core quota, ranking) and the anti-stickiness items 1-2
(play-proven expiry, narrowed decay exemption) are implemented and tested. Not
yet built: near-duplicate collapse, the daily explore drip, the server frontier
fix, and the whole channel-quality Phase B.

## Verdict on "purge the topic list, keep the likes"

Yes, and it will help immediately — but **a purge alone regresses in ~2 weeks**
because the same four rules that make topics sticky will rebuild the same shape
from the next brainstorm batch. Ship the reset *with* the rule changes below.
Two sync details make a naive purge useless:

- `topics` is browser-local (`SYNC_FIELDS` does **not** include it, `main.py:116`),
  so clearing it works locally.
- `topicSignals` **is** synced and merged per-client by max (`main.py:193`,
  `app.js:2303`), so a local wipe is resurrected by the next pull. A reset needs a
  server-visible tombstone epoch (`resetAt`), not just local deletion.

## 1. Why likes lose and old topics stick

| # | Mechanism | Code | Effect |
|---|---|---|---|
| 1 | Generated topics get core seats two ways | `app.js:230-235`, `:8906` | The backend roles planner returns `role: "core"` for a whole brainstorm batch, and `topicRole` honours any stored role; legacy `weight >= 10` also derives core. Either way a guess takes a core seat with zero engagement evidence. Core is 60% of every queue (`QUEUE_COMPOSE`, `:219-227`). |
| 2 | Mined-like weight = tier + 2 | `app.js:8698` | A-tier like = 10, **B-tier like = 6** — below a brainstorm A-tier's 8. Remote-synced mined replay forces tier B/weight 4 (`:2404-2406`), so a like mined in another browser enters at 6. `getScoreAndMatches` adds raw `topic.weight` per title hit (`:4298`), so generated topics outrank liked ones in video ranking too. |
| 3 | PROVEN immunity is permanent for plays | `app.js:8427-8432` | `play >= 2` → proven forever (plays never decay). Proven topics are exempt from decay (`:997-1001`), exempt from 21-day eviction (`:1020`), and keep seats in the 400-topic cap (`:1043-1051`). One generated topic that got two plays is immortal. |
| 4 | Queue is composed once, then drained FIFO | `app.js:318-384`, `:442`, `:10078` | Likes only reorder the **front** of an existing 30-topic composition (`:8714-8722`); the remaining 29 slots are the old composition. |
| 5 | Likes only re-rank through cluster share | `buildClusterIndex` `:254`, `:357-361` | A like steers core slots only if its mined topic is already mapped to a cluster; a fresh like's topic is often not. |
| 6 | Ignore needs 8 unengaged impressions and a play/open reset | `app.js:8412-8424` | A topic played once ever can never be retired; impression counters are the only kill path. |
| 7 | Server brain re-ranks the same closed node set | `brain_graph.py:272`, `:294-295`, `:337-341` | PPR seeds are decayed likes only (restart α = 0.25); no node can enter that is not already a rating/mined/signal label. Frontier = `imp == 0` only (`:357`), so a topic that was ever shown is never "new". |
| 8 | No reset affordance exists | `purgeUnearnedTopics` `:1605-1633` | Version-gated one-shot (`TOPIC_PURGE_VERSION = 1`); no UI to clear topics while keeping likes. Settings only offers Force Prune (graph), Remove All (channels), Clear All (blocked), clear liked videos, delete profile. |

Net: likes are a **tie-breaker**, not the driver. Generated guesses get equal or
better seats, and once a guess gets two plays it outranks everything forever.

## 2. Phase A — reset that keeps likes

New `resetDiscoveryFeed({ keepLikes: true })` in `app/app.js`, exposed as
`window.wgResetDiscovery` and a Settings → Discovery "Reset topics (keep likes)"
button next to `btn-prune-graph` (`app/index.html:889`).

**Earned set** (what survives):
1. topics in `minedVideos[*].topics`
2. `discoveryTopic` + `matchedTopics` of every `ratingStates[*].r === 5`
3. `likedTopics`
4. hand-added topics (`src === "hand"`)
5. topics with `play > 0` inside 90 days

Everything else dropped, with a `topic_purge_log` entry (`{at, before, after, dropped}`,
same shape as `:1630`).

**Weight after reset:** `weight = clamp(2 + 4 * decayedLikes, 2, 16)` per earned
topic, `role: "core"`, `bornRole: "core"`, `src: "like-mined"` where applicable.

**Cleared:** `topics` (to the earned set), `topic_signals` (all imp/open/play),
`smart_feed_pool`, `smart_feed_used_topics` (in-memory), `feed_mix` (the 24h
ledger), `smart_feed_videos`, `smartFeedTopicsQueue`; bump `pool_version` → `"5"`
(`:1437`) and `topic_purge_version` → `2`.

**Preserved:** `rating_states`, `mined_videos`, `liked_topics`, `avoided_videos`,
`rejected_facets`, `blocked_channels`, `burned_queries`, `disliked_topics`,
`queue`, `playlists`, `watched`, `settings`, `topic_policies`.

**Server tombstone:** add `resetAt` (int ms, whole-value LWW) to `SYNC_FIELDS`
(`main.py:116`) and `_wgSyncSnapshot()` (`app.js:2232`). Then:
- `_merge_topic_signals` (`main.py:193`) drops records with `t < resetAt`.
- `brain_graph.rank_brain_topics` (`:228-231`) ignores `topicSignals` older than
  `resetAt`; ratings and `mined` are **not** filtered — likes must survive.
- The reset writes `resetAt = Date.now()` locally and pushes it before the
  snapshot; every browser and the server honour it.

## 3. Phase A — make likes the driver

1. **Provenance.** Stamp `src` on every insert: `like-mined` (`:8704`),
   `brainstorm` (`:8906`), `seed` (`:9028`), `hand`. Backfill legacy entries
   lazily in `topicRole` from `minedVideos` membership.
2. **Role fix.** `topicRole` (`:230-235`): drop `weight >= 10` as a core
   derivation. Core = like-mined, in `likedTopics`, hand-added, or proven by a
   play inside 90 days. Brainstorm/seed topics are `adjacent` at best, honouring
   the backend `role` only down to `adjacent` (never `core`).
3. **Weight bands.** like-mined `A: 10 + 2*min(decayedLikes,3)` (cap 16),
   `B: 9 + 2*min(decayedLikes,3)` — both strictly above the brainstorm cap of
   `6` on insert (`generateBrainstormTopics`) and the seed's `5`. Fix the remote
   replay (`:2404-2406`) to preserve the mined tier in the synced `mined` payload
   instead of forcing B/4, and give tier-less remote entries weight 8.
4. **Queue recomposition on like.** In `applyMinedTopics`, instead of unshifting
   into the stale queue: drop pending entries whose topic is `src === "brainstorm"`
   and not liked, then `unshift` the mined topics (current `:8714-8722` becomes
   the fallback only when the queue is already short).
5. **Core split.** In `composeTopicQueue` (`:318-384`) split the core quota:
   `coreLiked` ≥ 50% of core slots (from like-mined/proven/hand), `coreOther`
   fills the rest. Keep the Steck cluster calibration over the liked half.
6. **Ranking.** `getScoreAndMatches` (`:4298`): multiply the weight bonus by
   `1.5` for like-mined topics. `scoreDiscoveryVideo` authority (`:4243-4248`):
   replace the binary `likedChannel` flag with
   `0.35 * min(1, decayedLikesOfTopic / 3) + 0.15 * likedChannel`.

## 4. Phase A — anti-stickiness (so the reset stays reset)

1. **Play-proven expires.** Add `lastPlayAt` to the signal record; `isProvenTopic`
   requires `play > 0 && lastPlayAt` inside 90 days. Keeps real favourites,
   retires the topic that got two plays a year ago.
2. **Decay applies to brainstorm proven topics.** `pruneTopicPool` (`:997-1001`):
   PROVEN exemption only for like-mined/hand topics; brainstorm/seed proven
   topics decay like everything else.
3. **Near-duplicate collapse.** At insert, compute `topicSignature` (`:592`) and
   skip/merge when Jaccard ≥ 0.8 against an existing topic (same cluster, new
   string is the audit's "no semantic distance" failure, `plan/algorithm_audit.md` §2.1).
4. **Explore drip.** One lateral batch per day from the top like-mined seed via
   `generateTopicsForSeeds` (`:8961`), `bornRole: "explore"`, uncoupled from
   thresholds. Without this the pool only shrinks between likes.
5. **Frontier fix on the server.** `brain_graph.py:357`: frontier should be
   "low impressions **and** high PPR", not `imp == 0`; expose
   `/sync/brain/frontier-seeds` (currently only a key inside the
   recommendations response, `main.py:265`).

## 5. Phase B — channel-quality layer

Today there is **no channel-level signal**: authority is per-video
(`0.5*log10(views)/6.5 + 0.5*likedChannel`, `:4243-4248`), the only channel gate
is `<100` views (`:7473`), the only aggregate is `getLikedChannelAffinity`
(`:3944`), and no source returns subscriber or verified data (scraper mapping
`:9556-9578`; Google path never calls `channels?part=statistics`).

**B1. `buildChannelQuality()`** — cached, invalidated with
`invalidateLikedChannelCache()`; keyed by `channelId || lowercased name`; built
from state only:

```
likes, dislikes, plays, impressions  <- ratingStates / topicSignals / watchedHistory
medianViews                          <- pool videos for that channel
q = 0.45*min(1, log10(medianViews)/6.5)
  + 0.35*min(1, likes/3)
  - 0.50*min(1, dislikes/2)
  - 0.40*min(1, unengagedImpressions/8)
```

**B2. Gates** in the fetch filter (`:9692-9718`, beside `isSpamShapedVideo`):
- drop when `dislikes >= 2`
- drop when `impressions >= 8 && plays === 0` (high-view spam: the channel is
  shown and never chosen)
- demote when the channel has ≥3 pool videos, all `viewCount > 5M`, zero
  likes/plays
- keep the liked-channel exemption

**B3. Scoring:** `authority += 0.25 * q` in `scoreDiscoveryVideo`; pass `q` via
`ctx` from `buildSlateCtx` (`:9381`). Keep the per-slate channel cap of 2
(`SLATE_DEFAULTS`, `:9214-9222`) and add a cross-slate cap of 3 per channel per
24h using the existing `feedMix.shown` rows (`:4081-4097`).

**B4. Quality-by-construction supply:** add a fifth fetch form
`fetchLikedChannelUploads()` for the top N liked channels (channel id from
`ratingStates[*].v.channelId`), fed into the pool beside the four search forms
(`:9545-9600`). Uploads from channels you already liked cannot be spam channels.
This also fixes the audit's "single supply source" finding (`algorithm_audit.md` §2.2).

**B5. Subscriber/verified (optional, needs a fetch):** scraper forwards
`channel_follower_count` / `channel_is_verified` (yt-dlp flat output already has
them) or a Google `channels?part=statistics` batch for the top 20 pool channels.
Fold into `q` as a capped bonus (`+0.15` for ≥100k subs, verified badge `+0.05`).
Do not block Phase B on this.

## 6. Verification

- New Node tests: `test/reset.test.mjs` (earned set, preserved keys, weight
  formula), `test/channel_quality.test.mjs` (gates, spam demotion, liked-channel
  exemption), extend `test/topic_queue.test.mjs` (core split ≥50% liked),
  `test/topic_outcomes.test.mjs` (play-proven expiry), `test/rank.test.mjs`
  (like multiplier).
- `sync-service`: `pytest` — `resetAt` drops old signals in
  `_merge_topic_signals`; `rank_brain_topics` honours it; likes survive.
- Smoke: run `npm test`; in the dashboard call `wgResetDiscovery()`, confirm
  topics = earned set, queue starts with liked topics, pool empty; reload and
  confirm the server does not resurrect old `topicSignals`.
- Deploy: `npm run deploy`; bump asset query strings (`?v=20261115-...`) for
  `app.js` / `app.min.js`; NAS redeploy for the sync-service.

## 7. Ordering

A1 reset (server `resetAt` first) → A2 roles/weights → A3 anti-stickiness →
B1/B2/B3 channel quality → B4 liked-channel supply → B5 subscriber enrichment.
A1 alone is a stopgap; A2+A3 are what stop the same old topics coming back.

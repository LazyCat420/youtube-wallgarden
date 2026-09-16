# Handoff — Music Feed, Anti-DJ Mix Gate, Queue Autoplay Fix & FYP Avoidance Loop (2026-09-16)

Fixes the queue/play-next autoplay bug, introduces a dedicated algorithmic Music Feed strictly filtering out DJ mixes and compilations in favor of standalone artist tracks, and creates a two-way recommendation avoidance feedback loop between regular YouTube browsing and Wallgarden. Assets bumped to `?v=20260916-v70`.

## What changed
- **Queue & Play Next Autoplay Fix**:
  - `addToQueue(video, playNext)` in `app/app.js`: eliminated flawed `!isWatchMode` condition that forcibly stopped active playback and autoplayed the new video when floating in Miniplayer or browsing the feed. Active playback is strictly preserved uninterrupted.
  - Video card 3-dot dropdown menu updated with "Play Next" (inserts at head of queue), "Add to Queue" (appends to queue), and "Add to Playlist" options with SVG icons and click handlers.
  - Test suite: `test/queue_playback.test.mjs` verifying queue preservation during watch mode, miniplayer mode, idle state, FIFO playback, and dropdown action availability.
- **Dedicated Music Feed & Anti-DJ Mix Gate**:
  - Dedicated "Music Feed" sidebar navigation button in `app/index.html` and view orchestration in `app/app.js` (`renderMusicFeed()`, `loadNextMusicFeedBatch()`).
  - Binary Anti-DJ Mix gate (`isDjMixOrCompilation(video)`) strictly eliminating tracks $> 14$ minutes and matching regex for full mixes, DJ sets, club mixes, live sets, megamixes, compilations, mixtapes, boiler rooms, soundtracks, discographies, and album streams.
  - Automatic music taste seeding (`getMusicSeeds()`): extracts verified artist channels (including `- Topic` channels), liked track artist splits, and music genre topics from the user's active preferences.
  - Test suite: `test/music_filter.test.mjs` validating rejection of mixes/compilations, pass-through of authentic artist songs, and music seed extraction.
- **Two-Way Extension FYP Avoidance Loop**:
  - `extension/scripts/content.js`: observes YouTube recommendation cards (`ytd-rich-item-renderer`, `ytd-video-renderer`, etc.) entering the viewport. Cards seen for $\ge 15$ seconds that are NOT clicked are marked as skipped/uninteresting and dispatched in batches via `FYP_AVOID_BATCH`.
  - Rejection handler (`handleRejection`): clicking YouTube's native "Not interested" sends `NOT_INTERESTED` (recording avoidance and setting $-5$ rating in Wallgarden), while "Don't recommend channel" sends `BLOCK_CHANNEL`.
  - `extension/scripts/background.js`: persists `NOT_INTERESTED` and `FYP_AVOID_BATCH` events to the server's `PUT /sync/global` endpoint under `avoided` and relays `WG_EXT_SYNC` to open Wallgarden tabs.
  - `sync-service/main.py`: added `avoided` to `SYNC_FIELDS` and LWW map mergers. Verified with `test_lww_avoided_merges_by_timestamp` in `test_merge.py`.
  - `app/app.js`: added `avoidedVideos` state, `isAvoidedVideo(video)` gate hooked at the top of `isSpamShapedVideo`, snapshot persistence in `_wgSyncSnapshot()`, and `handleExtensionSyncEvent` handling `FYP_AVOID_BATCH`, `NOT_INTERESTED`, and `BLOCK_CHANNEL`.
  - Fixed binary null byte in `extension/scripts/content.js` (`commentKey`) replacing with `\u0000`.
  - Test suite: `test/fyp_avoidance.test.mjs` verifying avoidance gates, message ingestion, and feed eviction.
- **Validation**:
  - All 18 unit test suites in `npm test` passing cleanly.
  - All 22 server sync merge tests in `sync-service` passing cleanly.

---

# Handoff — floating bottom-right miniplayer & full feed discovery (2026-09-16)

Adds floating bottom-right Miniplayer (Picture-in-Picture) support so users can continuously watch YouTube videos while browsing and scrolling the discovery feed at 100% full width. Assets bumped to `?v=20260916-v69`.

## What changed
- **Zero-reload miniplayer mode**: `#inline-player` transitions seamlessly via `body.miniplayer-mode` to a fixed floating window on the bottom right (`380px`, `bottom: 24px`, `right: 24px`) without detaching, re-inserting, or restarting the playing iframe or `<video>` stream.
- **Feed restoration**: In miniplayer mode, `.main-content` clears grid column splits, restoring `.feed-section` to full viewport width for unrestricted browsing, filtering, and infinite scrolling.
- **Quick controls**:
  - Minimize button in inline player action bar (`.btn-toggle-miniplayer`, labeled `Miniplayer (i)`).
  - Hover overlay on video with Expand to Watch View, Close, and Play/Pause toggle.
  - Compact bottom strip displaying video title, channel, expand, play/pause, and close.
  - Clicking miniplayer outside buttons expands it back to the full side-by-side watch mode.
- **Keyboard shortcuts**: `i` toggles between watch mode and miniplayer mode (ignoring input/textarea targets); `Escape` restores watch mode.
- **Auto-minimize**: Navigating sidebar views (Smart Feed, Subscriptions, Liked Videos) or submitting a search while watching a video automatically minimizes the player into the corner so the new feed has full width.
- **Test suite**: Added `test/miniplayer.test.mjs` covering state transitions, DOM preservation, keyboard gating, auto-minimization, and cleanup. All 15 unit test suites pass.

---

# Handoff — the calibrated feed: dated rows, a composed slate, topic roles (2026-09-06)

Four commits on this repo (`6f8215c` era buckets + ledger, `cfaf6d2` slate,
`ab26c4c` topic roles, `4316e65` plan), plus `trading-service@631935ab`
(scraper dates, redeployed as scraper-service) and
`lazy-agent-service@5955b89` (roles + FIT). All three containers deployed to
synology and live-verified. Assets at `?v=20260906-v68`.

The blueprint with the full audit is `plan/calibrated_feed.md`. Read it first.

## Why

"Random topics pulling random videos" was five mechanisms, each reasonable:
every discovery video arrived UNDATED (the scraper's date repair was gated on
`require_transcript`), the per-topic rank was computed and then the whole pool
was SHUFFLED (`_rankScore` was never read again), retrieval never asked
YouTube for any era, the brainstorm prompt told 75% of every batch to leave
the user's scene, and topic selection was a full-pool shuffle where weight
decided WHEN a topic was fetched, never WHETHER.

## What is live

- **Dates.** Every scraper row now carries `published_at` (approximate:
  month/year real, day = today's) plus `published_at_estimated` and a
  `description` snippet. Probe after deploy: 90/90 dated across three forms,
  upload years 2009–2026. Pool version 3 flushed the undated pool.
- **Era buckets + prior.** `eraBucketOf` (recent <1y / mid 1–4y / classic
  4–10y / vintage >10y, 10-day edge tolerance; undated = unknown, charged to
  recent). `deriveEraPrior` = dated likes smoothed toward 35/35/25/5.
- **Four retrieval forms** (`DISCOVERY_FORMS`): recent (`sp=CAMSBAgFEAE=`,
  popularity + this year), broad, depth, proven. Limits scale with the topic's
  role budget (10/8/5). Cold-start fan-out 6 → 4 topics.
- **One rank scale** (`rankScoreFor`) recomputed at composition time.
- **`composeSlate`** — Steck-calibrated, MMR-penalised, channel/topic-capped,
  one explore slot, deterministic. `takeSlate` at both draw sites; the shuffle
  and `pickDiverseBatch` are gone. Per-topic keep of 8 is itself a slate.
- **Topic roles** (core / adjacent / explore) stamped at birth, derived for
  legacy entries; `composeTopicQueue` builds 30-topic slates at 60/25/15 with
  core calibrated across liked clusters by like share and an explore share
  that adapts to its hit-rate; graduation on play/like; explore expiry on
  IGNORED. Brainstorm asks for 60 topics and sends `rateFit`.
- **Backend**: roles decided per batch (one blended CORE at 0.6, ADJACENT
  by cluster share, EXPLORE at 0.9), FIT rubric next to ANCHORING, `/similar`
  sees all seeds and the failed-shape line and is rated, `promptVariant`
  echoed, grounding evidence carries views + years and may return DEAD.
  Live probe: 20 topics → roles 7/8/5, fits 18 HIGH / 2 MED, variant echoed.

## Instruments — this is how the change gets judged

```
wgFeedMix()   // era shown vs target, KL, plays/likes per 100 shown, top channels with max-in-any-12, per-mode shuffle/slate
wgEraPrior()  // default vs derived era prior, dated-like count
wgTopicMix()  // topics by role (engaged % of shown), core fetched share vs like share per cluster, explore hit-rate, v1/v2/v2-nofit arms
wgPromptAB()  // unchanged; the brainstorm path finally stamps src
WG_DEBUG = 1  // logs each composed slate's era/topic/channel breakdown
```

Acceptance after ≥ 7 days of ledger and ≥ 20 shown topics per role is written
in `plan/calibrated_feed.md`. **Do not edit prompts or constants before that
horizon** — this repo has learned twice that an eyeball read does not survive
n = 30.

## Same evening: why it took so long to load (`381660d`, assets `v68`)

The user asked why the feed took so long and why "discovering more" never
ended. Three measured causes, none of them the ranking math:

| measured | value |
|---|---|
| classify 30 candidates on the Jetson | **10.2 s**, and `fetchVideosForTopic` AWAITED it before returning — nothing rendered until the scraper AND the model had answered |
| cold start | every topic's videos held behind one `Promise.all` until the slowest topic came back |
| 16 parallel scraper searches (4 topics x 4 forms) on the 4-core NAS | **14.7 s wall, 13 of 16 EMPTY** (10 s subprocess timeout, no fallback) — the preloader got `[]` and asked again every 1.5 s |

Fixed: `scheduleLateClassification` (verdicts land in the background, at most
two in flight, NOVELTY/OFF_TOPIC evicted from the pool when they arrive);
the preloader absorbs each topic as it lands and renders the first batch from
the first topic back; cold-start fan-out 3; per-form timeout 30 s. Scraper
side (`trading-service@7c7c6a58`, redeployed): a 3-wide gate on yt-dlp
subprocesses, 25 s each, and a 30-minute search cache. Re-probed after the
deploy: the same 16-wide burst returned **0 empties** (was 13), and a repeated
single search answers in ~0.1 s. The scraper runs two uvicorn workers, so the
cache is per worker — a repeated burst still misses about half the time.

`test/feed_latency.test.mjs` pins all three client changes.

## Traps for the next session

- Bump every `?v=` (now `20260906-v67`) or the immutable cache serves the
  old bundle; three bumps happened in one session for three deploys.
- `window.wgX` helpers live on the VM's `window` in tests: `get("window").wgX`.
  Copy VM arrays out with `plain()` before `deepStrictEqual` (test/_boot.mjs).
- YouTube's this-year window is honoured on most calls but not all: one
  "raku kiln firing" call through the container returned 2015/2020/2021 rows
  while the same request direct and a retry were all 2025–2026. The slate
  charges rows by their REAL date, so a leaky window costs nothing but one
  wasted form.
- `sort:"date"` is relevance order since YouTube's Jan 2026 change; the
  channel-sync fallback still asks for it. Documented, not fixed.
- The Jetson currently reports model `nemotron35`; the backend pins the box,
  discovers the model, and only warns when it is not the expected Qwen.
- `test:smoke` needs `.venv` (gitignored) — from a worktree run
  `../youtube-wallgarden/.venv/bin/python test/smoke.py` (12/12 today).

---

# Handoff — pinned to the Jetson, and the AI channel suggestion never ran (2026-08-22)

Commit `b29bdf0` (this repo) + `lazy-agent-service@8456371`. Both containers
deployed to synology and live-verified. Assets at `?v=20260822-v61`.

## Why

All wallgarden LLM work now runs on the **Jetson** (10.0.0.30:8000,
`cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit`). Gold Spark is shared with the trading
stack and is deliberately no longer used — not even as a fallback. The backend
enforces the pin; see `lazy-agent-service/HANDOFF.md` for the resolver change
and the GPU-counter evidence.

The 07-28 note in this file said *"Provider resolution still prefers Gold Spark
(`vllm-2`, gemma-4-26B) over Jetson's Qwen — unchanged behavior"*. That is now
resolved, and Gold Spark has since been swapped to `deepseek-v4-flash-0731`.

## The trap this repo contributed

The dashboard persists its dropdown pick as `provider::model` in localStorage
(`state.settings.llmModel`) and `buildLlmContext()` (`app.js`) sends it on
**every** `/api/wallgarden/*` request. The old backend took that hint verbatim
and skipped resolution entirely — so the browser, not the server, chose the box.

**Changing only the server default would have looked fixed on a clean profile
and changed nothing in an existing tab.** The backend now ignores non-Jetson
hints. Existing tabs also self-heal: `/wallgarden/models` returns only the
Jetson, so `fetchWallgardenModels()` finds the saved value missing and
re-selects.

## The bug that was hiding behind a `catch`

The channel-recommendation call (`app.js`, the `vllmPromise` block) is the ONE
path that skips the wallgarden backend and hits prism directly. It did:

```js
const resp = await fetch("/prism/chat", { … });
const data = await resp.json();
```

**Prism's `/chat` streams SSE unless you pass `?stream=false`.** The body was
`data: {…}` frames, `resp.json()` threw at character 0 on every single run, and
the surrounding `catch` turned that into a `console.error`. The "AI Suggestion"
source silently never appeared in the recommendations list — for as long as the
call has existed.

Measured through this container's own nginx proxy:

```
POST /prism/chat                  -> body starts 'data: {"type":"user_message"…'
                                     JSONDecodeError at char 0
POST /prism/chat?stream=false     -> {"text":"OK"}
```

Same call also sent snake_case `max_tokens`, which prism's `/chat` silently
drops (already noted in the 07-28 handoff below) — so its 1000-token cap was
never applied. Now `maxTokens`.

## Qwen3.6 reasons by default

The Jetson's model puts everything in a separate `reasoning` field and leaves
`content: null`. Probed directly: a 16-token budget returned `content: null`,
`finish_reason: "length"`, all tokens spent reasoning. Any direct call from this
repo must send `thinkingEnabled: false` — it is mandatory, not a tuning knob.
The backend's `callPrismChat` already sent it; the direct `/prism/chat` call did
not, and now does.

`getPinnedModel()` (next to `parseModelSetting`) is the single client-side
identity helper: it prefers whatever the backend reports for the Jetson — so a
re-provisioned box heals itself — and falls back to the pinned constant only
before the model list has loaded.

## Verified

- `npm test` — 5 suites pass. `npm run build` — clean. `npm run test:smoke` — 12/12.
- Live: `/api/wallgarden/models` returns only the Jetson; the minified bundle
  serving from the container contains both the pin and `?stream=false`.
- Every backend LLM route exercised live (brainstorm, similar, taste-profile,
  extract-topics, judge-topics, classify-candidates) — all HTTP 200, and the
  Jetson's `vllm:request_success_total` moved while Gold Spark's never did.

## Traps for the next session

- **Bump every `?v=` string** (now `20260822-v61`) or the change silently does
  not ship — `app.min.js`/`.css` are gitignored and the Dockerfile re-minifies.
- The settings "LLM Configuration" dropdown is now informational: only the
  Jetson is ever offered, and the backend refuses anything else.
- If you add another direct-to-prism call, it needs all three:
  `?stream=false`, `maxTokens` (camelCase), and `thinkingEnabled: false`.

---

# Handoff — "Editorial Garden" UI retheme shipped (2026-07-28)

Commit `8b87871`, deployed to synology, live-verified (v55 assets serving,
Fraunces loading, smoke 12/12, popup e2e 14/14).

## What changed

Full visual redesign replacing the generic Tailwind-blue/glassmorphism look
with an editorial magazine style on a moss/sage garden palette:

- **Tokens are single-source** in `app/index.html` `:root` (inline critical
  CSS) — app.css no longer defines any. OKLCH moss accent kit
  (base/hover/deep/subtle/contrast), 3-step warm surfaces, 4-step text ramp,
  alpha hairline border ramp, terracotta danger / dry-gold warning. Legacy
  names (`--card-border`, `--theme-blue-*`, …) are ALIASES to new tokens —
  migrate off them, don't redefine.
- **Fraunces** (Google Fonts) is the display face: wordmark, view titles,
  video/card titles, modal headers, empty states. Inter stays for UI.
- **Compact buttons**: `.btn` 26px / `.btn-sm` 22px, hairline quiet variants,
  solid moss primary with dark-ink text. No glows, no press-scale, no lifts.
- **Editorial cards**: `.video-card` has no box chrome — rounded thumbnail +
  serif title + 11px meta on the page surface. Hover = thumb brightness, not
  translateY.
- **Emoji → SVG**: `icon(name, size)` helper + `ICONS` map at top of app.js;
  index.html emoji buttons are inline Lucide-style SVGs. 🌿 stays as the brand
  mark; 🌤 stays in the weather widget. Toast emoji prefixes stripped.
- Inline styles consolidated: index.html 117 → 49 (rest are token-refs/layout);
  new utility classes at the bottom of app.css (`.input-field`, `.filter-input`,
  `.stat-box`, `.settings-section-card`, `.icon-14`, …).
- `extension/popup/popup.css` rewritten on mirrored token values (extension
  can't import app css — keep in sync manually). Old #4CAF50 theme is gone.
- `ontologyRenderer.js` canvas colors moved to the garden palette
  (TYPE_COLORS + stage/tooltip/edge colors near their draw sites).

## Follow-up (same day): watch-page compaction + nav collapse (`68e9545`)

- Player sidebar actions are compact auto-width `btn-sm` chips in wrap rows
  (`.sidebar-actions-grid` is now flex-wrap; `.sidebar-actions-row` added).
- FIXED a v55 regression: `ensureInlinePlayer` builds its HTML from a
  joined array of PLAIN strings — `${icon(...)}` rendered literally. Any
  future icon substitution there must use `' + icon("x") + '` concatenation.
- `.btn` now has `white-space: nowrap`.
- Desktop nav collapse — REDONE in `df1d169` to match prism-client's
  NavigationSidebarComponent (the first cut hid the sidebar entirely,
  which was wrong):
  - Collapsed = **52px icon rail**, not `display:none`. Icons stay
    visible; `.nav-label`, `.nav-count`, `.brand-name`, `.brand-icon`,
    `.btn-sidebar-label`, `.weather-widget` hide inside the rail.
  - Toggle lives IN the sidebar brand row (`#btn-nav-collapse`), not the
    header. Right-aligned when expanded; centered + `scaleX(-1)` when
    collapsed so it reads as "expand". Header burger is mobile-only again.
  - State is `html[data-nav-collapsed="true"]`, applied **pre-paint** by
    an inline `<script>` in index.html — app.min.js is deferred, so a
    JS-only restore flashed the full sidebar on every load.
  - The rail CSS is DUPLICATED in the index.html critical block and in
    app.css (app.min.css loads later and wins) — edit both or the
    collapsed state changes after CSS load.
  - Footer button labels are wrapped in `.btn-sidebar-label` spans; they
    were bare text nodes that CSS could not hide.

## Traps for the next session

- **Tokens live ONLY in index.html** — do not re-add a `:root` to app.css
  (app.min.css loads after the inline block and would win the cascade).
- `npm run build` + bump ALL `?v=` strings (now `20260728-v55`) or the theme
  silently doesn't ship. min files are gitignored; deploy copies working tree.
- `.ontology-node-detail` display toggling is JS `style.display` over a class
  default of `display:none` — works, don't "fix" it.
- Verification gates that must stay at zero: `rgba(74, 222, 128`,
  `#3B82F6|#60A5FA|#1E40AF|#4CAF50`, `backdrop-filter` in app.css.

## Open / follow-ups

- app.js still has 97 inline styles in template strings (all token-referencing
  or dynamic) — further consolidation is polish, not correctness.
- A light theme is now a ~25-token override block under
  `[data-theme="light"]` in index.html + a toggle; structure is ready.
- Fraunces weight is set via `font-weight: 520/550` (variable axis); if a
  fallback serif renders (offline), weights round to 500 — acceptable.

---

# Handoff — topic pipeline actually reaches the model now (2026-07-28)

Commit `d73599f` (this repo) + `lazy-agent-service@33f9b05`. Both containers
deployed to synology and live-verified (curl probe: 25 rated topics in 7.2s).

## Why — every single topic call was failing, deterministically

The 07-27 likes→topics engine shipped against a broken LLM path. NAS logs +
prism source showed:

- `callPrismAgent` hit prism **`/agent`** with no `agent` field and
  `enabledTools: []`. Prism ignores an empty array (`AgenticToolResolver`
  requires `length > 0`) and defaults to the **full CODING persona**: 17K-token
  system prompt + **361 tool schemas ≈ 106K tokens** on a 100K-context vLLM
  model.
- Budget went negative before the request started; output clamped to 1024 <
  the 4096 viable minimum, so prism's ContextExhaustionGuard **skipped the
  model call on every request and returned an empty HTTP 200**. Wallgarden
  parsed nothing, retried 3× per batch × 4 batches — 15 doomed calls plus
  ~80 memory-retrieval embedding calls per user action (the "embedding spam").
- The infamous "0 output tokens remain out of a 0 token window" message is a
  prism **display bug** (`ReActHarness.ts:425-426` hardcodes 0); the real
  window was 100000. The `memory:extract` entries in the request log are a
  co-traced background hook, not the failure.
- The frontend swallowed every error (`console.error`, status "Ready") and the
  preload refill loop refired every 15s forever.

prism-service is READ-ONLY for us, so everything is fixed caller-side.

## What shipped

**lazy-agent-service `33f9b05`**
- `callPrismAgent` → `callPrismChat`: **`POST /chat?stream=false`** — prism's
  plain server-to-server completion path. No persona, no tool schemas, no
  memory-retrieval embeddings. Gotchas encoded in the code: `maxTokens` must be
  camelCase (`max_tokens` is silently dropped by `/chat`), and
  `skipConversation: true` or every call persists a conversation doc.
- Attribution header is now `x-project: youtube-wallgarden` (was
  `lazy-tool-service`) — dashboard files wallgarden traffic correctly.
- Empty response text now **throws** (it's a gateway failure, never valid
  output) instead of laundering into "no topics" fake-success.
- Retry ladders got 1s/4s backoff. `rateTopics` / `judgeTopicGrounding` no
  longer return `{}` on a failed LLM call: one retry, `logger.error`, and both
  now return `{ …, failedBatches, totalBatches }`; the routes expose
  `degraded: true` (`topics`/`rated`/`verdicts` shapes unchanged — old clients
  fine).

**youtube-wallgarden `d73599f`**
- Failures toast + set status text (brainstorm/similar/mining/taste).
- Refill loop: 15s cooldown **doubles per consecutive brainstorm failure**
  (cap 5min), gated on `max(lastBrainstormTime, lastBrainstormAttempt)` — the
  attempt stamp was written-but-never-read before.
- Mining: per-video strike counter on the synced rating record
  (`st.v.extractionAttempts`); after 3 strikes → `st.v.extractionFailed`,
  never re-sent. (The 13/54 likes that never extract were being re-paid on
  every dashboard load.) Network/HTTP errors don't count strikes — only a
  successful response that omitted the video.
- nginx `/api/` timeouts 120s → 110s: stack staggers prism 100s < nginx 110s
  < browser 120s, so each layer sees a real error instead of racing timers.

## Verified live

- `curl :5591/wallgarden/brainstorm` (3 interests, numTopics 25) → 25 on-taste
  topics, `17A 8B 0C`, 7.2s total.
- prism logs during the probe: clean `[chat]` acquire/release pairs tagged
  `[youtube-wallgarden/admin]`, **zero** ContextExhaustionGuard /
  OutputTokenClamp / embedding lines.
- `docker ps` after deploy: both containers Up + healthy.

## Notes / not done

- Provider resolution still prefers Gold Spark (`vllm-2`, gemma-4-26B) over
  Jetson's Qwen — unchanged behavior, just now visible in logs.
- The prism-side bugs (empty-200 on guard skip, hardcoded 0/0 message,
  `enabledTools: []` ignored) are documented here but NOT fixed — Rod's code.
  Any other caller of `/agent` without an explicit lightweight agent will hit
  the same 106K wall.
- Frontend doesn't yet render the new `degraded` flag anywhere; it's in the
  responses when wanted.

---

# Handoff — likes → topics engine + ranked discovery (2026-07-27)

Commit `cd6b57b` (this repo) + `lazy-agent-service@5f1ab29` + `trading-service@038d365,652cdf9`
(scraper source). All three containers deployed to synology and live-verified.

*(superseded sections trimmed — see git history for the full 07-27 handoff;
its "13/54 likes retry every load" note is fixed by the 07-28 strike counter
above)*

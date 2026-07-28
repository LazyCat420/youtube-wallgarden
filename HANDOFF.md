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

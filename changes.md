# YouTube Wallgarden - Changes

### Created Extension Architecture
- Created Manifest V3 Chrome Extension in `d:\Github\youtube-wallgarden\extension\`
- `manifest.json`: Configured for `activeTab` and `storage` permissions.
- `background.js`: Implemented the Ollama API pipeline. Receives `evaluateWithOllama` messages from content scripts, queries the local API (`http://localhost:11434/api/generate` default, `llama3` default), and caches boolean `isBrainrot` scores into `chrome.storage.local`.
- `content.js`: Implemented the 3-layer Filtering system.
  - **Layer 1 (CSS Rules)**: Hard injects `<style>` tag to set `display: none` on `#shorts-inner-container` and `ytd-rich-shelf-renderer` to nuke YouTube shorts globally.
  - **Layer 2 (Heuristics)**: Implemented regex functions to detect ALL CAPS titles (if >80% capitalization) and excessive punctuation spams (??/!!/!!?).
  - **Layer 3 (AI Scraping & Messaging)**: Instantiated a `MutationObserver` mapped to `.ytd-rich-item-renderer` and `.ytd-video-renderer` classes. Extracts `Title`, `Channel`, and `Video ID`. Sends this data asynchronously off main-thread to the service worker, and dynamically applies `display:none` on callback if classified as brainrot.
- `popup.html`, `popup.css`, `popup.js`: Created sleek dark-mode UI with toggles for every layer of filtering, and configurable input fields for the local LLM endpoint and model. Automatically syncs variables to Local Storage so the `content.js` script reacts dynamically.

### Process Follow-up
- Successfully drafted the implementation plan in `plan/youtube_filter_plan.md`.
- Moved the fully implemented plan to `plan/done/youtube_filter_plan.md` as instructed by the user's logic loop.

---

### V2: Comprehensive Spam Blockers
Expanded the extension from 1 blocking category (Shorts) to **18 toggleable blockers** across 5 grouped categories.

**`popup.html`**: Added 3 new sections: Homepage Cleanup (7 toggles), Watch Page Cleanup (6 toggles), Global Annoyances (3 toggles).

**`popup.css`**: Complete redesign with custom toggle switches (green sliding pill), scrollable body, hover effects, gradient save button.

**`popup.js`**: Refactored from hardcoded element references to data-driven `SETTING_KEYS` and `TEXT_KEYS` arrays for automatic load/save.

**`content.js`**: Full rewrite of `applyBlockingCSS()` with CSS selectors targeting:
- Homepage: Shorts, Breaking News, Trending, Community Posts, People Also Watched, Ads/Promoted, Movies & Shows
- Watch Page: Merchandise, Super Thanks/Donations, Shorts Remix, Chat Replay, Info Cards/End Screens, Clip/Thanks buttons
- Global: Premium Upsells, Notification Popups, Music Upsells

Added `processShelves()` function as a text-based fallback for shelf elements that CSS `:has(:contains())` can't reliably target (e.g., "People also watched", "Breaking News").

---

### V3: Smart Learning Blocklist

**`content.js`**: Added `startMenuInterceptor()` system:
- Captures click events on YouTube's 3-dot menu buttons (capture phase) to track which video card triggered the menu
- `MutationObserver` watches for popup menu items containing "Not Interested" or "Don't recommend" text
- Hooks click handlers onto those menu items to call `handleRejection()`
- `handleRejection()` extracts channel name + title, adds channel to persistent blocklist, extracts weighted keywords via `extractKeywords()` (with 80+ stopwords filtered)
- `processVideos()` now checks incoming videos against `blocklist.channels` (exact match) and `blocklist.keywords` (threshold: keyword must appear in 3+ rejections, and 2+ hot keywords must match)
- Blocked videos show a green "🌿 Blocked: channelName" badge via `showBlockedBadge()`

**`popup.html`**: Added Smart Blocklist section at top with stats row, scrollable blocked channels list, and Export/Clear buttons.

**`popup.css`**: Added highlighted section styling, stats badges, blocked-item rows with remove buttons, and button row styles.

**`popup.js`**: Added `renderBlocklist()` to display blocked channels with per-channel unblock (✕) buttons. Added Export (downloads JSON) and Clear All (with confirm dialog) functionality.

---

### V4: Shorts Blocking Fix + Updated Selectors

**`content.js`**: Fixed Shorts not being hidden due to YouTube DOM changes:
- Added `ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])` for new Shorts wrapper
- Added `ytm-shorts-lockup-view-model-v2` and `a[href^="/shorts/"]` selectors for individual shorts
- Added JS-based `hideShortsElements()` function for text-based sidebar/section hiding (CSS can't match text content)
- Split CSS rules into isolated blocks so one invalid selector can't break all others
- Removed invalid `:has-text()` pseudo-selectors (uBlock syntax, not valid browser CSS)

---

### V5: Quick Block from Search + 3-Dot Menu Integration

**`content.js`**: Added two ways to block channels:

1. **🌿 3-dot menu injection**: Click ⋮ on any video → "🌿 Block ChannelName" appears at the bottom. Uses click-event + setTimeout approach (YouTube reuses popup containers, MutationObserver doesn't fire). Closes menu via Escape key dispatch to preserve YouTube's popup state.

2. **🚫 Inline block icon**: Small 🚫 appears next to ⋮ button on hover for quick one-click blocking without opening the menu.

3. **Shorts title-based blocking**: Shorts cards don't expose channel names in DOM. When blocking a Short, title keywords get a +5 weight boost for auto-blocking similar content.

- Removed `videoId` requirement from `processVideos()` — was preventing search results from being processed
- Broadened channel name selectors to cover YouTube's different element structures across pages
- Added `blockChannelAndHide()` helper for centralized channel blocking logic

---

### V6: Homepage Block + Shorts Sheet Popup + Smooth Hover

**`content.js`**: Full homepage and Shorts blocking support:

1. **Homepage video blocking (account-independent)**: YouTube's new `yt-lockup-view-model` cards use different selectors — added `h3 a` for titles, `a[href^="/@"]` for channels, `button[aria-label="More actions"]` for ⋮ buttons. Added 2-second periodic rescan because homepage cards load content lazily AFTER the `ytd-rich-item-renderer` container is added to the DOM.

2. **Shorts ⋮ menu block**: Shorts use a different popup (`yt-sheet-view-model` → `yt-list-view-model`) instead of `tp-yt-paper-listbox`. New `injectShortsBlockItem()` function creates a styled block item for the sheet popup. `tryInjectBlockItem()` now has dual-path detection (regular listbox vs Shorts sheet popup).

3. **Smooth 🚫 hover animation**: Block icon uses CSS `transform: scale(0.7→1.0)` + `opacity: 0→1` with 0.25s ease transition for a polished pop-in effect on video card hover.

---

### V8 (2026-07-13): Watchlist Sync + Smarter/Faster Discovery

**Extension `content.js`** — likes AND watchlist now sync to the Wallgarden app:

1. **Watch Later / playlist saves are now captured accurately**: instead of firing a blind `PLAYLIST_SAVE` the moment the "Save" menu item is clicked, the extension hooks the actual "Save video to..." dialog checkboxes (`ytd-playlist-add-to-option-renderer`) and sends `WATCHLIST_ADD` / `WATCHLIST_REMOVE` (for Watch Later) or `PLAYLIST_SAVE` with the playlist name — based on the checkbox's real post-click state.
2. **Card-level sync (not just watch pages)**: new `scrapeCardMetadata()` extracts videoId + title + channel from feed/search/sidebar cards, and `sendSyncEvent()` accepts an explicit videoId. Saving a video to Watch Later from the homepage now syncs with full metadata; previously it silently failed because the video ID was only read from the watch-page URL.
3. **Shorts URL support**: `getVideoIdFromUrl()` now parses `/shorts/<id>` paths, so likes on Shorts pages sync too.
4. `SUBSCRIBE` events now include scraped video metadata.

**App `app.js`**:

1. **New sync handlers** for `WATCHLIST_ADD` / `PLAYLIST_SAVE` / `WATCHLIST_REMOVE`: saved videos are mirrored into the Play Queue (watchlist), persisted, and fed into the ontology graph as a positive rating — so watch-later saves on YouTube now train the recommendation graph just like likes.
2. **LLM context upgraded**: `buildLlmContext()` now sends the last 15 liked video titles and last 15 watchlist titles (with channel names) to the brainstorm/similar endpoints — the strongest taste signals the LLM previously never saw.
3. **Feed accuracy**: `fetchVideosForTopic()` filters out already-watched (incl. YouTube-synced watch history) and disliked videos so they never resurface in the smart feed.
4. **Cold-start latency**: preloader fans out to 6 parallel topic fetches when the pool is empty (was 3), so the first feed render needs one round-trip instead of several. Pool inserts are now deduped against the existing pool and rendered feed.

**Backend `lazy-tool-service` (WallgardenService/WallgardenRoutes)**:

1. **Rewritten system prompts** for brainstorm + similar topics: "infer the person, not the list" framing, a ladder-of-distance quota (adjacent/lateral/wildcard/time-shift), "name the niche, not the category" rule, and moods/formats-as-topics — designed to produce dynamic, non-literal discovery topics instead of flat word associations.
2. **Temperature schedule inverted**: starts at 0.9 for creative variety and cools to 0.4 on JSON-format retries (was 0.1 rising — nearly deterministic, hence the boring literal topics).
3. New `likedVideos` / `watchlist` context fields accepted and injected into the user prompt, labeled by signal strength.

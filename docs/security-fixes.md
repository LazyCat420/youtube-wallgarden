# Security fixes log

## 2026-10-22: stored XSS in the RSS news feed

- Issue: `renderNewsFeed()` (`app/app.js`) put RSS `title`, `link` and the source `channelName` into `innerHTML` unescaped, and the description tag-strip (`/<[^>]+>/g`) let an unclosed tag such as `<img src=x onerror=...` through. Any feed, or the allorigins relay it is fetched through, could run script in the app's origin (where the profile, ratings and settings live in localStorage). A `javascript:` link also rendered as a clickable anchor.
- Root cause: string-built HTML without escaping for feed data.
- Fix: new helpers `safeHttpUrl()` (only `http:`/`https:` links; anything else renders the title as plain text), `newsDescriptionText()` (strip also removes unclosed tags) and `newsCardHeaderHTML()`, which runs every text field and the href through the existing `escapeHTML()`. `data-source` attributes and the error message are escaped too. Links get `rel="noopener noreferrer"`. `index.html` cache-bust bumped to `v72`.
- Tests: `test/news_render_xss.test.mjs` (added to `npm test`).
- Redeploy needed to ship (not done here); the Docker build regenerates `app.min.js` from `app.js`.

# Handoff — popup layout + comment filter (2026-07-20)

## Popup layout fix (`bda0138`)
The popup was unscrollable: the bottom sections and the Save button could not be
reached at all. Cause was `max-height: 520px` on `<body>` alone — **the popup
window sizes itself to `<html>`**, so body never became a scroll container; the
page just grew past the window. Anything added to the end of `popup.html` was
effectively invisible, which is how the comment filter shipped undiscoverable.

Now: fixed header / scrolling middle / pinned footer.
- `html { height: 580px }` — a definite height up the whole chain, under
  Chrome's ~600px popup ceiling.
- `.scroll-area { flex: 1 1 auto; min-height: 0; overflow-y: auto }` — the only
  scroll container. `min-height: 0` is load-bearing: without it a flex item
  refuses to shrink below its content height and no scrollbar ever appears.
- `.topbar` / `.bottombar` are `flex: 0 0 auto`, so Save is always on screen.

Every section is a `<details class="section" data-sec="...">` collapsed by
default, so all eight headings fit on one screen. Open state persists under
`popupOpenSections`. Each collapsed header carries an `n/total` badge of its
enabled toggles (`refreshSectionCounts()`), so a shut section still reports its
state. Adding a section = one `<details>` block with a `data-sec`; the JS is
generic over them.

`npm run test:popup` (`test/popup_layout_e2e.py`, 14 checks) pins this: the
document must fit the popup window, every heading must be visible unscrolled,
Save must stay pinned across scrolling, and opening all sections must not grow
the document. If you add settings, that test is what stops the popup silently
becoming unreachable again.

---

# Comment filter (`e6eaa64`)

## What shipped
The comments section can now be *filtered* rather than only collapsed: comments
with no substance are hidden in place, the rest stay. Off by default. Commit
`e6eaa64` on `master`, pushed and deployed to synology (`:8007`).

Two new settings in the popup, under "💬 Comment filter":
- `filterComments` — the feature switch. Default **off**.
- `commentAuditMode` — default **on**, so the first thing you see after enabling
  the filter is what it is actually catching, not a silently shorter thread.

## The three rules that govern the design
1. **Nothing is deleted.** A filtered comment keeps its place in the DOM with
   `.wg-comment-filtered` on it; the hiding is pure CSS off `html.wg-cf-on`.
   Turning the setting off restores everything with no re-scrape.
2. **Protections beat rules.** Likes ≥ 5, any reply, a pin, or a creator heart
   means a human vouched for it and no rule may touch it (`COMMENT_PROTECTIONS`).
3. **Rules match form, not opinion.** "This is wrong because X" survives;
   "absolute garbage" does not. Filtering for *substance*, not sentiment — the
   sharpest criticism under a video is often the most useful comment on it.

## Where the code is
All in `extension/scripts/content.js`, in the section headed
`Comment Filter — heuristic, reversible, auditable`:
- `WG_COMMENT_RULES` — the seven rules. Order matters: the audit bar names the
  *first* match, so specific rules sit above generic ones (`characterMash`
  before `lowEffort`).
- `COMMENT_PROTECTIONS` — the vetoes, checked before any rule runs.
- `scrapeComment()` — DOM → fields. Every selector has fallbacks; a missing
  field must degrade to "can't tell" (which protects the comment).
- `classifyComment()` — pure, and the unit-test entry point.
- `filterComments()` / `startCommentFilterWatcher()` — idempotent pass over
  `ytd-comment-thread-renderer:not([data-wg-cf])`, re-run on lazy-load.
- `renderCommentFilterBar()` — summary + per-rule breakdown + audit toggle.
- `clearFilteredComment()` — the "Not spam" undo.

Popup wiring is the same three-edit recipe as the collapse panels: a default in
`settings`, a checkbox in `popup.html`, the key in `SETTING_KEYS` in `popup.js`.

## Checking for false positives
This is what audit mode is for. Enable the filter, leave audit mode on, and
filtered comments stay visible — dimmed, dashed outline, tagged with the rule
that caught them. Each carries a **Not spam** button that restores it and
records its key in `commentAllowlist`, so it survives future pages and sessions.
"Forget my not-spam decisions" in the popup clears that list.

`emptyComplaint` is the rule most worth watching. It is deliberately the
narrowest — it needs a complaint word AND no argument marker AND ≤ 7 words. Drop
any one of those conditions and it starts eating real critique.

**Deliberately not a rule: timestamp lists.** They pattern-match as low-effort
(few words, repeated digits) and are frequently the single most useful comment
on a long video.

## Gotchas found along the way
- `\p{Emoji_Component}` **includes the ASCII digits 0-9**. The first version of
  `WG_EMOJI_RE` used it, so "the treaty was 1919 not 1918" scanned as eight
  emoji and got binned as character-mashing. Use `\p{Extended_Pictographic}`
  plus explicit joiners/modifiers. The unit-test corpus caught this.
- Punctuation is far too weak a substance signal. A comma in the substance
  regex let "mid video, worst channel" pass as reasoned. Conjunctions only.
- A thread that scrapes to empty text is still rendering — leave it *unmarked*
  so the next mutation batch retries, rather than passing it permanently on an
  empty read.
- The filter bar is a direct child of `ytd-comments#comments`, so the existing
  collapse CSS (`> *:not(.wg-collapse-bar)`) hides it when comments are
  collapsed. That is correct, but it's why the bar is inserted *after* the
  collapse bar rather than prepended.

## Verification
- `npm test` — `test/comment-filter.test.mjs` runs a labelled corpus (15 keeps,
  17 drops) through the real `classifyComment` out of the unmodified
  content.js. The **keeps are the contract**: reasoned criticism, corrections,
  blunt-but-specific complaints, timestamp lists. Add to it when you touch a rule.
- `npm run test:comments` — `test/comment_filter_e2e.py` drives content.js in
  headless chromium against a comment-section DOM: scrape, hide the right six of
  twelve, audit reveal, tag rendering, the undo path (class + tag + persisted
  allowlist + bar decrement), and filter-off restoring everything. 21/21.
- Deployed artifact confirmed byte-identical to local `content.js` on `:8007`.
  (Note: `grep` needs `-a` on that file — the emoji make it read as binary.)

This closes the "no automated test covers the collapse panels" gap from the
previous handoff for the comment path at least; the e2e harness is now committed
rather than a scratchpad throwaway.

## Not done
- The LLM ranking tier (score the top ~30 by likes, float substance up) is not
  built. This is the free heuristic tier only. `plan/llm_filtering_plan.md` and
  the prism plumbing in `app/app.js` are the starting points, but note the
  extension and dashboard are separate runtimes — routing would go through
  `background.js`.
- Rules are global. No per-channel or per-category tuning.

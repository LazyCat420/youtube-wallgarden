"""E2E: run the REAL content.js against a watch-page-shaped comment DOM.

Proves the parts the unit test can't: DOM scraping, CSS hiding, the audit bar,
and the "Not spam" undo path.
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT_JS = (ROOT / "extension/scripts/content.js").read_text()

# Each thread mirrors YouTube's real structure: #content-text, #vote-count-middle,
# the replies expander, pinned/heart badges.
COMMENTS = [
    # (text, likes, replies, pinned, hearted, owner, should_hide)
    ("The bit at 12:30 about cache invalidation finally made the tradeoff click.", "", 0, 0, 0, 0, False),
    ("This is wrong about the GDP figure because it uses nominal not real terms.", "", 0, 0, 0, 0, False),
    ("0:00 intro 2:14 setup 8:40 results 15:02 outro", "", 0, 0, 0, 0, False),
    ("Nailed it.", "4.2K", 0, 0, 0, 0, False),          # protected by likes
    ("wrong", "", 1, 0, 0, 0, False),                    # protected by replies
    ("first!", "", 0, 0, 1, 0, False),                   # protected by heart
    ("\U0001F525\U0001F525\U0001F525", "", 0, 0, 0, 0, True),
    ("Message me on telegram @cryptoking for signals", "", 0, 0, 0, 0, True),
    ("who's still watching this in 2026", "", 0, 0, 0, 0, True),
    ("lol", "", 0, 0, 0, 0, True),
    ("check out my channel for more of this content", "", 0, 0, 0, 0, True),
    ("absolute garbage", "", 0, 0, 0, 0, True),
]

def thread_html(i, text, likes, replies, pinned, hearted, owner):
    badges = ""
    if pinned:
        badges += '<ytd-pinned-comment-badge-renderer>Pinned</ytd-pinned-comment-badge-renderer>'
    if hearted:
        badges += '<ytd-creator-heart-renderer></ytd-creator-heart-renderer>'
    if owner:
        badges += '<ytd-author-comment-badge-renderer></ytd-author-comment-badge-renderer>'
    rep = f'<ytd-comment-replies-renderer><div id="more-replies">{replies} replies</div></ytd-comment-replies-renderer>' if replies else ''
    return f'''
    <ytd-comment-thread-renderer data-idx="{i}">
      <div id="header-author"><a id="author-text">@user{i}</a>{badges}</div>
      <div id="content-text">{text}</div>
      <span id="vote-count-middle">{likes}</span>
      {rep}
    </ytd-comment-thread-renderer>'''

PAGE = f'''<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="page-manager">
  <ytd-comments id="comments">
    <div id="sections">
      {''.join(thread_html(i, *c[:6]) for i, c in enumerate(COMMENTS))}
    </div>
  </ytd-comments>
</div>
</body></html>'''

# chrome stub. get MUST call back asynchronously — a synchronous stub runs
# content.js's boot path before its const declarations initialize.
CHROME_STUB = """
window.__store = { filterComments: true, commentAuditMode: false, _v7_shorts_reset: true };
window.__sets = [];
window.chrome = {
  storage: {
    local: {
      get: (keys, cb) => setTimeout(() => cb(JSON.parse(JSON.stringify(
            Object.fromEntries(Object.entries(window.__store))))), 0),
      set: (obj, cb) => { Object.assign(window.__store, obj); window.__sets.push(obj); if (cb) cb(); },
    },
    onChanged: { addListener: () => {} },
  },
  runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, getURL: p => p },
};
"""

results, failures = [], 0
def check(name, ok, detail=""):
    global failures
    results.append((ok, name, detail))
    if not ok: failures += 1

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    pg.on("console", lambda m: print("  [console]", m.text) if m.type == "error" else None)
    pg.set_content(PAGE)
    pg.add_init_script(CHROME_STUB)
    pg.evaluate(CHROME_STUB)
    pg.evaluate(CONTENT_JS)
    pg.wait_for_timeout(800)

    # 1. correct comments hidden / kept
    for i, c in enumerate(COMMENTS):
        text, should_hide = c[0], c[6]
        el = pg.locator(f'ytd-comment-thread-renderer[data-idx="{i}"]')
        hidden = not el.is_visible()
        rule = el.get_attribute("data-wg-cf-rule")
        check(f'{"hide" if should_hide else "keep"}: {text[:44]!r}',
              hidden == should_hide,
              f"visible={not hidden} rule={rule}")

    # 2. the summary bar appeared with the right count
    expected_hidden = sum(1 for c in COMMENTS if c[6])
    bar = pg.locator(".wg-cf-bar")
    check("audit bar present", bar.count() == 1)
    bar_text = bar.inner_text() if bar.count() else ""
    check(f"bar reports {expected_hidden} filtered",
          f"{expected_hidden} comments filtered" in bar_text, bar_text.replace("\n", " ")[:120])

    # 3. audit mode reveals every filtered comment, tagged
    pg.locator(".wg-cf-bar button").click()
    pg.wait_for_timeout(200)
    revealed = sum(1 for i, c in enumerate(COMMENTS) if c[6]
                   and pg.locator(f'ytd-comment-thread-renderer[data-idx="{i}"]').is_visible())
    check("audit mode reveals all filtered", revealed == expected_hidden, f"{revealed}/{expected_hidden}")
    tags = pg.locator(".wg-cf-tag:visible").count()
    check("each filtered comment tagged with its rule", tags == expected_hidden, f"{tags}/{expected_hidden}")

    # 4. UNDO: "Not spam" restores a comment and persists the decision
    first_hidden = next(i for i, c in enumerate(COMMENTS) if c[6])
    pg.locator(f'ytd-comment-thread-renderer[data-idx="{first_hidden}"] .wg-cf-tag button').click()
    pg.wait_for_timeout(200)
    el = pg.locator(f'ytd-comment-thread-renderer[data-idx="{first_hidden}"]')
    check("undo: class removed", "wg-comment-filtered" not in (el.get_attribute("class") or ""))
    check("undo: tag removed", el.locator(".wg-cf-tag").count() == 0)
    allow = pg.evaluate("window.__store.commentAllowlist || []")
    check("undo: persisted to allowlist", len(allow) == 1, str(allow))
    check("undo: bar count decremented",
          f"{expected_hidden - 1} comments filtered" in pg.locator(".wg-cf-bar").inner_text())

    # 5. turning the filter OFF restores everything, no re-scrape
    # content.js's `let settings` is function-scoped inside the evaluate wrapper,
    # not on window — drive the class the way syncCommentFilterClasses() would.
    pg.evaluate("document.documentElement.classList.remove('wg-cf-on')")
    pg.wait_for_timeout(200)
    all_visible = all(pg.locator(f'ytd-comment-thread-renderer[data-idx="{i}"]').is_visible()
                      for i in range(len(COMMENTS)))
    check("filter off restores every comment", all_visible)

    b.close()

for ok, name, detail in results:
    print(f"  {'✓' if ok else '✗'} {name}" + (f"   [{detail}]" if not ok and detail else ""))
print(f"\n{'✗' if failures else '✓'} {len(results) - failures}/{len(results)} checks passed")
sys.exit(1 if failures else 0)

"""E2E: the popup must fit the Chrome popup window and stay fully reachable.

This exists because the popup previously set max-height on <body> alone. The
popup window sizes to <html>, so body never became the scroll container: the
page just grew, and the bottom sections and the Save button were unreachable.
Anything that regresses that is caught here.
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
POPUP = ROOT / "extension/popup/popup.html"

# Chrome caps popup height around 600px; it never gives you a taller viewport.
POPUP_VIEWPORT = {"width": 340, "height": 600}

CHROME_STUB = """
window.__store = {};
window.chrome = {
  storage: { local: {
    get: (keys, cb) => setTimeout(() => cb({...window.__store}), 0),
    set: (obj, cb) => { Object.assign(window.__store, obj); if (cb) cb(); },
  }, onChanged: { addListener: () => {} } },
  runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, getURL: p => p },
  tabs: { query: (q, cb) => cb([]), create: () => {} },
};
"""

results, failures = [], 0
def check(name, ok, detail=""):
    global failures
    results.append((ok, name, detail))
    if not ok:
        failures += 1

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport=POPUP_VIEWPORT)
    pg.add_init_script(CHROME_STUB)
    pg.goto(POPUP.as_uri())
    pg.wait_for_timeout(400)

    # 1. Nothing overflows the popup window itself.
    doc_h = pg.evaluate("document.documentElement.scrollHeight")
    check("document fits the popup window", doc_h <= POPUP_VIEWPORT["height"],
          f"scrollHeight={doc_h} > {POPUP_VIEWPORT['height']}")

    # 2. Every section heading is visible without scrolling — this is the
    #    "I had no idea the comment filter was there" fix.
    sections = pg.locator(".section[data-sec] > summary")
    n = sections.count()
    check("all 8 sections present", n == 8, f"got {n}")
    offscreen = [sections.nth(i).inner_text().split("\n")[0]
                 for i in range(n)
                 if sections.nth(i).bounding_box()["y"] + sections.nth(i).bounding_box()["height"]
                 > POPUP_VIEWPORT["height"]]
    check("every section heading visible unscrolled", not offscreen, f"below fold: {offscreen}")

    # 3. The Save button is pinned and reachable at all times.
    save = pg.locator("#saveBtn")
    box = save.bounding_box()
    check("Save button on screen", box["y"] + box["height"] <= POPUP_VIEWPORT["height"],
          f"bottom={box['y'] + box['height']}")

    # 4. The middle actually scrolls when sections are opened.
    for i in range(n):
        sections.nth(i).click()
    pg.wait_for_timeout(300)
    metrics = pg.evaluate("""() => {
        const a = document.querySelector('.scroll-area');
        return { scrollH: a.scrollHeight, clientH: a.clientHeight, docH: document.documentElement.scrollHeight };
    }""")
    check("scroll-area is the overflow container",
          metrics["scrollH"] > metrics["clientH"],
          f"scrollHeight={metrics['scrollH']} clientHeight={metrics['clientH']}")
    check("opening everything does NOT grow the document",
          metrics["docH"] <= POPUP_VIEWPORT["height"], f"docH={metrics['docH']}")

    # 5. Scrolling to the bottom reaches the last control, Save still pinned.
    pg.evaluate("document.querySelector('.scroll-area').scrollTop = 1e6")
    pg.wait_for_timeout(200)
    last = pg.locator("#blockPunctuation")
    check("last toggle reachable by scrolling", last.is_visible())
    box2 = save.bounding_box()
    check("Save stays pinned after scrolling", abs(box2["y"] - box["y"]) < 1,
          f"moved {box['y']} -> {box2['y']}")

    # 6. The comment filter controls are real and reachable.
    cf = pg.locator("#filterComments")
    check("comment filter toggle present", cf.count() == 1)
    cf.scroll_into_view_if_needed()
    check("comment filter toggle visible", cf.is_visible())
    check("audit mode toggle visible", pg.locator("#commentAuditMode").is_visible())

    # 7. Open/closed state persists across a reopen.
    pg.evaluate("""() => {
        document.querySelectorAll('.section[data-sec]').forEach(s => s.open = false);
        document.querySelector('.section[data-sec=comments]').open = true;
    }""")
    pg.wait_for_timeout(300)
    saved = pg.evaluate("window.__store.popupOpenSections")
    check("open sections persisted", saved == ["comments"], str(saved))

    # 8. Collapsed headers report their toggle counts.
    badge = pg.locator('.section[data-sec="homepage"] .count')
    check("collapsed header shows a count badge", badge.count() == 1)
    check("count badge reads 7/7", badge.inner_text() == "7/7", badge.inner_text() if badge.count() else "")

    pg.screenshot(path="/tmp/claude-1000/-home-lazycat-github-projects-sun/d20a88b5-dd25-431b-a045-8d6b34d67bc1/scratchpad/popup.png")
    b.close()

for ok, name, detail in results:
    print(f"  {'✓' if ok else '✗'} {name}" + (f"   [{detail}]" if not ok and detail else ""))
print(f"\n{'✗' if failures else '✓'} {len(results) - failures}/{len(results)} checks passed")
sys.exit(1 if failures else 0)

#!/usr/bin/env python3
"""
Headless smoke test for the Wallgarden dashboard.

There is no bundler and app.js is a 7k-line script-tag blob, so unit tests can
only reach the pure learning logic (see learn.test.mjs). This exercises the
*real* boot path in Chromium: it loads index.html, swaps the minified bundle for
the unminified source so errors map to real lines, stubs every backend/external
call, seeds a little state, and asserts the app boots, renders suggestion pills,
and switches views — with ZERO uncaught exceptions or console errors.

Run:  scraper-service/.venv/bin/python youtube-wallgarden/test/smoke.py
      (from the `sun` root; or adjust APP_DIR below)
Exit code 0 = pass, 1 = fail.
"""
import http.server
import json
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

APP_DIR = (pathlib.Path(__file__).resolve().parent.parent / "app").resolve()

# Backend + third-party hosts the boot path pokes; all stubbed to empty 200s so
# nothing hangs and the app takes its normal fetch-failure branches.
STUB_MARKERS = ("/api/", "/prism/", "/vault/", "/scraper/", "/youtube",
                "/reddit/", "open-meteo", "ipapi.co", "googleapis.com",
                "allorigins")

# Seed enough state that buildSuggestionGroups() produces pills. Keys mirror
# getProfileKey("<x>") -> wallgarden_default_<x>.
SEED = {
    "wallgarden_default_topics": json.dumps([
        {"phrase": "raku reduction firing", "weight": 9},
        {"phrase": "chemical reactions", "weight": 5},
        {"phrase": "kiln atmosphere control", "weight": 7},
    ]),
    "wallgarden_default_liked_topics": json.dumps(["raku reduction firing"]),
    "wallgarden_default_search_history": json.dumps(["pottery glaze"]),
    "wallgarden_profiles": json.dumps(["default"]),
    "wallgarden_current_profile": "default",
}


def serve(directory):
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main():
    httpd, port = serve(APP_DIR)
    base = f"http://127.0.0.1:{port}"
    errors = []
    app_js = (APP_DIR / "app.js").read_text()

    def stub_body(url):
        # Give the geo/weather chain real-shaped payloads so its normal success
        # path runs (an empty {} would make it throw and muddy the error check).
        if "ipapi.co" in url:
            return '{"latitude":0,"longitude":0,"city":"Testville"}'
        if "geocoding-api.open-meteo" in url:
            return '{"results":[{"latitude":0,"longitude":0,"name":"Testville"}]}'
        if "api.open-meteo" in url:
            return '{"current_weather":{"temperature":20,"weathercode":0,"windspeed":5}}'
        return "{}"

    def route(r):
        url = r.request.url
        if "app.min.js" in url:  # test the SOURCE, not the built bundle
            r.fulfill(status=200, content_type="application/javascript", body=app_js)
        elif any(m in url for m in STUB_MARKERS):
            r.fulfill(status=200, content_type="application/json", body=stub_body(url))
        else:
            r.continue_()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context()
            ctx.add_init_script(
                "(()=>{const s=%s;for(const k in s)localStorage.setItem(k,s[k]);})()"
                % json.dumps(SEED)
            )
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
            page.on("console", lambda m: errors.append(f"CONSOLE.error: {m.text}")
                    if m.type == "error" else None)
            page.route("**/*", route)

            page.goto(f"{base}/index.html", wait_until="domcontentloaded")
            page.wait_for_timeout(1500)  # let init fns + renderSearchSuggestions run

            checks = []

            def check(name, ok, detail=""):
                checks.append((name, ok, detail))

            # 1. Boot produced no uncaught errors / console errors.
            check("no uncaught errors", not errors, "; ".join(errors[:5]))

            # 2. Suggestion pills rendered from seeded topics.
            pills = page.locator("#search-suggestions .suggestion-pill").count()
            check("suggestion pills render", pills > 0, f"pills={pills}")

            # 3. Core layout is present.
            check("view title present", page.locator("#current-view-title").count() == 1)
            check("nav items present", page.locator(".nav-item[data-view]").count() >= 5)

            # 4. Switching views updates the title (setupEventListeners wiring).
            before = page.locator("#current-view-title").inner_text()
            page.locator('.nav-item[data-view="news-feed"]').click()
            page.wait_for_timeout(300)
            after = page.locator("#current-view-title").inner_text()
            check("view switch updates title", before != after, f"'{before}' -> '{after}'")

            # 5. createVideoCard builds a wired card (covers rating buttons +
            #    3-dot action menu, the two blocks decomposition extracts).
            card = page.evaluate(
                """() => {
                    const v = {id:'abc12345678', title:'Smoke Test Video',
                        channelName:'Test Channel', channelId:'UCxxxxxxxxxxxxxxxxxxxxxx',
                        matchedTopics:['pottery'], viewCount:1234, published:Date.now(),
                        duration:600, isDiscover:true, discoveryTopic:'pottery'};
                    const c = createVideoCard(v);
                    document.body.appendChild(c);
                    c.querySelector('.title-rating-btn[data-rating="5"]').click();  // like
                    c.querySelector('.card-action-btn').click();                    // open menu
                    return {
                        isCard: c.classList.contains('video-card'),
                        title: c.querySelector('.video-title')?.textContent,
                        ratingBtns: c.querySelectorAll('.title-rating-btn').length,
                        liked: state.videoRatings['abc12345678'] === 5,
                        menuOpen: !!document.querySelector('.card-action-dropdown'),
                    };
                }"""
            )
            check("createVideoCard builds a card", card["isCard"] and card["title"] == "Smoke Test Video",
                  str(card))
            check("card has rating buttons", card["ratingBtns"] == 2)
            check("rating click updates state", card["liked"] is True)
            check("action menu opens", card["menuOpen"] is True)

            # 6. playVideo builds the inline player shell + wired sidebar.
            player = page.evaluate(
                """() => {
                    const v = {id:'def45678901', title:'Play Test',
                        channelName:'Chan', channelId:'UCyyyyyyyyyyyyyyyyyyyyyy',
                        description:'desc', matchedTopics:[], discoveryTopic:''};
                    playVideo(v);
                    const p = document.getElementById('inline-player');
                    const like = p && p.querySelector('.sidebar-btn-like');
                    if (like) like.click();
                    return {
                        built: !!p,
                        hasSidebar: !!(p && p.querySelector('.inline-player-sidebar')),
                        sidebarButtons: p ? p.querySelectorAll('.sidebar-actions-grid .btn').length : 0,
                        playing: state.currentlyPlayingId === 'def45678901',
                    };
                }"""
            )
            check("playVideo builds inline player", player["built"] and player["hasSidebar"], str(player))
            check("sidebar action buttons wired", player["sidebarButtons"] >= 4)
            check("playVideo sets currentlyPlaying", player["playing"] is True)

            browser.close()
    finally:
        httpd.shutdown()

    failed = [c for c in checks if not c[1]]
    for name, ok, detail in checks:
        print(f"  {'✅' if ok else '❌'} {name}" + (f"  ({detail})" if detail else ""))
    if failed:
        print(f"\nSMOKE FAILED: {len(failed)}/{len(checks)} checks")
        return 1
    print(f"\nSmoke passed: {len(checks)}/{len(checks)} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())

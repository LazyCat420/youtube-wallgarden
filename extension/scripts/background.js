// ============================================================
//  WALLGARDEN: Background Router
// ============================================================
// Three jobs, in priority order:
//   1. POST every sync event straight to the Wallgarden sync API, so YouTube
//      activity is recorded even when the dashboard is CLOSED. This is the
//      durable path — the dashboard picks it up on its next pull.
//   2. Relay the event to any open dashboard tab, so an open dashboard updates
//      instantly instead of waiting for its next poll. (Cosmetic, best-effort.)
//   3. If the server is unreachable, queue the event and retry on a timer, so
//      nothing is lost when the NAS is down.
//
// Both 1 and 2 can run for the same event; that's safe because the server
// merge is per-video last-write-wins — applying the same decision twice is a
// no-op.

const WG_APP_URL_PREFIXES = [
    "http://10.0.0.16",
    "http://localhost",
    "http://127.0.0.1"
];

const DEFAULT_API_BASE = "http://10.0.0.16:8007";

const PENDING_KEY = "wg_pending_sync";
const APP_STATE_KEY = "wg_app_state";
const API_BASE_KEY = "wg_api_base";
const MAX_PENDING = 200;
const RETRY_ALARM = "wg-retry-pending";

function isWallgardenTab(tab) {
    return !!(tab.url && WG_APP_URL_PREFIXES.some(p => tab.url.startsWith(p)));
}

async function getApiBase() {
    const data = await chrome.storage.local.get([API_BASE_KEY]);
    return String(data[API_BASE_KEY] || DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** Reflect the offline-queue depth on the toolbar icon so waiting saves are visible. */
async function updateBadge() {
    const data = await chrome.storage.local.get([PENDING_KEY]);
    const count = (data[PENDING_KEY] || []).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#2e7d46" });
}

/**
 * Park an event in storage BEFORE we try to send it.
 *
 * This is the durability guarantee. An MV3 service worker can be terminated at
 * any moment — including in the middle of our fetch — and if the event only
 * existed in memory it would vanish with no trace (the .catch() would never run
 * either). Storage survives worker death, so the retry alarm can always finish
 * the job. Superseding entries for the same video+action keeps the queue tight.
 */
async function queuePendingEvent(event) {
    const data = await chrome.storage.local.get([PENDING_KEY]);
    const pending = (data[PENDING_KEY] || []).filter(
        e => !(e.videoId === event.videoId && e.action === event.action)
    );
    pending.push(event);
    await chrome.storage.local.set({ [PENDING_KEY]: pending.slice(-MAX_PENDING) });
}

/** Minimal video metadata so the dashboard can render a synced item it has never seen. */
function slimVideo(ev) {
    if (!ev || !ev.videoId) return undefined;
    const v = { id: ev.videoId, thumbnailUrl: `https://i.ytimg.com/vi/${ev.videoId}/hqdefault.jpg` };
    if (ev.title) v.title = ev.title;
    if (ev.channelName) v.channelName = ev.channelName;
    if (ev.channelId) v.channelId = ev.channelId;
    if (ev.duration) v.duration = ev.duration;
    if (ev.viewCount) v.viewCount = ev.viewCount;
    return v;
}

/**
 * Translate a YouTube action into the server's timestamped sync shape.
 * Ratings: r = 5 like / -5 dislike / 0 cleared. Queue: p = 1 present / 0 removed.
 * Returns null for actions with no server-side field (e.g. SUBSCRIBE).
 */
function buildSyncFields(ev) {
    if (!ev || !ev.videoId) return null;
    const t = ev.syncedAt || Date.now();
    const v = slimVideo(ev);
    const id = ev.videoId;

    switch (ev.action) {
        case "LIKE":
            return { ratings: { [id]: { r: 5, t, v } } };
        case "DISLIKE":
            return { ratings: { [id]: { r: -5, t, v } } };
        case "UNLIKE":
        case "UNDISLIKE":
            return { ratings: { [id]: { r: 0, t, v } } };
        case "WATCHED":
            return { watched: { [id]: t } };
        case "WATCHLIST_ADD":
        case "PLAYLIST_SAVE":
        case "WALLGARDEN_SAVE":
            return { queue: { [id]: { p: 1, t, v } } };
        case "WATCHLIST_REMOVE":
            return { queue: { [id]: { p: 0, t, v } } };
        default:
            return null;
    }
}

/** Durable path: write the event to the sync API. Throws if it doesn't land. */
async function postEventToServer(ev) {
    const fields = buildSyncFields(ev);
    if (!fields) return; // nothing to persist for this action

    const base = await getApiBase();
    const res = await fetch(`${base}/sync/global`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
    });
    if (!res.ok) throw new Error(`sync API responded ${res.status}`);
    console.log(`[Background] ${ev.action} ${ev.videoId} → synced to server`);
}

/** Best-effort: nudge any open dashboard tab so its UI updates immediately. */
function relayToOpenTabs(event) {
    chrome.tabs.query({}, (tabs) => {
        tabs.filter(isWallgardenTab).forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { type: "WG_EXT_SYNC", data: event })
                .catch(() => { /* tab open but bridge not active — server path still covers it */ });
        });
    });
}

let _flushing = false;
let _flushAgain = false;

/** Send everything queued, dropping each event only once the server has it. */
async function flushPendingToServer() {
    // Only one pass at a time (so two passes can't double-send), but a request
    // that arrives mid-pass must not be discarded — an event queued just after
    // we read the list would otherwise wait for the next alarm tick. Loop again.
    if (_flushing) { _flushAgain = true; return; }
    _flushing = true;
    try {
        do {
            _flushAgain = false;
            const data = await chrome.storage.local.get([PENDING_KEY]);
            const pending = data[PENDING_KEY] || [];
            if (pending.length === 0) continue;

            const remaining = [];
            for (const ev of pending) {
                try {
                    await postEventToServer(ev);
                } catch (e) {
                    remaining.push(ev);  // stays queued for the retry alarm
                }
            }
            await chrome.storage.local.set({ [PENDING_KEY]: remaining });
            updateBadge();
            if (remaining.length < pending.length) {
                console.log(`[Background] Synced ${pending.length - remaining.length} event(s) to server`);
            }
            if (remaining.length) {
                console.warn(`[Background] ${remaining.length} event(s) still queued — will retry`);
                break;  // server is down; wait for the alarm rather than spinning
            }
        } while (_flushAgain);
    } finally {
        _flushing = false;
    }
}

/**
 * Durable handling of one YouTube action: write it down first, then try to
 * deliver. Never do the network call alone — see queuePendingEvent().
 */
async function handleSyncEvent(event) {
    await queuePendingEvent(event);
    await flushPendingToServer();
}

// Retry queued events periodically (a service worker can be suspended, so this
// must be an alarm rather than setInterval) and whenever the worker wakes.
chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) flushPendingToServer();
});
// Flush on every worker wake-up as well as browser start / extension reload, so
// a queued like isn't sitting around waiting for the next alarm tick.
chrome.runtime.onStartup.addListener(() => flushPendingToServer());
chrome.runtime.onInstalled.addListener(() => flushPendingToServer());
updateBadge();
flushPendingToServer();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WALLGARDEN_SYNC') {
        const event = { ...message.data, syncedAt: Date.now() };
        console.log("[Background] Sync event:", event);

        // Cosmetic: instant update for an already-open dashboard.
        relayToOpenTabs(event);

        // Durable: persist + send. `return true` below is load-bearing — it keeps
        // the message channel (and therefore this service worker) alive until the
        // POST settles. Without it Chrome may terminate the worker mid-request,
        // killing the fetch AND its catch handler, so the like disappears
        // entirely — which is exactly what happened when the dashboard was
        // closed and nothing else kept the worker awake.
        handleSyncEvent(event)
            .catch(e => console.error("[Background] sync failed:", e))
            .finally(() => sendResponse({ success: true }));
        return true;
    } else if (message.type === 'WALLGARDEN_APP_READY') {
        // The dashboard now pulls state from the server itself, so there is
        // normally nothing to hand over. Kept so events queued while the server
        // was down still reach an open dashboard, and retried to the server.
        flushPendingToServer();
        sendResponse({ pending: [] });
        return true;
    } else if (message.type === 'WG_APP_STATE') {
        // Reverse channel: the dashboard mirrored its playlists / saved video IDs
        // back to us. Cache them so the YouTube content script can offer a real
        // playlist picker and badge already-saved videos.
        chrome.storage.local.set({ [APP_STATE_KEY]: message.data || {} });
        sendResponse({ success: true });
    }
});

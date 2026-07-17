// ============================================================
//  WALLGARDEN: Bridge Script (Extension -> App context)
// ============================================================

// Listen directly to incoming messages from background service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'WG_EXT_SYNC') {
        console.log("[Wallgarden Bridge] Forwarding sync event to page:", message.data);
        window.postMessage({
            type: 'WG_EXT_SYNC',
            data: message.data
        }, "*");
    }
});

// Reverse channel: the dashboard page broadcasts its state (playlists, saved
// video IDs) via window.postMessage. Relay it up to the background worker so it
// can be cached for the YouTube content script.
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'WG_APP_STATE') return;
    try {
        chrome.runtime.sendMessage({ type: 'WG_APP_STATE', data: event.data.data }, () => {
            if (chrome.runtime.lastError) {
                // Background worker may be asleep — harmless, next broadcast retries
            }
        });
    } catch (e) {
        console.warn("[Wallgarden Bridge] Failed to relay app state:", e.message);
    }
});

// On app load, pull any sync events that were queued while the app was closed.
// Wait past window load so the app's message listener (deferred script) exists.
function flushPendingSyncEvents() {
    try {
        chrome.runtime.sendMessage({ type: 'WALLGARDEN_APP_READY' }, (resp) => {
            if (chrome.runtime.lastError) {
                console.warn("[Wallgarden Bridge] Pending flush failed:", chrome.runtime.lastError.message);
                return;
            }
            const pending = (resp && resp.pending) || [];
            if (pending.length === 0) return;
            console.log(`[Wallgarden Bridge] Replaying ${pending.length} queued sync events`);
            pending.forEach(ev => {
                window.postMessage({ type: 'WG_EXT_SYNC', data: ev }, "*");
            });
        });
    } catch (e) {
        console.warn("[Wallgarden Bridge] Pending flush exception:", e.message);
    }
}

if (document.readyState === 'complete') {
    setTimeout(flushPendingSyncEvents, 1500);
} else {
    window.addEventListener('load', () => setTimeout(flushPendingSyncEvents, 1500));
}

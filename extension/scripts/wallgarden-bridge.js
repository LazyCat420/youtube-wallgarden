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

// ============================================================
//  WALLGARDEN: Background Router (Message Relay + Offline Queue)
// ============================================================

const WG_APP_URL_PREFIXES = [
    "http://10.0.0.16",
    "http://localhost",
    "http://127.0.0.1"
];

const PENDING_KEY = "wg_pending_sync";
const MAX_PENDING = 200;

function isWallgardenTab(tab) {
    return !!(tab.url && WG_APP_URL_PREFIXES.some(p => tab.url.startsWith(p)));
}

function queuePendingEvent(event) {
    chrome.storage.local.get([PENDING_KEY], (data) => {
        const pending = data[PENDING_KEY] || [];
        pending.push(event);
        chrome.storage.local.set({ [PENDING_KEY]: pending.slice(-MAX_PENDING) });
        console.log("[Background] No Wallgarden tab reachable — queued sync event for later:", event);
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WALLGARDEN_SYNC') {
        const event = { ...message.data, syncedAt: Date.now() };
        console.log("[Background] Routing sync event to Wallgarden tabs:", event);

        chrome.tabs.query({}, (tabs) => {
            const targets = tabs.filter(isWallgardenTab);

            if (targets.length === 0) {
                // App not open — persist so it syncs on next app load
                queuePendingEvent(event);
                return;
            }

            let attempts = 0;
            let delivered = 0;
            targets.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'WG_EXT_SYNC',
                    data: event
                }).then(() => {
                    delivered++;
                }).catch(() => {
                    // Tab exists but bridge content script isn't active
                }).finally(() => {
                    attempts++;
                    if (attempts === targets.length && delivered === 0) {
                        queuePendingEvent(event);
                    }
                });
            });
        });

        sendResponse({ success: true });
    } else if (message.type === 'WALLGARDEN_APP_READY') {
        // Wallgarden app tab loaded — hand over any queued events
        chrome.storage.local.get([PENDING_KEY], (data) => {
            const pending = data[PENDING_KEY] || [];
            if (pending.length > 0) {
                console.log(`[Background] Flushing ${pending.length} queued sync events to Wallgarden app`);
                chrome.storage.local.set({ [PENDING_KEY]: [] });
            }
            sendResponse({ pending });
        });
        return true; // keep sendResponse alive for the async storage read
    }
});

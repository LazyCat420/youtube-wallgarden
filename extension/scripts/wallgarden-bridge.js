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

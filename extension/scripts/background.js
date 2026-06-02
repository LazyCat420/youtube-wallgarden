// ============================================================
//  WALLGARDEN: Background Router (Message Relay)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WALLGARDEN_SYNC') {
        console.log("[Background] Routing sync event:", message.data);
        
        // Find all Wallgarden tabs (by matching the likely origins)
        chrome.tabs.query({ url: ["http://10.0.0.16:*/*", "http://localhost:*/*", "http://127.0.0.1:*/*"] }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'WG_EXT_SYNC',
                    data: message.data
                });
            });
        });
        sendResponse({ success: true });
    }
});

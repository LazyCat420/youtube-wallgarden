// ============================================================
//  WALLGARDEN: Background Router (Message Relay)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WALLGARDEN_SYNC') {
        console.log("[Background] Routing sync event:", message.data);
        
        // Find all Wallgarden tabs (by matching the likely origins)
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                if (tab.url && (tab.url.startsWith("http://10.0.0.16") || tab.url.startsWith("http://localhost") || tab.url.startsWith("http://127.0.0.1"))) {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'WG_EXT_SYNC',
                        data: message.data
                    }).catch(() => {});
                }
            });
        });
        sendResponse({ success: true });
    }
});

// ============================================================
//  WALLGARDEN: Background Router (Message Relay)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WALLGARDEN_SYNC') {
        console.log("[Background] Routing sync event to Wallgarden tabs:", message.data);
        
        // Query all tabs and broadcast to any Wallgarden app instances
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                if (tab.url && (
                    tab.url.startsWith("http://10.0.0.16") || 
                    tab.url.startsWith("http://localhost") || 
                    tab.url.startsWith("http://127.0.0.1")
                )) {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'WG_EXT_SYNC',
                        data: message.data
                    }).catch((err) => {
                        // Ignore errors from tabs that do not have the content script active
                    });
                }
            });
        });

        sendResponse({ success: true });
    }
});

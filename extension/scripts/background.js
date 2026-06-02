// ============================================================
//  WALLGARDEN: Background Router (Message Relay)
// ============================================================

// Keep track of active Port connections from Wallgarden tabs
const activeBridgePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'wallgarden-bridge') {
        activeBridgePorts.add(port);
        console.log("[Background] Wallgarden bridge connected. Active ports:", activeBridgePorts.size);
        
        port.onDisconnect.addListener(() => {
            activeBridgePorts.delete(port);
            console.log("[Background] Wallgarden bridge disconnected. Active ports:", activeBridgePorts.size);
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WALLGARDEN_SYNC') {
        console.log("[Background] Routing sync event to active ports:", message.data);
        
        // 1. Send via active Port connections (preferred)
        activeBridgePorts.forEach(port => {
            try {
                port.postMessage({
                    type: 'WG_EXT_SYNC',
                    data: message.data
                });
            } catch (e) {
                console.warn("[Background] Failed to send sync event through port:", e);
                activeBridgePorts.delete(port);
            }
        });

        // 2. Fallback: Query all tabs and send via chrome.tabs.sendMessage (for unrefreshed Wallgarden tabs)
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

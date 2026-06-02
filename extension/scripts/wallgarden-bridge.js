// ============================================================
//  WALLGARDEN: Bridge Script (Extension -> App context)
// ============================================================

// Establish a long-lived Port connection with background.js
let port = null;

function connectToBackground() {
    try {
        port = chrome.runtime.connect({ name: 'wallgarden-bridge' });
        
        port.onMessage.addListener((message) => {
            if (message.type === 'WG_EXT_SYNC') {
                window.postMessage({
                    type: 'WG_EXT_SYNC',
                    data: message.data
                }, "*");
            }
        });

        port.onDisconnect.addListener(() => {
            port = null;
            // Attempt to reconnect after a delay if context is still valid
            setTimeout(connectToBackground, 5000);
        });
    } catch (e) {
        // Handle connection or context invalidated errors
    }
}

// Initial connection
connectToBackground();

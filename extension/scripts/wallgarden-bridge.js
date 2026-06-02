// ============================================================
//  WALLGARDEN: Bridge Script (Extension -> App context)
// ============================================================

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WG_EXT_SYNC') {
        // Forward to the webpage context via window.postMessage
        window.postMessage({
            type: 'WG_EXT_SYNC',
            data: message.data
        }, "*");
    }
});

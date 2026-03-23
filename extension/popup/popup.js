// All setting keys that map to checkbox IDs in the popup
const SETTING_KEYS = [
    // Smart Blocklist
    'enableSmartBlock',
    // Homepage
    'blockShorts', 'blockBreakingNews', 'blockTrending', 'blockCommunityPosts',
    'blockPeopleAlsoWatched', 'blockAds', 'blockMoviesShows',
    // Watch Page
    'blockMerch', 'blockDonations', 'blockShortsRemix', 'blockChatReplay',
    'blockInfoCards', 'blockClipThanks',
    // Global
    'blockPremiumUpsell', 'blockNotifPopup', 'blockMusicUpsell',
    // Heuristics
    'blockAllCaps', 'blockPunctuation'
];

const TEXT_KEYS = [];

document.addEventListener('DOMContentLoaded', () => {
    const saveBtn = document.getElementById('saveBtn');
    const saveStatus = document.getElementById('saveStatus');
    const exportBtn = document.getElementById('exportBtn');
    const clearBtn = document.getElementById('clearBtn');
    const addChannelBtn = document.getElementById('addChannelBtn');
    const addChannelInput = document.getElementById('addChannelInput');

    // Manual add channel
    function addChannelFromInput() {
        const name = addChannelInput.value.trim();
        if (!name) return;
        chrome.storage.local.get('blocklist', (data) => {
            const bl = data.blocklist || { channels: [], keywords: {}, rejectionLog: [] };
            const lower = name.toLowerCase();
            if (!bl.channels.includes(lower)) {
                bl.channels.push(lower);
                chrome.storage.local.set({ blocklist: bl }, () => {
                    renderBlocklist(bl);
                    addChannelInput.value = '';
                });
            } else {
                addChannelInput.value = '';
                saveStatus.textContent = 'Already blocked!';
                setTimeout(() => { saveStatus.textContent = ''; }, 1500);
            }
        });
    }

    addChannelBtn.addEventListener('click', addChannelFromInput);
    addChannelInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addChannelFromInput();
    });

    // Load existing settings
    chrome.storage.local.get([...SETTING_KEYS, ...TEXT_KEYS, 'blocklist'], (data) => {
        SETTING_KEYS.forEach(key => {
            const el = document.getElementById(key);
            if (el && data[key] !== undefined) el.checked = data[key];
        });
        TEXT_KEYS.forEach(key => {
            const el = document.getElementById(key);
            if (el && data[key] !== undefined) el.value = data[key];
        });

        // Render blocklist
        renderBlocklist(data.blocklist);
    });

    // Save settings
    saveBtn.addEventListener('click', () => {
        const payload = {};
        SETTING_KEYS.forEach(key => {
            const el = document.getElementById(key);
            if (el) payload[key] = el.checked;
        });
        TEXT_KEYS.forEach(key => {
            const el = document.getElementById(key);
            if (el) payload[key] = el.value.trim();
        });

        chrome.storage.local.set(payload, () => {
            saveStatus.textContent = '✓ Settings saved!';
            setTimeout(() => { saveStatus.textContent = ''; }, 2000);
        });
    });

    // Export blocklist as JSON
    exportBtn.addEventListener('click', () => {
        chrome.storage.local.get('blocklist', (data) => {
            const blob = new Blob([JSON.stringify(data.blocklist || {}, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'wallgarden-blocklist.json';
            a.click();
            URL.revokeObjectURL(url);
        });
    });

    // Clear all blocklist data
    clearBtn.addEventListener('click', () => {
        if (confirm('Clear all blocked channels and learned keywords? This cannot be undone.')) {
            const emptyBlocklist = { channels: [], keywords: {}, rejectionLog: [] };
            chrome.storage.local.set({ blocklist: emptyBlocklist }, () => {
                renderBlocklist(emptyBlocklist);
                saveStatus.textContent = '✓ Blocklist cleared!';
                setTimeout(() => { saveStatus.textContent = ''; }, 2000);
            });
        }
    });
});

/**
 * Render the blocked channels list and stats in the popup
 */
function renderBlocklist(blocklist) {
    const listEl = document.getElementById('blockedChannelsList');
    const statChannels = document.getElementById('statChannels');
    const statKeywords = document.getElementById('statKeywords');

    if (!blocklist || !blocklist.channels) {
        blocklist = { channels: [], keywords: {}, rejectionLog: [] };
    }

    // Update stats
    statChannels.textContent = `${blocklist.channels.length} channels blocked`;
    const kwCount = Object.keys(blocklist.keywords || {}).length;
    statKeywords.textContent = `${kwCount} keywords tracked`;

    // Render channel list
    listEl.innerHTML = '';

    if (blocklist.channels.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No channels blocked yet. Use YouTube\'s "Don\'t recommend channel" to start learning.</div>';
        return;
    }

    blocklist.channels.forEach(channel => {
        const item = document.createElement('div');
        item.className = 'blocked-item';

        const name = document.createElement('span');
        name.textContent = channel;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Unblock this channel';
        removeBtn.addEventListener('click', () => {
            removeChannel(channel);
        });

        item.appendChild(name);
        item.appendChild(removeBtn);
        listEl.appendChild(item);
    });
}

/**
 * Remove a single channel from the blocklist
 */
function removeChannel(channelName) {
    chrome.storage.local.get('blocklist', (data) => {
        const bl = data.blocklist || { channels: [], keywords: {}, rejectionLog: [] };
        bl.channels = bl.channels.filter(c => c !== channelName);
        chrome.storage.local.set({ blocklist: bl }, () => {
            renderBlocklist(bl);
        });
    });
}

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
    'blockAllCaps', 'blockPunctuation',
    // Collapsible panels (fold away, don't delete)
    'collapseChat', 'collapseRelated', 'collapseComments',
    // Comment filter (hide in place, always reversible)
    'filterComments', 'commentAuditMode'
];

const TEXT_KEYS = [];

const WG_DASHBOARD_URL = "http://10.0.0.16:8007";

document.addEventListener('DOMContentLoaded', () => {
    const saveBtn = document.getElementById('saveBtn');
    const saveStatus = document.getElementById('saveStatus');
    const exportBtn = document.getElementById('exportBtn');
    const clearBtn = document.getElementById('clearBtn');
    const addChannelBtn = document.getElementById('addChannelBtn');
    const addChannelInput = document.getElementById('addChannelInput');
    const openDashboardBtn = document.getElementById('openDashboardBtn');

    // Dashboard sync panel
    openDashboardBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: WG_DASHBOARD_URL });
    });

    function renderSyncStatus(data) {
        const appStateData = data.wg_app_state || {};
        const pending = data.wg_pending_sync || [];
        const playlists = appStateData.playlists || [];
        const savedCount = (appStateData.savedVideoIds || []).length;

        const statQueue = document.getElementById('statQueue');
        const statPlaylists = document.getElementById('statPlaylists');
        const statPending = document.getElementById('statPending');

        statQueue.textContent = `${savedCount} saved video${savedCount === 1 ? '' : 's'}`;
        statPlaylists.textContent = `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`;
        statPending.textContent = pending.length > 0
            ? `⏳ ${pending.length} event${pending.length === 1 ? '' : 's'} waiting for dashboard`
            : '✓ All synced';
    }

    chrome.storage.local.get(['wg_app_state', 'wg_pending_sync'], renderSyncStatus);

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
        // Counts read the checkboxes, so they must run after the values land.
        refreshSectionCounts();
    });

    initCollapsibleSections();

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

    // Keep the collapsed-header counts honest as toggles are flipped.
    document.querySelector('.scroll-area')?.addEventListener('change', e => {
        if (e.target.matches('input[type="checkbox"]')) refreshSectionCounts();
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

    // Forget the comments the user hand-cleared in audit mode. Safe to do at
    // any time: they simply get re-classified on the next page load.
    document.getElementById('clearCommentAllowlist')?.addEventListener('click', () => {
        chrome.storage.local.set({ commentAllowlist: [] }, () => {
            saveStatus.textContent = '✓ Cleared "not spam" decisions';
            setTimeout(() => { saveStatus.textContent = ''; }, 2000);
        });
    });
});

// Sections are collapsed by default so every heading fits on one screen — the
// old flat layout ran past the bottom of the popup and the last sections were
// unreachable. Open state is remembered per section.
const OPEN_SECTIONS_KEY = 'popupOpenSections';

function initCollapsibleSections() {
    const sections = [...document.querySelectorAll('.section[data-sec]')];
    chrome.storage.local.get([OPEN_SECTIONS_KEY], (data) => {
        const open = new Set(data[OPEN_SECTIONS_KEY] || []);
        sections.forEach(s => { s.open = open.has(s.dataset.sec); });
    });
    sections.forEach(s => {
        s.addEventListener('toggle', () => {
            const open = sections.filter(x => x.open).map(x => x.dataset.sec);
            chrome.storage.local.set({ [OPEN_SECTIONS_KEY]: open });
        });
    });
}

/**
 * Badge each collapsed header with how many of its toggles are on, so a shut
 * section still reports its state without being opened.
 */
function refreshSectionCounts() {
    document.querySelectorAll('.section[data-sec]').forEach(section => {
        const boxes = [...section.querySelectorAll('input[type="checkbox"]')];
        const summary = section.querySelector(':scope > summary');
        if (!summary) return;

        let badge = summary.querySelector('.count');
        if (!boxes.length) { badge?.remove(); return; }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'count';
            // Ahead of the chevron, which is a ::after on the summary itself.
            summary.appendChild(badge);
        }
        const on = boxes.filter(b => b.checked).length;
        badge.textContent = `${on}/${boxes.length}`;
        badge.classList.toggle('none', on === 0);
    });
}

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

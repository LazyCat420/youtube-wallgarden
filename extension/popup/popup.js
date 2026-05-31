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
    'blockPremiumUpsell', 'blockNotifPopup', 'blockMusicUpsell', 'enableAgeBypass',
    // Heuristics
    'blockAllCaps', 'blockPunctuation'
];

const TEXT_KEYS = [];

let currentProfileId = 'default';
let allProfiles = [];
let profileBlocklist = { channels: [], keywords: {}, rejectionLog: [] };

document.addEventListener('DOMContentLoaded', () => {
    const profileSelect = document.getElementById('profileSelect');
    const addProfileBtn = document.getElementById('addProfileBtn');
    const deleteProfileBtn = document.getElementById('deleteProfileBtn');

    const saveBtn = document.getElementById('saveBtn');
    const saveStatus = document.getElementById('saveStatus');
    const exportBtn = document.getElementById('exportBtn');
    const clearBtn = document.getElementById('clearBtn');
    const addChannelBtn = document.getElementById('addChannelBtn');
    const addChannelInput = document.getElementById('addChannelInput');

    // 1. Initial Load & Migration
    chrome.storage.local.get(['activeProfileId', 'profiles', 'blocklist', ...SETTING_KEYS, ...TEXT_KEYS], (data) => {
        if (!data.profiles || data.profiles.length === 0) {
            // First time migration to profiles
            allProfiles = [
                { id: 'default', name: 'General', type: 'normal' },
                { id: 'incognito', name: 'Incognito', type: 'incognito' }
            ];
            currentProfileId = 'default';
            const payload = {
                profiles: allProfiles,
                activeProfileId: currentProfileId,
                blocklist_default: data.blocklist || { channels: [], keywords: {}, rejectionLog: [] }
            };
            // Cleanup the old flat blocklist to save space, if desired. We'll leave it for now just in case.
            chrome.storage.local.set(payload, () => {
                initializeUI(data);
            });
        } else {
            allProfiles = data.profiles;
            currentProfileId = data.activeProfileId || allProfiles[0].id;
            initializeUI(data);
        }
    });

    function initializeUI(data) {
        // Load settings (global)
        SETTING_KEYS.forEach(key => {
            const el = document.getElementById(key);
            if (el && data[key] !== undefined) el.checked = data[key];
        });
        TEXT_KEYS.forEach(key => {
            const el = document.getElementById(key);
            if (el && data[key] !== undefined) el.value = data[key];
        });

        renderProfileDropdown();
        loadProfileBlocklist(currentProfileId);
    }

    // 2. Profile Management
    function renderProfileDropdown() {
        profileSelect.innerHTML = '';
        allProfiles.forEach(p => {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = p.name;
            if (p.type === 'incognito') option.textContent = '🕵️ ' + p.name;
            if (p.id === currentProfileId) option.selected = true;
            profileSelect.appendChild(option);
        });
        updateIncognitoUI();
    }

    function updateIncognitoUI() {
        const isIncognito = allProfiles.find(p => p.id === currentProfileId)?.type === 'incognito';
        if (isIncognito) {
            profileSelect.classList.add('incognito-mode');
        } else {
            profileSelect.classList.remove('incognito-mode');
        }
    }

    profileSelect.addEventListener('change', (e) => {
        const newProfileId = e.target.value;
        if (newProfileId !== currentProfileId) {
            currentProfileId = newProfileId;
            chrome.storage.local.set({ activeProfileId: currentProfileId }, () => {
                updateIncognitoUI();
                loadProfileBlocklist(currentProfileId);
            });
        }
    });

    addProfileBtn.addEventListener('click', () => {
        const name = prompt('Enter a name for the new profile (e.g. Stocks, Coding):');
        if (name && name.trim()) {
            const id = 'profile_' + Date.now();
            allProfiles.push({ id, name: name.trim(), type: 'normal' });
            currentProfileId = id;
            const emptyBlocklist = { channels: [], keywords: {}, rejectionLog: [] };
            chrome.storage.local.set({ 
                profiles: allProfiles, 
                activeProfileId: currentProfileId,
                [`blocklist_${id}`]: emptyBlocklist
            }, () => {
                renderProfileDropdown();
                loadProfileBlocklist(currentProfileId);
            });
        }
    });

    deleteProfileBtn.addEventListener('click', () => {
        if (currentProfileId === 'default' || currentProfileId === 'incognito') {
            alert('Cannot delete default or incognito profiles.');
            return;
        }
        if (confirm('Are you sure you want to delete this profile?')) {
            allProfiles = allProfiles.filter(p => p.id !== currentProfileId);
            currentProfileId = 'default';
            chrome.storage.local.set({ 
                profiles: allProfiles, 
                activeProfileId: currentProfileId 
            }, () => {
                renderProfileDropdown();
                loadProfileBlocklist(currentProfileId);
            });
        }
    });

    // 3. Blocklist Management
    function loadProfileBlocklist(profileId) {
        chrome.storage.local.get(`blocklist_${profileId}`, (data) => {
            profileBlocklist = data[`blocklist_${profileId}`] || { channels: [], keywords: {}, rejectionLog: [] };
            renderBlocklist(profileBlocklist);
        });
    }

    function addChannelFromInput() {
        const isIncognito = allProfiles.find(p => p.id === currentProfileId)?.type === 'incognito';
        if (isIncognito) {
            saveStatus.textContent = 'Cannot add to Incognito profile!';
            setTimeout(() => { saveStatus.textContent = ''; }, 1500);
            return;
        }

        const name = addChannelInput.value.trim();
        if (!name) return;
        
        const lower = name.toLowerCase();
        if (!profileBlocklist.channels) profileBlocklist.channels = [];
        
        if (!profileBlocklist.channels.includes(lower)) {
            profileBlocklist.channels.push(lower);
            chrome.storage.local.set({ [`blocklist_${currentProfileId}`]: profileBlocklist }, () => {
                renderBlocklist(profileBlocklist);
                addChannelInput.value = '';
            });
        } else {
            addChannelInput.value = '';
            saveStatus.textContent = 'Already blocked!';
            setTimeout(() => { saveStatus.textContent = ''; }, 1500);
        }
    }

    addChannelBtn.addEventListener('click', addChannelFromInput);
    addChannelInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addChannelFromInput();
    });

    // Save global settings
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
        const blob = new Blob([JSON.stringify(profileBlocklist || {}, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const profileName = allProfiles.find(p => p.id === currentProfileId)?.name || 'export';
        a.download = `wallgarden-${profileName.toLowerCase()}-blocklist.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Clear all blocklist data for current profile
    clearBtn.addEventListener('click', () => {
        const isIncognito = allProfiles.find(p => p.id === currentProfileId)?.type === 'incognito';
        if (isIncognito) return; // Nothing to clear

        if (confirm('Clear all blocked channels and learned keywords for this profile? This cannot be undone.')) {
            profileBlocklist = { channels: [], keywords: {}, rejectionLog: [] };
            chrome.storage.local.set({ [`blocklist_${currentProfileId}`]: profileBlocklist }, () => {
                renderBlocklist(profileBlocklist);
                saveStatus.textContent = '✓ Blocklist cleared!';
                setTimeout(() => { saveStatus.textContent = ''; }, 2000);
            });
        }
    });

    window.removeChannel = function(channelName) {
        if (!profileBlocklist.channels) return;
        profileBlocklist.channels = profileBlocklist.channels.filter(c => c !== channelName);
        chrome.storage.local.set({ [`blocklist_${currentProfileId}`]: profileBlocklist }, () => {
            renderBlocklist(profileBlocklist);
        });
    };
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
            window.removeChannel(channel);
        });

        item.appendChild(name);
        item.appendChild(removeBtn);
        listEl.appendChild(item);
    });
}

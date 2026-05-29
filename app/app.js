// 🌿 Wallgarden - Dashboard Controller

// Seeding Default Channels (if empty)
const DEFAULT_CHANNELS = [
    { name: "Fireship", id: "UCsBjURrPoezykLs9EqgamOA" },
    { name: "3Blue1Brown", id: "UCYO_jab_esuFRV4b17AJtAw" },
    { name: "The Primeagen", id: "UC8ENHE5xdFSwx71u3fDH5Xw" },
    { name: "Veritasium", id: "UCHnyfMqiRRG1u-2MsSQLbXA" },
    { name: "Lex Fridman", id: "UCSHZKyawb77ixDdsGog4iWA" }
];

// Seeding Default Topics (if empty)
const DEFAULT_TOPICS = [
    { phrase: "coding", weight: 5 },
    { phrase: "programming", weight: 5 },
    { phrase: "javascript", weight: 3 },
    { phrase: "rust", weight: 4 },
    { phrase: "ai", weight: 5 },
    { phrase: "artificial intelligence", weight: 5 },
    { phrase: "llm", weight: 5 },
    { phrase: "math", weight: 3 },
    { phrase: "science", weight: 3 },
    { phrase: "physics", weight: 3 },
    { phrase: "gossip", weight: -10 },
    { phrase: "drama", weight: -10 },
    { phrase: "brainrot", weight: -10 }
];

// State Manager
let state = {
    channels: [],
    topics: [],
    blockedChannels: [], // Array of { name: string, id: string }
    cache: {
        videos: {}, // channelId -> array of videos
        lastSync: 0
    },
    currentView: "smart-feed", // 'smart-feed', or search queries
    searchQuery: "",
    searchHistory: [], // Rolling history of searches (max 10)
    brainstormTopics: [], // Brainstormed topics from LLM
    brainstormLoading: false,
    lastBrainstormTime: 0,
    lastBrainstormAttempt: 0,
    videoRatings: {}, // explicit ratings set by user
    settings: {
        useYtdlp: true,
        muteShorts: false
    },
    discoverBatchIndex: 0,
    discoverMaxReached: false,

    // Smart Feed State
    smartFeedVideos: [],
    smartFeedTopicsQueue: [],
    smartFeedUsedTopics: [],
    smartFeedLoading: false,
    smartFeedInitialized: false,
    smartFeedSubscriptionIndex: 0,
    smartFeedPreloadedVideos: [],
    smartFeedPreloadLoading: false
};

const DISCOVER_BATCH_SIZE = 30;
const DISCOVER_MAX_RESULTS = 150;

// In-memory session cache for topic search discovery results
let sessionTopicSearchCache = {};
let topicSearchLoading = {};
let renderTimeouts = [];
let searchDebounceTimeout = null;

function clearRenderTimeouts() {
    renderTimeouts.forEach(t => clearTimeout(t));
    renderTimeouts = [];
}

function getWeightedRandomTopics(topics) {
    const positiveTopics = topics.filter(t => t.weight > 0);
    // Sort using weighted random sampling without replacement (A-Res algorithm)
    return positiveTopics
        .map(t => ({
            phrase: t.phrase.toLowerCase(),
            sortKey: Math.pow(Math.random(), 1 / t.weight)
        }))
        .sort((a, b) => b.sortKey - a.sortKey)
        .map(t => t.phrase);
}

function initSmartFeed() {
    state.smartFeedVideos = [];
    state.smartFeedUsedTopics = [];
    state.smartFeedLoading = false;
    state.smartFeedSubscriptionIndex = 0;
    state.smartFeedInitialized = true;
    state.smartFeedPreloadedVideos = [];
    state.smartFeedPreloadLoading = false;
    
    // Get positive topics randomized by weight
    const randomizedTopics = getWeightedRandomTopics(state.topics);
    
    state.smartFeedTopicsQueue = [...randomizedTopics];
    if (state.smartFeedTopicsQueue.length === 0) {
        state.smartFeedTopicsQueue = ["coding", "programming", "ai", "science", "physics"];
    }
    console.log("[Smart Feed] Initialized with topics queue:", state.smartFeedTopicsQueue);
    
    // Start background preloading
    fillSmartFeedPreloadBuffer();
}

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
    loadState();
    setupEventListeners();
    initSmartFeed();
    fetchLlmModel();
    updateSubCount();
    renderSearchSuggestions();
    
    // Render cached feed immediately so the UI is active and loads discovery videos
    renderFeed();
    
    // Auto-sync in the background if cache is empty or older than 1 hour (3600 seconds)
    const cacheAge = (Date.now() - state.cache.lastSync) / 1000;
    if (cacheAge > 3600 || getCachedVideosCount() === 0) {
        syncFeeds(true); // silent background sync
    } else {
        updateStatusText(`Loaded from cache (${Math.round(cacheAge/60)}m ago)`);
    }

    // Unconditionally run background brainstorm topics on load to populate the feed and hit vLLM
    setTimeout(() => {
        console.log("[Smart Feed] Launch brainstorm started...");
        generateBrainstormTopics(true, 1); // Appends new topics with 1 request
    }, 1000);
});

// Update subscription count badge in sidebar
function updateSubCount() {
    const el = document.getElementById("nav-sub-count");
    if (el) el.textContent = state.channels.length;
}

// Render suggestion pills under the search bar
function renderSearchSuggestions() {
    const container = document.getElementById("search-suggestions");
    if (!container) return;
    container.innerHTML = "";
    
    const suggestions = new Set();
    
    // 1. Positive-weight topics
    state.topics
        .filter(t => t.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .forEach(t => suggestions.add(t.phrase.toLowerCase()));
    
    // 2. Liked topics
    if (state.likedTopics) {
        state.likedTopics.forEach(t => suggestions.add(t.toLowerCase()));
    }
    
    // 3. Recent search history (last 5)
    if (state.searchHistory) {
        state.searchHistory.slice(0, 5).forEach(q => suggestions.add(q.toLowerCase()));
    }
    
    // Limit to 12 pills
    const pills = [...suggestions].slice(0, 12);
    
    pills.forEach(topic => {
        const pill = document.createElement("button");
        pill.className = "suggestion-pill";
        pill.type = "button";
        pill.textContent = topic.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        pill.addEventListener("click", () => {
            const searchInput = document.getElementById("input-search-videos");
            if (searchInput) searchInput.value = topic;
            state.discoverBatchIndex = 0;
            state.discoverMaxReached = false;
            triggerGlobalSearch(topic);
        });
        container.appendChild(pill);
    });
}

// Load variables from Local Storage
function loadState() {
    const rawChannels = localStorage.getItem("wallgarden_channels");
    const rawTopics = localStorage.getItem("wallgarden_topics");
    const rawBlocked = localStorage.getItem("wallgarden_blocked_channels");
    const rawCache = localStorage.getItem("wallgarden_cache");
    const rawSettings = localStorage.getItem("wallgarden_settings");
    const rawSearchHistory = localStorage.getItem("wallgarden_search_history");
    const rawBrainstorm = localStorage.getItem("wallgarden_brainstorm_topics");
    const rawVideoRatings = localStorage.getItem("wallgarden_video_ratings");
    const rawDiscovered = localStorage.getItem("wallgarden_discovered_channels");

    const rawLiked = localStorage.getItem("wallgarden_liked_topics");
    const rawDisliked = localStorage.getItem("wallgarden_disliked_topics");

    state.channels = rawChannels ? JSON.parse(rawChannels) : [...DEFAULT_CHANNELS];
    state.topics = rawTopics ? JSON.parse(rawTopics) : [...DEFAULT_TOPICS];
    state.blockedChannels = rawBlocked ? JSON.parse(rawBlocked) : [];
    state.likedTopics = rawLiked ? JSON.parse(rawLiked) : [];
    state.dislikedTopics = rawDisliked ? JSON.parse(rawDisliked) : [];
    state.settings = rawSettings ? JSON.parse(rawSettings) : { useYtdlp: true, muteShorts: false };
    state.searchHistory = rawSearchHistory ? JSON.parse(rawSearchHistory) : [];
    state.brainstormTopics = rawBrainstorm ? JSON.parse(rawBrainstorm) : [];
    state.videoRatings = rawVideoRatings ? JSON.parse(rawVideoRatings) : {};
    state.discoveredChannels = rawDiscovered ? JSON.parse(rawDiscovered) : [];
    
    if (rawCache) {
        state.cache = JSON.parse(rawCache);
    }

    // Migrate old bad default channel IDs if present
    let migrated = false;
    state.channels = state.channels.map(ch => {
        if (ch.id === "UCsBjURrdUwzDMc21q5cEQcA") { // old Fireship
            migrated = true;
            return { name: "Fireship", id: "UCsBjURrPoezykLs9EqgamOA" };
        }
        if (ch.id === "UCuzc7nC_G-Ssp-kK1335T4Q") { // old The Primeagen
            migrated = true;
            return { name: "The Primeagen", id: "UC8ENHE5xdFSwx71u3fDH5Xw" };
        }
        if (ch.id === "UCSHZKyawb77KJmFMK23ORVg") { // old Lex Fridman
            migrated = true;
            return { name: "Lex Fridman", id: "UCSHZKyawb77ixDdsGog4iWA" };
        }
        return ch;
    });

    if (migrated) {
        saveChannels();
        state.cache = { videos: {}, lastSync: 0 };
        saveCache();
    }
    
    // Save defaults back to storage if they were missing
    if (!rawChannels) saveChannels();
    if (!rawTopics) saveTopics();
    if (!rawBlocked) saveBlocked();

    document.getElementById("subscribed-count").textContent = state.channels.length;
    document.getElementById("blocked-count").textContent = state.blockedChannels.length;

    // Set settings toggles UI
    document.getElementById("toggle-use-ytdlp").checked = state.settings.useYtdlp;
    document.getElementById("toggle-mute-shorts").checked = state.settings.muteShorts;
}

function saveSettings() {
    localStorage.setItem("wallgarden_settings", JSON.stringify(state.settings));
}

function saveBlocked() {
    localStorage.setItem("wallgarden_blocked_channels", JSON.stringify(state.blockedChannels));
    document.getElementById("blocked-count").textContent = state.blockedChannels.length;
}

// Save helpers
function saveChannels() {
    localStorage.setItem("wallgarden_channels", JSON.stringify(state.channels));
    document.getElementById("subscribed-count").textContent = state.channels.length;
}

function saveTopics() {
    localStorage.setItem("wallgarden_topics", JSON.stringify(state.topics));
}

function saveLikedTopics() {
    localStorage.setItem("wallgarden_liked_topics", JSON.stringify(state.likedTopics));
}

function saveDislikedTopics() {
    localStorage.setItem("wallgarden_disliked_topics", JSON.stringify(state.dislikedTopics));
}

function saveCache() {
    localStorage.setItem("wallgarden_cache", JSON.stringify(state.cache));
}

function saveVideoRatings() {
    localStorage.setItem("wallgarden_video_ratings", JSON.stringify(state.videoRatings));
}

function saveSearchHistory() {
    localStorage.setItem("wallgarden_search_history", JSON.stringify(state.searchHistory));
}

function getCachedVideosCount() {
    return Object.values(state.cache.videos).reduce((acc, curr) => acc + curr.length, 0);
}

// Setup Interactive UI Listeners
function setupEventListeners() {
    // Navigation
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
            document.querySelectorAll(".nav-item").forEach(btn => btn.classList.remove("active"));
            const btn = e.currentTarget;
            btn.classList.add("active");
            
            // Reset Search Input on Navigation
            state.searchQuery = "";
            state.discoverBatchIndex = 0;
            state.discoverMaxReached = false;
            const searchInput = document.getElementById("input-search-videos");
            if (searchInput) searchInput.value = "";
            const clearBtn = document.getElementById("btn-clear-search");
            if (clearBtn) clearBtn.classList.add("hidden");

            state.currentView = btn.dataset.view;
            state.discoverBatchIndex = 0;
            state.discoverMaxReached = false;
            document.getElementById("current-view-title").textContent = btn.querySelector(".nav-label").textContent;
            
            if (state.currentView === "smart-feed") {
                state.smartFeedVideos = [];
                state.smartFeedPreloadedVideos = [];
                initSmartFeed(); // Repopulates and randomizes topics queue
            } else if (state.currentView === "discover-channels") {
                initDiscoverChannels();
            }
            
            renderFeed();
        });
    });

    // Sync button
    const btnSync = document.getElementById("btn-sync-now");
    btnSync.addEventListener("click", () => syncFeeds());

    // Settings Modal toggles
    const btnOpenSettings = document.getElementById("btn-open-settings");
    const btnCloseSettings = document.getElementById("btn-close-settings");
    const settingsModal = document.getElementById("settings-modal");

    btnOpenSettings.addEventListener("click", () => {
        renderChannelsList();
        renderTopicsList();
        renderBlockedList();
        renderPreferencesLists();
        document.getElementById("search-results-container").classList.add("hidden");
        settingsModal.classList.remove("hidden");
    });
    btnCloseSettings.addEventListener("click", () => {
        settingsModal.classList.add("hidden");
        document.getElementById("search-results-container").classList.add("hidden");
        initSmartFeed(); // Reinitialize topic queue with updated weights
        updateSubCount();
        renderSearchSuggestions();
        renderFeed();
    });

    // Close search results button
    document.getElementById("btn-close-search-results").addEventListener("click", () => {
        document.getElementById("search-results-container").classList.add("hidden");
    });

    // Settings Tabs toggles
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            
            e.target.classList.add("active");
            document.getElementById(e.target.dataset.tab).classList.add("active");
        });
    });

    // Add channel input
    const btnAddChannel = document.getElementById("btn-add-channel");
    const inputChannel = document.getElementById("input-channel-handle");
    
    btnAddChannel.addEventListener("click", async () => {
        const query = inputChannel.value.trim();
        if (!query) return;
        
        btnAddChannel.disabled = true;
        btnAddChannel.textContent = "Searching...";
        
        try {
            await resolveAndAddChannel(query);
            inputChannel.value = "";
            renderChannelsList();
        } catch (err) {
            alert(err.message);
        } finally {
            btnAddChannel.disabled = false;
            btnAddChannel.textContent = "Add Channel";
        }
    });

    // Clear all channels
    document.getElementById("btn-clear-channels").addEventListener("click", () => {
        if (confirm("Are you sure you want to remove all subscribed channels?")) {
            state.channels = [];
            saveChannels();
            renderChannelsList();
        }
    });

    // Drag and Drop OPML
    const dropZone = document.getElementById("opml-drop-zone");
    const fileInput = document.getElementById("input-opml-file");

    dropZone.addEventListener("click", () => fileInput.click());
    
    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });
    
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length) {
            handleOPMLFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener("change", (e) => {
        if (e.target.files.length) {
            handleOPMLFile(e.target.files[0]);
        }
    });

    // LLM Topic Preferences
    document.getElementById("btn-add-liked-topic").addEventListener("click", () => {
        const phrase = document.getElementById("input-liked-topic").value.trim().toLowerCase();
        if (phrase && !state.likedTopics.includes(phrase)) {
            state.likedTopics.push(phrase);
            saveLikedTopics();
            document.getElementById("input-liked-topic").value = "";
            renderPreferencesLists();
        }
    });

    document.getElementById("btn-add-disliked-topic").addEventListener("click", () => {
        const phrase = document.getElementById("input-disliked-topic").value.trim().toLowerCase();
        if (phrase && !state.dislikedTopics.includes(phrase)) {
            state.dislikedTopics.push(phrase);
            saveDislikedTopics();
            document.getElementById("input-disliked-topic").value = "";
            renderPreferencesLists();
        }
    });

    // Save Topic keyword
    document.getElementById("btn-save-topic").addEventListener("click", () => {
        const phrase = document.getElementById("input-topic-phrase").value.trim().toLowerCase();
        const weight = parseInt(document.getElementById("select-topic-weight").value, 10);
        
        if (!phrase) return;
        
        const existingIdx = state.topics.findIndex(t => t.phrase === phrase);
        if (existingIdx !== -1) {
            state.topics[existingIdx].weight = weight;
        } else {
            state.topics.push({ phrase, weight });
        }
        
        saveTopics();
        document.getElementById("input-topic-phrase").value = "";
        renderTopicsList();
    });

    // Block channel input
    const btnBlockChannel = document.getElementById("btn-block-channel");
    const inputBlockChannel = document.getElementById("input-block-channel");
    
    btnBlockChannel.addEventListener("click", () => {
        const query = inputBlockChannel.value.trim();
        if (!query) return;
        
        const isId = /^UC[A-Za-z0-9_-]{22}$/.test(query);
        const name = isId ? "Channel ID: " + query : query;
        const id = isId ? query : "";
        
        if (!state.blockedChannels.some(bc => (id && bc.id === id) || (!id && bc.name.toLowerCase() === query.toLowerCase()))) {
            state.blockedChannels.push({ name, id });
            saveBlocked();
            renderBlockedList();
            inputBlockChannel.value = "";
        } else {
            alert("Channel is already blocked!");
        }
    });

    // Clear blocked channels
    document.getElementById("btn-clear-blocked").addEventListener("click", () => {
        if (confirm("Are you sure you want to clear the blocklist?")) {
            state.blockedChannels = [];
            saveBlocked();
            renderBlockedList();
        }
    });

    // Export/Import settings JSON
    document.getElementById("btn-export-settings").addEventListener("click", exportSettings);
    
    const restoreInput = document.getElementById("input-restore-json");
    restoreInput.addEventListener("change", (e) => {
        if (e.target.files.length) {
            importSettings(e.target.files[0]);
        }
    });

    // Close Inline Player — bound dynamically when player is created by playVideo()

    // Global settings toggles
    document.getElementById("toggle-use-ytdlp").addEventListener("change", (e) => {
        state.settings.useYtdlp = e.target.checked;
        saveSettings();
    });
    document.getElementById("toggle-mute-shorts").addEventListener("change", (e) => {
        state.settings.muteShorts = e.target.checked;
        saveSettings();
        renderFeed();
    });

    // Search input handlers
    const searchForm = document.getElementById("search-form");
    const searchInput = document.getElementById("input-search-videos");
    const clearSearchBtn = document.getElementById("btn-clear-search");

    if (searchForm && searchInput) {
        searchForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const query = searchInput.value.trim();
            if (query) {
                state.discoverBatchIndex = 0;
                state.discoverMaxReached = false;
                triggerGlobalSearch(query);
            }
        });

        searchInput.addEventListener("input", (e) => {
            state.searchQuery = e.target.value.trim();
            if (state.searchQuery) {
                clearSearchBtn.classList.remove("hidden");
            } else {
                clearSearchBtn.classList.add("hidden");
                // If we were in a search view, go back to smart-feed
                if (state.currentView.startsWith("search_")) {
                    state.currentView = "smart-feed";
                    document.querySelectorAll(".nav-item").forEach(btn => {
                        if (btn.dataset.view === "smart-feed") btn.classList.add("active");
                        else btn.classList.remove("active");
                    });
                    document.getElementById("current-view-title").textContent = "Smart Feed";
                }
            }
            clearTimeout(searchDebounceTimeout);
            searchDebounceTimeout = setTimeout(() => {
                renderFeed();
            }, 250);
        });
    }

    if (clearSearchBtn) {
        clearSearchBtn.addEventListener("click", () => {
            searchInput.value = "";
            state.searchQuery = "";
            clearSearchBtn.classList.add("hidden");
            if (state.currentView.startsWith("search_")) {
                state.currentView = "smart-feed";
                document.querySelectorAll(".nav-item").forEach(btn => {
                    if (btn.dataset.view === "smart-feed") btn.classList.add("active");
                    else btn.classList.remove("active");
                });
                document.getElementById("current-view-title").textContent = "Smart Feed";
            }
            state.discoverBatchIndex = 0;
            state.discoverMaxReached = false;
            renderFeed();
        });
    }

    // Recommendation buttons
    document.querySelectorAll(".btn-add-rec").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const name = e.target.dataset.name;
            const id = e.target.dataset.id;
            
            if (!state.channels.some(c => c.id === id)) {
                state.channels.push({ name, id });
                saveChannels();
                renderChannelsList();
                e.target.disabled = true;
                e.target.textContent = "Added";
                syncFeeds(); // Trigger sync for the new channel
            } else {
                alert("Channel is already subscribed!");
            }
        });
    });

    // Brainstorm More button
    const btnBrainstormMore = document.getElementById("btn-brainstorm-more");
    if (btnBrainstormMore) {
        btnBrainstormMore.addEventListener("click", () => generateBrainstormTopics());
    }

    // Topic Search in Settings (LLM Preferences)
    const topicSearchInput = document.getElementById("input-topic-search");
    const clearTopicSearchBtn = document.getElementById("btn-clear-topic-search");
    if (topicSearchInput) {
        topicSearchInput.addEventListener("input", () => {
            const q = topicSearchInput.value.trim().toLowerCase();
            if (q) {
                clearTopicSearchBtn.classList.remove("hidden");
            } else {
                clearTopicSearchBtn.classList.add("hidden");
            }
            renderPreferencesLists(q);
        });
    }
    if (clearTopicSearchBtn) {
        clearTopicSearchBtn.addEventListener("click", () => {
            topicSearchInput.value = "";
            clearTopicSearchBtn.classList.add("hidden");
            renderPreferencesLists();
        });
    }

    // Legacy Topic Search
    const legacyTopicSearchInput = document.getElementById("input-legacy-topic-search");
    const clearLegacyTopicSearchBtn = document.getElementById("btn-clear-legacy-topic-search");
    if (legacyTopicSearchInput) {
        legacyTopicSearchInput.addEventListener("input", () => {
            const q = legacyTopicSearchInput.value.trim().toLowerCase();
            if (q) {
                clearLegacyTopicSearchBtn.classList.remove("hidden");
            } else {
                clearLegacyTopicSearchBtn.classList.add("hidden");
            }
            renderTopicsList(q);
        });
    }
    if (clearLegacyTopicSearchBtn) {
        clearLegacyTopicSearchBtn.addEventListener("click", () => {
            legacyTopicSearchInput.value = "";
            clearLegacyTopicSearchBtn.classList.add("hidden");
            renderTopicsList();
        });
    }
}

function renderSidebarTopics() {
    // Consolidated into Smart Feed - no sidebar topic tabs anymore
}

// Add/Resolve YouTube Channel via Nginx proxy / scraping
async function resolveAndAddChannel(query) {
    let channelId = "";
    let channelName = "";

    // Case 0: Reddit Subreddit
    if (query.startsWith("r/") || query.startsWith("reddit.com/r/") || query.startsWith("https://www.reddit.com/r/")) {
        const match = query.match(/r\/([a-zA-Z0-9_]+)/);
        if (match && match[1]) {
            const subreddit = match[1].toLowerCase();
            channelId = `reddit:r/${subreddit}`;
            channelName = `r/${subreddit}`;
            
            if (state.channels.some(c => c.id === channelId)) {
                throw new Error("Subreddit is already in your subscription list!");
            }
            state.channels.push({ name: channelName, id: channelId });
            saveChannels();
            syncFeeds();
            return;
        }
    }

    // Case 1: UC... style direct Channel ID
    if (/^UC[A-Za-z0-9_-]{22}$/.test(query)) {
        channelId = query;
        channelName = query.substring(0, 10) + "..."; // Placeholder name, will be fetched in sync
        
        if (state.channels.some(c => c.id === channelId)) {
            throw new Error("Channel is already in your subscription list!");
        }
        state.channels.push({ name: channelName, id: channelId });
        saveChannels();
        syncFeeds(); // Trigger sync for the new channel
    } 
    // Case 2: Handle style, e.g. @fireship
    else if (query.startsWith("@")) {
        const cleanHandle = query.substring(1);
        const resolveUrl = `/youtube/@${cleanHandle}`; // General proxy endpoint
        
        try {
            const resp = await fetch(resolveUrl);
            if (!resp.ok) throw new Error("Could not reach YouTube to resolve handle");
            const text = await resp.text();
            
            const match = text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/);
            if (match && match[1]) {
                channelId = match[1];
                const titleMatch = text.match(/<title>(.*?) - YouTube<\/title>/);
                channelName = titleMatch ? titleMatch[1] : query;
            } else {
                throw new Error("Unable to locate channel ID on YouTube page. Make sure the handle is correct.");
            }
        } catch (err) {
            console.error("Resolve error:", err);
            throw new Error("Failed resolving handle: " + err.message);
        }

        if (state.channels.some(c => c.id === channelId)) {
            throw new Error("Channel is already in your subscription list!");
        }
        state.channels.push({ name: channelName, id: channelId });
        saveChannels();
        syncFeeds(); // Trigger sync for the new channel
    } 
    // Case 3: Fuzzy Search
    else {
        try {
            const channels = await searchChannelsOnYouTube(query);
            renderFuzzySearchResults(channels);
        } catch (err) {
            console.error("Search error:", err);
            throw new Error("Search failed: " + err.message);
        }
    }
}

// Scrape YouTube search results for channels using the Nginx proxy
async function searchChannelsOnYouTube(query) {
    const url = `/youtube/results?search_query=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Search request failed.");
    const htmlText = await resp.text();

    let ytData = null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");
    const scripts = doc.querySelectorAll("script");
    for (const script of scripts) {
        if (script.textContent.includes("ytInitialData")) {
            const text = script.textContent;
            const startIndex = text.indexOf("ytInitialData =");
            if (startIndex !== -1) {
                const jsonStart = text.indexOf("{", startIndex);
                if (jsonStart !== -1) {
                    let jsonText = text.substring(jsonStart);
                    const endIndex = jsonText.lastIndexOf("}");
                    if (endIndex !== -1) {
                        jsonText = jsonText.substring(0, endIndex + 1);
                    }
                    try {
                        ytData = JSON.parse(jsonText);
                        break;
                    } catch (e) {
                        console.error("JSON parse error in ytInitialData", e);
                    }
                }
            }
        }
    }

    if (!ytData) {
        throw new Error("Could not parse search data from YouTube.");
    }

    const channels = [];
    const seenIds = new Set();

    try {
        const contents = ytData.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        for (const sec of contents) {
            const items = sec.itemSectionRenderer?.contents || [];
            for (const item of items) {
                // Direct Channel Renderer
                if (item.channelRenderer) {
                    const cr = item.channelRenderer;
                    const chId = cr.channelId;
                    if (chId && !seenIds.has(chId)) {
                        seenIds.add(chId);
                        const title = cr.title?.simpleText || cr.title?.runs?.[0]?.text || "Unknown Channel";
                        const handle = cr.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
                        const subCount = cr.subscriberCountText?.simpleText || cr.videoCountText?.simpleText || "";
                        channels.push({ id: chId, name: title, handle: handle, subCount: subCount });
                    }
                }
                // Extract owner from Video Renderer
                if (item.videoRenderer) {
                    const vr = item.videoRenderer;
                    const run = vr.ownerText?.runs?.[0];
                    const chId = run?.navigationEndpoint?.browseEndpoint?.browseId;
                    if (chId && !seenIds.has(chId)) {
                        seenIds.add(chId);
                        const title = run.text || "Unknown Channel";
                        const handle = run.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
                        channels.push({ id: chId, name: title, handle: handle, subCount: "From Video Search" });
                    }
                }
            }
        }
    } catch (e) {
        console.error("Error traversing search JSON", e);
    }

    return channels;
}

// Render search results inline
function renderFuzzySearchResults(channels) {
    const container = document.getElementById("search-results-container");
    const list = document.getElementById("search-results-list");
    list.innerHTML = "";

    if (channels.length === 0) {
        list.innerHTML = `<div class="input-hint" style="padding: 1rem 0;">No matching channels found. Try typing a more specific name.</div>`;
        container.classList.remove("hidden");
        return;
    }

    channels.forEach(ch => {
        const row = document.createElement("div");
        row.className = "search-result-row";

        const isSubscribed = state.channels.some(c => c.id === ch.id);
        const metaText = `${ch.handle ? ch.handle : ch.id}${ch.subCount ? ' • ' + ch.subCount : ''}`;

        row.innerHTML = `
            <div class="search-result-info">
                <span class="search-result-name">${escapeHTML(ch.name)}</span>
                <span class="search-result-meta">${escapeHTML(metaText)}</span>
            </div>
            <button class="btn-add-search-result" data-id="${ch.id}" data-name="${escapeHTML(ch.name)}" ${isSubscribed ? 'disabled' : ''}>
                ${isSubscribed ? 'Added' : 'Subscribe'}
            </button>
        `;

        const btn = row.querySelector(".btn-add-search-result");
        btn.addEventListener("click", () => {
            if (state.channels.some(c => c.id === ch.id)) return;
            state.channels.push({ name: ch.name, id: ch.id });
            saveChannels();
            renderChannelsList();
            btn.disabled = true;
            btn.textContent = "Added";
            syncFeeds(); // Trigger sync for the new channel
        });

        list.appendChild(row);
    });

    container.classList.remove("hidden");
}

// Fetch Feeds in parallel via Nginx proxy and parse XML
async function syncFeeds() {
    if (state.channels.length === 0) {
        updateStatusText("No channels to sync.");
        return;
    }

    // Clear session topic search cache on sync to fetch fresh results next time, but preserve currently loading ones
    for (const key in sessionTopicSearchCache) {
        if (!topicSearchLoading[key]) {
            delete sessionTopicSearchCache[key];
        }
    }

    const btnSync = document.getElementById("btn-sync-now");
    btnSync.classList.add("spinning");
    updateStatusText("Syncing RSS Feeds...");
    
    let activeSyncs = 0;
    const maxConcurrency = 4;
    const channelsToSync = [...state.channels];
    const results = {};
    
    // Dynamic parallel chunks worker
    const worker = async () => {
        while (channelsToSync.length > 0) {
            const channel = channelsToSync.shift();
            let videos = [];
            let success = false;

            // Check if it's a Reddit feed
            if (channel.id.startsWith("reddit:")) {
                try {
                    const subreddit = channel.id.split(":")[1].replace("r/", "");
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 8000);
                    const response = await fetch(`/reddit/r/${subreddit}/hot/.rss`, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    if (response.ok) {
                        const xmlText = await response.text();
                        const parser = new DOMParser();
                        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                        
                        const entries = xmlDoc.querySelectorAll("entry");
                        entries.forEach(entry => {
                            const title = entry.querySelector("title")?.textContent || "";
                            const content = entry.querySelector("content")?.textContent || entry.querySelector("summary")?.textContent || "";
                            const publishedStr = entry.querySelector("published")?.textContent || entry.querySelector("updated")?.textContent || "";
                            
                            const ytMatch = content.match(/href="https:\/\/(?:www\.)?youtube\.com\/watch\?v=([^"&?]+)/) || 
                                            content.match(/href="https:\/\/youtu\.be\/([^"&?]+)/);
                            
                            if (ytMatch && ytMatch[1]) {
                                videos.push({
                                    id: ytMatch[1],
                                    title: title,
                                    channelName: channel.name,
                                    channelId: channel.id,
                                    published: new Date(publishedStr).getTime()
                                });
                            }
                        });
                        success = true;
                    }
                } catch (err) {
                    console.error(`Reddit sync failed for ${channel.name}:`, err);
                }
            }
            // Try RSS first if useYtdlp setting is not active
            else if (!state.settings.useYtdlp) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 8000);
                    const response = await fetch(`/youtube-feed/?channel_id=${channel.id}`, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    if (response.ok) {
                        const xmlText = await response.text();
                        const parser = new DOMParser();
                        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                        
                        const feedTitle = xmlDoc.querySelector("feed > title")?.textContent;
                        if (feedTitle && channel.name.includes("...")) {
                            channel.name = feedTitle;
                        }

                        const entries = xmlDoc.querySelectorAll("feed > entry");
                        entries.forEach(entry => {
                            const videoId = entry.querySelector("videoId")?.textContent || 
                                            entry.querySelector("id")?.textContent?.split(":")[2];
                            const title = entry.querySelector("title")?.textContent || "";
                            const publishedStr = entry.querySelector("published")?.textContent || 
                                                 entry.querySelector("updated")?.textContent || "";
                                                 
                            if (videoId && title) {
                                videos.push({
                                    id: videoId,
                                    title: title,
                                    channelName: feedTitle || channel.name,
                                    channelId: channel.id,
                                    published: new Date(publishedStr).getTime()
                                });
                            }
                        });
                        success = true;
                    }
                } catch (rssErr) {
                    console.warn(`RSS feed sync failed for channel ${channel.name}, falling back to scraper-service:`, rssErr);
                }
            }

            // Fallback to Scraper Service (yt-dlp) if RSS failed or useYtdlp is true
            if (!success && !channel.id.startsWith("reddit:")) {
                try {
                    console.log(`Syncing channel ${channel.name} (${channel.id}) via scraper-service...`);
                    const controller = new AbortController();
                    // Increased timeout to 120s to allow fetching all videos from the channel
                    const timeoutId = setTimeout(() => controller.abort(), 120000);
                    const response = await fetch("/scraper/collect", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            source: "youtube",
                            channels: [channel.id],
                            limit: 0,
                            days_back: 0,
                            require_transcript: false
                        }),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    if (response.ok) {
                        const data = await response.json();
                        if (data && Array.isArray(data.items)) {
                            data.items.forEach(item => {
                                videos.push({
                                    id: item.video_id,
                                    title: item.title,
                                    channelName: item.channel || channel.name,
                                    channelId: channel.id,
                                    published: item.published_at ? new Date(item.published_at).getTime() : Date.now()
                                });
                            });
                            
                            if (data.items.length > 0 && data.items[0].channel && channel.name.includes("...")) {
                                channel.name = data.items[0].channel;
                            }
                            success = true;
                        }
                    } else {
                        console.warn(`Scraper-service returned status ${response.status} for ${channel.name}`);
                    }
                } catch (scraperErr) {
                    console.error(`Scraper sync failed for ${channel.name}:`, scraperErr);
                }
            }

            if (success) {
                const existing = state.cache.videos[channel.id] || [];
                const merged = [...videos];
                existing.forEach(ev => {
                    if (!merged.some(nv => nv.id === ev.id)) {
                        merged.push(ev);
                    }
                });
                merged.sort((a, b) => b.published - a.published);
                results[channel.id] = merged.slice(0, 50);
            } else {
                console.warn(`All sync methods failed for channel ${channel.name}. Retaining cache.`);
                if (state.cache.videos[channel.id]) {
                    results[channel.id] = state.cache.videos[channel.id];
                }
            }
        }
    };
    
    const workers = Array(Math.min(maxConcurrency, channelsToSync.length))
        .fill(null)
        .map(() => worker());
        
    await Promise.all(workers);
    
    state.cache.videos = results;
    state.cache.lastSync = Date.now();
    saveCache();
    saveChannels(); // Updates names if they changed
    
    btnSync.classList.remove("spinning");
    updateStatusText("Synced successfully just now");
    
    renderFeed();
}

// Compute custom interest score for a video
function invalidateScoreCache() {
    console.log("[Performance] Invalidating video score cache...");
    Object.values(state.cache.videos).forEach(channelVideos => {
        channelVideos.forEach(v => {
            delete v._score;
            delete v._matchedTopics;
        });
    });
    if (state.smartFeedVideos) {
        state.smartFeedVideos.forEach(v => {
            delete v._score;
            delete v._matchedTopics;
        });
    }
}

function getScoreAndMatches(video) {
    if (video._score !== undefined && video._matchedTopics !== undefined) {
        return { score: video._score, matches: video._matchedTopics };
    }
    
    let score = 0;
    const title = video.title.toLowerCase();
    const matches = [];
    
    state.topics.forEach(topic => {
        const phrase = topic.phrase.toLowerCase();
        let matched = false;
        
        if (phrase.length <= 3) {
            const regex = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i");
            matched = regex.test(title);
        } else {
            matched = title.includes(phrase);
        }
        
        if (matched) {
            score += topic.weight;
            matches.push(topic.phrase.toLowerCase());
        }
    });
    
    // Add heavy penalty for ALL CAPS spams (heuristic trigger)
    const uppercaseLetters = video.title.replace(/[^A-Z]/g, "").length;
    const totalLetters = video.title.replace(/[^a-zA-Z]/g, "").length;
    if (totalLetters > 5 && (uppercaseLetters / totalLetters) > 0.8) {
        score -= 8;
        matches.push("all-caps");
    }

    // Punctuation trigger (e.g. ??? or !!!)
    if (/(\?{3,}|!{3,})/.test(video.title)) {
        score -= 5;
        matches.push("punctuation");
    }
    
    // Explicit Topic Preferences Penalty
    if (state.dislikedTopics && state.dislikedTopics.length > 0) {
        state.dislikedTopics.forEach(dt => {
            if (title.includes(dt.toLowerCase()) || matches.includes(dt.toLowerCase())) {
                score -= 15;
                matches.push(`disliked:${dt}`);
            }
        });
    }
    
    // Explicit user rating override
    video._score = score;
    video._matchedTopics = matches;
    return { score, matches };
}

// Navigation & dynamic feed fetching helper functions
function navigateToChannel(channelId, channelName) {
    if (state.currentView !== "discover-channels" && state.currentView !== "subscriptions" && !state.currentView.startsWith("channel_")) {
        state.lastViewBeforeInspect = state.currentView;
    } else if (state.currentView === "discover-channels" || state.currentView === "subscriptions") {
        state.lastViewBeforeInspect = state.currentView;
    }
    state.currentView = "channel_" + channelId;
    document.getElementById("current-view-title").textContent = channelName;
    renderFeed();
}

async function resolveAndInspectChannelByName(channelName) {
    showToast(`🔍 Locating channel "${channelName}"...`, "info");
    try {
        let channelId = "";
        if (channelName.startsWith("@")) {
            const cleanHandle = channelName.substring(1);
            const resolveUrl = `/youtube/@${cleanHandle}`;
            const resp = await fetch(resolveUrl);
            if (resp.ok) {
                const text = await resp.text();
                const match = text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/);
                if (match && match[1]) {
                    channelId = match[1];
                }
            }
        }
        
        if (!channelId) {
            const channels = await searchChannelsOnYouTube(channelName);
            if (channels && channels.length > 0) {
                channelId = channels[0].id;
            }
        }
        
        if (channelId) {
            navigateToChannel(channelId, channelName);
        } else {
            showToast(`❌ Could not resolve channel ID for "${channelName}"`, "danger");
        }
    } catch (err) {
        console.error("Error resolving channel:", err);
        showToast("Error locating channel: " + err.message, "danger");
    }
}

async function fetchChannelFeedOnDemand(channelId, channelName) {
    try {
        const response = await fetch(`/youtube-feed/?channel_id=${channelId}`);
        if (!response.ok) throw new Error("Failed to fetch RSS feed");
        const xmlText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        
        const feedTitle = xmlDoc.querySelector("feed > title")?.textContent || channelName;
        const entries = xmlDoc.querySelectorAll("feed > entry");
        const videos = [];
        
        entries.forEach(entry => {
            const videoId = entry.querySelector("videoId")?.textContent || 
                            entry.querySelector("id")?.textContent?.split(":")[2];
            const title = entry.querySelector("title")?.textContent || "";
            const publishedStr = entry.querySelector("published")?.textContent || 
                                 entry.querySelector("updated")?.textContent || "";
                                 
            if (videoId && title) {
                videos.push({
                    id: videoId,
                    title: title,
                    channelName: feedTitle,
                    channelId: channelId,
                    published: new Date(publishedStr).getTime()
                });
            }
        });
        
        state.tempChannelFeeds = state.tempChannelFeeds || {};
        state.tempChannelFeeds[channelId] = {
            name: feedTitle,
            videos: videos
        };
        
        navigateToChannel(channelId, feedTitle);
    } catch (err) {
        console.error("Failed to load channel feed dynamically:", err);
        const grid = document.getElementById("video-grid");
        if (grid) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; min-height: 200px;">
                    <div class="empty-icon">⚠️</div>
                    <h3>Failed to load feed</h3>
                    <p>${escapeHTML(err.message)}</p>
                    <button class="btn btn-secondary btn-sm" id="btn-inspect-error-back">Back</button>
                </div>
            `;
            document.getElementById("btn-inspect-error-back").addEventListener("click", () => {
                if (state.lastViewBeforeInspect) {
                    state.currentView = state.lastViewBeforeInspect;
                    state.lastViewBeforeInspect = null;
                } else {
                    state.currentView = "subscriptions";
                }
                renderFeed();
            });
        }
    }
}

// Render Helper Function (declared globally for reuse)
function renderCard(video, targetContainer) {
    const card = document.createElement("div");
    card.className = "video-card fade-in";
    if (video.isDiscover) {
        card.classList.add("discover-card");
    }
    
    let scoreClass = "mid";
    if (video.score >= 5) scoreClass = "high";
    if (video.score < 0) scoreClass = "low";
    
    const relativeTime = video.isDiscover ? (video.publishedStr || "Recently") : getRelativeTime(video.published);
    const topMatchedTopic = video.matchedTopics.find(t => t !== "all-caps" && t !== "punctuation");
    const categoryText = topMatchedTopic ? capitalizePhrase(topMatchedTopic) : "";
    
    // Format meta/views if available
    let metaLine = video.channelName;
    if (video.viewCount && video.viewCount > 0) {
        metaLine += ` • ${formatViews(video.viewCount)}`;
    }
    
    // Check if channel is already subscribed
    const isSubscribed = state.channels.some(ch => 
        (ch.id && video.channelId && ch.id === video.channelId) || 
        (ch.name && video.channelName && ch.name.toLowerCase() === video.channelName.toLowerCase())
    );
    
    card.innerHTML = `
        <div class="thumbnail-area">
            <img class="thumbnail-img" src="https://i.ytimg.com/vi/${video.id}/hqdefault.jpg" alt="${escapeHTML(video.title)}">
            <div class="thumbnail-play-overlay">
                <div class="play-icon-circle">▶</div>
            </div>
            <div class="score-badge ${scoreClass}">★ ${video.score}</div>
            ${video.isDiscover && video.discoveryTopic ? `<div class="category-badge" style="background:var(--accent);color:var(--bg)">✨ ${capitalizePhrase(video.discoveryTopic)}</div>` : (video.isDiscover ? `<div class="search-badge">🔍 Search</div>` : (categoryText ? `<div class="category-badge">${categoryText}</div>` : ""))}
        </div>
        <div class="card-details">
            <div class="video-title-row">
                <h3 class="video-title">${escapeHTML(video.title)}</h3>
                <button class="card-action-btn" title="Actions">⋮</button>
            </div>
            <p class="video-channel"><span class="channel-link" data-id="${video.channelId || ''}" data-name="${escapeHTML(video.channelName)}">${escapeHTML(video.channelName)}</span>${video.viewCount && video.viewCount > 0 ? ` • ${formatViews(video.viewCount)}` : ''}</p>
            <p class="video-time">${relativeTime}${video.duration ? ` • ${formatDuration(video.duration)}` : ""}</p>
        </div>
    `;
    
    const openAction = () => playVideo(video);
    card.querySelector(".thumbnail-play-overlay").addEventListener("click", openAction);
    card.querySelector(".video-title").addEventListener("click", openAction);
    
    const channelLink = card.querySelector(".channel-link");
    if (channelLink) {
        channelLink.addEventListener("click", (e) => {
            e.stopPropagation();
            const chId = channelLink.dataset.id;
            const chName = channelLink.dataset.name;
            if (chId) {
                navigateToChannel(chId, chName);
            } else {
                resolveAndInspectChannelByName(chName);
            }
        });
    }
    
    // 3-dot action menu
    const actionBtn = card.querySelector(".card-action-btn");
    actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Close any existing dropdown
        document.querySelectorAll(".card-action-dropdown").forEach(d => d.remove());
        
        const dropdown = document.createElement("div");
        dropdown.className = "card-action-dropdown";
        // Determine the topic associated with this video
        const videoTopic = video.discoveryTopic || (video.matchedTopics ? video.matchedTopics.find(t => t !== "all-caps" && t !== "punctuation" && !t.startsWith("disliked:")) : null) || "";
        const currentRating = state.videoRatings[video.id];
        
        dropdown.innerHTML = `
            <div class="card-rating-row">
                <button class="rate-thumb-btn thumb-up${currentRating === 5 ? ' active' : ''}" data-rating="5" title="Like">👍 Like</button>
                <button class="rate-thumb-btn thumb-down${currentRating === -5 ? ' active' : ''}" data-rating="-5" title="Dislike">👎 Dislike</button>
            </div>
            <button data-action="subscribe">${isSubscribed ? '➖ Unsubscribe' : '➕ Subscribe to Channel'}</button>
            <button class="danger" data-action="block">🚫 Block Channel</button>
            <button data-action="remove-topic"${videoTopic ? '' : ' disabled'}>🗑️ Remove Topic${videoTopic ? ': ' + capitalizePhrase(videoTopic) : ''}</button>
            <button data-action="hide">🔇 Hide Video</button>
        `;
        
        dropdown.querySelectorAll(".rate-thumb-btn").forEach(btn => {
            btn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const rating = parseInt(ev.target.dataset.rating, 10);
                state.videoRatings[video.id] = rating;
                saveVideoRatings();
                
                // Update badge visually
                const badge = card.querySelector(".score-badge");
                if (badge) {
                    badge.textContent = rating > 0 ? '👍' : '👎';
                    badge.className = "score-badge " + (rating > 0 ? "high" : "low");
                }
                dropdown.remove();
                showToast(rating > 0 ? '👍 Liked' : '👎 Disliked', rating > 0 ? "success" : "info");
            });
        });
        
        dropdown.querySelector('[data-action="block"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            const channelName = video.channelName;
            const channelId = video.channelId || "";
            if (!state.blockedChannels.some(bc => bc.name.toLowerCase() === channelName.toLowerCase())) {
                state.blockedChannels.push({ name: channelName, id: channelId });
                saveBlocked();
            }
            dropdown.remove();
            showToast(`🚫 Blocked ${channelName}`, "danger");
            // Remove all cards from this channel with fade-out
            document.querySelectorAll(".video-card").forEach(c => {
                const chEl = c.querySelector(".video-channel");
                if (chEl && chEl.textContent.toLowerCase().includes(channelName.toLowerCase())) {
                    c.classList.add("fade-out-remove");
                    setTimeout(() => c.remove(), 350);
                }
            });
        });
        
        dropdown.querySelector('[data-action="subscribe"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            const channelName = video.channelName;
            const channelId = video.channelId || "";
            
            if (isSubscribed) {
                // Unsubscribe
                state.channels = state.channels.filter(ch => 
                    !(ch.id && video.channelId && ch.id === video.channelId) &&
                    !(ch.name && video.channelName && ch.name.toLowerCase() === video.channelName.toLowerCase())
                );
                saveChannels();
                updateSubCount();
                dropdown.remove();
                showToast(`➖ Unsubscribed from ${channelName}`, "info");
            } else {
                // Subscribe
                state.channels.push({ name: channelName, id: channelId });
                saveChannels();
                updateSubCount();
                dropdown.remove();
                showToast(`✅ Subscribed to ${channelName}`, "success");
            }
            renderChannelsList();
        });
        
        dropdown.querySelector('[data-action="remove-topic"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (!videoTopic) return;
            
            const normalizedTopic = videoTopic.trim().toLowerCase();
            
            // Add to disliked topics if not already there
            if (!state.dislikedTopics.includes(normalizedTopic)) {
                state.dislikedTopics.push(normalizedTopic);
                saveDislikedTopics();
            }
            
            // Remove from liked topics if present
            if (state.likedTopics.includes(normalizedTopic)) {
                state.likedTopics = state.likedTopics.filter(t => t !== normalizedTopic);
                saveLikedTopics();
            }
            
            dropdown.remove();
            showToast(`🗑️ Removed topic "${capitalizePhrase(videoTopic)}" and added to disliked`, "danger");
            
            // Fade out all cards with this topic
            document.querySelectorAll(".video-card").forEach(c => {
                const topicAttr = c.getAttribute('data-discover-topic');
                const catBadge = c.querySelector('.category-badge');
                const catText = catBadge ? catBadge.textContent.replace('✨ ', '').trim().toLowerCase() : '';
                if ((topicAttr && topicAttr.toLowerCase() === normalizedTopic) || catText === normalizedTopic) {
                    c.classList.add("fade-out-remove");
                    setTimeout(() => c.remove(), 350);
                }
            });
            
            // Also nuke from smart feed state
            nukeDiscoverTopic(videoTopic);
        });
        
        dropdown.querySelector('[data-action="hide"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            dropdown.remove();
            card.classList.add("fade-out-remove");
            setTimeout(() => card.remove(), 350);
            showToast(`🔇 Video hidden`, "info");
        });
        
        // Position absolutely relative to document body to avoid z-index/overflow issues
        const rect = actionBtn.getBoundingClientRect();
        dropdown.style.position = "absolute";
        dropdown.style.top = `${window.scrollY + rect.bottom + 4}px`;
        dropdown.style.right = `${document.documentElement.clientWidth - (window.scrollX + rect.right)}px`;
        dropdown.style.left = "auto";
        dropdown.style.zIndex = "1000";
        document.body.appendChild(dropdown);
        
        // Close dropdown on outside click
        const closeDropdown = (ev) => {
            if (!dropdown.contains(ev.target) && ev.target !== actionBtn) {
                dropdown.remove();
                document.removeEventListener("click", closeDropdown);
            }
        };
        setTimeout(() => document.addEventListener("click", closeDropdown), 0);
    });
    
    targetContainer.appendChild(card);
}

// Load and Render Video Grid
function renderFeed() {
    clearRenderTimeouts();
    const grid = document.getElementById("video-grid");
    const shortsShelf = document.getElementById("shorts-shelf");
    const shortsGrid = document.getElementById("shorts-grid");
    const redditShelf = document.getElementById("reddit-shelf");
    const redditGrid = document.getElementById("reddit-grid");
    const emptyState = document.getElementById("empty-state");
    const brainstormContainer = document.getElementById("ai-brainstorm-container");
    const discoverChannelsContainer = document.getElementById("discover-channels-container");
    
    if (grid) grid.classList.remove("hidden");
    if (brainstormContainer) brainstormContainer.classList.add("hidden");
    if (discoverChannelsContainer) discoverChannelsContainer.classList.add("hidden");
    setupInfiniteScroll();
    
    if (state.currentView === "discover-channels") {
        if (grid) grid.classList.add("hidden");
        if (discoverChannelsContainer) discoverChannelsContainer.classList.remove("hidden");
        renderDiscoverChannelsView();
        return;
    }
    
    grid.innerHTML = "";
    shortsGrid.innerHTML = "";
    shortsShelf.classList.add("hidden");
    if (redditGrid) redditGrid.innerHTML = "";
    if (redditShelf) redditShelf.classList.add("hidden");
    
    // Handle Subscriptions Management View
    if (state.currentView === "subscriptions") {
        emptyState.classList.add("hidden");
        if (shortsShelf) shortsShelf.classList.add("hidden");
        
        if (state.channels.length === 0) {
            emptyState.classList.remove("hidden");
            const emptyIcon = emptyState.querySelector(".empty-icon");
            const emptyH3 = emptyState.querySelector("h3");
            const emptyP = emptyState.querySelector("p");
            if (emptyIcon) emptyIcon.textContent = "📺";
            if (emptyH3) emptyH3.textContent = "No subscriptions yet";
            if (emptyP) emptyP.textContent = "Add channels via Settings or subscribe from video cards.";
            return;
        }
        
        const channelGrid = document.createElement("div");
        channelGrid.className = "channel-card-grid";
        channelGrid.style.gridColumn = "1 / -1";
        
        state.channels.forEach((channel, idx) => {
            const cachedVideos = state.cache.videos[channel.id] || [];
            const card = document.createElement("div");
            card.className = "channel-card fade-in";
            
            card.innerHTML = `
                <div class="channel-card-name">${escapeHTML(channel.name)}</div>
                <div class="channel-card-id">${channel.id}</div>
                <div class="channel-card-meta">${cachedVideos.length} video${cachedVideos.length !== 1 ? 's' : ''} cached</div>
                <div class="channel-card-actions">
                    <button class="btn btn-primary btn-sm btn-view-channel">View Videos</button>
                    <button class="btn btn-danger btn-sm btn-unsub-channel">Unsubscribe</button>
                </div>
            `;
            
            // Click card to view channel videos
            card.querySelector(".btn-view-channel").addEventListener("click", (e) => {
                e.stopPropagation();
                state.currentView = "channel_" + channel.id;
                document.getElementById("current-view-title").textContent = channel.name;
                renderFeed();
            });
            
            // Click card body to view channel
            card.addEventListener("click", (e) => {
                if (e.target.closest(".channel-card-actions")) return;
                state.currentView = "channel_" + channel.id;
                document.getElementById("current-view-title").textContent = channel.name;
                renderFeed();
            });
            
            // Unsubscribe
            card.querySelector(".btn-unsub-channel").addEventListener("click", (e) => {
                e.stopPropagation();
                state.channels.splice(idx, 1);
                saveChannels();
                updateSubCount();
                showToast(`➖ Unsubscribed from ${channel.name}`, "info");
                renderFeed();
            });
            
            channelGrid.appendChild(card);
        });
        
        grid.appendChild(channelGrid);
        return;
    }
    
    // Handle Channel Detail View
    if (state.currentView.startsWith("channel_")) {
        emptyState.classList.add("hidden");
        const channelId = state.currentView.substring(8);
        const isSubscribed = state.channels.some(ch => ch.id === channelId);
        
        let channelVideos = [];
        let channelName = document.getElementById("current-view-title").textContent || "Channel";
        
        if (isSubscribed) {
            channelVideos = state.cache.videos[channelId] || [];
            const channel = state.channels.find(ch => ch.id === channelId);
            if (channel) channelName = channel.name;
        } else {
            const tempFeed = state.tempChannelFeeds && state.tempChannelFeeds[channelId];
            if (tempFeed) {
                channelVideos = tempFeed.videos;
                channelName = tempFeed.name;
            } else {
                fetchChannelFeedOnDemand(channelId, channelName);
                return;
            }
        }
        
        // Back button
        const backRow = document.createElement("div");
        backRow.style.gridColumn = "1 / -1";
        backRow.style.marginBottom = "1rem";
        backRow.style.display = "flex";
        backRow.style.justifyContent = "space-between";
        backRow.style.alignItems = "center";
        
        const backBtn = document.createElement("button");
        backBtn.className = "btn btn-secondary btn-sm";
        backBtn.innerHTML = "← Back";
        backBtn.addEventListener("click", () => {
            if (state.lastViewBeforeInspect) {
                state.currentView = state.lastViewBeforeInspect;
                state.lastViewBeforeInspect = null;
            } else {
                state.currentView = "subscriptions";
            }
            document.querySelectorAll(".nav-item").forEach(btn => {
                if (btn.dataset.view === state.currentView) btn.classList.add("active");
                else btn.classList.remove("active");
            });
            const activeNav = document.querySelector(`.nav-item[data-view="${state.currentView}"]`);
            document.getElementById("current-view-title").textContent = activeNav ? activeNav.querySelector(".nav-label").textContent : "Wallgarden";
            renderFeed();
        });
        backRow.appendChild(backBtn);
        
        const headerActions = document.createElement("div");
        headerActions.style.display = "flex";
        headerActions.style.gap = "0.5rem";
        
        if (isSubscribed) {
            headerActions.innerHTML = `
                <button class="btn btn-danger btn-sm btn-header-unsub">Unsubscribe</button>
                <button class="btn btn-danger btn-sm btn-header-block">🚫 Block Channel</button>
            `;
            headerActions.querySelector(".btn-header-unsub").addEventListener("click", () => {
                state.channels = state.channels.filter(ch => ch.id !== channelId);
                saveChannels();
                updateSubCount();
                showToast(`➖ Unsubscribed from ${channelName}`, "info");
                navigateToChannel(channelId, channelName);
            });
        } else {
            headerActions.innerHTML = `
                <button class="btn btn-primary btn-sm btn-header-sub" style="background:var(--accent);color:var(--bg-primary);border-color:var(--accent);">➕ Subscribe</button>
                <button class="btn btn-danger btn-sm btn-header-block">🚫 Block Channel</button>
            `;
            headerActions.querySelector(".btn-header-sub").addEventListener("click", () => {
                state.channels.push({ name: channelName, id: channelId });
                saveChannels();
                updateSubCount();
                showToast(`✅ Subscribed to ${channelName}`, "success");
                navigateToChannel(channelId, channelName);
            });
        }
        
        headerActions.querySelector(".btn-header-block").addEventListener("click", () => {
            if (!state.blockedChannels.some(bc => bc.id === channelId)) {
                state.blockedChannels.push({ name: channelName, id: channelId });
                saveBlocked();
            }
            showToast(`🚫 Blocked ${channelName}`, "danger");
            if (state.lastViewBeforeInspect) {
                state.currentView = state.lastViewBeforeInspect;
                state.lastViewBeforeInspect = null;
            } else {
                state.currentView = "subscriptions";
            }
            renderFeed();
        });
        backRow.appendChild(headerActions);
        grid.appendChild(backRow);
        
        if (!isSubscribed) {
            const banner = document.createElement("div");
            banner.className = "channel-inspect-banner";
            banner.innerHTML = `
                <div class="channel-inspect-content">
                    <h3>🌿 Channel Inspection Mode</h3>
                    <p>You are viewing the latest videos of <strong>${escapeHTML(channelName)}</strong>. Subscribe to add them to your Smart Feed, or Block to hide them permanently.</p>
                </div>
            `;
            grid.appendChild(banner);
        }
        
        if (channelVideos.length === 0) {
            emptyState.classList.remove("hidden");
            const emptyH3 = emptyState.querySelector("h3");
            const emptyP = emptyState.querySelector("p");
            if (emptyH3) emptyH3.textContent = "No cached videos";
            if (emptyP) emptyP.textContent = "Try syncing feeds to load videos for this channel.";
            return;
        }
        
        let scored = channelVideos.map(v => {
            const evaluation = getScoreAndMatches(v);
            return {
                ...v,
                score: evaluation.score,
                matchedTopics: evaluation.matches,
                isDiscover: false
            };
        });
        
        // Separate shorts
        let shorts = [];
        if (state.settings.muteShorts) {
            scored = scored.filter(v => !isShortVideo(v));
        } else {
            shorts = scored.filter(isShortVideo);
            scored = scored.filter(v => !isShortVideo(v));
        }
        
        scored.sort((a, b) => b.published - a.published);
        
        if (shorts.length > 0) {
            shortsShelf.classList.remove("hidden");
            const shortsFragment = document.createDocumentFragment();
            shorts.slice(0, 10).forEach(s => renderCard(s, shortsFragment));
            shortsGrid.appendChild(shortsFragment);
        }
        
        const fragment = document.createDocumentFragment();
        scored.forEach(video => renderCard(video, fragment));
        grid.appendChild(fragment);
        return;
    }
    
    // Handle Smart Feed
    if (state.currentView === "smart-feed") {
        let subVideos = [];
        let redditVideos = [];
        Object.values(state.cache.videos).forEach(channelVideos => {
            channelVideos.forEach(v => {
                const evaluation = getScoreAndMatches(v);
                const enriched = {
                    ...v,
                    score: evaluation.score,
                    matchedTopics: evaluation.matches,
                    isDiscover: false
                };
                if (v.channelId && v.channelId.startsWith("reddit:")) {
                    redditVideos.push(enriched);
                } else {
                    subVideos.push(enriched);
                }
            });
        });
        
        subVideos = subVideos.filter(video => {
            const isBlockedId = state.blockedChannels.some(bc => bc.id && bc.id === video.channelId);
            const isBlockedName = state.blockedChannels.some(bc => !bc.id && video.channelName.toLowerCase().includes(bc.name.toLowerCase()));
            return !isBlockedId && !isBlockedName && video.score > -10;
        });
        
        let subShorts = [];
        if (state.settings.muteShorts) {
            subVideos = subVideos.filter(v => !isShortVideo(v));
        } else {
            subShorts = subVideos.filter(isShortVideo);
            subVideos = subVideos.filter(v => !isShortVideo(v));
        }
        
        subVideos.sort((a, b) => {
            if (a.score >= 5 && b.score < 5) return -1;
            if (b.score >= 5 && a.score < 5) return 1;
            return b.published - a.published;
        });
        
        const initialSubVideos = subVideos.slice(0, 20);
        
        if (subShorts.length > 0) {
            shortsShelf.classList.remove("hidden");
            const shortsFragment = document.createDocumentFragment();
            subShorts.slice(0, 10).forEach(short => renderCard(short, shortsFragment));
            shortsGrid.appendChild(shortsFragment);
        }

        if (redditVideos.length > 0 && redditShelf && redditGrid) {
            redditShelf.classList.remove("hidden");
            const redditFragment = document.createDocumentFragment();
            redditVideos.sort((a, b) => b.published - a.published).slice(0, 15).forEach(vid => renderCard(vid, redditFragment));
            redditGrid.appendChild(redditFragment);
        }
        
        if (initialSubVideos.length > 0) {
            const detailsElement = document.createElement("details");
            detailsElement.className = "subscriptions-collapsible";
            detailsElement.style.gridColumn = "1 / -1";
            detailsElement.open = true;
            
            const summaryElement = document.createElement("summary");
            summaryElement.className = "discover-section-header";
            summaryElement.style.cursor = "pointer";
            summaryElement.style.outline = "none";
            summaryElement.style.marginBottom = "1rem";
            summaryElement.style.display = "flex";
            summaryElement.style.alignItems = "center";
            summaryElement.style.listStyle = "none";
            
            summaryElement.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span class="collapse-icon" style="font-size: 0.9rem; transition: transform 0.2s;">▼</span>
                        <h2 class="discover-section-title" style="font-size: 1.15rem; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
                            <span>🌿 Subscribed Feeds</span>
                        </h2>
                        <span class="discover-badge" style="font-size: 0.7rem; opacity: 0.6;">Your Subscriptions</span>
                    </div>
                    <span style="font-size: 0.8rem; color: var(--text-muted);">Click to toggle</span>
                </div>
            `;
            
            summaryElement.addEventListener("click", () => {
                const icon = summaryElement.querySelector(".collapse-icon");
                icon.style.transform = detailsElement.open ? "rotate(-90deg)" : "rotate(0deg)";
            });

            detailsElement.appendChild(summaryElement);
            
            const subGrid = document.createElement("div");
            subGrid.className = "video-grid";
            subGrid.style.marginBottom = "2rem";
            
            const feedFragment = document.createDocumentFragment();
            initialSubVideos.forEach(video => renderCard(video, feedFragment));
            subGrid.appendChild(feedFragment);
            
            detailsElement.appendChild(subGrid);
            grid.appendChild(detailsElement);
        }
        
        // ── Suggestions Section (AI-driven discover feed) ──
        const suggestionsHeader = document.createElement("div");
        suggestionsHeader.className = "suggestions-section-header";
        suggestionsHeader.style.gridColumn = "1 / -1";
        suggestionsHeader.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <h2 class="discover-section-title" style="font-size: 1.15rem; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
                        <span>✨ Suggestions</span>
                    </h2>
                    <span class="suggestions-badge">AI Discovery</span>
                </div>
                <span style="font-size: 0.8rem; color: var(--text-muted);">Based on your topics & interests</span>
            </div>
        `;
        grid.appendChild(suggestionsHeader);
        
        const suggestionsGrid = document.createElement("div");
        suggestionsGrid.id = "suggestions-grid";
        suggestionsGrid.className = "video-grid";
        grid.appendChild(suggestionsGrid);
        
        if (state.smartFeedVideos.length > 0) {
            const fragment = document.createDocumentFragment();
            state.smartFeedVideos.forEach(video => {
                renderCard(video, fragment);
            });
            suggestionsGrid.appendChild(fragment);
        } else {
            loadNextSmartFeedBatch();
        }
        
        if (initialSubVideos.length === 0 && state.smartFeedVideos.length === 0) {
            emptyState.classList.remove("hidden");
        } else {
            emptyState.classList.add("hidden");
        }
        return;
    }
    
    // Handle Search View (when state.currentView starts with "search_")
    if (state.currentView.startsWith("search_")) {
        const searchQuery = state.currentView.substring(7);
        const queryTerm = searchQuery.toLowerCase();
        
        let allVideos = [];
        Object.values(state.cache.videos).forEach(channelVideos => {
            channelVideos.forEach(v => {
                const evaluation = getScoreAndMatches(v);
                allVideos.push({
                    ...v,
                    score: evaluation.score,
                    matchedTopics: evaluation.matches,
                    isDiscover: false
                });
            });
        });
        
        allVideos = allVideos.filter(video => {
            const isBlockedId = state.blockedChannels.some(bc => bc.id && bc.id === video.channelId);
            const isBlockedName = state.blockedChannels.some(bc => !bc.id && video.channelName.toLowerCase().includes(bc.name.toLowerCase()));
            return !isBlockedId && !isBlockedName && video.score > -10;
        });
        
        allVideos = allVideos.filter(v => 
            v.title.toLowerCase().includes(queryTerm) || 
            v.channelName.toLowerCase().includes(queryTerm)
        );
        
        allVideos.sort((a, b) => {
            if (a.score >= 5 && b.score < 5) return -1;
            if (b.score >= 5 && a.score < 5) return 1;
            return b.published - a.published;
        });
        
        if (sessionTopicSearchCache[queryTerm] === undefined && !topicSearchLoading[queryTerm]) {
            fetchTopicSearchDiscovery(queryTerm);
        }
        
        let discoverVideos = [];
        if (sessionTopicSearchCache[queryTerm]) {
            discoverVideos = sessionTopicSearchCache[queryTerm].map(v => {
                const evaluation = getScoreAndMatches(v);
                return {
                    ...v,
                    score: evaluation.score,
                    matchedTopics: evaluation.matches
                };
            });
            
            discoverVideos = discoverVideos.filter(video => {
                const isBlockedId = state.blockedChannels.some(bc => bc.id && bc.id === video.channelId);
                const isBlockedName = state.blockedChannels.some(bc => !bc.id && video.channelName.toLowerCase().includes(bc.name.toLowerCase()));
                return !isBlockedId && !isBlockedName && video.score > -10;
            });
            
            discoverVideos = discoverVideos.filter(dv => !allVideos.some(sv => sv.id === dv.id));
            discoverVideos.sort((a, b) => b.score - a.score);
        }
        
        let allShorts = [];
        if (state.settings.muteShorts) {
            allVideos = allVideos.filter(v => !isShortVideo(v));
            discoverVideos = discoverVideos.filter(v => !isShortVideo(v));
        } else {
            const subShorts = allVideos.filter(isShortVideo);
            allVideos = allVideos.filter(v => !isShortVideo(v));
            const discShorts = discoverVideos.filter(isShortVideo);
            discoverVideos = discoverVideos.filter(v => !isShortVideo(v));
            allShorts = [...subShorts, ...discShorts];
        }
        
        const isSearchLoading = topicSearchLoading[queryTerm];
        if (allVideos.length === 0 && discoverVideos.length === 0 && isSearchLoading) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; min-height: 200px;">
                    <div class="sync-spinner" style="font-size: 2rem; position: static; transform: none; display: block; animation: spin 1s linear infinite; margin: 2rem auto;">🔄</div>
                    <h3>Searching YouTube...</h3>
                    <p>Fetching public search results for "${capitalizePhrase(queryTerm)}"</p>
                </div>
            `;
            emptyState.classList.add("hidden");
            return;
        }
        
        if (allVideos.length === 0 && discoverVideos.length === 0 && allShorts.length === 0) {
            emptyState.classList.remove("hidden");
            return;
        }
        emptyState.classList.add("hidden");
        
        if (allShorts.length > 0) {
            shortsShelf.classList.remove("hidden");
            const shortsFragment = document.createDocumentFragment();
            allShorts.forEach(short => renderCard(short, shortsFragment));
            shortsGrid.appendChild(shortsFragment);
        }
        
        const feedFragment = document.createDocumentFragment();
        allVideos.slice(0, 120).forEach(video => renderCard(video, feedFragment));
        grid.appendChild(feedFragment);
        
        if (discoverVideos.length > 0) {
            const divider = document.createElement("div");
            divider.className = "discover-section-header";
            divider.innerHTML = `
                <h2 class="discover-section-title">🔍 Public Search Results for "${capitalizePhrase(searchQuery)}"</h2>
                <span class="discover-badge">YouTube Public Search</span>
            `;
            grid.appendChild(divider);
        
        // Render ALL cached discover videos (infinite scroll handles batching)
        if (topicSearchLoading[queryTerm]) {
            // If currently streaming, render already-loaded ones instantly
            const discoverFragment = document.createDocumentFragment();
            discoverVideos.forEach(video => renderCard(video, discoverFragment));
            grid.appendChild(discoverFragment);
        } else {
            // Otherwise render the first 18 instantly via fragment, and stagger the rest with a 10ms timeout
            const instantBatch = discoverVideos.slice(0, 18);
            const staggeredBatch = discoverVideos.slice(18);
            
            const discoverFragment = document.createDocumentFragment();
            instantBatch.forEach(video => renderCard(video, discoverFragment));
            grid.appendChild(discoverFragment);
            
            staggeredBatch.forEach((video, index) => {
                const t = setTimeout(() => {
                    renderCard(video, grid);
                }, index * 10);
                renderTimeouts.push(t);
            });
        }

        // Show infinite scroll loader if currently fetching more
        if (topicSearchLoading[queryTerm]) {
            const loader = document.createElement("div");
            loader.className = "infinite-scroll-loader";
            loader.innerHTML = `<div class="loader-spinner"></div><p>Loading more results...</p>`;
            grid.appendChild(loader);
        } else if (state.discoverMaxReached) {
            const endMsg = document.createElement("div");
            endMsg.className = "end-of-results";
            endMsg.textContent = `Showing top ${DISCOVER_MAX_RESULTS} results. Refine your search for more.`;
            grid.appendChild(endMsg);
        }
    }
}
}

// Display Video in Inline Player (above feed, no overlay)
function playVideo(video) {
    // Get or create the inline player element
    let inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) {
        // Dynamically create the inline player and insert before feed-section
        inlinePlayer = document.createElement("div");
        inlinePlayer.id = "inline-player";
        inlinePlayer.className = "inline-player";
        inlinePlayer.innerHTML = [
            '<div class="inline-player-inner">',
            '  <div class="inline-player-video">',
            '    <div class="player-wrapper-box"></div>',
            '  </div>',
            '  <div class="inline-player-bar">',
            '    <div class="inline-player-meta">',
            '      <h2 class="player-title"></h2>',
            '      <p class="player-channel"></p>',
            '    </div>',
            '    <button class="inline-player-close" title="Close Player">✕ Close</button>',
            '  </div>',
            '</div>'
        ].join("");
        // Insert before .feed-section inside .main-content
        const feedSection = document.querySelector(".feed-section");
        if (feedSection && feedSection.parentNode) {
            feedSection.parentNode.insertBefore(inlinePlayer, feedSection);
        } else {
            const mainContent = document.querySelector(".main-content");
            if (mainContent) mainContent.appendChild(inlinePlayer);
        }
        // Bind close button using querySelector on the element itself
        inlinePlayer.querySelector(".inline-player-close").addEventListener("click", closePlayer);
    }

    // Use querySelector on the player element - never document.getElementById
    const playerWrapper = inlinePlayer.querySelector(".player-wrapper-box");
    const titleEl = inlinePlayer.querySelector(".player-title");
    const channelEl = inlinePlayer.querySelector(".player-channel");

    if (titleEl) titleEl.textContent = video.title;
    if (channelEl) channelEl.textContent = video.channelName;

    if (playerWrapper) {
        playerWrapper.innerHTML = '<iframe ' +
            'src="https://www.youtube.com/embed/' + video.id + '?autoplay=1&rel=0&modestbranding=1" ' +
            'title="' + escapeHTML(video.title) + '" ' +
            'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
            'allowfullscreen></iframe>';
    }

    // Show and animate in
    inlinePlayer.classList.remove("hidden", "closing");
    inlinePlayer.style.display = "";

    // Scroll the main content area so player is visible
    const mainContent = document.querySelector(".main-content");
    if (mainContent) mainContent.scrollTop = 0;

    // Trigger background similar topic generation (deferred)
    if (video.title) {
        setTimeout(() => {
            console.log(`[Smart Feed] Watching video, triggering background similar topics generation for: "${video.title}"`);
            generateSimilarTopicsFromSearch(video.title);
        }, 3000);
    }
}

function closePlayer() {
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) return;
    inlinePlayer.classList.add("closing");
    setTimeout(() => {
        inlinePlayer.classList.add("hidden");
        inlinePlayer.classList.remove("closing");
        const pw = inlinePlayer.querySelector(".player-wrapper-box");
        if (pw) pw.innerHTML = ""; // Stops playback
    }, 250);
}

function triggerGlobalSearch(query) {
    if (!query) return;
    
    // Append to search history, keeping max 10
    state.searchHistory = [query, ...state.searchHistory.filter(q => q.toLowerCase() !== query.toLowerCase())].slice(0, 10);
    saveSearchHistory();
    
    // Switch navigation active states (clear active highlight on menu)
    document.querySelectorAll(".nav-item").forEach(btn => btn.classList.remove("active"));
    
    state.currentView = "search_" + query;
    document.getElementById("current-view-title").textContent = `Search: "${query}"`;
    state.discoverBatchIndex = 0;
    state.discoverMaxReached = false;
    
    // Trigger rendering (which will show loading spinner and fetch discovery)
    renderFeed();
    
    // Trigger background similar topic generation using LLM
    generateSimilarTopicsFromSearch(query);
}

// Parse OPML uploaded file and import channels
function handleOPMLFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(e.target.result, "text/xml");
            const outlines = xmlDoc.querySelectorAll("outline[xmlUrl]");
            
            let addedCount = 0;
            outlines.forEach(outline => {
                const xmlUrl = outline.getAttribute("xmlUrl");
                const channelTitle = outline.getAttribute("title") || outline.getAttribute("text") || "Unknown Channel";
                
                // Extract channel_id query param
                const match = xmlUrl.match(/[?&]channel_id=(UC[A-Za-z0-9_-]{22})/);
                if (match && match[1]) {
                    const id = match[1];
                    if (!state.channels.some(c => c.id === id)) {
                        state.channels.push({ name: channelTitle, id: id });
                        addedCount++;
                    }
                }
            });
            
            saveChannels();
            renderChannelsList();
            alert(`Imported ${addedCount} new channels successfully!`);
        } catch (err) {
            alert("Failed parsing OPML file: " + err.message);
        }
    };
    reader.readAsText(file);
}

// Settings Rendering lists
function renderChannelsList() {
    const list = document.getElementById("channels-list");
    list.innerHTML = "";
    
    state.channels.forEach((channel, idx) => {
        const row = document.createElement("div");
        row.className = "channel-row";
        row.innerHTML = `
            <div class="channel-info">
                <span class="channel-name">${escapeHTML(channel.name)}</span>
                <span class="channel-id">${channel.id}</span>
            </div>
            <button class="btn-remove" data-idx="${idx}">✕</button>
        `;
        
        row.querySelector(".btn-remove").addEventListener("click", (e) => {
            state.channels.splice(e.target.dataset.idx, 1);
            saveChannels();
            renderChannelsList();
        });
        list.appendChild(row);
    });
    
    document.getElementById("subscribed-count").textContent = state.channels.length;
}

function renderPreferencesLists(filterQuery) {
    const q = (filterQuery || "").trim().toLowerCase();
    
    const renderList = (containerId, topicsArray, deleteCallback) => {
        const container = document.getElementById(containerId);
        container.innerHTML = "";
        
        const filtered = q ? topicsArray.filter(t => t.toLowerCase().includes(q)) : topicsArray;
        
        if (filtered.length === 0) {
            const msg = q ? `No topics matching "${escapeHTML(q)}".` : "No topics added.";
            container.innerHTML = `<span style="color:var(--text-muted);font-size:0.85rem;">${msg}</span>`;
            return;
        }
        filtered.forEach(topic => {
            const row = document.createElement("div");
            row.className = "topic-row";
            row.style.marginBottom = "0.25rem";
            row.style.background = "rgba(255,255,255,0.05)";
            
            // Highlight matching text if searching
            let displayText = escapeHTML(topic);
            if (q) {
                const idx = topic.toLowerCase().indexOf(q);
                if (idx !== -1) {
                    const before = escapeHTML(topic.slice(0, idx));
                    const match = escapeHTML(topic.slice(idx, idx + q.length));
                    const after = escapeHTML(topic.slice(idx + q.length));
                    displayText = `${before}<span class="topic-search-highlight">${match}</span>${after}`;
                }
            }
            
            row.innerHTML = `
                <span class="topic-phrase" style="font-size:0.85rem;">${displayText}</span>
                <button class="btn-remove" data-phrase="${escapeHTML(topic)}">✕</button>
            `;
            row.querySelector(".btn-remove").addEventListener("click", (e) => {
                deleteCallback(e.target.dataset.phrase);
            });
            container.appendChild(row);
        });
    };

    renderList("liked-topics-list", state.likedTopics, (phrase) => {
        state.likedTopics = state.likedTopics.filter(t => t !== phrase);
        saveLikedTopics();
        // Auto-move to disliked
        const normalized = phrase.trim().toLowerCase();
        if (!state.dislikedTopics.includes(normalized)) {
            state.dislikedTopics.push(normalized);
            saveDislikedTopics();
        }
        renderPreferencesLists(q);
    });

    renderList("disliked-topics-list", state.dislikedTopics, (phrase) => {
        state.dislikedTopics = state.dislikedTopics.filter(t => t !== phrase);
        saveDislikedTopics();
        renderPreferencesLists(q);
    });
}

function renderTopicsList(filterQuery) {
    const list = document.getElementById("topics-list");
    list.innerHTML = "";
    const q = (filterQuery || "").trim().toLowerCase();
    
    // Sort topics by weight descending
    let sortedTopics = [...state.topics].sort((a, b) => b.weight - a.weight);
    
    // Filter if search query provided
    if (q) {
        sortedTopics = sortedTopics.filter(t => t.phrase.toLowerCase().includes(q));
    }
    
    if (sortedTopics.length === 0 && q) {
        list.innerHTML = `<span style="color:var(--text-muted);font-size:0.85rem;">No legacy topics matching "${escapeHTML(q)}".</span>`;
        return;
    }
    
    sortedTopics.forEach(topic => {
        const row = document.createElement("div");
        row.className = "topic-row";
        
        const badgeClass = topic.weight >= 0 ? "positive" : "negative";
        const sign = topic.weight >= 0 ? "+" : "";
        
        // Highlight matching text if searching
        let displayText = escapeHTML(topic.phrase);
        if (q) {
            const idx = topic.phrase.toLowerCase().indexOf(q);
            if (idx !== -1) {
                const before = escapeHTML(topic.phrase.slice(0, idx));
                const match = escapeHTML(topic.phrase.slice(idx, idx + q.length));
                const after = escapeHTML(topic.phrase.slice(idx + q.length));
                displayText = `${before}<span class="topic-search-highlight">${match}</span>${after}`;
            }
        }
        
        row.innerHTML = `
            <span class="topic-phrase">${displayText}</span>
            <div class="topic-controls" style="display: flex; gap: 0.5rem; align-items: center;">
                <span class="topic-badge-weight ${badgeClass}">${sign}${topic.weight}</span>
                <button class="btn-like-legacy" data-phrase="${escapeHTML(topic.phrase)}" title="Move to Liked Topics" style="background: transparent; border: none; cursor: pointer; font-size: 1.1rem; padding: 0;">👍</button>
                <button class="btn-remove btn-remove-legacy" data-phrase="${escapeHTML(topic.phrase)}" title="Remove & Move to Disliked Topics">✕</button>
            </div>
        `;
        
        row.querySelector(".btn-like-legacy").addEventListener("click", (e) => {
            const phrase = e.target.dataset.phrase;
            state.topics = state.topics.filter(t => t.phrase !== phrase);
            saveTopics();
            
            const normalized = phrase.trim().toLowerCase();
            if (!state.likedTopics.includes(normalized)) {
                state.likedTopics.push(normalized);
                saveLikedTopics();
            }
            // Ensure it's not in disliked
            state.dislikedTopics = state.dislikedTopics.filter(t => t !== normalized);
            saveDislikedTopics();
            
            renderPreferencesLists(document.getElementById("input-topic-search")?.value || "");
            renderTopicsList(document.getElementById("input-legacy-topic-search")?.value || "");
        });

        row.querySelector(".btn-remove-legacy").addEventListener("click", (e) => {
            const phrase = e.target.dataset.phrase;
            state.topics = state.topics.filter(t => t.phrase !== phrase);
            saveTopics();
            
            const normalized = phrase.trim().toLowerCase();
            if (!state.dislikedTopics.includes(normalized)) {
                state.dislikedTopics.push(normalized);
                saveDislikedTopics();
            }
            // Ensure it's not in liked
            state.likedTopics = state.likedTopics.filter(t => t !== normalized);
            saveLikedTopics();
            
            renderPreferencesLists(document.getElementById("input-topic-search")?.value || "");
            renderTopicsList(document.getElementById("input-legacy-topic-search")?.value || "");
        });
        list.appendChild(row);
    });
}

// Export Settings to JSON file
function exportSettings() {
    const backup = {
        channels: state.channels,
        topics: state.topics,
        blockedChannels: state.blockedChannels
    };
    
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = "wallgarden-settings.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Import Settings from JSON file
function importSettings(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const backup = JSON.parse(e.target.result);
            if (Array.isArray(backup.channels) && Array.isArray(backup.topics)) {
                state.channels = backup.channels;
                state.topics = backup.topics;
                state.blockedChannels = Array.isArray(backup.blockedChannels) ? backup.blockedChannels : [];
                saveChannels();
                saveTopics();
                saveBlocked();
                
                renderChannelsList();
                renderTopicsList();
                renderBlockedList();
                alert("Settings restored successfully!");
            } else {
                throw new Error("Invalid format. Channels and Topics properties must be arrays.");
            }
        } catch (err) {
            alert("Restoration failed: " + err.message);
        }
    };
    reader.readAsText(file);
}

// Render Blocked Channels List in Settings
function renderBlockedList() {
    const list = document.getElementById("blocked-list");
    list.innerHTML = "";
    
    state.blockedChannels.forEach((bc, idx) => {
        const row = document.createElement("div");
        row.className = "channel-row";
        row.innerHTML = `
            <div class="channel-info">
                <span class="channel-name">${escapeHTML(bc.name)}</span>
                ${bc.id ? `<span class="channel-id">${bc.id}</span>` : ""}
            </div>
            <button class="btn-remove" data-idx="${idx}">✕</button>
        `;
        
        row.querySelector(".btn-remove").addEventListener("click", (e) => {
            state.blockedChannels.splice(e.target.dataset.idx, 1);
            saveBlocked();
            renderBlockedList();
        });
        list.appendChild(row);
    });
    
    document.getElementById("blocked-count").textContent = state.blockedChannels.length;
}

// String & utility helper functions
function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalizePhrase(str) {
    return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getRelativeTime(timestamp) {
    const diffMs = Date.now() - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHr / 24);
    
    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHr > 0) return `${diffHr}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return "Just now";
}

function updateStatusText(text) {
    document.getElementById("dashboard-status-text").textContent = text;
}

// Fetch general YouTube search results for a topic in the background (CORS bypassed)
async function fetchTopicSearchDiscovery(topicPhrase, offset) {
    const cacheKey = topicPhrase.toLowerCase();
    offset = offset || 0;
    const fetchCount = offset + DISCOVER_BATCH_SIZE;
    const url = `/youtube/results?search_query=${encodeURIComponent(topicPhrase)}`;
    console.log(`[Search Debug] fetchTopicSearchDiscovery initiated for: "${topicPhrase}" (cacheKey: "${cacheKey}", offset: ${offset}, fetchCount: ${fetchCount})`);
    if (topicSearchLoading[cacheKey]) {
        console.log(`[Search Debug] fetchTopicSearchDiscovery already loading for "${cacheKey}". Aborting duplicate call.`);
        return;
    }
    topicSearchLoading[cacheKey] = true;
    
    updateStatusText(`Searching YouTube for "${topicPhrase}"...`);
    
    let videos = [];
    let success = false;
    
    if (state.settings.useYtdlp) {
        try {
            console.log(`[Search Debug] Fetching /scraper/collect stream for "${topicPhrase}" via POST (limit: ${fetchCount})...`);
            updateStatusText(`Searching via yt-dlp for "${topicPhrase}"...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const resp = await fetch("/scraper/collect", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    source: "youtube",
                    query: topicPhrase,
                    limit: fetchCount,
                    days_back: 0,
                    require_transcript: false,
                    stream: true
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            console.log(`[Search Debug] /scraper/collect response status: ${resp.status} (${resp.statusText})`);
            if (resp.ok) {
                if (!sessionTopicSearchCache[cacheKey]) {
                    sessionTopicSearchCache[cacheKey] = [];
                }
                const existingIds = new Set(sessionTopicSearchCache[cacheKey].map(v => v.id));
                success = true;

                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                console.log("[Search Debug] Stream reader obtained. Starting read loop...");

                while (true) {
                    console.log("[Search Debug] Awaiting reader.read()...");
                    const { value, done } = await reader.read();
                    console.log(`[Search Debug] Reader chunk received. done: ${done}, chunk size: ${value ? value.length : 0} bytes`);
                    if (done) {
                        console.log("[Search Debug] Done flag is true. Exiting read loop.");
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop();
                    console.log(`[Search Debug] Split buffer into ${lines.length} lines. Remaining buffer size: ${buffer.length} chars`);

                    for (const line of lines) {
                        if (line.trim()) {
                            try {
                                console.log(`[Search Debug] Parsing NDJSON line: ${line.substring(0, 120)}...`);
                                const item = JSON.parse(line);
                                if (item.error) {
                                    console.warn("[Search Debug] Stream item contains error:", item.error);
                                    continue;
                                }
                                const video = {
                                    id: item.video_id,
                                    title: item.title,
                                    channelName: item.channel,
                                    channelId: "",
                                    publishedStr: item.published_at ? getRelativeTime(new Date(item.published_at).getTime()) : "Recently",
                                    published: item.published_at ? new Date(item.published_at).getTime() : Date.now(),
                                    duration: item.duration_secs,
                                    viewCount: item.view_count,
                                    isDiscover: true
                                };

                                if (!sessionTopicSearchCache[cacheKey]) {
                                    console.log("[Search Debug] Re-initializing session cache (must have been cleared by sync).");
                                    sessionTopicSearchCache[cacheKey] = [];
                                }
                                // Deduplicate against existing cached results
                                if (!existingIds.has(video.id)) {
                                    existingIds.add(video.id);
                                    sessionTopicSearchCache[cacheKey].push(video);
                                    console.log(`[Search Debug] Cached video: "${video.title}" (ID: ${video.id})`);

                                    // Append directly if the user is still looking at this topic or search
                                    const currentActiveTopic = state.currentView.startsWith("topic_") ? state.currentView.substring(6).toLowerCase() : "";
                                    const currentActiveSearch = state.currentView.startsWith("search_") ? state.currentView.substring(7).toLowerCase() : "";
                                    console.log(`[Search Debug] View check - ActiveTopic: "${currentActiveTopic}", ActiveSearch: "${currentActiveSearch}", cacheKey: "${cacheKey}"`);
                                    if (currentActiveTopic === cacheKey || currentActiveSearch === cacheKey) {
                                        console.log(`[Search Debug] Match! Appending streamed video card directly.`);
                                        appendStreamedDiscoverVideo(video, topicPhrase);
                                    }
                                }
                            } catch (e) {
                                console.error("[Search Debug] Error parsing stream line:", e, line);
                            }
                        }
                    }
                }

                // Stream ended, update status
                console.log("[Search Debug] Stream ended successfully.");
                updateStatusText("Ready");
                topicSearchLoading[cacheKey] = false;
                
                // Check if we hit the max results cap
                if (sessionTopicSearchCache[cacheKey] && sessionTopicSearchCache[cacheKey].length >= DISCOVER_MAX_RESULTS) {
                    state.discoverMaxReached = true;
                }
                
                const currentActiveTopic = state.currentView.startsWith("topic_") ? state.currentView.substring(6).toLowerCase() : "";
                const currentActiveSearch = state.currentView.startsWith("search_") ? state.currentView.substring(7).toLowerCase() : "";
                if (currentActiveTopic === cacheKey || currentActiveSearch === cacheKey) {
                    if (offset > 0) {
                        // Infinite scroll batch — cards are already appended by appendStreamedDiscoverVideo().
                        // Just remove the loading spinner and show end-of-results if needed.
                        const grid = document.getElementById("video-grid");
                        const loader = grid.querySelector(".infinite-scroll-loader");
                        if (loader) loader.remove();
                        
                        if (state.discoverMaxReached) {
                            const endMsg = document.createElement("div");
                            endMsg.className = "end-of-results";
                            endMsg.textContent = `Showing top ${DISCOVER_MAX_RESULTS} results. Refine your search for more.`;
                            grid.appendChild(endMsg);
                        }
                        console.log("[Search Debug] Infinite scroll batch complete. Skipping full renderFeed().");
                    } else {
                        // Initial batch — do a full render to set up the grid layout
                        console.log("[Search Debug] Initial batch complete. Performing final renderFeed().");
                        renderFeed();
                    }
                }
            } else {
                console.warn(`[Search Debug] Scraper-service returned status ${resp.status}. Falling back to HTML scraping.`);
            }
        } catch (err) {
            console.error("[Search Debug] Failed fetching discovery search via yt-dlp, falling back to HTML scraper:", err);
        }
    }
    
    // Fallback to raw HTML scraping if yt-dlp is off or failed
    if (!success) {
        try {
            console.log(`[Search Debug] Executing HTML scraper fallback for: "${topicPhrase}"...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!resp.ok) throw new Error("Search request failed.");
            const htmlText = await resp.text();

            let ytData = null;
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, "text/html");
            const scripts = doc.querySelectorAll("script");
            for (const script of scripts) {
                if (script.textContent.includes("ytInitialData")) {
                    const text = script.textContent;
                    const startIndex = text.indexOf("ytInitialData =");
                    if (startIndex !== -1) {
                        const jsonStart = text.indexOf("{", startIndex);
                        if (jsonStart !== -1) {
                            let jsonText = text.substring(jsonStart);
                            const endIndex = jsonText.lastIndexOf("}");
                            if (endIndex !== -1) {
                                jsonText = jsonText.substring(0, endIndex + 1);
                            }
                            try {
                                ytData = JSON.parse(jsonText);
                                break;
                            } catch (e) {
                                console.error("JSON parse error in ytInitialData", e);
                            }
                        }
                    }
                }
            }

            if (!ytData) {
                throw new Error("Could not parse search data.");
            }

            const contents = ytData.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
            for (const sec of contents) {
                const items = sec.itemSectionRenderer?.contents || [];
                for (const item of items) {
                    // Extract Video Renderer
                    if (item.videoRenderer) {
                        const vr = item.videoRenderer;
                        try {
                            const videoId = vr.videoId;
                            const title = vr.title?.runs?.[0]?.text || "";
                            const channelName = vr.ownerText?.runs?.[0]?.text || "Unknown Channel";
                            const channelId = vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || "";
                            const publishedStr = vr.publishedTimeText?.simpleText || "Recently";
                            
                            // Parse duration if available in raw search data
                            let durationSecs = 0;
                            const durationStr = vr.lengthText?.simpleText;
                            if (durationStr) {
                                const parts = durationStr.split(":").map(Number);
                                if (parts.length === 2) {
                                    durationSecs = parts[0] * 60 + parts[1];
                                } else if (parts.length === 3) {
                                    durationSecs = parts[0] * 3600 + parts[1] * 60 + parts[2];
                                }
                            }
                            
                            if (videoId && title) {
                                videos.push({
                                    id: videoId,
                                    title: title,
                                    channelName: channelName,
                                    channelId: channelId,
                                    publishedStr: publishedStr,
                                    published: Date.now(),
                                    duration: durationSecs,
                                    isDiscover: true
                                });
                            }
                        } catch (err) {
                            // ignore malformed video renderer objects
                        }
                    }
                    
                    // Also parse Short Shelf
                    if (item.reelShelfRenderer) {
                        const items = item.reelShelfRenderer.items || [];
                        items.forEach(reelItem => {
                            if (reelItem.reelItemRenderer) {
                                const ri = reelItem.reelItemRenderer;
                                const videoId = ri.videoId;
                                const title = ri.headline?.simpleText || ri.headline?.runs?.[0]?.text || "";
                                if (videoId && title) {
                                    videos.push({
                                        id: videoId,
                                        title: title,
                                        channelName: "YouTube Shorts",
                                        channelId: "",
                                        publishedStr: "Recently",
                                        published: Date.now(),
                                        duration: 30,
                                        isDiscover: true,
                                        isExplicitShort: true
                                    });
                                }
                            }
                        });
                    }
                }
            }
        } catch (err) {
            console.error("Failed fetching discovery search for topic:", topicPhrase, err);
            updateStatusText(`Search discovery failed: ${err.message}`);
        }
    }
    if (!success) {
        sessionTopicSearchCache[cacheKey] = videos;
        updateStatusText("Ready");
        topicSearchLoading[cacheKey] = false;
        renderFeed();
    }
}

function appendStreamedDiscoverVideo(video, topicPhrase) {
    const grid = document.getElementById("video-grid");
    const emptyState = document.getElementById("empty-state");
    
    if (emptyState) emptyState.classList.add("hidden");
    
    // Clear search loading spinner if it is the only child of the grid
    const spinnerDiv = grid.querySelector(".empty-state");
    if (spinnerDiv && spinnerDiv.innerHTML.includes("Searching YouTube")) {
        grid.innerHTML = "";
    }
    
    // Evaluate video score and matched topics
    const evaluation = getScoreAndMatches(video);
    const enrichedVideo = {
        ...video,
        score: evaluation.score,
        matchedTopics: evaluation.matches
    };
    
    // Blocked channel/nuke checks
    const isBlockedId = state.blockedChannels.some(bc => bc.id && bc.id === enrichedVideo.channelId);
    const isBlockedName = state.blockedChannels.some(bc => !bc.id && enrichedVideo.channelName.toLowerCase().includes(bc.name.toLowerCase()));
    if (isBlockedId || isBlockedName || enrichedVideo.score <= -10) {
        return; // Filtered out
    }
    
    // Render as standard or short
    const isShort = isShortVideo(enrichedVideo);
    if (isShort) {
        if (state.settings.muteShorts) return;
        const shortsShelf = document.getElementById("shorts-shelf");
        const shortsGrid = document.getElementById("shorts-grid");
        if (shortsShelf) shortsShelf.classList.remove("hidden");
        
        const card = document.createElement("div");
        card.className = "video-card fade-in discover-card";
        
        let scoreClass = "mid";
        if (enrichedVideo.score >= 5) scoreClass = "high";
        if (enrichedVideo.score < 0) scoreClass = "low";
        
        const relativeTime = enrichedVideo.publishedStr || "Recently";
        
        card.innerHTML = `
            <div class="thumbnail-area">
                <img class="thumbnail-img" src="https://i.ytimg.com/vi/${enrichedVideo.id}/hqdefault.jpg" alt="${escapeHTML(enrichedVideo.title)}">
                <div class="thumbnail-play-overlay">
                    <div class="play-icon-circle">▶</div>
                </div>
                <div class="score-badge ${scoreClass}">★ ${enrichedVideo.score}</div>
                <div class="search-badge">⚡ Short</div>
            </div>
            <div class="card-details">
                <h3 class="video-title">${escapeHTML(enrichedVideo.title)}</h3>
                <p class="video-channel">${escapeHTML(enrichedVideo.channelName)}</p>
                <p class="video-time">${relativeTime}</p>
            </div>
        `;
        
        const openAction = () => playVideo(enrichedVideo);
        card.querySelector(".thumbnail-area").addEventListener("click", openAction);
        card.querySelector(".video-title").addEventListener("click", openAction);
        
        // Show up to 30 streaming short results
        const discoverCardsCount = shortsGrid.querySelectorAll(".discover-card").length;
        if (discoverCardsCount < DISCOVER_BATCH_SIZE) {
            shortsGrid.appendChild(card);
        }
    } else {
        // Ensure discovery divider exists
        let divider = grid.querySelector(".discover-section-header");
        if (!divider) {
            divider = document.createElement("div");
            divider.className = "discover-section-header";
            const isSearch = state.currentView.startsWith("search_");
            const titleText = isSearch
                ? `🔍 Public Search Results for "${capitalizePhrase(topicPhrase)}"`
                : `🔍 Discover More on "${capitalizePhrase(topicPhrase)}"`;
            divider.innerHTML = `
                <h2 class="discover-section-title">${titleText}</h2>
                <span class="discover-badge">YouTube Public Search</span>
            `;
            grid.appendChild(divider);
        }
        
        const card = document.createElement("div");
        card.className = "video-card fade-in discover-card";
        
        let scoreClass = "mid";
        if (enrichedVideo.score >= 5) scoreClass = "high";
        if (enrichedVideo.score < 0) scoreClass = "low";
        
        const relativeTime = enrichedVideo.publishedStr || "Recently";
        let metaLine = enrichedVideo.channelName;
        if (enrichedVideo.viewCount && enrichedVideo.viewCount > 0) {
            metaLine += ` • ${formatViews(enrichedVideo.viewCount)}`;
        }
        
        card.innerHTML = `
            <div class="thumbnail-area">
                <img class="thumbnail-img" src="https://i.ytimg.com/vi/${enrichedVideo.id}/hqdefault.jpg" alt="${escapeHTML(enrichedVideo.title)}">
                <div class="thumbnail-play-overlay">
                    <div class="play-icon-circle">▶</div>
                </div>
                <div class="score-badge ${scoreClass}">★ ${enrichedVideo.score}</div>
                <div class="search-badge">🔍 Search</div>
            </div>
            <div class="card-details">
                <h3 class="video-title">${escapeHTML(enrichedVideo.title)}</h3>
                <p class="video-channel">${escapeHTML(metaLine)}</p>
                <p class="video-time">${relativeTime}${enrichedVideo.duration ? ` • ${formatDuration(enrichedVideo.duration)}` : ""}</p>
            </div>
        `;
        
        const openAction = () => playVideo(enrichedVideo);
        card.querySelector(".thumbnail-area").addEventListener("click", openAction);
        card.querySelector(".video-title").addEventListener("click", openAction);
        
        // Append streamed card to the grid
        grid.appendChild(card);
    }
}


function formatViews(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M views';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K views';
    }
    return num + ' views';
}

function formatDuration(secs) {
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const seconds = secs % 60;
    
    let parts = [];
    if (hrs > 0) {
        parts.push(hrs);
        parts.push(mins.toString().padStart(2, '0'));
    } else {
        parts.push(mins);
    }
    parts.push(seconds.toString().padStart(2, '0'));
    return parts.join(':');
}

function isShortVideo(video) {
    if (video.isExplicitShort) return true;
    if (video.duration && video.duration > 0 && video.duration < 60) return true;
    
    const titleLower = video.title.toLowerCase();
    if (titleLower.includes("#shorts") || titleLower.includes("/shorts/") || titleLower.includes("youtube short")) return true;
    return false;
}

// Toast notification system
function showToast(message, type) {
    type = type || "info";
    let container = document.querySelector(".toast-container");
    if (!container) {
        container = document.createElement("div");
        container.className = "toast-container";
        document.body.appendChild(container);
    }
    
    const toast = document.createElement("div");
    toast.className = `toast-item ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add("fade-out");
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Infinite scroll for search/topic/brainstorm views
// Infinite scroll using highly-optimized IntersectionObserver (eliminates layout thrashing)
let infiniteScrollObserver = null;

function setupInfiniteScroll() {
    const trigger = document.getElementById("infinite-scroll-trigger");
    if (!trigger) return;
    
    // Disconnect old observer if any
    if (infiniteScrollObserver) {
        infiniteScrollObserver.disconnect();
    }
    
    infiniteScrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                handleTriggerIntersection();
            }
        });
    }, {
        root: document.querySelector(".feed-section") || null,
        rootMargin: "300px" // Start loading 300px before the user reaches the bottom
    });
    
    infiniteScrollObserver.observe(trigger);
}

function handleTriggerIntersection() {
    // Handle Smart Feed scroll discovery
    if (state.currentView === "smart-feed") {
        loadNextSmartFeedBatch();
        return;
    }

    // Only activate for topic/search views
    const isTopicView = state.currentView.startsWith("topic_");
    const isSearchView = state.currentView.startsWith("search_");
    if (!isTopicView && !isSearchView) return;
    
    const queryTerm = isTopicView 
        ? state.currentView.substring(6).toLowerCase() 
        : state.currentView.substring(7).toLowerCase();
    
    // Don't fetch if already loading, max reached
    if (topicSearchLoading[queryTerm]) return;
    if (state.discoverMaxReached) return;
    
    // Don't fetch more if no initial results yet
    const cachedCount = sessionTopicSearchCache[queryTerm] ? sessionTopicSearchCache[queryTerm].length : 0;
    if (cachedCount === 0) return;
    
    // Check if we already hit the cap
    if (cachedCount >= DISCOVER_MAX_RESULTS) {
        state.discoverMaxReached = true;
        // Append end-of-results message without re-rendering
        const grid = document.getElementById("video-grid");
        if (grid && !grid.querySelector(".end-of-results")) {
            const endMsg = document.createElement("div");
            endMsg.className = "end-of-results";
            endMsg.textContent = `Showing top ${DISCOVER_MAX_RESULTS} results. Refine your search for more.`;
            grid.appendChild(endMsg);
        }
        return;
    }
    
    // Add a loading spinner at the bottom of the grid
    const grid = document.getElementById("video-grid");
    if (grid && !grid.querySelector(".infinite-scroll-loader")) {
        const loader = document.createElement("div");
        loader.className = "infinite-scroll-loader";
        loader.innerHTML = `<div class="loader-spinner"></div><p>Loading more results...</p>`;
        grid.appendChild(loader);
    }
    
    // Fetch next batch
    state.discoverBatchIndex++;
    const offset = state.discoverBatchIndex * DISCOVER_BATCH_SIZE;
    console.log(`[Infinite Scroll] Fetching batch ${state.discoverBatchIndex + 1} (offset: ${offset}) for "${queryTerm}"`);
    fetchTopicSearchDiscovery(queryTerm, offset);
}

// Initialize infinite scroll on load
document.addEventListener("DOMContentLoaded", setupInfiniteScroll);

// Robust JSON Parsing Utilities for LLM Responses
function extractJsonFromText(text) {
    if (!text) return null;
    
    // Try finding outer object { "topics": [...] } — use non-greedy match
    const objectMatch = text.match(/\{\s*"topics"\s*:\s*\[[\s\S]*?\]\s*\}/);
    if (objectMatch) {
        try {
            return JSON.parse(objectMatch[0]);
        } catch (e) { /* fall through */ }
    }
    
    // Try finding any JSON object { ... }
    const anyObjMatch = text.match(/\{[\s\S]*?\}/);
    if (anyObjMatch) {
        try {
            return JSON.parse(anyObjMatch[0]);
        } catch (e) { /* fall through */ }
    }
    
    // Try finding outer array [ ... ]
    const arrayMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (arrayMatch) {
        try {
            return JSON.parse(arrayMatch[0]);
        } catch (e) { /* fall through */ }
    }
    
    return null;
}

function parseLlmJsonResponse(content) {
    if (!content) return null;
    let clean = content.trim();
    
    // Remove markdown code blocks if present
    if (clean.startsWith("```json")) clean = clean.substring(7);
    else if (clean.startsWith("```")) clean = clean.substring(3);
    if (clean.endsWith("```")) clean = clean.substring(0, clean.length - 3);
    clean = clean.trim();
    
    try {
        return JSON.parse(clean);
    } catch (e) {
        // Try extracting JSON substring
        const parsed = extractJsonFromText(clean);
        if (parsed) return parsed;
        console.error("[JSON Parser] Failed all parsing attempts for content:", e);
        return null;
    }
}

// AI Topic Brainstorming Features
let activeLlmModel = "default-model";

// Tool definition for structured topic generation (agentic harness)
const TOPIC_TOOL_DEFINITION = {
    type: "function",
    function: {
        name: "suggest_topics",
        description: "Suggest new topics related to the user's interest graph. Each topic should be 1-3 words.",
        parameters: {
            type: "object",
            properties: {
                topics: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            phrase: { type: "string", description: "1-3 word topic name, e.g. 'container orchestration'" },
                            category: { type: "string", enum: ["sub_category", "similar", "interesting_tangent", "unrelated_but_interesting"] },
                            reason: { type: "string", description: "Short explanation of why this topic is suggested" },
                            associated_with: { type: "string", description: "Existing topic this connects to" }
                        },
                        required: ["phrase", "category", "reason", "associated_with"]
                    },
                    minItems: 5,
                    maxItems: 5
                }
            },
            required: ["topics"]
        }
    }
};

const BRAINSTORM_SYSTEM_PROMPT = `/no_think
You are a topic brainstorming assistant. Call the suggest_topics tool with 5 new topics related to the user's interests.`;

const SIMILAR_SYSTEM_PROMPT = `/no_think
You are a search query assistant. Call the suggest_topics tool with 5 topics related to the user's search query.`;

async function fetchLlmModel() {
    try {
        const resp = await fetch("/vllm/v1/models");
        if (resp.ok) {
            const data = await resp.json();
            if (data && data.data && data.data.length > 0) {
                activeLlmModel = data.data[0].id;
                console.log("vLLM active model detected:", activeLlmModel);
            }
        }
    } catch (err) {
        console.warn("Failed to fetch active vLLM model, using default:", err);
    }
}

// Extract topics from a vLLM response — supports tool_calls (preferred) and text fallback
function extractTopicsFromLlmResponse(message) {
    // 1. Try tool_calls first (structured output from agentic harness)
    if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
            try {
                const args = typeof tc.function.arguments === "string"
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments;
                if (args && Array.isArray(args.topics)) {
                    console.log("[Smart Feed] Extracted topics via tool_calls:", args.topics.length);
                    return args.topics;
                }
            } catch (e) {
                console.warn("[Smart Feed] Failed to parse tool_call arguments:", e, tc.function?.arguments);
            }
        }
    }
    
    // 2. Fallback to text content parsing
    let content = message.content;
    if (content === null || content === undefined || (typeof content === "string" && content.trim() === "")) {
        const reasoning = message.reasoning || message.reasoning_content;
        if (reasoning) content = reasoning;
    }
    
    if (!content) {
        console.warn("[Smart Feed DEBUG] No content in message:", JSON.stringify(message).substring(0, 500));
        return [];
    }
    
    console.log("[Smart Feed DEBUG] Raw vLLM content (first 500 chars):", content.substring(0, 500));
    
    const parsed = parseLlmJsonResponse(content);
    if (!parsed) {
        console.error("[Smart Feed DEBUG] JSON parsing failed entirely. Full content:", content);
        return [];
    }
    
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.topics)) return parsed.topics;
    
    console.warn("[Smart Feed DEBUG] Parsed object has no topics array:", parsed);
    return [];
}

async function generateBrainstormTopics(append, numRequests = 1) {
    append = append || false;
    if (state.brainstormLoading) return;
    state.brainstormLoading = true;
    state.lastBrainstormAttempt = Date.now();
    
    console.log(`[Smart Feed] Background LLM brainstorming started (firing ${numRequests} parallel requests)...`);
    
    // Truncated context: top 15 highest-weight topics, last 20 used
    const likedAll = state.topics.filter(t => t.weight > 0).sort((a, b) => b.weight - a.weight);
    const liked = likedAll.slice(0, 15).map(t => t.phrase).join(", ");
    const disliked = state.topics.filter(t => t.weight < 0).slice(0, 10).map(t => t.phrase).join(", ");
    const searches = state.searchHistory.slice(-10).join(", ");
    const recentUsed = state.smartFeedUsedTopics.slice(-20).join(", ");
    
    const userMessage = `My interests: [${liked}]
Disliked: [${disliked}]
Recent searches: [${searches}]
Recently used (avoid these): [${recentUsed}]

Suggest 5 new topics.`;

    const MAX_RETRIES = 2;
    let attempt = 0;
    let allAddedPhrases = [];
    let success = false;

    while (attempt <= MAX_RETRIES && !success) {
        try {
            if (activeLlmModel === "default-model") {
                await fetchLlmModel();
            }
            
            if (attempt > 0) {
                console.log(`[Smart Feed] Brainstorm attempt ${attempt + 1}/${MAX_RETRIES + 1} (increasing temperature)...`);
            }
            
            const fetchPromises = [];
            for (let i = 0; i < numRequests; i++) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000);
                
                const req = fetch("/vllm/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: activeLlmModel,
                        messages: [
                            { role: "system", content: BRAINSTORM_SYSTEM_PROMPT },
                            { role: "user", content: userMessage }
                        ],
                        tools: [TOPIC_TOOL_DEFINITION],
                        tool_choice: { type: "function", function: { name: "suggest_topics" } },
                        temperature: 0.1 + (attempt * 0.15),
                        max_tokens: 1500,
                        chat_template_kwargs: { "enable_thinking": false }
                    }),
                    signal: controller.signal
                }).then(async (res) => {
                    clearTimeout(timeoutId);
                    if (!res.ok) {
                        const body = await res.text().catch(() => "");
                        throw new Error(`vLLM returned ${res.status}: ${body.substring(0, 200)}`);
                    }
                    return res.json();
                });
                fetchPromises.push(req);
            }
            
            const results = await Promise.allSettled(fetchPromises);
            
            for (const result of results) {
                if (result.status === "rejected") {
                    console.error("[Smart Feed] Batch request failed:", result.reason);
                    continue;
                }
                
                const data = result.value;
                const message = data.choices?.[0]?.message;
                if (!message) {
                    console.warn("[Smart Feed DEBUG] No message in response:", JSON.stringify(data).substring(0, 300));
                    continue;
                }
                
                const topicsArray = extractTopicsFromLlmResponse(message);
                
                topicsArray.forEach(item => {
                    const phrase = (item.phrase || item.topic || item.keyword || "")?.trim().toLowerCase();
                    if (!phrase) return;
                    
                    const existsInTopics = state.topics.some(t => t.phrase.toLowerCase() === phrase);
                    if (!existsInTopics) {
                        state.topics.push({ phrase, weight: 5 });
                    }
                    
                    const inQueue = state.smartFeedTopicsQueue.includes(phrase);
                    const inUsed = state.smartFeedUsedTopics.includes(phrase);
                    if (!inQueue && !inUsed) {
                        state.smartFeedTopicsQueue.push(phrase);
                        allAddedPhrases.push(phrase);
                    }
                });
            }
            
            if (allAddedPhrases.length > 0) {
                success = true;
                saveTopics();
                console.log("[Smart Feed] Successfully brainstormed and queued new topics:", allAddedPhrases);
                if (!append) {
                    renderFeed();
                }
            } else {
                console.warn(`[Smart Feed] Brainstorming returned no new topics on attempt ${attempt + 1}.`);
                attempt++;
            }
        } catch (err) {
            console.error(`Brainstorm error on attempt ${attempt + 1}:`, err);
            attempt++;
            if (attempt > MAX_RETRIES && !append) {
                showToast("❌ Failed to brainstorm topics: " + err.message, "danger");
            }
        }
    }
    
    state.brainstormLoading = false;
    state.lastBrainstormTime = Date.now();
    updateStatusText("Ready");
}

async function generateSimilarTopicsFromSearch(searchQuery) {
    if (!searchQuery) return;
    console.log(`[Smart Feed] Background similar topics generation started for query: "${searchQuery}"`);
    
    // Truncated context: top 15 liked, last 20 used
    const liked = state.topics.filter(t => t.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 15).map(t => t.phrase).join(", ");
    const disliked = state.topics.filter(t => t.weight < 0).slice(0, 10).map(t => t.phrase).join(", ");
    const recentUsed = state.smartFeedUsedTopics.slice(-20).join(", ");
    
    const userMessage = `Search query: "${searchQuery}"
My interests: [${liked}]
Disliked: [${disliked}]
Recently used (avoid these): [${recentUsed}]

Suggest 5 topics related to "${searchQuery}".`;

    const MAX_RETRIES = 2;
    let attempt = 0;
    let addedPhrases = [];
    let success = false;

    while (attempt <= MAX_RETRIES && !success) {
        try {
            if (activeLlmModel === "default-model") {
                await fetchLlmModel();
            }
            
            if (attempt > 0) {
                console.log(`[Smart Feed] Similar brainstorm attempt ${attempt + 1}/${MAX_RETRIES + 1}...`);
            }
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            const response = await fetch("/vllm/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: activeLlmModel,
                    messages: [
                        { role: "system", content: SIMILAR_SYSTEM_PROMPT },
                        { role: "user", content: userMessage }
                    ],
                    tools: [TOPIC_TOOL_DEFINITION],
                    tool_choice: { type: "function", function: { name: "suggest_topics" } },
                    temperature: 0.1 + (attempt * 0.15),
                    max_tokens: 1500,
                    chat_template_kwargs: { "enable_thinking": false }
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`vLLM returned ${response.status}: ${body.substring(0, 200)}`);
            }
            
            const data = await response.json();
            const message = data.choices?.[0]?.message;
            if (!message) {
                console.warn("[Smart Feed DEBUG] No message in similar response:", JSON.stringify(data).substring(0, 300));
                throw new Error("No message returned from vLLM server.");
            }
            
            const topicsArray = extractTopicsFromLlmResponse(message);
            
            topicsArray.forEach(item => {
                const phrase = (item.phrase || item.topic || item.keyword || "")?.trim().toLowerCase();
                if (!phrase) return;
                
                const existsInTopics = state.topics.some(t => t.phrase.toLowerCase() === phrase);
                if (!existsInTopics) {
                    state.topics.push({ phrase, weight: 5 });
                }
                
                const inQueue = state.smartFeedTopicsQueue.includes(phrase);
                const inUsed = state.smartFeedUsedTopics.includes(phrase);
                if (!inQueue && !inUsed) {
                    state.smartFeedTopicsQueue.push(phrase);
                    addedPhrases.push(phrase);
                }
            });
            
            if (addedPhrases.length > 0) {
                success = true;
                saveTopics();
                console.log(`[Smart Feed] Successfully brainstormed and queued ${addedPhrases.length} similar topics for "${searchQuery}":`, addedPhrases);
                showToast(`💡 Queued ${addedPhrases.length} topics similar to "${searchQuery}"`, "success");
                
                fillSmartFeedPreloadBuffer();
            } else {
                console.warn(`[Smart Feed] Similar brainstorm returned no new topics on attempt ${attempt + 1}.`);
                attempt++;
            }
        } catch (err) {
            console.error(`Similar search topics brainstorm error on attempt ${attempt + 1}:`, err);
            attempt++;
        }
    }
}

// Time-range buckets for video era variety
const VIDEO_ERA_BUCKETS = ["before:2015", "before:2018", "before:2020", "after:2023", ""];

function getRandomEraBucket() {
    return VIDEO_ERA_BUCKETS[Math.floor(Math.random() * VIDEO_ERA_BUCKETS.length)];
}

async function fetchVideosForTopic(topic) {
    let videos = [];
    let success = false;
    const fetchCountPerRequest = 25;
    
    if (state.settings.useYtdlp) {
        try {
            // Parallel split-fetch: one current era + one random era bucket
            const eraBucket = getRandomEraBucket();
            const currentQuery = topic;
            const eraQuery = eraBucket ? `${topic} ${eraBucket}` : topic;
            
            console.log(`[Smart Feed Fetch] Parallel fetch for "${topic}" — current era + era bucket: "${eraBucket || 'none'}"`);
            
            const fetchOne = async (query, label) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                try {
                    const resp = await fetch("/scraper/collect", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            source: "youtube",
                            query: query,
                            limit: fetchCountPerRequest,
                            days_back: 0,
                            require_transcript: false
                        }),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data && Array.isArray(data.items)) {
                            console.log(`[Smart Feed Fetch] ${label} returned ${data.items.length} videos`);
                            return data.items;
                        }
                    }
                } catch (err) {
                    clearTimeout(timeoutId);
                    console.warn(`[Smart Feed Fetch] ${label} request failed:`, err.message);
                }
                return [];
            };
            
            // Fire both in parallel
            const [currentItems, eraItems] = await Promise.all([
                fetchOne(currentQuery, "current-era"),
                currentQuery !== eraQuery ? fetchOne(eraQuery, `era(${eraBucket})`) : Promise.resolve([])
            ]);
            
            const allItems = [...currentItems, ...eraItems];
            
            // Deduplicate by video_id
            const seenIds = new Set();
            allItems.forEach(item => {
                if (item.video_id && !seenIds.has(item.video_id)) {
                    seenIds.add(item.video_id);
                    videos.push({
                        id: item.video_id,
                        title: item.title,
                        channelName: item.channel,
                        channelId: "",
                        publishedStr: item.published_at ? getRelativeTime(new Date(item.published_at).getTime()) : "Recently",
                        published: item.published_at ? new Date(item.published_at).getTime() : Date.now(),
                        duration: item.duration_secs,
                        viewCount: item.view_count,
                        isDiscover: true,
                        discoveryTopic: topic
                    });
                }
            });
            
            // Shuffle to mix eras together
            videos.sort(() => Math.random() - 0.5);
            
            if (videos.length > 0) {
                success = true;
                console.log(`[Smart Feed Fetch] Total unique videos for "${topic}": ${videos.length}`);
            }
        } catch (err) {
            console.error(`[Smart Feed Fetch] Scraper fetch failed for "${topic}":`, err);
        }
    }
    
    if (!success) {
        try {
            const url = `/youtube/results?search_query=${encodeURIComponent(topic)}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (resp.ok) {
                const htmlText = await resp.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlText, "text/html");
                const scripts = doc.querySelectorAll("script");
                let ytData = null;
                for (const script of scripts) {
                    if (script.textContent.includes("ytInitialData")) {
                        const text = script.textContent;
                        const startIndex = text.indexOf("ytInitialData =");
                        if (startIndex !== -1) {
                            const jsonStart = text.indexOf("{", startIndex);
                            if (jsonStart !== -1) {
                                let jsonText = text.substring(jsonStart);
                                const endIndex = jsonText.lastIndexOf("}");
                                if (endIndex !== -1) {
                                    jsonText = jsonText.substring(0, endIndex + 1);
                                }
                                try {
                                    ytData = JSON.parse(jsonText);
                                    break;
                                } catch (e) {
                                    console.error("JSON parse error in ytInitialData", e);
                                }
                            }
                        }
                    }
                }
                
                if (ytData) {
                    const contents = ytData.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
                    for (const sec of contents) {
                        const items = sec.itemSectionRenderer?.contents || [];
                        for (const item of items) {
                            if (item.videoRenderer) {
                                const vr = item.videoRenderer;
                                const videoId = vr.videoId;
                                const title = vr.title?.runs?.[0]?.text || "";
                                const channelName = vr.ownerText?.runs?.[0]?.text || "Unknown Channel";
                                const publishedStr = vr.publishedTimeText?.simpleText || "Recently";
                                if (videoId && title) {
                                    videos.push({
                                        id: videoId,
                                        title: title,
                                        channelName: channelName,
                                        channelId: "",
                                        publishedStr: publishedStr,
                                        published: Date.now(),
                                        isDiscover: true,
                                        discoveryTopic: topic
                                    });
                                    if (videos.length >= fetchCountPerRequest) break;
                                }
                            }
                        }
                        if (videos.length >= fetchCountPerRequest) break;
                    }
                    success = true;
                }
            }
        } catch (err) {
            console.error(`[Smart Feed Fetch] HTML search fallback failed for "${topic}":`, err);
        }
    }
    
    if (videos.length > 0) {
        return videos.filter(v => {
            const evaluation = getScoreAndMatches(v);
            v.score = evaluation.score;
            v.matchedTopics = evaluation.matches;
            
            const isBlockedId = state.blockedChannels.some(bc => bc.id && bc.id === v.channelId);
            const isBlockedName = state.blockedChannels.some(bc => !bc.id && v.channelName.toLowerCase().includes(bc.name.toLowerCase()));
            
            return !isBlockedId && !isBlockedName && v.score > -10;
        });
    }
    
    return [];
}

let smartFeedPreloadTimeout = null;

async function fillSmartFeedPreloadBuffer() {
    if (state.smartFeedPreloadLoading) return;
    
    // We keep a larger buffer (e.g. 50) so we can randomly mix topics in loadNextSmartFeedBatch
    const targetPreloadCount = 200;
    if (state.smartFeedPreloadedVideos.length >= targetPreloadCount) {
        return; // Preload buffer is full
    }
    
    // Clear any pending timeout to prevent duplicate schedules
    if (smartFeedPreloadTimeout) {
        clearTimeout(smartFeedPreloadTimeout);
        smartFeedPreloadTimeout = null;
    }
    
    // Check if we need to brainstorm more topics using LLM
    const totalUpcoming = state.smartFeedTopicsQueue.length;
    const now = Date.now();
    const cooldownMs = 15000; // 15-second cooldown
    const isCooldownActive = state.lastBrainstormTime && (now - state.lastBrainstormTime < cooldownMs);

    if (totalUpcoming < 50 && !state.brainstormLoading && !isCooldownActive) {
        console.log("[Smart Feed] Total upcoming topics low, triggering background LLM brainstorm...");
        generateBrainstormTopics(true, 1).then(() => {
            fillSmartFeedPreloadBuffer();
        });
    }
    
    if (state.smartFeedTopicsQueue.length === 0) {
        console.log("[Smart Feed] Queue is empty! Repopulating from positive topics...");
        const randomizedTopics = getWeightedRandomTopics(state.topics);
        state.smartFeedTopicsQueue = [...randomizedTopics];
        if (state.smartFeedTopicsQueue.length === 0) {
            state.smartFeedTopicsQueue = ["coding", "programming", "ai", "science", "physics"];
        }
    }
    
    const topic = state.smartFeedTopicsQueue.shift();
    if (!topic) return;
    
    state.smartFeedPreloadLoading = true;
    state.smartFeedUsedTopics.push(topic);
    console.log(`[Smart Feed Preload] Pre-fetching discovery videos for topic: "${topic}"...`);
    
    try {
        const videos = await fetchVideosForTopic(topic);
        if (videos && videos.length > 0) {
            videos.forEach(v => v._topic = topic);
            
            // Limit to a max of 8 videos per topic to ensure a diverse mix in the feed
            // and prevent one topic (e.g. 50 videos) from dominating the view at once
            const limitedVideos = videos.slice(0, 8);
            state.smartFeedPreloadedVideos.push(...limitedVideos);
            
            // Shuffle to mix topics seamlessly
            state.smartFeedPreloadedVideos.sort(() => Math.random() - 0.5);
            
            console.log(`[Smart Feed Preload] Successfully preloaded topic "${topic}". Buffer size: ${state.smartFeedPreloadedVideos.length}`);
            
            // If the Smart Feed currently has no discovery videos rendered, and the user is waiting,
            // we should instantly render this newly loaded batch!
            if (state.currentView === "smart-feed" && state.smartFeedVideos.length === 0 && !state.smartFeedLoading) {
                loadNextSmartFeedBatch();
            }
        } else {
            console.warn(`[Smart Feed Preload] No videos found for topic "${topic}".`);
        }
    } catch (err) {
        console.error(`[Smart Feed Preload] Failed preloading for topic "${topic}":`, err);
    } finally {
        state.smartFeedPreloadLoading = false;
        
        // Cooldown delay of 1.5 seconds between fetches to protect from rate-limiting
        // Only schedule if we are still below target preload count
        if (state.smartFeedPreloadedVideos.length < targetPreloadCount) {
            smartFeedPreloadTimeout = setTimeout(() => {
                fillSmartFeedPreloadBuffer();
            }, 1500);
        }
    }
}

async function loadNextSmartFeedBatch() {
    if (state.smartFeedLoading) return;
    state.smartFeedLoading = true;
    
    // Target the dedicated suggestions grid, fall back to video-grid
    const suggestionsGrid = document.getElementById("suggestions-grid") || document.getElementById("video-grid");
    if (!suggestionsGrid) {
        state.smartFeedLoading = false;
        return;
    }
    
    // Check if we have preloaded content in the buffer
    if (state.smartFeedPreloadedVideos.length > 0) {
        // Take a batch of 12 mixed videos
        const batchSize = Math.min(12, state.smartFeedPreloadedVideos.length);
        const videosToRender = state.smartFeedPreloadedVideos.splice(0, batchSize);
        
        const existingIds = new Set(state.smartFeedVideos.map(v => v.id));
        const deduplicated = videosToRender.filter(v => !existingIds.has(v.id));
        
        if (deduplicated.length > 0) {
            state.smartFeedVideos.push(...deduplicated);
            
            const fragment = document.createDocumentFragment();
            deduplicated.forEach(video => {
                renderCard(video, fragment);
            });
            suggestionsGrid.appendChild(fragment);
        }
        
        state.smartFeedLoading = false;
        updateStatusText("Ready");
        
        // Trigger preloader to fill the gap
        fillSmartFeedPreloadBuffer();
        return;
    }
    
    // Fallback if buffer is empty
    let loader = suggestionsGrid.querySelector(".smart-feed-loader");
    if (!loader) {
        loader = document.createElement("div");
        loader.className = "smart-feed-loader infinite-scroll-loader";
        loader.innerHTML = `<div class="loader-spinner"></div><p style="margin: 0.5rem 0 0 0;">Discovering videos via AI topics...</p>`;
        loader.style.gridColumn = "1 / -1";
        loader.style.textAlign = "center";
        loader.style.padding = "2rem";
        suggestionsGrid.appendChild(loader);
    }
    
    if (state.smartFeedTopicsQueue.length === 0) {
        console.log("[Smart Feed] Queue is empty! Generating more topics first...");
        const randomizedTopics = getWeightedRandomTopics(state.topics);
        
        state.smartFeedTopicsQueue = [...randomizedTopics];
        if (state.smartFeedTopicsQueue.length === 0) {
            state.smartFeedTopicsQueue = ["coding", "programming", "ai", "science", "physics"];
        }
        
        generateBrainstormTopics(true);
    }
    
    const topic = state.smartFeedTopicsQueue.shift();
    if (!topic) {
        const updatedLoader = suggestionsGrid.querySelector(".smart-feed-loader");
        if (updatedLoader) updatedLoader.remove();
        state.smartFeedLoading = false;
        return;
    }
    state.smartFeedUsedTopics.push(topic);
    
    console.log(`[Smart Feed] Fetching discovery videos for topic: "${topic}" (on-demand fallback)...`);
    updateStatusText(`Smart Feed: Discovering "${capitalizePhrase(topic)}"...`);
    
    try {
        const videos = await fetchVideosForTopic(topic);
        const existingIds = new Set(state.smartFeedVideos.map(v => v.id));
        const deduplicated = videos.filter(v => !existingIds.has(v.id));
        
        if (deduplicated.length > 0) {
            deduplicated.forEach(v => v._topic = topic);
            state.smartFeedVideos.push(...deduplicated);
            
            const fragment = document.createDocumentFragment();
            deduplicated.forEach(video => {
                renderCard(video, fragment);
            });
            suggestionsGrid.appendChild(fragment);
        }
    } catch (err) {
        console.error(`[Smart Feed] Fallback fetch failed for "${topic}":`, err);
    } finally {
        const updatedLoader = suggestionsGrid.querySelector(".smart-feed-loader");
        if (updatedLoader) updatedLoader.remove();
        
        state.smartFeedLoading = false;
        updateStatusText("Ready");
        
        fillSmartFeedPreloadBuffer();
    }
}

// Mute and remove a discovery topic completely
function nukeDiscoverTopic(topic) {
    if (!topic) return;
    
    const normalizedTopic = topic.trim().toLowerCase();
    
    // 1. Set topic weight to -10 to mute it
    const existingIndex = state.topics.findIndex(t => t.phrase.toLowerCase() === normalizedTopic);
    if (existingIndex !== -1) {
        state.topics[existingIndex].weight = -10;
    } else {
        state.topics.push({ phrase: normalizedTopic, weight: -10 });
    }
    saveTopics();
    
    // 2. Clear from queue/preload states
    state.smartFeedUsedTopics = state.smartFeedUsedTopics.filter(t => t !== normalizedTopic);
    state.smartFeedTopicsQueue = state.smartFeedTopicsQueue.filter(t => t !== normalizedTopic);
    state.smartFeedPreloadedVideos = state.smartFeedPreloadedVideos.filter(item => item.topic !== normalizedTopic);
    
    // 3. Remove videos of this topic from active smartFeedVideos state
    state.smartFeedVideos = state.smartFeedVideos.filter(v => (v.discoveryTopic || "").toLowerCase() !== normalizedTopic);
    
    // 4. Locate and remove DOM elements
    const elements = [
        ...Array.from(document.querySelectorAll('.discover-section-header')),
        ...Array.from(document.querySelectorAll('.video-card'))
    ].filter(el => {
        const tAttr = el.getAttribute('data-discover-topic');
        return tAttr && tAttr.toLowerCase() === normalizedTopic;
    });
    
    elements.forEach(el => {
        el.classList.add("fade-out-remove");
        setTimeout(() => el.remove(), 350);
    });
    
    showToast(`🚫 Removed "${capitalizePhrase(topic)}" and muted it (-10 weight).`, "danger");
    
    // 5. Fill buffer and load next batch in background to keep feed populated
    setTimeout(() => {
        fillSmartFeedPreloadBuffer();
    }, 500);
}

// Edit a discovery topic and replace its contents inline
async function editDiscoverTopic(topic) {
    if (!topic) return;
    
    const normalizedTopic = topic.trim().toLowerCase();
    const newTopic = prompt(`Edit topic "${capitalizePhrase(normalizedTopic)}" keyphrase:`, normalizedTopic);
    if (newTopic === null) return;
    
    const newTopicClean = newTopic.trim().toLowerCase();
    if (!newTopicClean) {
        showToast("⚠️ Topic keyphrase cannot be empty.", "warning");
        return;
    }
    
    if (newTopicClean === normalizedTopic) return;
    
    // 1. Update/Add in state.topics (replace old topic with new one)
    state.topics = state.topics.filter(t => t.phrase.toLowerCase() !== normalizedTopic);
    const existingNewIndex = state.topics.findIndex(t => t.phrase.toLowerCase() === newTopicClean);
    if (existingNewIndex !== -1) {
        state.topics[existingNewIndex].weight = Math.max(state.topics[existingNewIndex].weight, 5); // Ensure not muted
    } else {
        state.topics.push({ phrase: newTopicClean, weight: 5 });
    }
    saveTopics();
    
    // 2. Update used topics
    state.smartFeedUsedTopics = state.smartFeedUsedTopics.map(t => t === normalizedTopic ? newTopicClean : t);
    
    // 3. Find header and show inline loading spinner
    const headerEl = Array.from(document.querySelectorAll('.discover-section-header'))
        .find(el => el.getAttribute('data-discover-topic') === normalizedTopic);
        
    if (headerEl) {
        const titleTextEl = headerEl.querySelector(".discover-topic-text");
        if (titleTextEl) {
            titleTextEl.innerHTML = `${escapeHTML(capitalizePhrase(newTopicClean))} <span class="sync-spinner" style="position: static; display: inline-block; animation: spinLoader 1s linear infinite; margin-left: 0.5rem; transform: none;">🔄</span>`;
        }
    }
    
    // 4. Animate and remove old cards for this topic from DOM and state
    const oldCards = Array.from(document.querySelectorAll('.video-card'))
        .filter(el => el.getAttribute('data-discover-topic') === normalizedTopic);
        
    oldCards.forEach(card => {
        card.classList.add("fade-out-remove");
        setTimeout(() => card.remove(), 350);
    });
    
    state.smartFeedVideos = state.smartFeedVideos.filter(v => (v.discoveryTopic || "").toLowerCase() !== normalizedTopic);
    
    showToast(`✏️ Updating topic to "${capitalizePhrase(newTopicClean)}"...`, "info");
    
    try {
        const videos = await fetchVideosForTopic(newTopicClean);
        const existingIds = new Set(state.smartFeedVideos.map(v => v.id));
        const deduplicated = videos.filter(v => !existingIds.has(v.id));
        
        // Find updated/current header element (in case DOM changed)
        const currentHeaderEl = Array.from(document.querySelectorAll('.discover-section-header'))
            .find(el => el.getAttribute('data-discover-topic') === normalizedTopic);
            
        if (currentHeaderEl) {
            // Update attributes and HTML of header
            currentHeaderEl.setAttribute("data-discover-topic", newTopicClean);
            
            currentHeaderEl.innerHTML = `
                <h2 class="discover-section-title" style="font-size: 1.1rem; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
                    <span>🔍 Discover:</span>
                    <span class="discover-topic-text" style="color: var(--accent);">${escapeHTML(capitalizePhrase(newTopicClean))}</span>
                    <div class="discover-topic-actions">
                        <button class="discover-action-btn edit-btn" title="Edit Topic" data-topic="${escapeHTML(newTopicClean)}">✏️</button>
                        <button class="discover-action-btn remove-btn" title="Remove Topic" data-topic="${escapeHTML(newTopicClean)}">✕</button>
                    </div>
                </h2>
                <span class="discover-badge" style="font-size: 0.7rem; opacity: 0.6;">Smart Feed Suggestion</span>
            `;
            
            // Bind new listeners
            currentHeaderEl.querySelector(".edit-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                editDiscoverTopic(newTopicClean);
            });
            currentHeaderEl.querySelector(".remove-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                nukeDiscoverTopic(newTopicClean);
            });
            
            if (deduplicated.length > 0) {
                state.smartFeedVideos.push(...deduplicated);
                
                const fragment = document.createDocumentFragment();
                deduplicated.forEach(video => {
                    renderCard(video, fragment);
                    const card = fragment.lastElementChild;
                    if (card) {
                        card.setAttribute("data-discover-topic", newTopicClean);
                    }
                });
                
                currentHeaderEl.after(fragment);
                showToast(`✅ Loaded new videos for "${capitalizePhrase(newTopicClean)}"`, "success");
            } else {
                showToast(`⚠️ No videos found for "${capitalizePhrase(newTopicClean)}"`, "warning");
                currentHeaderEl.classList.add("fade-out-remove");
                setTimeout(() => currentHeaderEl.remove(), 350);
            }
        }
    } catch (err) {
        console.error(`[Edit Topic] Fetch failed for "${newTopicClean}":`, err);
        showToast(`❌ Failed fetching videos for "${capitalizePhrase(newTopicClean)}"`, "danger");
        
        const currentHeaderEl = Array.from(document.querySelectorAll('.discover-section-header'))
            .find(el => el.getAttribute('data-discover-topic') === normalizedTopic);
        if (currentHeaderEl) {
            currentHeaderEl.classList.add("fade-out-remove");
            setTimeout(() => currentHeaderEl.remove(), 350);
        }
    } finally {
        fillSmartFeedPreloadBuffer();
    }
}

// ============================================================
//  DYNAMIC CHANNEL DISCOVERY SYSTEM
// ============================================================

function saveDiscovered() {
    localStorage.setItem("wallgarden_discovered_channels", JSON.stringify(state.discoveredChannels));
}

function initDiscoverChannels() {
    const btnRefresh = document.getElementById("btn-refresh-discover");
    if (btnRefresh && !btnRefresh.dataset.hooked) {
        btnRefresh.dataset.hooked = "true";
        btnRefresh.addEventListener("click", () => {
            generateDiscoverChannels(true);
        });
    }
    generateDiscoverChannels(false);
}

async function scrapeFeaturedChannels(channelId) {
    try {
        const resp = await fetch(`/youtube/channel/${channelId}`);
        if (!resp.ok) return [];
        const html = await resp.text();
        
        const match = html.match(/ytInitialData\s*=\s*({.+?});/);
        if (!match) return [];
        const data = JSON.parse(match[1]);
        
        const channels = [];
        function findChannelsRecursive(obj) {
            if (!obj || typeof obj !== "object") return;
            if (obj.channelId && (obj.title || obj.displayName)) {
                const name = obj.title?.simpleText || obj.title?.runs?.[0]?.text || obj.displayName?.runs?.[0]?.text || "";
                const handle = obj.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
                if (obj.channelId !== channelId) {
                    channels.push({
                        id: obj.channelId,
                        name: name,
                        handle: handle.startsWith("/@") ? handle.replace("/", "") : ""
                    });
                }
            }
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    findChannelsRecursive(obj[key]);
                }
            }
        }
        findChannelsRecursive(data);
        return channels;
    } catch (e) {
        console.warn("Featured channels scraping error:", e);
        return [];
    }
}

async function searchTopicsForChannels(topic) {
    try {
        const url = `/youtube/results?search_query=${encodeURIComponent(topic)}&sp=EgIQAg%3D%3D`;
        const resp = await fetch(url);
        if (!resp.ok) return [];
        const html = await resp.text();
        
        const match = html.match(/ytInitialData\s*=\s*({.+?});/);
        if (!match) return [];
        const data = JSON.parse(match[1]);
        
        const channels = [];
        function findChannelsRecursive(obj) {
            if (!obj || typeof obj !== "object") return;
            if (obj.channelId && (obj.title || obj.displayName)) {
                const name = obj.title?.simpleText || obj.title?.runs?.[0]?.text || obj.displayName?.runs?.[0]?.text || "";
                const handle = obj.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
                channels.push({
                    id: obj.channelId,
                    name: name,
                    handle: handle.startsWith("/@") ? handle.replace("/", "") : ""
                });
            }
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    findChannelsRecursive(obj[key]);
                }
            }
        }
        findChannelsRecursive(data);
        return channels;
    } catch (e) {
        console.warn("Topic channel search error:", e);
        return [];
    }
}

async function generateDiscoverChannels(force = false) {
    if (state.discoverChannelsLoading) return;
    
    if (!force && state.discoveredChannels && state.discoveredChannels.length > 0) {
        renderDiscoverChannelsView();
        return;
    }
    
    state.discoverChannelsLoading = true;
    
    const loadingState = document.getElementById("discover-loading-state");
    const grid = document.getElementById("discover-channels-grid");
    const btnRefresh = document.getElementById("btn-refresh-discover");
    
    if (loadingState) loadingState.classList.remove("hidden");
    if (grid) grid.classList.add("hidden");
    if (btnRefresh) btnRefresh.classList.add("spinning");
    
    let allRecommendations = [];
    const seenIds = new Set();
    const currentSubscribedIds = new Set(state.channels.map(c => c.id).filter(Boolean));
    const currentBlockedNames = new Set(state.blockedChannels.map(bc => bc.name.toLowerCase()));
    const currentBlockedIds = new Set(state.blockedChannels.map(bc => bc.id).filter(Boolean));
    
    const addRecommendation = (rec) => {
        if (!rec.id && !rec.handle) return;
        
        const key = rec.id || rec.handle;
        if (seenIds.has(key)) return;
        
        if (rec.id && currentSubscribedIds.has(rec.id)) return;
        if (rec.id && currentBlockedIds.has(rec.id)) return;
        if (rec.name && currentBlockedNames.has(rec.name.toLowerCase())) return;
        
        seenIds.add(key);
        allRecommendations.push(rec);
    };
    
    const promises = [];
    
    // 1. vLLM Suggestion
    const vllmPromise = (async () => {
        if (state.channels.length === 0) return;
        try {
            if (activeLlmModel === "default-model") {
                await fetchLlmModel();
            }
            
            const subscribedNames = state.channels.slice(0, 15).map(c => c.name).join(", ");
            const systemPrompt = `You are a YouTube channel recommendation engine. Recommend 5 high-quality channels that are similar in nature to the channels the user likes. Avoid recommending channels in the user's list. Return a JSON object with a 'channels' array: {"channels": [{"name": "Channel Name", "handle": "@handle", "reason": "1-sentence reason why the user will like it"}]}`;
            const userMessage = `I like these channels: [${subscribedNames}]. Suggest 5 other high-quality YouTube channels.`;
            
            const resp = await fetch("/vllm/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: activeLlmModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userMessage }
                    ],
                    temperature: 0.2,
                    max_tokens: 1000
                })
            });
            
            if (resp.ok) {
                const data = await resp.json();
                const content = data.choices?.[0]?.message?.content;
                const parsed = parseLlmJsonResponse(content);
                if (parsed && Array.isArray(parsed.channels)) {
                    parsed.channels.forEach(ch => {
                        if (ch.name) {
                            addRecommendation({
                                name: ch.name,
                                handle: ch.handle ? (ch.handle.startsWith("@") ? ch.handle : "@" + ch.handle) : "",
                                id: ch.id || "",
                                reason: ch.reason || "Suggested based on your subscription style.",
                                source: "vllm",
                                sourceLabel: "AI Suggestion"
                            });
                        }
                    });
                }
            }
        } catch (e) {
            console.error("vLLM channel recommendation failed:", e);
        }
    })();
    promises.push(vllmPromise);
    
    // 2. Featured channels scraper
    const featuredPromise = (async () => {
        if (state.channels.length === 0) return;
        try {
            const shuffled = [...state.channels].sort(() => 0.5 - Math.random());
            const selected = shuffled.slice(0, 3);
            
            for (const ch of selected) {
                if (!ch.id || ch.id.startsWith("reddit:")) continue;
                const results = await scrapeFeaturedChannels(ch.id);
                results.forEach(rec => {
                    if (rec.name) {
                        addRecommendation({
                            id: rec.id,
                            name: rec.name,
                            handle: rec.handle,
                            reason: `Featured on ${ch.name}`,
                            source: "featured",
                            sourceLabel: `Featured by ${ch.name}`
                        });
                    }
                });
            }
        } catch (e) {
            console.error("Featured channels scraper failed:", e);
        }
    })();
    promises.push(featuredPromise);
    
    // 3. Topic searches
    const topicPromise = (async () => {
        try {
            const topTopics = state.topics
                .filter(t => t.weight > 0)
                .sort((a, b) => b.weight - a.weight)
                .slice(0, 3)
                .map(t => t.phrase);
                
            if (topTopics.length === 0) {
                topTopics.push("programming", "science");
            }
            
            for (const topic of topTopics) {
                const results = await searchTopicsForChannels(topic);
                results.forEach(rec => {
                    if (rec.name) {
                        addRecommendation({
                            id: rec.id,
                            name: rec.name,
                            handle: rec.handle,
                            reason: `Top matching creator for "${topic}"`,
                            source: "topic",
                            sourceLabel: `Topic: ${capitalizePhrase(topic)}`
                        });
                    }
                });
            }
        } catch (e) {
            console.error("Topic search discovery failed:", e);
        }
    })();
    promises.push(topicPromise);
    
    await Promise.allSettled(promises);
    
    state.discoveredChannels = allRecommendations;
    saveDiscovered();
    
    state.discoverChannelsLoading = false;
    
    if (loadingState) loadingState.classList.add("hidden");
    if (grid) grid.classList.remove("hidden");
    if (btnRefresh) btnRefresh.classList.remove("spinning");
    
    renderDiscoverChannelsView();
}

function renderDiscoverChannelsView() {
    const grid = document.getElementById("discover-channels-grid");
    if (!grid) return;
    grid.innerHTML = "";
    
    if (!state.discoveredChannels || state.discoveredChannels.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1; min-height: 200px;">
                <div class="empty-icon">💡</div>
                <h3>No recommendations yet</h3>
                <p>Click "Refresh Suggestions" to run the dynamic discovery pipeline.</p>
            </div>
        `;
        return;
    }
    
    const sorted = [...state.discoveredChannels].sort((a, b) => {
        const order = { vllm: 0, featured: 1, topic: 2 };
        return (order[a.source] || 3) - (order[b.source] || 3);
    });
    
    sorted.forEach(rec => {
        const card = document.createElement("div");
        card.className = "discover-channel-card fade-in";
        
        let badgeClass = "vllm";
        if (rec.source === "featured") badgeClass = "featured";
        if (rec.source === "topic") badgeClass = "topic";
        
        card.innerHTML = `
            <div class="discover-channel-info">
                <span class="discover-source-badge ${badgeClass}">${escapeHTML(rec.sourceLabel)}</span>
                <h3>${escapeHTML(rec.name)}</h3>
                ${rec.handle ? `<div class="discover-channel-handle">${escapeHTML(rec.handle)}</div>` : ''}
                <div class="discover-channel-reason">${escapeHTML(rec.reason)}</div>
            </div>
            <div class="discover-channel-actions">
                <button class="btn btn-secondary btn-sm btn-inspect-rec">🔍 Inspect Feed</button>
                <button class="btn btn-primary btn-sm btn-sub-rec" style="background:var(--accent);color:var(--bg-primary);border-color:var(--accent);">➕ Subscribe</button>
            </div>
        `;
        
        card.querySelector(".btn-inspect-rec").addEventListener("click", () => {
            if (rec.id) {
                navigateToChannel(rec.id, rec.name);
            } else if (rec.handle) {
                resolveAndInspectChannelByName(rec.handle);
            } else {
                resolveAndInspectChannelByName(rec.name);
            }
        });
        
        card.querySelector(".btn-sub-rec").addEventListener("click", async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = "Subscribing...";
            
            try {
                let channelId = rec.id;
                if (!channelId) {
                    const nameToResolve = rec.handle || rec.name;
                    if (nameToResolve.startsWith("@")) {
                        const cleanHandle = nameToResolve.substring(1);
                        const resp = await fetch(`/youtube/@${cleanHandle}`);
                        if (resp.ok) {
                            const text = await resp.text();
                            const match = text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/);
                            if (match && match[1]) {
                                channelId = match[1];
                            }
                        }
                    }
                    if (!channelId) {
                        const searchResults = await searchChannelsOnYouTube(rec.name);
                        if (searchResults && searchResults.length > 0) {
                            channelId = searchResults[0].id;
                        }
                    }
                }
                
                if (channelId) {
                    if (!state.channels.some(ch => ch.id === channelId)) {
                        state.channels.push({ name: rec.name, id: channelId });
                        saveChannels();
                        updateSubCount();
                        showToast(`✅ Subscribed to ${rec.name}`, "success");
                        btn.textContent = "Subscribed";
                        btn.style.background = "transparent";
                        btn.style.color = "var(--text-muted)";
                        btn.style.borderColor = "var(--card-border)";
                        
                        state.discoveredChannels = state.discoveredChannels.filter(c => c.id !== rec.id && c.name !== rec.name);
                        saveDiscovered();
                        
                        syncFeeds();
                    } else {
                        showToast("Already subscribed!", "info");
                        btn.textContent = "Subscribed";
                    }
                } else {
                    throw new Error("Could not resolve channel ID");
                }
            } catch (err) {
                showToast("Failed to subscribe: " + err.message, "danger");
                btn.disabled = false;
                btn.textContent = "➕ Subscribe";
            }
        });
        
        grid.appendChild(card);
    });
}


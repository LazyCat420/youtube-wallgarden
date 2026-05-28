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

function initSmartFeed() {
    state.smartFeedVideos = [];
    state.smartFeedUsedTopics = [];
    state.smartFeedLoading = false;
    state.smartFeedSubscriptionIndex = 0;
    state.smartFeedInitialized = true;
    state.smartFeedPreloadedVideos = [];
    state.smartFeedPreloadLoading = false;
    
    // Get positive topics (weight > 0) sorted by weight descending
    const positiveTopics = state.topics
        .filter(t => t.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .map(t => t.phrase.toLowerCase());
    
    state.smartFeedTopicsQueue = [...positiveTopics];
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
    
    // Render cached feed immediately so the UI is active and loads discovery videos
    renderFeed();
    
    // Auto-sync in the background if cache is empty or older than 1 hour (3600 seconds)
    const cacheAge = (Date.now() - state.cache.lastSync) / 1000;
    if (cacheAge > 3600 || getCachedVideosCount() === 0) {
        syncFeeds(true); // silent background sync
    } else {
        updateStatusText(`Loaded from cache (${Math.round(cacheAge/60)}m ago)`);
    }

    // Pre-fetch brainstorm topics in background on load if queue is low
    if (state.smartFeedTopicsQueue.length < 5 && !state.brainstormLoading) {
        setTimeout(() => {
            console.log("[Smart Feed] Pre-fetching brainstorm topics in background...");
            generateBrainstormTopics(true); // Appends new topics
        }, 1000);
    }
});

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

    state.channels = rawChannels ? JSON.parse(rawChannels) : [...DEFAULT_CHANNELS];
    state.topics = rawTopics ? JSON.parse(rawTopics) : [...DEFAULT_TOPICS];
    state.blockedChannels = rawBlocked ? JSON.parse(rawBlocked) : [];
    state.settings = rawSettings ? JSON.parse(rawSettings) : { useYtdlp: true, muteShorts: false };
    state.searchHistory = rawSearchHistory ? JSON.parse(rawSearchHistory) : [];
    state.brainstormTopics = rawBrainstorm ? JSON.parse(rawBrainstorm) : [];
    state.videoRatings = rawVideoRatings ? JSON.parse(rawVideoRatings) : {};
    
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
        document.getElementById("search-results-container").classList.add("hidden");
        settingsModal.classList.remove("hidden");
    });
    btnCloseSettings.addEventListener("click", () => {
        settingsModal.classList.add("hidden");
        document.getElementById("search-results-container").classList.add("hidden");
        initSmartFeed(); // Reinitialize topic queue with updated weights
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

    // Close Player Modal
    document.getElementById("btn-close-player").addEventListener("click", closePlayer);
    document.getElementById("player-modal").addEventListener("click", (e) => {
        if (e.target === document.getElementById("player-modal")) {
            closePlayer();
        }
    });

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
}

function renderSidebarTopics() {
    // Consolidated into Smart Feed - no sidebar topic tabs anymore
}

// Add/Resolve YouTube Channel via Nginx proxy / scraping
async function resolveAndAddChannel(query) {
    let channelId = "";
    let channelName = "";

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

            // Try RSS first if use-ytdlp setting is not active
            if (!state.settings.useYtdlp) {
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
            if (!success) {
                try {
                    console.log(`Syncing channel ${channel.name} (${channel.id}) via scraper-service...`);
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 12000);
                    const response = await fetch("/scraper/collect", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            source: "youtube",
                            channels: [channel.id],
                            limit: 10,
                            days_back: 30,
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
function getScoreAndMatches(video) {
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
    
    // Explicit user rating override
    if (state.videoRatings && state.videoRatings[video.id] !== undefined) {
        score = state.videoRatings[video.id];
    }
    
    return { score, matches };
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
        ch.name.toLowerCase() === video.channelName.toLowerCase() || ch.id === video.channelId
    );
    
    card.innerHTML = `
        <div class="thumbnail-area">
            <img class="thumbnail-img" src="https://i.ytimg.com/vi/${video.id}/hqdefault.jpg" alt="${escapeHTML(video.title)}">
            <div class="thumbnail-play-overlay">
                <div class="play-icon-circle">▶</div>
            </div>
            <div class="score-badge ${scoreClass}">★ ${video.score}</div>
            ${video.isDiscover && video.discoveryTopic ? `<div class="category-badge" style="background:var(--accent);color:var(--bg)">✨ ${capitalizePhrase(video.discoveryTopic)}</div>` : (video.isDiscover ? `<div class="search-badge">🔍 Search</div>` : (categoryText ? `<div class="category-badge">${categoryText}</div>` : ""))}
            <button class="card-action-btn" title="Actions">⋮</button>
        </div>
        <div class="card-details">
            <h3 class="video-title">${escapeHTML(video.title)}</h3>
            <p class="video-channel">${escapeHTML(metaLine)}</p>
            <p class="video-time">${relativeTime}${video.duration ? ` • ${formatDuration(video.duration)}` : ""}</p>
        </div>
    `;
    
    const openAction = () => playVideo(video);
    card.querySelector(".thumbnail-play-overlay").addEventListener("click", openAction);
    card.querySelector(".video-title").addEventListener("click", openAction);
    
    // 3-dot action menu
    const actionBtn = card.querySelector(".card-action-btn");
    actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Close any existing dropdown
        document.querySelectorAll(".card-action-dropdown").forEach(d => d.remove());
        
        const dropdown = document.createElement("div");
        dropdown.className = "card-action-dropdown";
        dropdown.innerHTML = `
            <div style="display: flex; gap: 0.5rem; justify-content: space-around; padding: 0.5rem; border-bottom: 1px solid var(--card-border); margin-bottom: 0.25rem;">
                <button class="rate-btn" data-rating="5" title="Love it" style="padding: 0.25rem 0.5rem; border-radius: 4px; background: rgba(46, 204, 113, 0.2); color: #2ecc71;">⭐ 5</button>
                <button class="rate-btn" data-rating="3" title="Okay" style="padding: 0.25rem 0.5rem; border-radius: 4px; background: rgba(241, 196, 15, 0.2); color: #f1c40f;">⭐ 3</button>
                <button class="rate-btn" data-rating="0" title="Neutral" style="padding: 0.25rem 0.5rem; border-radius: 4px; background: rgba(149, 165, 166, 0.2); color: #95a5a6;">⭐ 0</button>
                <button class="rate-btn danger" data-rating="-5" title="Dislike" style="padding: 0.25rem 0.5rem; border-radius: 4px; background: rgba(231, 76, 60, 0.2); color: #e74c3c;">👎 -5</button>
            </div>
            <button class="danger" data-action="block">🚫 Block Channel</button>
            <button data-action="subscribe" ${isSubscribed ? 'disabled' : ''}>➕ ${isSubscribed ? 'Already Subscribed' : 'Subscribe to Channel'}</button>
            <button data-action="hide">🔇 Hide Video</button>
        `;
        
        dropdown.querySelectorAll(".rate-btn").forEach(btn => {
            btn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const rating = parseInt(ev.target.dataset.rating, 10);
                state.videoRatings[video.id] = rating;
                saveVideoRatings();
                
                // Update badge visually
                const badge = card.querySelector(".score-badge");
                if (badge) {
                    badge.textContent = `★ ${rating}`;
                    badge.className = "score-badge " + (rating >= 5 ? "high" : rating < 0 ? "low" : "mid");
                }
                dropdown.remove();
                showToast(`⭐ Rated ${rating} stars`, rating > 0 ? "success" : "info");
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
            if (isSubscribed) return;
            const channelName = video.channelName;
            const channelId = video.channelId || "";
            state.channels.push({ name: channelName, id: channelId });
            saveChannels();
            dropdown.remove();
            showToast(`✅ Subscribed to ${channelName}`, "success");
            renderChannelsList();
        });
        
        dropdown.querySelector('[data-action="hide"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            dropdown.remove();
            card.classList.add("fade-out-remove");
            setTimeout(() => card.remove(), 350);
            showToast(`🔇 Video hidden`, "info");
        });
        
        card.querySelector(".thumbnail-area").appendChild(dropdown);
        
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
    const emptyState = document.getElementById("empty-state");
    const brainstormContainer = document.getElementById("ai-brainstorm-container");
    
    if (grid) grid.classList.remove("hidden");
    if (brainstormContainer) brainstormContainer.classList.add("hidden");
    
    grid.innerHTML = "";
    shortsGrid.innerHTML = "";
    shortsShelf.classList.add("hidden");
    
    // Handle Smart Feed
    if (state.currentView === "smart-feed") {
        let subVideos = [];
        Object.values(state.cache.videos).forEach(channelVideos => {
            channelVideos.forEach(v => {
                const evaluation = getScoreAndMatches(v);
                subVideos.push({
                    ...v,
                    score: evaluation.score,
                    matchedTopics: evaluation.matches,
                    isDiscover: false
                });
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
        
        if (initialSubVideos.length > 0) {
            const subHeader = document.createElement("div");
            subHeader.className = "discover-section-header";
            subHeader.style.gridColumn = "1 / -1";
            subHeader.style.marginBottom = "1rem";
            subHeader.innerHTML = `
                <h2 class="discover-section-title" style="font-size: 1.15rem; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
                    <span>🌿 Subscribed Feeds</span>
                </h2>
                <span class="discover-badge" style="font-size: 0.7rem; opacity: 0.6;">Your Subscriptions</span>
            `;
            grid.appendChild(subHeader);
            
            const feedFragment = document.createDocumentFragment();
            initialSubVideos.forEach(video => renderCard(video, feedFragment));
            grid.appendChild(feedFragment);
        }
        
        if (state.smartFeedVideos.length > 0) {
            const fragment = document.createDocumentFragment();
            state.smartFeedVideos.forEach(video => {
                renderCard(video, fragment);
            });
            grid.appendChild(fragment);
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

// Display Video in Distraction-Free IFrame Modal
function playVideo(video) {
    const playerModal = document.getElementById("player-modal");
    const playerWrapper = document.getElementById("player-wrapper");
    
    document.getElementById("player-video-title").textContent = video.title;
    document.getElementById("player-video-channel").textContent = video.channelName;
    
    playerWrapper.innerHTML = `
        <iframe 
            src="https://www.youtube.com/embed/${video.id}?autoplay=1&rel=0&modestbranding=1" 
            title="${escapeHTML(video.title)}" 
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
            allowfullscreen>
        </iframe>
    `;
    
    playerModal.classList.remove("hidden");
}

function closePlayer() {
    document.getElementById("player-modal").classList.add("hidden");
    document.getElementById("player-wrapper").innerHTML = ""; // Stops playback instantly
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

function renderTopicsList() {
    const list = document.getElementById("topics-list");
    list.innerHTML = "";
    
    // Sort topics by weight descending
    const sortedTopics = [...state.topics].sort((a, b) => b.weight - a.weight);
    
    sortedTopics.forEach(topic => {
        const row = document.createElement("div");
        row.className = "topic-row";
        
        const badgeClass = topic.weight >= 0 ? "positive" : "negative";
        const sign = topic.weight >= 0 ? "+" : "";
        
        row.innerHTML = `
            <span class="topic-phrase">${escapeHTML(topic.phrase)}</span>
            <div class="topic-controls">
                <span class="topic-badge-weight ${badgeClass}">${sign}${topic.weight}</span>
                <button class="btn-remove" data-phrase="${escapeHTML(topic.phrase)}">✕</button>
            </div>
        `;
        
        row.querySelector(".btn-remove").addEventListener("click", (e) => {
            const phrase = e.target.dataset.phrase;
            state.topics = state.topics.filter(t => t.phrase !== phrase);
            saveTopics();
            renderTopicsList();
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
function setupInfiniteScroll() {
    const feedSection = document.querySelector(".feed-section");
    if (!feedSection) return;
    
    feedSection.addEventListener("scroll", () => {
        // Handle Smart Feed scroll discovery
        if (state.currentView === "smart-feed") {
            const scrollBottom = feedSection.scrollHeight - feedSection.scrollTop - feedSection.clientHeight;
            if (scrollBottom <= 300) {
                loadNextSmartFeedBatch();
            }
            return;
        }

        // Only activate for topic/search views
        const isTopicView = state.currentView.startsWith("topic_");
        const isSearchView = state.currentView.startsWith("search_");
        if (!isTopicView && !isSearchView) return;
        
        const queryTerm = isTopicView 
            ? state.currentView.substring(6).toLowerCase() 
            : state.currentView.substring(7).toLowerCase();
        
        // Don't fetch if already loading, max reached, or not near bottom
        if (topicSearchLoading[queryTerm]) return;
        if (state.discoverMaxReached) return;
        
        const scrollBottom = feedSection.scrollHeight - feedSection.scrollTop - feedSection.clientHeight;
        if (scrollBottom > 300) return;
        
        // Don't fetch more if no initial results yet
        const cachedCount = sessionTopicSearchCache[queryTerm] ? sessionTopicSearchCache[queryTerm].length : 0;
        if (cachedCount === 0) return;
        
        // Check if we already hit the cap
        if (cachedCount >= DISCOVER_MAX_RESULTS) {
            state.discoverMaxReached = true;
            // Append end-of-results message without re-rendering
            const grid = document.getElementById("video-grid");
            if (!grid.querySelector(".end-of-results")) {
                const endMsg = document.createElement("div");
                endMsg.className = "end-of-results";
                endMsg.textContent = `Showing top ${DISCOVER_MAX_RESULTS} results. Refine your search for more.`;
                grid.appendChild(endMsg);
            }
            return;
        }
        
        // Add a loading spinner at the bottom of the grid
        const grid = document.getElementById("video-grid");
        if (!grid.querySelector(".infinite-scroll-loader")) {
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
    });
}

// Initialize infinite scroll on load
document.addEventListener("DOMContentLoaded", setupInfiniteScroll);
// AI Topic Brainstorming Features
let activeLlmModel = "default-model";

const systemPrompt = `You are a creative topic brainstorming assistant for a YouTube feed curation dashboard. 
Your goal is to brainstorm a list of 5 interesting, specific topic keywords or short phrases that the user might want to explore.

To help the user discover new content and prevent feedback bubble overfitting, you MUST mix topics according to these rules:
1. **Subcategories (2 topics)**: Take some of the user's liked topics and suggest more specific, niche subcategories (e.g. if they like "coding", recommend "systems programming" or "AST parsing").
2. **Contrasting Alternatives (1-2 topics)**: Find areas that are the opposite or highly contrasting alternatives to the user's disliked topics. For example, if they dislike clickbait/gossip, suggest calm, academic, or high-educational topics.
3. **Surprise Explorations (1-2 topics)**: Generate subjects that are completely uncorrelated to any topics on their liked or disliked lists to surprise them and break the bubble.

Guidelines:
- Keep your reasoning/thinking process extremely brief and concise (under 2-3 sentences if possible).
- Generate exactly 5 diverse topics.
- Keep them short (1-3 words maximum, e.g. "Docker Containers", "Quantum Computing").
- Explain the reason for recommending each topic in a brief sentence, referencing the category mix rules (e.g., "Niche expansion based on coding", "Contrasting alternative to gossip", "Surprise exploration of new domains").
- Do NOT suggest any topics that are on the user's disliked list.
- Do NOT suggest any topics that are already in the list of currently displayed brainstormed topics.

You MUST respond ONLY with a valid JSON array of objects. No markdown, no HTML, no explanation outside the JSON. Keep any internal reasoning or thinking process extremely brief (under 50 words).
Each object must have the following keys:
- "phrase": The topic phrase (e.g. "Docker Containerization")
- "reason": A short explanation of why this topic was suggested.

Example response:
[
  {"phrase": "Docker Containers", "reason": "Niche expansion based on coding"},
  {"phrase": "Quantum Physics", "reason": "Surprise exploration of new domains"}
]`;

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

async function generateBrainstormTopics(append) {
    append = append || false;
    if (state.brainstormLoading) return;
    state.brainstormLoading = true;
    state.lastBrainstormAttempt = Date.now();
    
    console.log("[Smart Feed] Background LLM brainstorming started...");
    
    // Construct user profile message
    const liked = state.topics.filter(t => t.weight > 0).map(t => `${t.phrase} (weight: +${t.weight})`).join(", ");
    const disliked = state.topics.filter(t => t.weight < 0).map(t => `${t.phrase} (weight: ${t.weight})`).join(", ");
    const searches = state.searchHistory.join(", ");
    const currentQueue = state.smartFeedTopicsQueue.join(", ");
    const usedTopics = state.smartFeedUsedTopics.join(", ");
    
    const userMessage = `User Profile:
- Liked Topics: [${liked}]
- Disliked Topics: [${disliked}]
- Recent Searches: [${searches}]
- Currently Queued Topics (Avoid duplicates): [${currentQueue}]
- Already Used Topics (Avoid duplicates): [${usedTopics}]

Please brainstorm 5 new topics that fit this profile. Return ONLY JSON.`;

    try {
        if (activeLlmModel === "default-model") {
            await fetchLlmModel();
        }
        
        // Target proxied vllm route
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minutes for slower LLMs
        const response = await fetch("/vllm/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: activeLlmModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userMessage }
                ],
                temperature: 0.7,
                max_tokens: 3000
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`vLLM server returned status ${response.status}`);
        
        const data = await response.json();
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error("No message returned from vLLM server.");
        
        let content = message.content;
        if (content === null || content === undefined || content.trim() === "") {
            if (message.reasoning) {
                const jsonMatch = message.reasoning.match(/\[\s*\{[\s\S]*\}\s*\]/);
                if (jsonMatch) {
                    content = jsonMatch[0];
                }
            }
        }
        
        if (!content) {
            throw new Error("vLLM server returned empty content. Try again.");
        }
        
        content = content.trim();
        
        let cleanContent = content;
        if (cleanContent.startsWith("```json")) {
            cleanContent = cleanContent.substring(7);
        } else if (cleanContent.startsWith("```")) {
            cleanContent = cleanContent.substring(3);
        }
        if (cleanContent.endsWith("```")) {
            cleanContent = cleanContent.substring(0, cleanContent.length - 3);
        }
        cleanContent = cleanContent.trim();
        
        // Extract JSON array from the response content to avoid parsing extra reasoning text
        const jsonMatch = cleanContent.match(/\[\s*\{[\s\S]*\}\s*\]/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanContent);
        if (Array.isArray(parsed)) {
            const addedPhrases = [];
            parsed.forEach(item => {
                const phrase = item.phrase.trim().toLowerCase();
                if (!phrase) return;
                
                // Add to state.topics with default positive weight if not present
                const existsInTopics = state.topics.some(t => t.phrase.toLowerCase() === phrase);
                if (!existsInTopics) {
                    state.topics.push({ phrase, weight: 5 });
                }
                
                // Push to smartFeedTopicsQueue if not already in queue or used
                const inQueue = state.smartFeedTopicsQueue.includes(phrase);
                const inUsed = state.smartFeedUsedTopics.includes(phrase);
                if (!inQueue && !inUsed) {
                    state.smartFeedTopicsQueue.push(phrase);
                    addedPhrases.push(phrase);
                }
            });
            
            saveTopics();
            console.log("[Smart Feed] Successfully brainstormed and queued new topics:", addedPhrases);
            if (addedPhrases.length > 0 && !append) {
                showToast(`💡 Queued topics: ${addedPhrases.join(", ")}`, "success");
            }
        } else {
            throw new Error("Invalid response format: expected a JSON array.");
        }
    } catch (err) {
        console.error("Brainstorm error:", err);
        if (!append) {
            showToast("❌ Failed to brainstorm topics: " + err.message, "danger");
        }
    } finally {
        state.brainstormLoading = false;
        state.lastBrainstormTime = Date.now();
        updateStatusText("Ready");
    }
}

async function generateSimilarTopicsFromSearch(searchQuery) {
    if (!searchQuery) return;
    console.log(`[Smart Feed] Background similar topics generation started for query: "${searchQuery}"`);
    
    const disliked = state.topics.filter(t => t.weight < 0).map(t => `${t.phrase} (weight: ${t.weight})`).join(", ");
    const currentQueue = state.smartFeedTopicsQueue.join(", ");
    const usedTopics = state.smartFeedUsedTopics.join(", ");
    
    const systemPromptSimilar = `You are a creative topic brainstorming assistant for a YouTube feed curation dashboard. 
Your goal is to brainstorm a list of 10 to 20 interesting, specific topic keywords or short phrases that are closely related, similar, or logical next steps/expansions to the search query topic provided by the user.

Guidelines:
- Generate between 10 and 20 diverse, highly relevant topics.
- Keep them short (1-3 words maximum, e.g. "Quantum Computing", "Deep Learning").
- Explain the reason for recommending each topic in a brief sentence.
- Do NOT suggest any topics that are on the user's disliked list.
- Do NOT suggest any topics that are already in the list of currently displayed brainstormed topics.

You MUST respond ONLY with a valid JSON array of objects. No markdown, no HTML, no explanation outside the JSON. Keep any internal reasoning or thinking process extremely brief (under 50 words).
Each object must have the following keys:
- "phrase": The topic phrase (e.g. "Docker Containerization")
- "reason": A short explanation of why this topic is similar or related to the search query.

Example response:
[
  {"phrase": "Docker Containers", "reason": "Related topic on virtualization"},
  {"phrase": "Kubernetes Orchestration", "reason": "Next step after containerization"}
]`;

    const userMessage = `The user just searched for the topic: "${searchQuery}".
User Profile:
- Disliked Topics: [${disliked}]
- Currently Queued Topics (Avoid duplicates): [${currentQueue}]
- Already Used Topics (Avoid duplicates): [${usedTopics}]

Please brainstorm 10-20 new topics that are similar, related, or logical next steps/expansions to the searched topic "${searchQuery}" and fit the user's profile. Return ONLY JSON.`;

    try {
        if (activeLlmModel === "default-model") {
            await fetchLlmModel();
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000);
        const response = await fetch("/vllm/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: activeLlmModel,
                messages: [
                    { role: "system", content: systemPromptSimilar },
                    { role: "user", content: userMessage }
                ],
                temperature: 0.7,
                max_tokens: 3000
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`vLLM server returned status ${response.status}`);
        
        const data = await response.json();
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error("No message returned from vLLM server.");
        
        let content = message.content;
        if (content === null || content === undefined || content.trim() === "") {
            if (message.reasoning) {
                const jsonMatch = message.reasoning.match(/\[\s*\{[\s\S]*\}\s*\]/);
                if (jsonMatch) {
                    content = jsonMatch[0];
                }
            }
        }
        
        if (!content) {
            throw new Error("vLLM server returned empty content. Try again.");
        }
        
        content = content.trim();
        
        let cleanContent = content;
        if (cleanContent.startsWith("```json")) {
            cleanContent = cleanContent.substring(7);
        } else if (cleanContent.startsWith("```")) {
            cleanContent = cleanContent.substring(3);
        }
        if (cleanContent.endsWith("```")) {
            cleanContent = cleanContent.substring(0, cleanContent.length - 3);
        }
        cleanContent = cleanContent.trim();
        
        const jsonMatch = cleanContent.match(/\[\s*\{[\s\S]*\}\s*\]/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanContent);
        if (Array.isArray(parsed)) {
            const addedPhrases = [];
            parsed.forEach(item => {
                const phrase = item.phrase.trim().toLowerCase();
                if (!phrase) return;
                
                // Add to state.topics with default positive weight if not present
                const existsInTopics = state.topics.some(t => t.phrase.toLowerCase() === phrase);
                if (!existsInTopics) {
                    state.topics.push({ phrase, weight: 5 });
                }
                
                // Push to smartFeedTopicsQueue if not already in queue or used
                const inQueue = state.smartFeedTopicsQueue.includes(phrase);
                const inUsed = state.smartFeedUsedTopics.includes(phrase);
                if (!inQueue && !inUsed) {
                    state.smartFeedTopicsQueue.push(phrase);
                    addedPhrases.push(phrase);
                }
            });
            
            saveTopics();
            console.log(`[Smart Feed] Successfully brainstormed and queued ${addedPhrases.length} similar topics for "${searchQuery}":`, addedPhrases);
            if (addedPhrases.length > 0) {
                showToast(`💡 Queued ${addedPhrases.length} topics similar to "${searchQuery}"`, "success");
                
                // Trigger filling preload buffer with newly queued topics
                fillSmartFeedPreloadBuffer();
            }
        } else {
            throw new Error("Invalid response format: expected a JSON array.");
        }
    } catch (err) {
        console.error("Similar search topics brainstorm error:", err);
    }
}

async function fetchVideosForTopic(topic) {
    let videos = [];
    let success = false;
    const fetchCount = 10;
    
    if (state.settings.useYtdlp) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            const resp = await fetch("/scraper/collect", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    source: "youtube",
                    query: topic,
                    limit: fetchCount,
                    days_back: 0,
                    require_transcript: false
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (resp.ok) {
                const data = await resp.json();
                if (data && Array.isArray(data.items)) {
                    data.items.forEach(item => {
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
                    });
                    success = true;
                }
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
                                    if (videos.length >= fetchCount) break;
                                }
                            }
                        }
                        if (videos.length >= fetchCount) break;
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

async function fillSmartFeedPreloadBuffer() {
    if (state.smartFeedPreloadLoading) return;
    
    // We keep a larger buffer (e.g. 50) so we can randomly mix topics in loadNextSmartFeedBatch
    const targetPreloadCount = 50;
    if (state.smartFeedPreloadedVideos.length >= targetPreloadCount) {
        return; // Preload buffer is full
    }
    
    // Check if we need to brainstorm more topics using LLM
    const totalUpcoming = state.smartFeedTopicsQueue.length;
    const now = Date.now();
    const cooldownMs = 60000; // 60-second cooldown
    const isCooldownActive = state.lastBrainstormTime && (now - state.lastBrainstormTime < cooldownMs);

    if (totalUpcoming < 5 && !state.brainstormLoading && !isCooldownActive) {
        console.log("[Smart Feed] Total upcoming topics low, triggering background LLM brainstorm...");
        generateBrainstormTopics(true).then(() => {
            fillSmartFeedPreloadBuffer();
        });
    }
    
    if (state.smartFeedTopicsQueue.length === 0) {
        console.log("[Smart Feed] Queue is empty! Repopulating from positive topics...");
        const positiveTopics = state.topics
            .filter(t => t.weight > 0)
            .map(t => t.phrase.toLowerCase());
        state.smartFeedTopicsQueue = [...positiveTopics];
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
            state.smartFeedPreloadedVideos.push(...videos);
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
        setTimeout(() => {
            fillSmartFeedPreloadBuffer();
        }, 1500);
    }
}

async function loadNextSmartFeedBatch() {
    if (state.smartFeedLoading) return;
    state.smartFeedLoading = true;
    
    const grid = document.getElementById("video-grid");
    if (!grid) {
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
            grid.appendChild(fragment);
        }
        
        state.smartFeedLoading = false;
        updateStatusText("Ready");
        
        // Trigger preloader to fill the gap
        fillSmartFeedPreloadBuffer();
        return;
    }
    
    // Fallback if buffer is empty
    let loader = grid.querySelector(".smart-feed-loader");
    if (!loader) {
        loader = document.createElement("div");
        loader.className = "smart-feed-loader infinite-scroll-loader";
        loader.innerHTML = `<div class="loader-spinner"></div><p style="margin: 0.5rem 0 0 0;">Discovering videos via AI topics...</p>`;
        loader.style.gridColumn = "1 / -1";
        loader.style.textAlign = "center";
        loader.style.padding = "2rem";
        grid.appendChild(loader);
    }
    
    if (state.smartFeedTopicsQueue.length === 0) {
        console.log("[Smart Feed] Queue is empty! Generating more topics first...");
        const positiveTopics = state.topics
            .filter(t => t.weight > 0)
            .map(t => t.phrase.toLowerCase());
        
        state.smartFeedTopicsQueue = [...positiveTopics];
        if (state.smartFeedTopicsQueue.length === 0) {
            state.smartFeedTopicsQueue = ["coding", "programming", "ai", "science", "physics"];
        }
        
        generateBrainstormTopics(true);
    }
    
    const topic = state.smartFeedTopicsQueue.shift();
    if (!topic) {
        const updatedLoader = grid.querySelector(".smart-feed-loader");
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
            grid.appendChild(fragment);
        }
    } catch (err) {
        console.error(`[Smart Feed] Fallback fetch failed for "${topic}":`, err);
    } finally {
        const updatedLoader = grid.querySelector(".smart-feed-loader");
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


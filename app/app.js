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
    currentView: "all", // 'all', 'starred', or topic phrase
    settings: {
        useYtdlp: false,
        muteShorts: false
    }
};

// In-memory session cache for topic search discovery results
let sessionTopicSearchCache = {};
let topicSearchLoading = {};

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
    loadState();
    setupEventListeners();
    renderSidebarTopics();
    
    // Auto-sync if cache is empty or older than 1 hour (3600 seconds)
    const cacheAge = (Date.now() - state.cache.lastSync) / 1000;
    if (cacheAge > 3600 || getCachedVideosCount() === 0) {
        syncFeeds();
    } else {
        renderFeed();
        updateStatusText(`Loaded from cache (${Math.round(cacheAge/60)}m ago)`);
    }
});

// Load variables from Local Storage
function loadState() {
    const rawChannels = localStorage.getItem("wallgarden_channels");
    const rawTopics = localStorage.getItem("wallgarden_topics");
    const rawBlocked = localStorage.getItem("wallgarden_blocked_channels");
    const rawCache = localStorage.getItem("wallgarden_cache");
    const rawSettings = localStorage.getItem("wallgarden_settings");

    state.channels = rawChannels ? JSON.parse(rawChannels) : [...DEFAULT_CHANNELS];
    state.topics = rawTopics ? JSON.parse(rawTopics) : [...DEFAULT_TOPICS];
    state.blockedChannels = rawBlocked ? JSON.parse(rawBlocked) : [];
    state.settings = rawSettings ? JSON.parse(rawSettings) : { useYtdlp: false, muteShorts: false };
    
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
            
            state.currentView = btn.dataset.view;
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
        renderSidebarTopics();
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
}

// Dynamic Sidebar topics rendering
function renderSidebarTopics() {
    const container = document.getElementById("dynamic-topic-tabs");
    container.innerHTML = "";
    
    // Sort positive topics by weight descending
    const positiveTopics = state.topics
        .filter(t => t.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8); // show top 8 in sidebar
        
    positiveTopics.forEach(topic => {
        const btn = document.createElement("button");
        btn.className = "nav-item";
        btn.dataset.view = "topic_" + topic.phrase;
        
        // Pick a default emoji for topic styling
        let emoji = "🏷️";
        if (["code", "coding", "program", "programming", "dev", "rust", "javascript"].some(k => topic.phrase.includes(k))) emoji = "💻";
        if (["ai", "intelligence", "llm", "gpt", "model"].some(k => topic.phrase.includes(k))) emoji = "🧠";
        if (["math", "science", "physics", "quantum"].some(k => topic.phrase.includes(k))) emoji = "🔬";

        btn.innerHTML = `
            <span class="nav-icon">${emoji}</span>
            <span class="nav-label">${capitalizePhrase(topic.phrase)}</span>
        `;
        
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            state.currentView = "topic_" + topic.phrase;
            document.getElementById("current-view-title").textContent = capitalizePhrase(topic.phrase);
            renderFeed();
        });
        
        container.appendChild(btn);
    });
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

    // Clear session topic search cache on sync to fetch fresh results next time
    sessionTopicSearchCache = {};

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
            try {
                const response = await fetch(`/youtube-feed/?channel_id=${channel.id}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const xmlText = await response.text();
                
                // Parse Atom Feed
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                
                // Update Name from feed metadata if it was UC placeholder
                const feedTitle = xmlDoc.querySelector("feed > title")?.textContent;
                if (feedTitle && channel.name.includes("...")) {
                    channel.name = feedTitle;
                }

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
                            channelName: feedTitle || channel.name,
                            channelId: channel.id,
                            published: new Date(publishedStr).getTime()
                        });
                    }
                });
                
                results[channel.id] = videos;
            } catch (err) {
                console.error(`Error syncing channel ${channel.name}:`, err);
                // Keep existing cache for this channel on failure
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
    
    return { score, matches };
}

// Load and Render Video Grid
function renderFeed() {
    const grid = document.getElementById("video-grid");
    const shortsShelf = document.getElementById("shorts-shelf");
    const shortsGrid = document.getElementById("shorts-grid");
    const emptyState = document.getElementById("empty-state");
    
    grid.innerHTML = "";
    shortsGrid.innerHTML = "";
    shortsShelf.classList.add("hidden");
    
    // Flatten and enrich video list
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
    
    // Filter out videos from blocked channels
    allVideos = allVideos.filter(video => {
        const isBlockedId = state.blockedChannels.some(bc => bc.id && bc.id === video.channelId);
        const isBlockedName = state.blockedChannels.some(bc => !bc.id && video.channelName.toLowerCase().includes(bc.name.toLowerCase()));
        return !isBlockedId && !isBlockedName;
    });

    // Filter out videos with score <= -10 (auto-nuke spam)
    allVideos = allVideos.filter(v => v.score > -10);
    
    let isTopicView = false;
    let activeTopic = "";
    
    // Apply navigation filter
    if (state.currentView === "starred") {
        allVideos = allVideos.filter(v => v.score >= 5);
    } else if (state.currentView.startsWith("topic_")) {
        isTopicView = true;
        activeTopic = state.currentView.substring(6).toLowerCase();
        allVideos = allVideos.filter(v => v.matchedTopics.includes(activeTopic));
    }
    
    // Sort: High score at the top, then sort by publishing date descending
    allVideos.sort((a, b) => {
        if (a.score >= 5 && b.score < 5) return -1;
        if (b.score >= 5 && a.score < 5) return 1;
        return b.published - a.published;
    });
    
    // Topic Discovery Logic
    let discoverVideos = [];
    if (isTopicView) {
        // Trigger background search if not cached yet
        if (sessionTopicSearchCache[activeTopic] === undefined && !topicSearchLoading[activeTopic]) {
            fetchTopicSearchDiscovery(activeTopic);
        }
        
        if (sessionTopicSearchCache[activeTopic]) {
            discoverVideos = sessionTopicSearchCache[activeTopic].map(v => {
                const evaluation = getScoreAndMatches(v);
                return {
                    ...v,
                    score: evaluation.score,
                    matchedTopics: evaluation.matches
                };
            });
            
            // Filter discover videos
            discoverVideos = discoverVideos.filter(video => {
                const isBlockedId = state.blockedChannels.some(bc => bc.id && bc.id === video.channelId);
                const isBlockedName = state.blockedChannels.some(bc => !bc.id && video.channelName.toLowerCase().includes(bc.name.toLowerCase()));
                return !isBlockedId && !isBlockedName;
            });
            discoverVideos = discoverVideos.filter(v => v.score > -10);
            
            // Deduplicate (exclude videos already in subscribed topic feed)
            discoverVideos = discoverVideos.filter(dv => !allVideos.some(sv => sv.id === dv.id));
            
            // Sort discover videos by score descending
            discoverVideos.sort((a, b) => b.score - a.score);
        }
    }
    
    // Separate Shorts from standard videos
    let allShorts = [];
    
    if (state.settings.muteShorts) {
        // If Shorts are muted, completely filter them out
        allVideos = allVideos.filter(v => !isShortVideo(v));
        discoverVideos = discoverVideos.filter(v => !isShortVideo(v));
    } else {
        // Extract Shorts from Subscribed Feed
        const subShorts = allVideos.filter(isShortVideo);
        allVideos = allVideos.filter(v => !isShortVideo(v));
        
        // Extract Shorts from Discover Feed
        const discShorts = discoverVideos.filter(isShortVideo);
        discoverVideos = discoverVideos.filter(v => !isShortVideo(v));
        
        allShorts = [...subShorts, ...discShorts];
    }
    
    // Show spinner if we have no subscribed videos and public search is currently loading
    if (isTopicView && allVideos.length === 0 && topicSearchLoading[activeTopic]) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1; min-height: 200px;">
                <div class="sync-spinner" style="font-size: 2rem; position: static; transform: none; display: block; animation: spin 1s linear infinite; margin: 2rem auto;">🔄</div>
                <h3>Searching YouTube...</h3>
                <p>Fetching public search results for "${capitalizePhrase(activeTopic)}"</p>
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
    
    // Render Helper Function
    const renderCard = (video, targetContainer) => {
        const card = document.createElement("div");
        card.className = "video-card";
        
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
        
        card.innerHTML = `
            <div class="thumbnail-area">
                <img class="thumbnail-img" src="https://i.ytimg.com/vi/${video.id}/hqdefault.jpg" alt="${escapeHTML(video.title)}">
                <div class="thumbnail-play-overlay">
                    <div class="play-icon-circle">▶</div>
                </div>
                <div class="score-badge ${scoreClass}">★ ${video.score}</div>
                ${video.isDiscover ? `<div class="search-badge">🔍 Search</div>` : (categoryText ? `<div class="category-badge">${categoryText}</div>` : "")}
            </div>
            <div class="card-details">
                <h3 class="video-title">${escapeHTML(video.title)}</h3>
                <p class="video-channel">${escapeHTML(metaLine)}</p>
                <p class="video-time">${relativeTime}${video.duration ? ` • ${formatDuration(video.duration)}` : ""}</p>
            </div>
        `;
        
        const openAction = () => playVideo(video);
        card.querySelector(".thumbnail-area").addEventListener("click", openAction);
        card.querySelector(".video-title").addEventListener("click", openAction);
        
        targetContainer.appendChild(card);
    };

    // Render Shorts shelf if there are Shorts
    if (allShorts.length > 0) {
        shortsShelf.classList.remove("hidden");
        allShorts.forEach(short => renderCard(short, shortsGrid));
    }

    // Render Subscribed videos (capped at 120)
    allVideos.slice(0, 120).forEach(video => renderCard(video, grid));
    
    // Render Discover section
    if (isTopicView && discoverVideos.length > 0) {
        const divider = document.createElement("div");
        divider.className = "discover-section-header";
        divider.innerHTML = `
            <h2 class="discover-section-title">🔍 Discover More on "${capitalizePhrase(activeTopic)}"</h2>
            <span class="discover-badge">YouTube Public Search</span>
        `;
        grid.appendChild(divider);
        
        // Render Discover videos (capped at 30)
        discoverVideos.slice(0, 30).forEach(video => renderCard(video, grid));
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
async function fetchTopicSearchDiscovery(topicPhrase) {
    if (topicSearchLoading[topicPhrase]) return;
    topicSearchLoading[topicPhrase] = true;
    
    updateStatusText(`Searching YouTube for "${topicPhrase}"...`);
    
    let videos = [];
    let success = false;
    
    if (state.settings.useYtdlp) {
        try {
            updateStatusText(`Searching via yt-dlp for "${topicPhrase}"...`);
            const resp = await fetch("/scraper/collect", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    source: "youtube",
                    query: topicPhrase,
                    limit: 15,
                    days_back: 30
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && Array.isArray(data.items)) {
                    videos = data.items.map(item => ({
                        id: item.video_id,
                        title: item.title,
                        channelName: item.channel,
                        channelId: "",
                        publishedStr: item.published_at ? getRelativeTime(new Date(item.published_at).getTime()) : "Recently",
                        published: item.published_at ? new Date(item.published_at).getTime() : Date.now(),
                        duration: item.duration_secs,
                        viewCount: item.view_count,
                        isDiscover: true
                    }));
                    success = true;
                }
            } else {
                console.warn(`Scraper-service returned status ${resp.status}. Falling back to HTML scraping.`);
            }
        } catch (err) {
            console.error("Failed fetching discovery search via yt-dlp, falling back to HTML scraper:", err);
        }
    }
    
    // Fallback to raw HTML scraping if yt-dlp is off or failed
    if (!success) {
        try {
            const url = `/youtube/results?search_query=${encodeURIComponent(topicPhrase)}`;
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

    sessionTopicSearchCache[topicPhrase] = videos;
    updateStatusText("Ready");
    topicSearchLoading[topicPhrase] = false;
    renderFeed();
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

// 🌿 Wallgarden - Dashboard Controller

// ── Inline SVG icon system (Lucide-style, stroke = currentColor) ──
const ICONS = {
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    tv: '<rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    sprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
    bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    sparkles: '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>',
    miniplayer: '<rect width="20" height="16" x="2" y="4" rx="2"/><rect width="8" height="6" x="12" y="12" rx="1" fill="currentColor"/>',
    expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="10" y1="14" x2="3" y2="21"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/>',
    pause: '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>',
};

function icon(name, size = 14, extraClass = "") {
    const paths = ICONS[name] || ICONS.x;
    return `<svg class="icon-svg ${extraClass}" style="width:${size}px;height:${size}px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}


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
    { phrase: "gossip", weight: -10 },
    { phrase: "drama", weight: -10 },
    { phrase: "brainrot", weight: -10 }
];

// Google API Key from vault
let GOOGLE_API_KEY = "";

async function fetchGoogleApiKey() {
    try {
        const resp = await fetch("/vault/secrets?keys=GOOGLE_API_KEY");
        if (resp.ok) {
            const data = await resp.json();
            if (data.GOOGLE_API_KEY) {
                GOOGLE_API_KEY = data.GOOGLE_API_KEY;
                debug("[Google API] Key fetched successfully.");
            }
        }
    } catch (err) {
        console.error("[Google API] Failed to fetch API key:", err);
    }
}

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
    playlists: {}, // id -> { name, createdAt, videos: [] }
    queue: [], // list of queued video objects
    currentlyPlayingId: null, // ID of currently playing video to avoid restarts on state updates
    currentlyPlayingVideo: null, // Full metadata object of currently playing video
    isMiniplayer: false, // Whether the player is in floating bottom-right miniplayer mode
    brainstormTopics: [], // Brainstormed topics from LLM
    brainstormLoading: false,
    lastBrainstormTime: 0,
    lastBrainstormAttempt: 0,
    // Consecutive brainstorm failures — drives exponential backoff in the
    // preload refill loop. Not persisted; a page load starts the streak fresh.
    brainstormFailureStreak: 0,
    videoRatings: {}, // explicit ratings set by user (videoId -> 5 | -5)
    likedVideos: [], // array of video objects liked by the user
    // Timestamped canonical rating log for cross-browser sync. videoId ->
    // { r: 5|-5|0, t: <ms>, v: <minimal video meta> }. r=0 is a tombstone
    // (unliked/undisliked) so removals propagate; newest `t` wins on merge.
    ratingStates: {},
    // Same timestamped-log pattern for the watchlist queue and playlists so
    // REMOVALS propagate too. queueStates: videoId -> { p:1|0, t, v }.
    // playlistStates: plId -> { name, createdAt, deleted, t, videos:{vId:{p,t,v}} }.
    queueStates: {},
    playlistStates: {},
    // Liked videos already mined into topics by the LLM. videoId ->
    // { t: <ms>, topics: [..] }. Synced (LWW per video) so a second browser
    // reuses the extraction instead of re-paying the LLM call.
    minedVideos: {},
    // LLM-written summary of the user's taste, regenerated as likes accrue.
    // { text, clusters, generatedAt, likeCount } | null. Synced whole-value.
    tasteProfile: null,
    settings: {
        useGoogleApiSearch: false,
        useYtdlp: true,
        muteShorts: false,
        altPlayerInstance: "https://yewtu.be",
        weatherCity: "",
        llmEndpoint: "/prism/",
        llmModel: ""
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
    smartFeedPreloadedVideos: [], // kept as reference/compat if needed
    smartFeedPreloadLoading: false,
    smartFeedSuggestionPool: [],
    burnedQueries: [], // Rolling list of nuked topic queries the LLM should avoid re-suggesting
    // ── Signal ledger + agent work queue (see plan/signal_gated_topics.md) ──
    // Browsing no longer generates topics. Interest is COUNTED here, and only a
    // count crossing its threshold enqueues work for the agent.
    topicSignals: {},   // { [topic]: { t, c: { [clientId]: {imp,open,play} }, f: {imp,open,play} } }
    agentQueue: [],     // [{ type, key, payload, addedAt }] — the "checklist"
    llmCallStats: {},   // { [endpoint]: { n, lastAt } } — the before/after number
    // Feed-mix ledger: every video the smart feed SHOWED, with its era bucket,
    // topic, channel and what it later earned. Read with wgFeedMix().
    feedMix: { shown: [] },
    // Mined / defined topic retrieval policies (intent, positive facets, negative exclusions).
    topicPolicies: {},
    // Cached semantic candidate classifications (videoId -> { classification, reason, t }).
    candidateClassificationCache: {},
    profiles: ["default"],
    currentProfile: "default"
};

const DISCOVER_BATCH_SIZE = 30;
const DISCOVER_MAX_RESULTS = 150;

// Verbose per-video logging in the stream read loop; costs real frame time when on
const DEBUG = false;
// Debug logging is silenced in production. Flip DEBUG (or set window.WG_DEBUG in
// the console) to see the [Smart Feed]/[Learn]/[Performance] traces. Real
// problems still go through console.error/console.warn, which are never gated.
function debug(...args) { if (DEBUG || (typeof window !== "undefined" && window.WG_DEBUG)) console.log(...args); }

// In-memory session cache for topic search discovery results
let sessionDiscoverOffset = 0; // fallback counter for yt-dlp discover

// Pagination state for Google API search
let topicSearchPageTokens = {};
let sessionTopicSearchCache = {};
let topicSearchLoading = {};
let renderTimeouts = [];
let renderRafs = [];
let searchDebounceTimeout = null;

function clearRenderTimeouts() {
    renderTimeouts.forEach(t => clearTimeout(t));
    renderTimeouts = [];
    renderRafs.forEach(r => cancelAnimationFrame(r));
    renderRafs = [];
}

function getWeightedRandomTopics(topics, scoreFn) {
    // Soft retire: a topic the user was shown 8+ times and never once touched
    // does not get picked again. It stays in the pool at its weight — one
    // deliberate open/play/like flips the predicate and it is instantly back.
    // Never auto-burned; only the user burns.
    const likeCounts = buildTopicLikeCounts();
    const positiveTopics = topics.filter(t => t.weight > 0 && !isIgnoredTopic(t.phrase, likeCounts));
    // Sort using weighted random sampling without replacement (A-Res algorithm)
    const weightOf = typeof scoreFn === "function" ? scoreFn : (t => t.weight);
    return positiveTopics
        .map(t => ({
            phrase: t.phrase.toLowerCase(),
            sortKey: Math.pow(Math.random(), 1 / Math.max(1e-6, weightOf(t)))
        }))
        .sort((a, b) => b.sortKey - a.sortKey)
        .map(t => t.phrase);
}

// ── Topic roles and the composed queue ────────────────────────────────
// Until 2026-09-06 the fetch queue was the WHOLE positive pool in a weighted
// shuffle, drained fully before refilling: weight decided WHEN a topic was
// fetched, never WHETHER, and a weight-10 mined-from-a-like topic got the
// same 8 videos as a weight-4 ungraded one. There was no exploration budget
// — exploration was 75% of every brainstorm call instead.
//
// Every topic now carries a role. CORE is what the user demonstrably watches
// (mined from a like, proven by plays, hand-added); ADJACENT is one step
// away; EXPLORE is the small experiment slot. The queue is composed in
// slates of QUEUE_COMPOSE.slate with role quotas, core calibrated across the
// user's liked clusters by like share (Steck), and an explore share that
// adapts to its measured hit-rate. Explore topics graduate to core on a play
// or a like and expire when IGNORED.
const TOPIC_ROLES = ["core", "adjacent", "explore"];
const QUEUE_COMPOSE = {
    slate: 30,                                   // topics per composition (was: the whole pool)
    mix: { core: 0.60, adjacent: 0.25, explore: 0.15 },
    exploreBand: [0.05, 0.25],                   // the adaptive share stays inside this
    exploreTargetHitRate: 0.15,                  // hit-rate above target -> share drifts up
    exploreMinResolved: 10,                      // graduated+expired explore topics before adapting
    successHalfLifeMs: 14 * 86400e3,
    fetchBudget: { core: 10, adjacent: 8, explore: 5 }   // per-form limit hint for fetchVideosForTopic
};

/** The role a topic plays. Legacy entries derive: proven or weight >= 10 -> core, else adjacent; never explore. */
function topicRole(t, likeCounts) {
    if (!t) return "adjacent";
    if (TOPIC_ROLES.includes(t.role)) return t.role;
    if (isProvenTopic(t.phrase, likeCounts) || t.weight >= 10) return "core";
    return "adjacent";
}

/** A play or a like on an explore/adjacent topic makes it core; bornRole never changes. */
function promoteTopicRole(phrase, why) {
    const key = normalizeTopic(phrase);
    if (!key) return false;
    const t = (state.topics || []).find(x => normalizeTopic(x.phrase) === key);
    if (!t || t.weight <= 0) return false;
    const before = TOPIC_ROLES.includes(t.role) ? t.role : null;
    if (before === "core") return false;
    if (!t.bornRole) t.bornRole = before || "adjacent";
    t.role = "core";
    t.graduatedAt = Date.now();
    debug(`[Topics] "${key}" graduated ${before || "legacy"} -> core (${why || "engagement"})`);
    saveTopics();
    return true;
}

/** Like-share per liked cluster (Steck's p(cluster|user)) and topic -> cluster. */
function buildClusterIndex() {
    const share = {};
    const topicToCluster = new Map();
    const clusters = buildLikedClusters();
    let total = 0;
    clusters.forEach((c, i) => {
        const name = c.name || `cluster ${i + 1}`;
        const size = c.size || c.videos.length;
        share[name] = (share[name] || 0) + size;
        total += size;
        (c.ids || []).forEach(id => {
            (((state.minedVideos || {})[id] || {}).topics || []).forEach(t => {
                const k = normalizeTopic(t);
                if (k && !topicToCluster.has(k)) topicToCluster.set(k, name);
            });
        });
    });
    Object.keys(share).forEach(k => { share[k] = total ? share[k] / total : 0; });
    return { share, topicToCluster, clusters };
}

function clusterOfTopic(t, idx) {
    if (t && t.cluster) return t.cluster;
    const k = normalizeTopic(t && t.phrase);
    return (idx && idx.topicToCluster.get(k)) || "other";
}

/** Integer slots per bucket by largest remainder; sums exactly to n. */
function largestRemainderSlots(n, shares) {
    const keys = Object.keys(shares);
    const total = keys.reduce((a, k) => a + (shares[k] || 0), 0) || 1;
    const exact = keys.map(k => n * (shares[k] || 0) / total);
    const out = {};
    let left = n;
    keys.forEach((k, i) => { out[k] = Math.floor(exact[i]); left -= out[k]; });
    keys.map((k, i) => ({ k, frac: exact[i] - Math.floor(exact[i]), i }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i)
        .forEach(({ k }) => { if (left > 0) { out[k] += 1; left -= 1; } });
    return out;
}

/** Explore share = default x (measured hit-rate / target), clamped, once enough explore topics have resolved. */
function adaptiveExploreShare(topics, likeCounts) {
    const born = (topics || []).filter(t => t.bornRole === "explore");
    let hits = 0, expired = 0;
    born.forEach(t => {
        const k = normalizeTopic(t.phrase);
        if (t.graduatedAt || topicSignalTotal(k, "play") > 0 || (likeCounts[k] || 0) > 0) hits += 1;
        else if (isIgnoredTopic(k, likeCounts) || t.weight <= 0.5) expired += 1;
    });
    const resolved = hits + expired;
    const base = QUEUE_COMPOSE.mix.explore;
    if (resolved < QUEUE_COMPOSE.exploreMinResolved) return { share: base, hits, expired, adapted: false };
    const rate = hits / resolved;
    const [lo, hi] = QUEUE_COMPOSE.exploreBand;
    const share = Math.max(lo, Math.min(hi, base * (rate / QUEUE_COMPOSE.exploreTargetHitRate)));
    return { share, hits, expired, adapted: true };
}

/**
 * Compose the next slate of topics to fetch. Returns phrases (the queue stays
 * string[] for its .shift() consumers). Pure apart from Math.random inside
 * the weighted sampler and the ledger/like reads.
 */
function composeTopicQueue(topics, n) {
    const size = Math.max(1, n || QUEUE_COMPOSE.slate);
    const likeCounts = buildTopicLikeCounts();
    const now = Date.now();
    const eligible = (topics || []).filter(t => t && t.weight > 0 && !isBurned(t.phrase) && !isIgnoredTopic(t.phrase, likeCounts));
    if (!eligible.length) return [];

    const byRole = { core: [], adjacent: [], explore: [] };
    eligible.forEach(t => byRole[topicRole(t, likeCounts)].push(t));

    const explore = adaptiveExploreShare(topics, likeCounts);
    const share = { ...QUEUE_COMPOSE.mix, explore: explore.share };
    share.core += QUEUE_COMPOSE.mix.explore - explore.share;   // the delta stays with core
    const quota = largestRemainderSlots(Math.min(size, eligible.length), share);

    // Recency of success: a topic that earned a play/like recently samples
    // above its raw weight; the bonus halves every two weeks.
    const lastSuccess = t => {
        const rec = (state.topicSignals || {})[normalizeTopic(t.phrase)];
        return Math.max(t.graduatedAt || 0, (rec && rec.t && (topicSignalTotal(normalizeTopic(t.phrase), "play") > 0) ? rec.t : 0));
    };
    const score = t => {
        const ls = lastSuccess(t);
        const bonus = ls ? 0.5 * Math.exp(-(now - ls) / QUEUE_COMPOSE.successHalfLifeMs) : 0;
        return Math.max(0.1, t.weight) * (1 + bonus);
    };
    const pick = (list, k, taken) => {
        if (k <= 0 || !list.length) return [];
        const fresh = list.filter(t => !taken.has(normalizeTopic(t.phrase)));
        return getWeightedRandomTopics(fresh, score).slice(0, k);
    };

    const taken = new Set();
    const picked = { core: [], adjacent: [], explore: [] };
    const takeAll = (role, phrases) => { phrases.forEach(p => { taken.add(p); picked[role].push(p); }); };

    // Core, calibrated across liked clusters by like share.
    const idx = buildClusterIndex();
    const clusterNames = Object.keys(idx.share).filter(k => idx.share[k] > 0);
    if (clusterNames.length && quota.core > 0) {
        const perCluster = largestRemainderSlots(quota.core, idx.share);
        clusterNames.forEach(name => {
            const pool = byRole.core.filter(t => clusterOfTopic(t, idx) === name);
            takeAll("core", pick(pool, perCluster[name] || 0, taken));
        });
    }
    takeAll("core", pick(byRole.core, quota.core - picked.core.length, taken));
    takeAll("adjacent", pick(byRole.adjacent, quota.adjacent, taken));
    takeAll("explore", pick(byRole.explore, quota.explore, taken));

    // Shortfall in any role fills from core, then adjacent, then explore.
    let want = Math.min(size, eligible.length) - taken.size;
    for (const role of ["core", "adjacent", "explore"]) {
        if (want <= 0) break;
        const more = pick(byRole[role], want, taken);
        takeAll(role, more);
        want -= more.length;
    }

    // Interleave so explore is spread through the slate, not clumped at the end.
    const out = [];
    const lists = [picked.core, picked.adjacent, picked.explore];
    const maxLen = Math.max(...lists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) lists.forEach(l => { if (i < l.length) out.push(l[i]); });
    debug(`[Topics] composed queue of ${out.length}: core ${picked.core.length}, adjacent ${picked.adjacent.length}, explore ${picked.explore.length} (explore share ${(explore.share * 100).toFixed(0)}%${explore.adapted ? ", adapted" : ""})`);
    return out;
}

/** Role + per-form fetch budget for a topic about to be fetched. */
function topicFetchHint(phrase) {
    const key = normalizeTopic(phrase);
    const t = (state.topics || []).find(x => normalizeTopic(x.phrase) === key);
    const role = t ? topicRole(t, buildTopicLikeCounts()) : "adjacent";
    return { role, fetchBudget: QUEUE_COMPOSE.fetchBudget[role] || QUEUE_COMPOSE.fetchBudget.adjacent };
}

window.wgTopicMix = function () {
    const likeCounts = buildTopicLikeCounts();
    const idx = buildClusterIndex();
    const topics = (state.topics || []).filter(t => t.weight > 0);
    const shown = topics.filter(t => topicSignalTotal(normalizeTopic(t.phrase), "imp") > 0);
    const byRole = {};
    TOPIC_ROLES.forEach(r => { byRole[r] = { n: 0, shown: 0, played: 0, liked: 0 }; });
    topics.forEach(t => {
        const r = topicRole(t, likeCounts); const k = normalizeTopic(t.phrase);
        const b = byRole[r]; b.n += 1;
        if (topicSignalTotal(k, "imp") > 0) b.shown += 1;
        if (topicSignalTotal(k, "play") > 0) b.played += 1;
        if ((likeCounts[k] || 0) > 0) b.liked += 1;
    });
    Object.values(byRole).forEach(b => { b.engaged_pct = b.shown ? Math.round(100 * b.played / b.shown) : null; });
    const fetchedByCluster = {};
    shown.forEach(t => { if (topicRole(t, likeCounts) === "core") { const c = clusterOfTopic(t, idx); fetchedByCluster[c] = (fetchedByCluster[c] || 0) + 1; } });
    const coreShown = Object.values(fetchedByCluster).reduce((a, b) => a + b, 0);
    const clusters = {};
    Object.keys(idx.share).forEach(c => { clusters[c] = { like_share_pct: Math.round(100 * idx.share[c]), core_fetched_pct: coreShown ? Math.round(100 * (fetchedByCluster[c] || 0) / coreShown) : null }; });
    if (fetchedByCluster.other) clusters.other = { like_share_pct: 0, core_fetched_pct: coreShown ? Math.round(100 * fetchedByCluster.other / coreShown) : null };
    const explore = adaptiveExploreShare(topics, likeCounts);
    const byGen = {};
    topics.forEach(t => {
        const g = t.gen || "v1"; const k = normalizeTopic(t.phrase);
        const b = byGen[g] || (byGen[g] = { n: 0, shown: 0, played: 0, tierA: 0 });
        b.n += 1; if (t.weight >= 8) b.tierA += 1;
        if (topicSignalTotal(k, "imp") > 0) b.shown += 1;
        if (topicSignalTotal(k, "play") > 0) b.played += 1;
    });
    Object.values(byGen).forEach(b => { b.tierA_pct = Math.round(100 * b.tierA / b.n); b.engaged_pct = b.shown ? Math.round(100 * b.played / b.shown) : null; });
    console.log("topics by role (n, shown, played, liked, engaged% of shown):"); console.table(byRole);
    console.log("core fetched share vs like share, by liked cluster:"); console.table(clusters);
    console.log(`explore: ${explore.hits} graduated, ${explore.expired} expired -> hit-rate ${explore.hits + explore.expired ? Math.round(100 * explore.hits / (explore.hits + explore.expired)) : "n/a"}%, share ${(explore.share * 100).toFixed(0)}%${explore.adapted ? " (adapted)" : " (default; needs " + QUEUE_COMPOSE.exploreMinResolved + " resolved)"}`);
    console.log("by generation arm (v1 = pre-roles, v2 = roles+fit, v2-nofit = roles, anchoring only):"); console.table(byGen);
    return { byRole, clusters, explore, byGen };
};

function initSmartFeed() {
    state.smartFeedVideos = [];
    state.smartFeedUsedTopics = [];
    state.smartFeedLoading = false;
    state.smartFeedSubscriptionIndex = 0;
    state.smartFeedInitialized = true;
    state.smartFeedPreloadLoading = false;
    
    // Get positive topics randomized by weight
    state.smartFeedTopicsQueue = composeTopicQueue(state.topics);

    // ── Graph-based topic discovery: inject related topics ──
    const recentLiked = (state.likedTopics || []).slice(-5);
    if (recentLiked.length > 0 && state.ontologyGraph) {
        // Filter burns here too: the graph is a separate path into the queue
        // and it used to let a topic you had explicitly nuked walk right back
        // in through its neighbours.
        // Capped at 2: graph injection bypasses pool hygiene, so it is charged
        // against the explore budget rather than added on top of it.
        const graphSuggestions = graphGetRelatedForDiscovery(state.ontologyGraph, recentLiked, 2)
            .filter(t => !isBurned(t));
        graphSuggestions.forEach((topic, i) => {
            if (!state.smartFeedTopicsQueue.includes(topic)) {
                const insertPos = Math.min(i * 3, state.smartFeedTopicsQueue.length);
                state.smartFeedTopicsQueue.splice(insertPos, 0, topic);
            }
        });
        if (graphSuggestions.length > 0) {
            debug("[Smart Feed] Graph-discovered topics:", graphSuggestions);
        }
    }
    
    debug("[Smart Feed] Initialized with topics queue:", state.smartFeedTopicsQueue);
    
    // Start background preloading
    fillSmartFeedPreloadBuffer();
}

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
    loadState();
    // Existing profiles carry a topic pool that has been growing unbounded
    // since day one; clear the silt before anything reads from it.
    pruneTopicPool();
    setupEventListeners();
    initSmartFeed();
    fetchPrismModels();
    updateSubCount();
    renderSearchSuggestions();
    
    fetchWeather();
    fetchGoogleApiKey();
    
    // Render cached feed immediately so the UI is active and loads discovery videos
    renderFeed();

    // Mirror our current state to the extension so the YouTube-side Save button
    // has playlists + saved-video badges from the moment the dashboard loads.
    setTimeout(broadcastAppState, 1200);

    // Pull shared state from the sync service and keep it in step with other
    // browsers (likes/saves made anywhere land here, keyed by profile).
    startCrossBrowserSync();

    // Unconditionally auto-sync feeds when the page is loaded/refreshed
    syncFeeds();

    // One-time cleanup of the pool the old runaway loop filled. Runs before
    // anything reads state.topics for a request.
    purgeUnearnedTopics();

    // NO launch brainstorm. Opening the dashboard is not a request for 100 new
    // topics; the pool that exists is served, and the queue refills it only
    // when a signal earns it.

    // Mine any not-yet-extracted likes into topics. 8s puts this after the
    // first cross-browser sync pull has merged remote likes in; idempotent
    // via state.minedVideos, so running on every load is fine. This is the one
    // load-time LLM call that survives: it converts likes the user already gave
    // us, rather than inventing new topics.
    setTimeout(() => {
        if (collectUnminedLikes().length) enqueueAgentJob("mine_likes", "likes", {});
    }, 8000);

    // The checklist drains only while the user is idle.
    ["scroll", "click", "keydown", "mousemove", "touchstart"].forEach(evt =>
        window.addEventListener(evt, markUserActivity, { passive: true })
    );
    setInterval(maybeFlushAgentQueue, 5000);
    updateAgentQueueBadge();

    // Regenerate the taste profile if likes moved enough since the last one.
    setTimeout(() => refreshTasteProfile(), 12000);

    // Grounding gate over the upcoming topic queue (fail-open). Runs on a real
    // 90s interval — the old one-shot scheduleGrounding(20000) here was
    // cancelled within ~1.5s by the preload loop's own (now deleted) re-arm,
    // so in practice the gate only fired by accident.
    startGroundingInterval();
});

// Update subscription count badge in sidebar
function updateSubCount() {
    const el = document.getElementById("nav-sub-count");
    if (el) el.textContent = state.channels.length;
}

let currentSearchSuggestions = [];

function getSuggestionsPool() {
    const pool = [];
    const seen = new Set();
    const add = (phrase) => {
        if (!phrase) return;
        const normalized = phrase.trim().toLowerCase();
        if (!normalized) return;
        if ((state.dislikedTopics || []).some(dt => dt.toLowerCase() === normalized)) return;
        if (isBurned(normalized)) return;
        if (!seen.has(normalized)) {
            seen.add(normalized);
            pool.push(normalized);
        }
    };

    // 1. Liked topics
    (state.likedTopics || []).forEach(t => add(t));
    // 2. Recent search history
    (state.searchHistory || []).forEach(q => add(q));
    // 3. User preferred (topics with weight > 0)
    (state.topics || []).filter(t => t.weight > 0).forEach(t => add(t.phrase));
    // 4. Brainstormed queue
    (state.smartFeedTopicsQueue || []).forEach(t => add(t));
    
    return pool;
}

// ── Burning a topic ─────────────────────────────────────────────────────
// Deleting a topic used to just blacklist the exact string, so burning
// "self care" bought you "mindful living" on the next brainstorm. A burn now
// has to GENERALISE, which means three things beyond forgetting the phrase:
//   1. it becomes a disliked topic, so its videos take the scoring penalty;
//   2. it goes negative in the ontology graph and propagates to neighbours,
//      which damps the whole semantic cluster it came from;
//   3. its siblings — topics sharing its distinctive words — get demoted, so
//      the shape of the mistake dies with it and not just the one instance.

// Words too common to carry a topic's identity. "long term aging" is generic
// because of "aging", not because of "long"/"term".
const TOPIC_STOPWORDS = new Set([
    "the", "a", "an", "of", "and", "for", "in", "on", "to", "with", "at", "by",
    "long", "term", "new", "best", "top", "how", "diy", "advanced", "basic",
    "modern", "high", "low", "big", "small", "good", "great",
]);

/** Canonical form of a topic phrase, for storage and all comparisons. */
function normalizeTopic(phrase) {
    return (phrase || "").trim().toLowerCase();
}

/** The words that actually give a topic its identity. */
function topicSignature(phrase) {
    return normalizeTopic(phrase)
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 2 && !TOPIC_STOPWORDS.has(w));
}

// ── Burn parole ──────────────────────────────────────────────────────
// Burns are sentences, not death: taste changes over months. An entry serves
// 6 months × 2^(strikes-1); after that it becomes ELIGIBLE again — it is not
// deleted, so a re-burn finds the record, increments strikes and doubles the
// next sentence. Entries are {q, t, strikes}; readers tolerate the legacy
// bare-string shape (old localStorage, old backups, test fixtures) and the
// load path canonicalises.
const BURN_PAROLE_BASE_MS = 6 * 30 * 86400e3;

function burnRecord(b) {
    if (typeof b === "string") return { q: normalizeTopic(b), t: Date.now(), strikes: 1 };
    return { q: normalizeTopic(b.q), t: b.t || Date.now(), strikes: b.strikes || 1 };
}

function isBurnServing(rec, now) {
    return (now - rec.t) < BURN_PAROLE_BASE_MS * Math.pow(2, (rec.strikes || 1) - 1);
}

/** Phrases currently serving a burn sentence — the only ones filters honour. */
function activeBurnedPhrases() {
    const now = Date.now();
    return (state.burnedQueries || [])
        .map(burnRecord)
        .filter(r => r.q && isBurnServing(r, now))
        .map(r => r.q);
}

// isBurned runs once per topic across the whole pool (suggestions, prune,
// brainstorm). Recomputing every burned query's signature on each call was
// O(topics × burned × words); cache them and rebuild only when the burned list
// changes (new identity or length), plus an explicit bust in burnTopic for the
// at-cap push+shift case that leaves the length unchanged. The cache also
// self-expires hourly so a sentence ending mid-session is eventually honoured.
let _burnedSigCache = null;
function invalidateBurnedSignatures() { _burnedSigCache = null; }
function getBurnedSignatures() {
    const burned = state.burnedQueries || [];
    const stale = _burnedSigCache && (Date.now() - _burnedSigCache.builtAt > 3600e3);
    if (!_burnedSigCache || stale || _burnedSigCache.ref !== burned || _burnedSigCache.n !== burned.length) {
        const active = activeBurnedPhrases();
        _burnedSigCache = {
            ref: burned,
            n: burned.length,
            builtAt: Date.now(),
            exact: new Set(active),
            sigs: active.map(topicSignature).filter(s => s.length > 0),
        };
    }
    return _burnedSigCache;
}

/**
 * True if `phrase` is burned outright, or is a reworded/elaborated version of
 * something burned — one that contains the burned topic's full identity
 * ("self care" burned also rejects "self care routines"). Burning a specific
 * phrase does NOT take out the broader topic it specialises: burning
 * "kiln safety" leaves "kiln atmosphere control" alone, and burning
 * "quantum computing" leaves the general topic "computing" alone.
 */
function isBurned(phrase) {
    const normalized = normalizeTopic(phrase);
    if (!normalized) return false;
    const { exact, sigs } = getBurnedSignatures();
    if (exact.has(normalized)) return true;

    const sig = topicSignature(normalized);
    if (sig.length === 0) return false;
    const sigSet = new Set(sig);
    // The candidate must contain EVERY word of some burned topic's identity.
    return sigs.some(bs => bs.every(w => sigSet.has(w)));
}

/**
 * Burn a topic and everything it teaches us. Returns the sibling topics that
 * were demoted as collateral, so callers can tell the user what just happened.
 */
function burnTopic(phrase) {
    const normalized = (phrase || "").trim().toLowerCase();
    if (!normalized) return [];

    // A profile saved before these lists existed will be missing them.
    if (!Array.isArray(state.burnedQueries)) state.burnedQueries = [];
    if (!Array.isArray(state.dislikedTopics)) state.dislikedTopics = [];
    if (!Array.isArray(state.topics)) state.topics = [];

    // 1. Remember it — as a sentence, not forever. A fresh burn serves 6
    //    months; re-burning after parole doubles the next sentence. Re-burning
    //    while still serving just restarts the clock (same strikes) so a
    //    grounding SLOP verdict can't stack strikes on one bad week.
    const existingIdx = state.burnedQueries.findIndex(b => burnRecord(b).q === normalized);
    if (existingIdx !== -1) {
        const rec = burnRecord(state.burnedQueries[existingIdx]);
        if (!isBurnServing(rec, Date.now())) rec.strikes += 1;
        rec.t = Date.now();
        state.burnedQueries[existingIdx] = rec;
    } else {
        state.burnedQueries.push({ q: normalized, t: Date.now(), strikes: 1 });
        if (state.burnedQueries.length > 500) state.burnedQueries.shift();
    }
    invalidateBurnedSignatures();
    saveBurnedQueries();

    // 2. Make it an actual negative signal. Without this the topic kept its
    //    positive weight everywhere except the suggestion list. Entries added
    //    HERE are tagged so they parole with the burn; hand-typed dislikes
    //    (settings input / toggle) carry no tag and stay permanent.
    if (!state.dislikedTopics.some(t => t.toLowerCase() === normalized)) {
        state.dislikedTopics.push(normalized);
        if (!state.dislikedTopicsMeta) state.dislikedTopicsMeta = {};
        state.dislikedTopicsMeta[normalized] = { t: Date.now(), viaBurn: true };
        persistField("disliked_topics_meta", state.dislikedTopicsMeta);
        saveDislikedTopics();
    }

    // 3. Drive it negative in the graph and let the penalty spread to its
    //    neighbours, so the cluster it belongs to cools off too.
    if (state.ontologyGraph && typeof graphUpsertNode === "function") {
        const nodeId = graphUpsertNode(state.ontologyGraph, normalized, "Topic", -8);
        if (typeof graphPropagateNegative === "function") {
            graphPropagateNegative(state.ontologyGraph, nodeId);
        }
        if (typeof saveOntologyGraph === "function") saveOntologyGraph();
    }

    // 4. Demote the siblings that share its identity. This is the part that
    //    generalises: burning "hazard analysis" should also cost "hazard
    //    assessment" and "hazard protocols", not leave them at full weight.
    const sig = topicSignature(normalized);
    const demoted = [];
    if (sig.length > 0) {
        (state.topics || []).forEach(t => {
            const tp = t.phrase.toLowerCase();
            if (tp === normalized) return;
            const shared = topicSignature(tp).filter(w => sig.includes(w)).length;
            // Needs to share the burned topic's whole identity, not one word.
            if (shared === sig.length && t.weight > 0) {
                t.weight = Math.max(0, t.weight - 4);
                demoted.push(t.phrase);
            }
        });
    }

    // 5. Now forget it everywhere it could still surface.
    state.likedTopics = (state.likedTopics || []).filter(t => t.toLowerCase() !== normalized);
    saveLikedTopics();
    state.searchHistory = (state.searchHistory || []).filter(q => q.toLowerCase() !== normalized);
    saveSearchHistory();
    state.smartFeedTopicsQueue = (state.smartFeedTopicsQueue || []).filter(t => t.toLowerCase() !== normalized);
    state.topics = (state.topics || []).filter(t => t.phrase.toLowerCase() !== normalized);
    saveTopics();
    invalidateScoreCache();

    // 6. Evict its videos and its bookkeeping. Every AUTOMATIC burn used to
    //    leave up to 8 videos of the burned topic in the persisted suggestion
    //    pool (only the manual nuke path open-coded this cleanup), plus a
    //    ledger record and a grounding verdict for a topic that no longer
    //    exists.
    const matchesBurned = v => ((v.discoveryTopic || v._topic || v.topic || "").trim().toLowerCase() === normalized);
    if (Array.isArray(state.smartFeedSuggestionPool)) {
        const beforePool = state.smartFeedSuggestionPool.length;
        state.smartFeedSuggestionPool = state.smartFeedSuggestionPool.filter(v => !matchesBurned(v));
        if (state.smartFeedSuggestionPool.length !== beforePool) saveSmartFeedSuggestionPool();
    }
    if (Array.isArray(state.smartFeedVideos)) {
        state.smartFeedVideos = state.smartFeedVideos.filter(v => !matchesBurned(v));
    }
    state.smartFeedUsedTopics = (state.smartFeedUsedTopics || []).filter(t => normalizeTopic(t) !== normalized);
    if (state.topicSignals && state.topicSignals[normalized]) {
        delete state.topicSignals[normalized];
        saveTopicSignals();
    }
    if (state.groundingVerdicts && state.groundingVerdicts[normalized]) {
        delete state.groundingVerdicts[normalized];
        saveGroundingVerdicts();
    }
    // Sweep the weight-0 siblings step 4 just created, instead of leaving them
    // for whichever unrelated growth event next triggers a prune.
    pruneTopicPool();

    debug(`[Learn] Burned "${normalized}"`
        + (demoted.length ? `; demoted ${demoted.length} sibling(s): ${demoted.join(", ")}` : ""));
    return demoted;
}

/**
 * Keep the topic pool from turning into a junk drawer. It was append-only:
 * every topic the LLM ever produced lived forever at weight 5, good ones got
 * consumed by the feed while duds just accumulated, and the suggestion chips
 * sampled that silt at random. Decay what goes unused and evict the tail.
 */
const TOPIC_POOL_MAX = 400;
const TOPIC_DECAY_PER_PRUNE = 0.5;

// Wall-clock staleness thresholds. The old decay keyed on the session-only
// smartFeedUsedTopics list, which is reset on every nav and never persisted —
// so the one prune guaranteed to run (page load) decayed NOTHING, the 0.5
// floor made weight-eviction unreachable, and the 400 cap ended up evicting
// the topics the feed had actually served (the only ones decay ever touched)
// while never-served silt kept its birth weight forever.
const TOPIC_STALE_DECAY_MS = 7 * 86400e3;   // no signal for a week -> start decaying
const TOPIC_STALE_EVICT_MS = 21 * 86400e3;  // decayed to the floor AND dead 3 weeks -> evict

/** Most recent moment anything happened to this topic: added, or any signal. */
function topicFreshness(t) {
    const rec = (state.topicSignals || {})[normalizeTopic(t.phrase)];
    return Math.max(t.addedAt || 0, (rec && rec.t) || 0);
}

function pruneTopicPool() {
    if (!Array.isArray(state.topics)) return;
    const before = state.topics.length;
    const now = Date.now();

    const likedSet = new Set((state.likedTopics || []).map(normalizeTopic));
    const likeCounts = buildTopicLikeCounts();

    // Age-based decay. Exempt: negatives (user decisions), liked topics, and
    // PROVEN topics (the ledger says they earn engagement — staleness there
    // means the feed under-served them, not that they failed).
    state.topics.forEach(t => {
        if (t.weight <= 0) return;
        // Unknown age is NOT infinite age: a topic that reaches here without a
        // stamp (legacy data, direct insertion) starts its clock now instead
        // of decaying on sight.
        if (!t.addedAt) { t.addedAt = now; return; }
        const phrase = normalizeTopic(t.phrase);
        if (likedSet.has(phrase) || isProvenTopic(phrase, likeCounts)) return;
        // An explore topic that was shown enough to be IGNORED has resolved:
        // the experiment failed. Drop it to the floor so the 21-day eviction
        // below can reach it. Core/adjacent keep the soft retirement only.
        if (t.role === "explore" && isIgnoredTopic(phrase, likeCounts)) {
            t.weight = Math.min(t.weight, 0.5);
            return;
        }
        if (now - topicFreshness(t) > TOPIC_STALE_DECAY_MS) {
            t.weight = Math.max(0.5, t.weight - TOPIC_DECAY_PER_PRUNE);
        }
    });

    // Eviction: sat at the floor with three signal-free weeks behind it. Log
    // what went — this is destructive and should be inspectable, not trusted.
    const evicted = [];
    state.topics = state.topics.filter(t => {
        if (t.weight > 0 && t.weight <= 0.5 && t.addedAt &&
            now - topicFreshness(t) > TOPIC_STALE_EVICT_MS &&
            !likedSet.has(normalizeTopic(t.phrase))) {
            evicted.push(t.phrase);
            return false;
        }
        // Exact burns only. isBurned() generalises to supersets — using it
        // here would DELETE the siblings step 4 of burnTopic deliberately
        // demoted-but-kept (the two mechanisms were in silent disagreement;
        // the sibling policy is demote, and the generalising check guards the
        // ADD paths). The weight-0 case is burn-sibling demotion hitting zero.
        return t.weight !== 0 && !getBurnedSignatures().exact.has(normalizeTopic(t.phrase));
    });
    if (evicted.length) {
        let log = [];
        try { log = JSON.parse(localStorage.getItem(getProfileKey("topic_evict_log")) || "[]"); } catch (e) { /* fresh */ }
        log.push({ at: now, evicted });
        persistField("topic_evict_log", log.slice(-50));
        debug(`[Learn] Evicted ${evicted.length} stale topic(s): ${evicted.join(", ")}`);
    }

    // Hard cap: negatives and PROVEN topics keep their seats (engaged evidence
    // must not lose the cap fight to freshly-minted weight-5 guesses); the
    // rest compete on weight.
    if (state.topics.length > TOPIC_POOL_MAX) {
        const keep = [];
        const contenders = [];
        state.topics.forEach(t => {
            if (t.weight < 0 || isProvenTopic(t.phrase, likeCounts)) keep.push(t);
            else contenders.push(t);
        });
        contenders.sort((a, b) => b.weight - a.weight);
        state.topics = [...keep, ...contenders.slice(0, Math.max(0, TOPIC_POOL_MAX - keep.length))];
    }

    if (state.topics.length !== before) {
        debug(`[Learn] Pruned topic pool: ${before} -> ${state.topics.length}`);
    }
    saveTopics();
    invalidateScoreCache();
}

function deleteSuggestion(topic) {
    const normalized = topic.toLowerCase();

    burnTopic(normalized);

    // Remove from current active suggestion list
    const index = currentSearchSuggestions.indexOf(normalized);
    if (index > -1) {
        currentSearchSuggestions.splice(index, 1);
    }
    
    // Try to find a replacement!
    const pool = getSuggestionsPool();
    const replacement = pool.find(p => !currentSearchSuggestions.includes(p));
    if (replacement) {
        if (index > -1) {
            currentSearchSuggestions.splice(index, 0, replacement);
        } else {
            currentSearchSuggestions.push(replacement);
        }
    }
    
    // Re-render suggestions
    renderSearchSuggestions(true);
}

// How many chips to show before the "show more" fold. The old cloud dumped a
// random 50 in one flat wall, reshuffled on every render — nothing was ranked,
// so an AI dud and a topic you chose yourself looked identical and competed for
// the same attention. Show a short, RANKED, stable list instead.
const SUGGESTIONS_VISIBLE = 12;
let suggestionsExpanded = false;

/** Build the chip list: grouped by provenance, ranked by weight within group. */
function buildSuggestionGroups() {
    const seen = new Set();
    const take = (phrase) => {
        const n = (phrase || "").trim().toLowerCase();
        if (!n || seen.has(n)) return null;
        if ((state.dislikedTopics || []).some(dt => dt.toLowerCase() === n)) return null;
        if (isBurned(n)) return null;
        seen.add(n);
        return n;
    };
    const weightOf = (phrase) => {
        const t = (state.topics || []).find(x => x.phrase.toLowerCase() === phrase);
        return t ? t.weight : 0;
    };

    // Order matters: a topic you picked yourself outranks one the AI guessed.
    const yours = (state.likedTopics || [])
        .map(take).filter(Boolean)
        .sort((a, b) => weightOf(b) - weightOf(a));

    const recent = (state.searchHistory || []).slice(-8).reverse()
        .map(take).filter(Boolean);

    // Rank AI topics by the weight the backend's anchoring grade gave them, so
    // specific topics ("raku reduction firing") sit above broad ones
    // ("chemical reactions") instead of being shuffled together.
    const discovered = (state.topics || [])
        .filter(t => t.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .map(t => take(t.phrase)).filter(Boolean);

    return [
        { label: "Your interests", topics: yours, cls: "grp-yours" },
        { label: "Recent searches", topics: recent, cls: "grp-recent" },
        { label: "AI discoveries", topics: discovered, cls: "grp-ai" },
    ].filter(g => g.topics.length > 0);
}

// Render suggestion pills under the search bar
function renderSearchSuggestions(useExisting = false) {
    const container = document.getElementById("search-suggestions");
    if (!container) return;
    container.innerHTML = "";

    const groups = buildSuggestionGroups();

    if (!useExisting || currentSearchSuggestions.length === 0) {
        currentSearchSuggestions = groups.flatMap(g => g.topics);
    }

    if (groups.length === 0) return;

    const makePill = (topic, cls) => {
        const pill = document.createElement("div");
        pill.className = `suggestion-pill ${cls}`;

        const textSpan = document.createElement("span");
        textSpan.className = "suggestion-text";
        textSpan.textContent = topic.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        textSpan.addEventListener("click", () => {
            const searchInput = document.getElementById("input-search-videos");
            if (searchInput) searchInput.value = topic;
            state.discoverBatchIndex = 0;
            state.discoverMaxReached = false;
            triggerGlobalSearch(topic);
        });
        pill.appendChild(textSpan);

        const deleteSpan = document.createElement("span");
        deleteSpan.className = "delete-suggestion";
        deleteSpan.innerHTML = icon("x", 10);
        deleteSpan.title = `Remove "${topic}" — also damps similar topics`;
        deleteSpan.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteSuggestion(topic);
        });
        pill.appendChild(deleteSpan);
        return pill;
    };

    // Collapsed: one tight ranked row. Expanded: the full set, grouped.
    if (!suggestionsExpanded) {
        const row = document.createElement("div");
        row.className = "suggestion-row";
        // Keep a little of each provenance rather than 12 AI topics in a row.
        const quota = [
            [groups.find(g => g.cls === "grp-yours"), 5],
            [groups.find(g => g.cls === "grp-recent"), 2],
            [groups.find(g => g.cls === "grp-ai"), SUGGESTIONS_VISIBLE],
        ];
        const shown = [];
        for (const [g, n] of quota) {
            if (!g) continue;
            for (const t of g.topics.slice(0, n)) {
                if (shown.length < SUGGESTIONS_VISIBLE && !shown.includes(t)) {
                    shown.push(t);
                    row.appendChild(makePill(t, g.cls));
                }
            }
        }
        container.appendChild(row);
    } else {
        groups.forEach(g => {
            const section = document.createElement("div");
            section.className = "suggestion-group";
            const h = document.createElement("span");
            h.className = "suggestion-group-label";
            h.textContent = g.label;
            section.appendChild(h);
            const row = document.createElement("div");
            row.className = "suggestion-row";
            g.topics.forEach(t => row.appendChild(makePill(t, g.cls)));
            section.appendChild(row);
            container.appendChild(section);
        });
    }

    const total = groups.reduce((n, g) => n + g.topics.length, 0);
    if (total > SUGGESTIONS_VISIBLE) {
        const toggle = document.createElement("button");
        toggle.className = "suggestion-toggle";
        toggle.textContent = suggestionsExpanded
            ? "Show less"
            : `Show all ${total} topics`;
        toggle.addEventListener("click", () => {
            suggestionsExpanded = !suggestionsExpanded;
            renderSearchSuggestions(true);
        });
        container.appendChild(toggle);
    }
}

// Helper to get profile-prefixed key for localstorage
function getProfileKey(key) {
    if (!state.currentProfile || state.currentProfile === "default") {
        return `wallgarden_default_${key}`;
    }
    return `wallgarden_${state.currentProfile}_${key}`;
}

// Load profiles list and current profile
function initProfiles() {
    const rawProfiles = localStorage.getItem("wallgarden_profiles");
    let parsed = rawProfiles ? JSON.parse(rawProfiles) : ["default"];
    
    // Sanitize profiles: ensure they are strings and remove corrupted "[object Object]" entries
    state.profiles = parsed.filter(p => typeof p === "string" && p !== "[object Object]");
    
    if (state.profiles.length === 0) {
        state.profiles = ["default"];
    } else if (!state.profiles.includes("default")) {
        state.profiles.unshift("default");
    }
    
    // Save sanitized list back to storage
    localStorage.setItem("wallgarden_profiles", JSON.stringify(state.profiles));
    
    const rawCurrentProfile = localStorage.getItem("wallgarden_current_profile");
    state.currentProfile = rawCurrentProfile || "default";
    
    if (!state.profiles.includes(state.currentProfile)) {
        state.currentProfile = "default";
        localStorage.setItem("wallgarden_current_profile", "default");
    }
}

// Load variables from Local Storage
function loadState() {
    initProfiles();
    
    // Migration helper
    function getStoredItem(key) {
        const prefixedKey = getProfileKey(key);
        let val = localStorage.getItem(prefixedKey);
        if (val === null && state.currentProfile === "default") {
            // Check legacy un-prefixed key
            const legacyVal = localStorage.getItem(`wallgarden_${key}`);
            if (legacyVal !== null) {
                debug(`[Profile Migration] Migrating legacy key wallgarden_${key} to ${prefixedKey}`);
                localStorage.setItem(prefixedKey, legacyVal);
                val = legacyVal;
            }
        }
        return val;
    }

    const rawChannels = getStoredItem("channels");
    const rawTopics = getStoredItem("topics");
    const rawBlocked = getStoredItem("blocked_channels");
    const rawCache = getStoredItem("cache");
    const rawSettings = getStoredItem("settings");
    const rawSearchHistory = getStoredItem("search_history");
    const rawBrainstorm = getStoredItem("brainstorm_topics");
    const rawVideoRatings = getStoredItem("video_ratings");
    const rawDiscovered = getStoredItem("discovered_channels");
    const rawPool = getStoredItem("smart_feed_pool");
    const rawLiked = getStoredItem("liked_topics");
    const rawDisliked = getStoredItem("disliked_topics");
    const rawBurned = getStoredItem("burned_queries");
    const rawPlaylists = getStoredItem("playlists");
    const rawLikedVideos = getStoredItem("liked_videos");
    const rawNewsRatings = getStoredItem("news_ratings");
    const rawQueue = getStoredItem("queue");
    const rawGraph = getStoredItem("ontology_graph");

    // Standard profile initialization - a fresh profile has NO topics and NO channels!
    state.channels = rawChannels ? JSON.parse(rawChannels) : (state.currentProfile === "default" ? [...DEFAULT_CHANNELS] : []);
    state.topics = rawTopics ? JSON.parse(rawTopics) : (state.currentProfile === "default" ? [...DEFAULT_TOPICS] : []);
    // Topics from before addedAt existed (and hand-added ones, which never set
    // it) must not read as instantly stale — their clock starts now.
    state.topics.forEach(t => { if (!t.addedAt) t.addedAt = Date.now(); });
    state.blockedChannels = rawBlocked ? JSON.parse(rawBlocked) : [];
    state.likedTopics = rawLiked ? JSON.parse(rawLiked) : [];
    state.dislikedTopics = rawDisliked ? JSON.parse(rawDisliked) : [];
    state.settings = rawSettings ? JSON.parse(rawSettings) : { useYtdlp: true, muteShorts: false, altPlayerInstance: "https://yewtu.be", discoverySortOrder: "relevance" };
    if (!state.settings.altPlayerInstance) {
        state.settings.altPlayerInstance = "https://yewtu.be";
    }
    if (!state.settings.discoverySortOrder) {
        state.settings.discoverySortOrder = "relevance";
    }
    if (!state.settings.llmEndpoint) {
        state.settings.llmEndpoint = "/prism/";
    }
    if (!state.settings.llmModel) {
        state.settings.llmModel = "";
    }
    state.searchHistory = rawSearchHistory ? JSON.parse(rawSearchHistory) : [];
    // watchedHistory was WRITE-ONLY: three writers, zero readers of the
    // stored key, so the anti-resurface guard in fetchVideosForTopic was dead
    // on every cold load until the sync pull happened to rehydrate it. Note
    // the key is deliberately unprefixed (shared across profiles), matching
    // its writers.
    try {
        state.watchedHistory = JSON.parse(localStorage.getItem("wallgarden_watched") || "{}");
    } catch (e) { state.watchedHistory = {}; }
    state.topicSignals = JSON.parse(getStoredItem("topic_signals") || "{}");
    state.agentQueue = JSON.parse(getStoredItem("agent_queue") || "[]");
    state.llmCallStats = JSON.parse(getStoredItem("llm_call_stats") || "{}");
    try {
        state.feedMix = JSON.parse(getStoredItem("feed_mix") || '{"shown":[]}');
    } catch (e) { state.feedMix = null; }
    if (!state.feedMix || !Array.isArray(state.feedMix.shown)) state.feedMix = { shown: [] };
    state.brainstormTopics = rawBrainstorm ? JSON.parse(rawBrainstorm) : [];
    state.videoRatings = rawVideoRatings ? JSON.parse(rawVideoRatings) : {};
    const rawRatingStates = getStoredItem("rating_states");
    state.ratingStates = rawRatingStates ? JSON.parse(rawRatingStates) : {};
    const rawQueueStates = getStoredItem("queue_states");
    state.queueStates = rawQueueStates ? JSON.parse(rawQueueStates) : {};
    const rawPlaylistStates = getStoredItem("playlist_states");
    state.playlistStates = rawPlaylistStates ? JSON.parse(rawPlaylistStates) : {};
    state.discoveredChannels = rawDiscovered ? JSON.parse(rawDiscovered) : [];
    state.smartFeedSuggestionPool = rawPool ? JSON.parse(rawPool) : [];
    // Canonicalise legacy bare-string burns into {q,t,strikes} records. The
    // conservative choice for an undated legacy burn is "sentence starts now".
    state.burnedQueries = (rawBurned ? JSON.parse(rawBurned) : []).map(burnRecord);
    state.dislikedTopicsMeta = JSON.parse(getStoredItem("disliked_topics_meta") || "{}");
    // Parole sweep for dislikes that came in via a burn: they expire with the
    // burn's base sentence. Hand-typed dislikes have no meta and never expire.
    {
        const now = Date.now();
        const expired = Object.entries(state.dislikedTopicsMeta)
            .filter(([, m]) => m && m.viaBurn && (now - (m.t || 0)) >= BURN_PAROLE_BASE_MS)
            .map(([ph]) => ph);
        if (expired.length) {
            const gone = new Set(expired);
            state.dislikedTopics = (state.dislikedTopics || []).filter(t => !gone.has(normalizeTopic(t)));
            expired.forEach(ph => delete state.dislikedTopicsMeta[ph]);
            persistField("disliked_topics_meta", state.dislikedTopicsMeta);
            saveDislikedTopics();
            debug(`[Learn] Paroled ${expired.length} burn-added disliked topic(s): ${expired.join(", ")}`);
        }
    }
    state.playlists = rawPlaylists ? JSON.parse(rawPlaylists) : {};
    if (state.playlists) {
        Object.values(state.playlists).forEach(pl => {
            if (pl && !pl.videos) pl.videos = [];
        });
    }
    state.likedVideos = rawLikedVideos ? JSON.parse(rawLikedVideos) : [];
    state.newsSourceRatings = rawNewsRatings ? JSON.parse(rawNewsRatings) : {};
    state.queue = rawQueue ? JSON.parse(rawQueue) : [];
    state.ontologyGraph = rawGraph ? JSON.parse(rawGraph) : { nodes: {}, edges: {}, clusters: {} };
    const rawMined = getStoredItem("mined_videos");
    state.minedVideos = rawMined ? JSON.parse(rawMined) : {};
    const rawTasteProfile = getStoredItem("taste_profile");
    state.tasteProfile = rawTasteProfile ? JSON.parse(rawTasteProfile) : null;
    const rawPolicies = getStoredItem("topic_policies");
    state.topicPolicies = rawPolicies ? JSON.parse(rawPolicies) : {};
    const rawClassifications = getStoredItem("candidate_classifications");
    state.candidateClassificationCache = rawClassifications ? JSON.parse(rawClassifications) : {};
    // 30-day TTL, mirroring the grounding-verdict sweep below. This cache had
    // NO expiry: verdicts accumulated in localStorage forever, and the `t`
    // stamp was written but never read.
    {
        const classCutoff = Date.now() - 30 * 86400e3;
        let swept = 0;
        Object.keys(state.candidateClassificationCache).forEach(k => {
            if ((state.candidateClassificationCache[k].t || 0) < classCutoff) {
                delete state.candidateClassificationCache[k]; swept++;
            }
        });
        if (swept) saveCandidateClassificationCache();
    }
    const rawVerdicts = getStoredItem("grounding_verdicts");
    state.groundingVerdicts = rawVerdicts ? JSON.parse(rawVerdicts) : {};
    // Expire verdicts on their per-verdict TTLs (REAL 30d, others 7d) — the
    // same sweep the grounding interval runs, so expiry no longer waits for a
    // page load.
    sweepGroundingVerdicts();
    if (state.settings.statsPromptEnabled === undefined) {
        state.settings.statsPromptEnabled = true;
    }
    if (state.settings.groundingEnabled === undefined) {
        state.settings.groundingEnabled = true;
    }
    
    if (rawCache) {
        state.cache = JSON.parse(rawCache);
    } else {
        state.cache = { videos: {}, lastSync: 0 };
    }
    
    // One-time flush when the ranking pipeline changes: pool entries fetched
    // under an older strategy (e.g. the date-sorted era queries) would keep
    // serving slop for days. Bump WG_POOL_VERSION to invalidate.
    // "3": every entry fetched before scraper 2026-09-06 has published=null
    // (the scraper's date repair was gated on require_transcript). Era
    // bucketing needs dated rows, so the undated pool goes.
    const WG_POOL_VERSION = "3";
    if (getStoredItem("pool_version") !== JSON.stringify(WG_POOL_VERSION) && state.smartFeedSuggestionPool.length > 0) {
        debug(`[Smart Feed] Pool version changed — flushing ${state.smartFeedSuggestionPool.length} pre-ranking suggestions.`);
        state.smartFeedSuggestionPool = [];
        saveSmartFeedSuggestionPool();
    }
    persistField("pool_version", WG_POOL_VERSION);

    // Discard expired cached suggestions older than 14 days
    // Pools saved by the old code carry frozen _score values — strip them so
    // every entry re-scores against CURRENT preferences at render time.
    (state.smartFeedSuggestionPool || []).forEach(v => { delete v._score; delete v._matchedTopics; });
    const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
    const initialPoolSize = state.smartFeedSuggestionPool.length;
    state.smartFeedSuggestionPool = state.smartFeedSuggestionPool.filter(v =>
        v.crawledAt && v.crawledAt > fourteenDaysAgo
    );
    if (state.smartFeedSuggestionPool.length !== initialPoolSize) {
        debug(`[Smart Feed] Discarded ${initialPoolSize - state.smartFeedSuggestionPool.length} expired suggestions older than 14 days.`);
        saveSmartFeedSuggestionPool();
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
    
    // Save defaults back to storage if they were missing (only for default profile or custom profile with values)
    if (!rawChannels && state.currentProfile === "default") saveChannels();
    if (!rawTopics && state.currentProfile === "default") saveTopics();
    if (!rawBlocked && state.currentProfile === "default") saveBlocked();

    document.getElementById("subscribed-count").textContent = state.channels.length;
    document.getElementById("blocked-count").textContent = state.blockedChannels.length;

    // Set settings toggles UI
    const googleApiToggle = document.getElementById("toggle-use-google-api-search");
    if (googleApiToggle) googleApiToggle.checked = state.settings.useGoogleApiSearch;
    document.getElementById("toggle-use-ytdlp").checked = state.settings.useYtdlp;
    document.getElementById("toggle-mute-shorts").checked = state.settings.muteShorts;
    const groundingToggle = document.getElementById("toggle-grounding");
    if (groundingToggle) groundingToggle.checked = state.settings.groundingEnabled !== false;
    const statsToggle = document.getElementById("toggle-stats-prompt");
    if (statsToggle) statsToggle.checked = state.settings.statsPromptEnabled !== false;
    const altPlayerInput = document.getElementById("input-alt-player-instance");
    if (altPlayerInput) {
        altPlayerInput.value = state.settings.altPlayerInstance || "https://yewtu.be";
    }
    const weatherCityInput = document.getElementById("input-weather-city");
    if (weatherCityInput) {
        weatherCityInput.value = state.settings.weatherCity || "";
    }
    
    // Update profiles settings UI dropdowns
    renderProfileDropdowns();

    migrateTopicsToGraph();
}

function migrateTopicsToGraph() {
    // Auto-detect broken v2 migration: had nodes but 0 edges = scoring wasn't run
    if (localStorage.getItem(getProfileKey("ontology_v2_migrated")) === "1"
        && Object.keys(state.ontologyGraph.edges || {}).length === 0
        && Object.keys(state.ontologyGraph.nodes || {}).length > 0) {
        debug("[Ontology V2] Detected broken migration (nodes but 0 edges) — re-running...");
        localStorage.removeItem(getProfileKey("ontology_v2_migrated"));
    }
    
    if (localStorage.getItem(getProfileKey("ontology_v2_migrated"))) return;
    
    debug("[Ontology V2] Wiping old graph and rebuilding with proper edge creation...");
    state.ontologyGraph = { nodes: {}, edges: {}, clusters: {} };
    
    // Re-seed from current state
    (state.topics || []).forEach(t => {
        if (t.weight !== 0) graphUpsertNode(state.ontologyGraph, t.phrase, "Topic", t.weight);
    });
    (state.likedTopics || []).forEach(t => graphUpsertNode(state.ontologyGraph, t, "Topic", 4));
    (state.dislikedTopics || []).forEach(t => graphUpsertNode(state.ontologyGraph, t, "Topic", -4));
    
    // Rebuild edges from video ratings history
    // CRITICAL: cached videos don't have matchedTopics — it's computed by getScoreAndMatches()
    // We must run scoring on each video before passing to graphProcessRating()
    const ratings = state.videoRatings || {};
    const cache = state.cache?.videos || {};
    let rebuiltCount = 0;
    Object.entries(ratings).forEach(([videoId, rating]) => {
        for (const channelVideos of Object.values(cache)) {
            const video = channelVideos.find(v => v.id === videoId);
            if (video) {
                // Run scoring to populate matchedTopics (they're not stored in cache)
                const evaluation = getScoreAndMatches(video);
                graphProcessRating(state.ontologyGraph, {
                    ...video,
                    matchedTopics: evaluation.matches
                }, rating > 0 ? 1 : -1);
                rebuiltCount++;
                break;
            }
        }
    });
    
    const nodeCount = Object.keys(state.ontologyGraph.nodes).length;
    const edgeCount = Object.keys(state.ontologyGraph.edges).length;
    debug(`[Ontology V2] Rebuilt graph: ${nodeCount} nodes, ${edgeCount} edges from ${rebuiltCount} ratings`);
    
    saveOntologyGraph();
    localStorage.setItem(getProfileKey("ontology_v2_migrated"), "1");
}

// One place that turns "field -> JSON in this profile's slot" into a write, so
// each saver is a name + a value instead of a copy of the same setItem line.
// (The debounced pool/graph savers below deliberately don't route through it.)
function persistField(key, value) {
    localStorage.setItem(getProfileKey(key), JSON.stringify(value));
}

function saveSettings() { persistField("settings", state.settings); }

function saveBlocked() {
    persistField("blocked_channels", state.blockedChannels);
    document.getElementById("blocked-count").textContent = state.blockedChannels.length;
}

// Save helpers
function saveChannels() {
    persistField("channels", state.channels);
    document.getElementById("subscribed-count").textContent = state.channels.length;
}

// ── One-time migration: drop what the runaway loop invented ─────────
//
// The old /similar path added its results at weight 2, and — called from
// playVideo — added the raw video TITLE as a "topic" at weight 2 as well. Those
// entries never represented a choice the user made. Anything the user actually
// earned is kept: mined-from-a-like (10/6), hand-added, tier-A brainstormed (8),
// and every negative weight (a burn is a decision too).
const TOPIC_PURGE_VERSION = 1;

function looksLikeVideoTitle(phrase) {
    // Real topics are 1-4 words by prompt contract; video titles are longer and
    // carry title-case punctuation the topic vocabulary never uses.
    return phrase.split(/\s+/).length > 5 || /[|\[\]()!?"'#]/.test(phrase);
}

function purgeUnearnedTopics() {
    // getStoredItem is scoped INSIDE loadState — read through the same profile
    // key helper persistField uses instead.
    const done = Number(JSON.parse(localStorage.getItem(getProfileKey("topic_purge_version")) || "0"));
    if (done >= TOPIC_PURGE_VERSION) return;

    const liked = new Set((state.likedTopics || []).map(normalizeTopic));
    const mined = new Set();
    Object.values(state.minedVideos || {}).forEach(m =>
        (m.topics || []).forEach(t => mined.add(normalizeTopic(t)))
    );

    const before = (state.topics || []).length;
    const dropped = [];
    state.topics = (state.topics || []).filter(t => {
        const phrase = normalizeTopic(t.phrase);
        if (t.weight < 0) return true;                       // burns are decisions
        if (liked.has(phrase) || mined.has(phrase)) return true; // earned via a like
        if (looksLikeVideoTitle(phrase)) { dropped.push(t.phrase); return false; }
        if (t.weight <= 2) { dropped.push(t.phrase); return false; } // /similar spam
        return true;                                          // tier-A/B, hand-added
    });

    persistField("topic_purge_version", TOPIC_PURGE_VERSION);
    // Keep the evidence: this is destructive and the user should be able to see
    // exactly what went, rather than take "cleaned up" on faith.
    persistField("topic_purge_log", { at: Date.now(), before, after: state.topics.length, dropped });
    saveTopics();
    console.log(`[Topics] Purged ${dropped.length} unearned topics (${before} -> ${state.topics.length}). ` +
                `Inspect with JSON.parse(localStorage.getItem("${getProfileKey("topic_purge_log")}")).`);
}

// ══════════════════════════════════════════════════════════════════════
// SIGNAL LEDGER — browsing counts, it does not generate
// ══════════════════════════════════════════════════════════════════════
//
// Before this, playing a video fired /similar (10 topics) on a 3s timer with no
// in-flight guard, the raw video TITLE was pushed into the pool as a weight-2
// "topic", and the preload loop re-checked a brainstorm gate every 1.5s and
// asked for 100 more topics every 15s. Browsing alone could add hundreds of
// topics nobody asked for.
//
// Now: every browse action increments a COUNTER. Topics are generated only when
// a counter crosses its threshold, or on an outright like. Thresholds differ by
// how much intent the action carries — seeing something in the feed is weak,
// choosing to play it is strong.
const SIGNAL_THRESHOLDS = {
    imp:  10,  // videos from this topic dwelled on 5s+ in the feed (weakest)
    open:  4,  // searched it, or clicked its suggestion pill
    play:  3   // actually played a video that came from it (strongest)
};

// Each browser owns its own counter namespace so the counts can be summed
// across browsers without double-counting. See mergeTopicSignals + the
// _merge_topic_signals docstring in sync-service/main.py for why per-key LWW
// (what every other synced field uses) would silently DISCARD the other
// browser's progress toward a threshold.
function getClientId() {
    let id = localStorage.getItem("wallgarden_client_id");
    if (!id) {
        id = "c" + Math.random().toString(36).slice(2, 10);
        localStorage.setItem("wallgarden_client_id", id);
    }
    return id;
}

// ── Instrumentation: the before/after number ────────────────────────
// There was no historical record of how many LLM calls a browsing session cost
// (the container's logs reset on deploy and prism's stats need auth), so this
// counter IS the measurement. Read it from the console with wgCallStats().
function countedFetch(url, opts) {
    const key = String(url).split("?")[0];
    if (!state.llmCallStats) state.llmCallStats = {};
    const rec = state.llmCallStats[key] || (state.llmCallStats[key] = { n: 0, lastAt: 0 });
    rec.n += 1;
    rec.lastAt = Date.now();
    persistField("llm_call_stats", state.llmCallStats);
    debug(`[LLM] ${key} (call #${rec.n} this browser)`);
    return fetch(url, opts);
}

window.wgCallStats = function () {
    const stats = state.llmCallStats || {};
    const total = Object.values(stats).reduce((a, r) => a + r.n, 0);
    console.table(stats);
    console.log(`total LLM calls: ${total}`);
    return { total, stats };
};

window.wgResetCallStats = function () {
    state.llmCallStats = {};
    persistField("llm_call_stats", {});
    console.log("LLM call stats reset");
};

// Surfaced when the feed runs dry. Generation is now opt-in, so an empty queue
// has to ASK rather than silently spending a brainstorm.
let _emptyNoticeShownAt = 0;
function notifyTopicQueueEmpty() {
    if (Date.now() - _emptyNoticeShownAt < 120000) return;
    _emptyNoticeShownAt = Date.now();
    debug("[Smart Feed] Topic queue empty - waiting for a signal or a manual refill.");
    showToast('Out of topics - like something, or press "Brainstorm more"', "warning");
}

function saveTopicSignals() { persistField("topic_signals", state.topicSignals); schedulePushRemoteState(); }

/** Total for one signal kind across ALL browsers. */
function topicSignalTotal(topic, kind) {
    const rec = (state.topicSignals || {})[normalizeTopic(topic)];
    if (!rec || !rec.c) return 0;
    return Object.values(rec.c).reduce((sum, per) => sum + ((per && per[kind]) || 0), 0);
}

/**
 * Record one unit of interest in a topic.
 *
 * `dedupeKey` (a video id, for impressions) makes the increment idempotent —
 * without it, scrolling one topic's eight cards past the viewport would spend
 * eight of the ten impressions a threshold is meant to represent.
 * Returns true if this call crossed a threshold and enqueued work.
 */
function recordTopicSignal(topic, kind, dedupeKey) {
    const phrase = normalizeTopic(topic);
    if (!phrase || !SIGNAL_THRESHOLDS[kind]) return false;
    // A topic the user already rejected must never climb back via browsing.
    if (isBurned(phrase) || (state.dislikedTopics || []).includes(phrase)) return false;

    if (!state.topicSignals) state.topicSignals = {};
    const rec = state.topicSignals[phrase] || (state.topicSignals[phrase] = { t: 0, c: {}, f: {} });

    if (dedupeKey) {
        if (!rec.seen) rec.seen = {};
        if (rec.seen[dedupeKey]) return false;
        rec.seen[dedupeKey] = 1;
        // Bound the dedupe set — it only has to cover one threshold's worth.
        const keys = Object.keys(rec.seen);
        if (keys.length > 40) delete rec.seen[keys[0]];
    }

    const cid = getClientId();
    const per = rec.c[cid] || (rec.c[cid] = {});
    per[kind] = (per[kind] || 0) + 1;
    rec.t = Date.now();

    const total = topicSignalTotal(phrase, kind);
    const firedAt = (rec.f && rec.f[kind]) || 0;
    const crossed = total >= firedAt + SIGNAL_THRESHOLDS[kind];

    if (crossed) {
        // Re-arm from the CURRENT total, so the next expansion needs another
        // full threshold of fresh interest rather than firing on every
        // subsequent increment.
        rec.f[kind] = total;
        enqueueAgentJob("expand_topic", phrase, { topic: phrase, reason: kind, count: total });
    }
    saveTopicSignals();
    // One deliberate play graduates an explore/adjacent topic to core.
    if (kind === "play") promoteTopicRole(phrase, "play");
    return crossed;
}

// ══════════════════════════════════════════════════════════════════════
// AGENT WORK QUEUE — the checklist
// ══════════════════════════════════════════════════════════════════════
//
// Work accumulates here and is spent in ONE batched request when the user goes
// idle, instead of firing a call per action while they are still browsing.
const AGENT_QUEUE_MAX = 30;
const AGENT_IDLE_MS = 25000;      // quiet period before a flush is allowed
const AGENT_MIN_GAP_MS = 60000;   // floor between flushes, whatever else happens
const TOPICS_PER_TRIGGER = 2;     // adaptive budget…
const TOPICS_PER_FLUSH_MAX = 15;  // …capped under the measured 25-output ceiling

function saveAgentQueue() { persistField("agent_queue", state.agentQueue); }

function enqueueAgentJob(type, key, payload) {
    if (!state.agentQueue) state.agentQueue = [];
    if (state.agentQueue.some(j => j.type === type && j.key === key)) return false;
    state.agentQueue.push({ type, key, payload: payload || {}, addedAt: Date.now() });
    // Drop the OLDEST on overflow: a queue this full means the user is far
    // ahead of the agent, and the freshest interest is the most relevant.
    if (state.agentQueue.length > AGENT_QUEUE_MAX) state.agentQueue.shift();
    saveAgentQueue();
    updateAgentQueueBadge();
    debug(`[Agent Queue] +${type}:${key} (${state.agentQueue.length} pending)`);
    return true;
}

let _lastUserActivity = Date.now();
let _lastAgentFlush = 0;
let _agentFlushInProgress = false;

function markUserActivity() { _lastUserActivity = Date.now(); }

function updateAgentQueueBadge() {
    const el = document.getElementById("agent-queue-count");
    if (el) el.textContent = String((state.agentQueue || []).length);
}

/** Fires on a timer, but only ACTS when the user has gone quiet. */
function maybeFlushAgentQueue() {
    const q = state.agentQueue || [];
    if (!q.length || _agentFlushInProgress) return;
    const now = Date.now();
    if (now - _lastUserActivity < AGENT_IDLE_MS) return;
    if (now - _lastAgentFlush < AGENT_MIN_GAP_MS) return;
    flushAgentQueue();
}

/**
 * Spend the whole checklist in one pass.
 *
 * Budget scales with accumulated evidence rather than with elapsed time, so one
 * like costs one small call and a long session's worth of signals costs one
 * larger call — never the 8-calls-per-15-seconds the old refill loop spent.
 */
async function flushAgentQueue(force) {
    const q = state.agentQueue || [];
    if (!q.length || _agentFlushInProgress) return;
    _agentFlushInProgress = true;
    _lastAgentFlush = Date.now();

    const jobs = q.slice();
    state.agentQueue = [];
    saveAgentQueue();
    updateAgentQueueBadge();

    const expands = jobs.filter(j => j.type === "expand_topic");
    const budget = Math.min(TOPICS_PER_FLUSH_MAX, Math.max(2, jobs.length * TOPICS_PER_TRIGGER));

    try {
        debug(`[Agent Queue] flushing ${jobs.length} job(s), budget ${budget} topics${force ? " (manual)" : ""}`);
        if (jobs.some(j => j.type === "mine_likes")) {
            await mineLikedVideosIntoTopics();
        }
        if (expands.length) {
            // Strongest evidence first (play > open > impressions, then count):
            // the backend anchors half the expansion on seeds[0], and the
            // strongest reason decides whether the children are born
            // adjacent or explore.
            const strength = { play: 3, open: 2, imp: 1 };
            const ordered = expands.slice().sort((a, b) =>
                ((strength[b.payload.reason] || 0) - (strength[a.payload.reason] || 0)) ||
                ((b.payload.count || 0) - (a.payload.count || 0)));
            const seeds = ordered.map(j => j.payload.topic).filter(Boolean);
            await generateTopicsForSeeds(seeds, budget, ordered[0] && ordered[0].payload.reason);
        }
    } catch (err) {
        console.error("[Agent Queue] flush failed:", err);
        showToast("Topic update failed - will retry later", "error");
        // Put the work back so a failed flush doesn't silently lose the signal.
        state.agentQueue = jobs.concat(state.agentQueue || []).slice(-AGENT_QUEUE_MAX);
        saveAgentQueue();
        updateAgentQueueBadge();
    } finally {
        _agentFlushInProgress = false;
    }
}

function saveTopics()         { persistField("topics", state.topics); }
function saveLikedTopics()    { persistField("liked_topics", state.likedTopics); }
function saveMinedVideos()    { persistField("mined_videos", state.minedVideos); schedulePushRemoteState(); }
function saveTasteProfile()   { persistField("taste_profile", state.tasteProfile); schedulePushRemoteState(); }
function saveGroundingVerdicts() { persistField("grounding_verdicts", state.groundingVerdicts); }
function saveDislikedTopics() { persistField("disliked_topics", state.dislikedTopics); }
function saveTopicPolicies()  { persistField("topic_policies", state.topicPolicies); schedulePushRemoteState(); }
function saveCandidateClassificationCache() { persistField("candidate_classifications", state.candidateClassificationCache); }
function saveCache()          { persistField("cache", state.cache); }
function saveVideoRatings()   { persistField("video_ratings", state.videoRatings); schedulePushRemoteState(); }
function saveNewsRatings()    { persistField("news_ratings", state.newsSourceRatings); }
function saveLikedVideos()    {
    persistField("liked_videos", state.likedVideos);
    invalidateLikedChannelCache();
    scheduleAppStateBroadcast();
    schedulePushRemoteState();
    // Every path that changes likes ends here (card buttons, sidebar, sync
    // rebuild). A like is the one unambiguous "yes" the user gives us, so it
    // enqueues work rather than firing immediately — the flush picks it up once
    // they stop browsing, and carries it alongside everything else pending.
    if (!_syncApplying && collectUnminedLikes().length) {
        enqueueAgentJob("mine_likes", "likes", { pending: collectUnminedLikes().length });
    }
}
function saveSearchHistory()  { persistField("search_history", state.searchHistory); }

// The pool and ontology graph are saved from hot paths (scroll batches, watch
// signals), and JSON.stringify of those blocks blocks the main thread — so both
// are debounced. flushPendingSaves() runs before profile switches and on
// pagehide so pending writes land under the right profile key and survive close.
let _poolSaveTimer = null;
function saveSmartFeedSuggestionPool() {
    clearTimeout(_poolSaveTimer);
    _poolSaveTimer = setTimeout(flushSmartFeedSuggestionPoolSave, 1500);
}
function flushSmartFeedSuggestionPoolSave() {
    clearTimeout(_poolSaveTimer);
    _poolSaveTimer = null;
    // Strip the memoized score before persisting. Entries used to serialize
    // with `_score` baked in, and getScoreAndMatches returns the cached value
    // — so a dislike's -15 dislikedTopics penalty and the -50 user-disliked
    // penalty never applied to anything already in the pool: up to 1000
    // videos frozen at fetch-time scores for 14 days.
    const clean = (state.smartFeedSuggestionPool || []).map(v => {
        // `description` is a classifier hint that already did its job before
        // the entry reached the pool; 1000 x 200 chars is dead weight in storage.
        const { _score, _matchedTopics, description, ...rest } = v;
        return rest;
    });
    persistField("smart_feed_pool", clean);
}

function saveBurnedQueries() { persistField("burned_queries", state.burnedQueries); }

function savePlaylists() {
    if (state.playlists) {
        Object.values(state.playlists).forEach(pl => {
            if (pl && !pl.videos) pl.videos = [];
        });
    }
    persistField("playlists", state.playlists);
    scheduleAppStateBroadcast();
    schedulePushRemoteState();
}

// Save discovered channels helper (profile-aware)
function saveDiscovered() { persistField("discovered_channels", state.discoveredChannels); }

function saveQueue() {
    persistField("queue", state.queue);
    scheduleAppStateBroadcast();
    schedulePushRemoteState();
}

// ── Reverse channel: mirror our state to the browser extension ──
// The Wallgarden extension caches this so the YouTube watch-page "Save" button
// can offer a real playlist picker and badge videos we've already saved. The
// extension's bridge content script (running on this same page) picks the
// message up and relays it to the extension's background worker.
let _appStateBroadcastTimer = null;
function scheduleAppStateBroadcast() {
    clearTimeout(_appStateBroadcastTimer);
    _appStateBroadcastTimer = setTimeout(broadcastAppState, 400);
}

function broadcastAppState() {
    clearTimeout(_appStateBroadcastTimer);
    _appStateBroadcastTimer = null;
    try {
        const playlists = Object.values(state.playlists || {}).map(pl => ({
            id: pl.id,
            name: pl.name,
            count: (pl.videos || []).length
        }));
        const savedIds = new Set();
        (state.queue || []).forEach(v => v && v.id && savedIds.add(v.id));
        Object.values(state.playlists || {}).forEach(pl => {
            (pl.videos || []).forEach(v => v && v.id && savedIds.add(v.id));
        });
        (state.likedVideos || []).forEach(v => v && v.id && savedIds.add(v.id));

        window.postMessage({
            type: 'WG_APP_STATE',
            data: {
                playlists,
                savedVideoIds: [...savedIds],
                watchedIds: Object.keys(state.watchedHistory || {})
            }
        }, "*");
    } catch (e) {
        debug("[Wallgarden Sync] broadcastAppState failed:", e && e.message);
    }
}

// ── Cross-browser sync (wallgarden-sync service — one global monolithic store) ──
// localStorage is per-browser, so a like/unlike/dislike in one browser never
// reaches another. This layer mirrors state to a small server-side store that is
// the single source of truth for ALL browsers (no per-profile partitioning).
//
// Ratings are synced as timestamped decisions, not a set: each video carries
// { r: 5|-5|0, t } and the newest `t` wins on merge — so unlike (r→0) and
// dislike (r→-5) PROPAGATE across browsers, which the recommendation algorithm
// depends on. Queue/playlists/watched stay additive. Fails soft if unreachable.
const WG_SYNC_ENABLED = true;
const WG_SYNC_KEY = "global";   // monolith: everyone shares one document
let _syncApplying = false;      // true while applying a remote merge → suppress push echo
let _wgPushTimer = null;
// Shadows of what the LAST stamp actually observed locally. A removal is only
// real if an item was in one of these and then disappeared; without them, an
// item merged in from the server looks identical to a local deletion and gets
// wrongly tombstoned. Null until the first stamp (we can't infer removals that
// happened while this tab was closed — those were tombstoned in that session).
let _lastStampedRatings = null;   // { videoId: rating }
let _lastStampedQueue = null;     // Set(videoId)
let _lastStampedPlaylists = null; // { playlistId: Set(videoId) }

// Minimal video metadata carried with a rating so any browser can render the
// liked list even if it never saw the video in its own feed.
function _wgVideoMeta(videoId) {
    const v = (typeof findVideoById === "function" && findVideoById(videoId)) ||
        (state.likedVideos || []).find(x => x && x.id === videoId);
    if (!v) return { id: videoId };
    return {
        id: v.id,
        title: v.title,
        channelName: v.channelName,
        channelId: v.channelId,
        published: v.published,
        thumbnailUrl: v.thumbnailUrl || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        duration: v.duration || 0,
        viewCount: v.viewCount || 0
    };
}

// Reconcile the timestamped ratingStates log against the plain videoRatings map
// the rest of the app mutates, stamping `t` on anything that changed. Captures
// every like/unlike/dislike regardless of which code path made it, without
// touching each call site. Skipped while applying a remote merge (that path
// writes ratingStates directly with the authoritative remote timestamps).
function stampRatingStates() {
    if (_syncApplying) return;
    if (!state.ratingStates) state.ratingStates = {};
    const now = Date.now();
    const vr = state.videoRatings || {};
    // Added or changed ratings
    Object.entries(vr).forEach(([id, r]) => {
        const cur = state.ratingStates[id];
        if (!cur || cur.r !== r) {
            state.ratingStates[id] = { r, t: now, v: _wgVideoMeta(id) };
            if (r === 5) {
                markFeedEvent(id, "like");
                const liked = (typeof findVideoById === "function" && findVideoById(id)) || null;
                const topic = liked && (liked.discoveryTopic || liked._topic);
                if (topic) promoteTopicRole(topic, "like");
            }
        }
    });
    // Cleared ratings (unlike / undislike) → tombstone (r=0) so the removal syncs.
    //
    // Only tombstone ids we OBSERVED locally on a previous pass and that have
    // since disappeared — that is a real local unlike. Deriving removal from
    // "in ratingStates but not in videoRatings" is wrong: a rating merged in
    // from the server lands in ratingStates before/without ever being in this
    // browser's videoRatings, and was being misread as a removal — which
    // silently converted another browser's (or the extension's) fresh like
    // into an unlike and pushed that back to the server.
    if (_lastStampedRatings) {
        Object.keys(_lastStampedRatings).forEach(id => {
            if (id in vr) return;
            const st = state.ratingStates[id];
            if (st && st.r !== 0) state.ratingStates[id] = { r: 0, t: now, v: st.v };
        });
    }
    _lastStampedRatings = { ...vr };
    persistField("rating_states", state.ratingStates);
}

function _wgSlim(v) {
    if (!v || !v.id) return v;
    return {
        id: v.id,
        title: v.title,
        channelName: v.channelName,
        channelId: v.channelId,
        published: v.published,
        thumbnailUrl: v.thumbnailUrl || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        duration: v.duration || 0,
        viewCount: v.viewCount || 0
    };
}

// Reconcile the timestamped queue log against state.queue, stamping presence
// tombstones (p=0) for anything removed. Mirrors stampRatingStates.
function stampQueueStates() {
    if (_syncApplying) return;
    if (!state.queueStates) state.queueStates = {};
    const now = Date.now();
    const present = new Set();
    (state.queue || []).forEach(v => {
        if (!v || !v.id) return;
        present.add(v.id);
        const st = state.queueStates[v.id];
        if (!st || st.p !== 1) state.queueStates[v.id] = { p: 1, t: now, v: _wgSlim(v) };
    });
    // Tombstone only ids we saw in the queue on a previous pass (a real local
    // removal) — never one that just arrived from the server. See the note in
    // stampRatingStates().
    if (_lastStampedQueue) {
        _lastStampedQueue.forEach(id => {
            if (present.has(id)) return;
            const st = state.queueStates[id];
            if (st && st.p === 1) state.queueStates[id] = { p: 0, t: now, v: st.v };
        });
    }
    _lastStampedQueue = present;
    persistField("queue_states", state.queueStates);
}

// Reconcile the timestamped playlist log against state.playlists, stamping
// video-removal (p=0) and whole-playlist deletion (deleted) tombstones.
function stampPlaylistStates() {
    if (_syncApplying) return;
    if (!state.playlistStates) state.playlistStates = {};
    const now = Date.now();
    const ps = state.playlistStates;
    const seen = {}; // plId -> Set(videoId) observed this pass
    Object.values(state.playlists || {}).forEach(pl => {
        if (!pl || !pl.id) return;
        let entry = ps[pl.id];
        if (!entry) entry = ps[pl.id] = { name: pl.name, createdAt: pl.createdAt, deleted: false, t: now, videos: {} };
        if (entry.name !== pl.name || entry.deleted) { entry.name = pl.name; entry.deleted = false; entry.t = now; }
        if (!entry.videos) entry.videos = {};
        const present = new Set();
        (pl.videos || []).forEach(v => {
            if (!v || !v.id) return;
            present.add(v.id);
            const vs = entry.videos[v.id];
            if (!vs || vs.p !== 1) entry.videos[v.id] = { p: 1, t: now, v: _wgSlim(v) };
        });
        seen[pl.id] = present;
        // Only tombstone videos we saw in this playlist on a previous pass.
        const before = _lastStampedPlaylists && _lastStampedPlaylists[pl.id];
        if (before) {
            before.forEach(vid => {
                if (present.has(vid)) return;
                const vs = entry.videos[vid];
                if (vs && vs.p === 1) entry.videos[vid] = { p: 0, t: now, v: vs.v };
            });
        }
    });
    // Whole-playlist deletions — again only for playlists we previously observed.
    if (_lastStampedPlaylists) {
        Object.keys(_lastStampedPlaylists).forEach(plid => {
            if (plid in (state.playlists || {})) return;
            const entry = ps[plid];
            if (entry && !entry.deleted) { entry.deleted = true; entry.t = now; }
        });
    }
    _lastStampedPlaylists = seen;
    persistField("playlist_states", ps);
}

// Rebuild state.queue from queueStates (present items, ordered by add time).
function _wgRebuildQueue() {
    const items = Object.values(state.queueStates || {})
        .filter(st => st.p === 1 && st.v)
        .sort((a, b) => (a.t || 0) - (b.t || 0))
        .map(st => st.v);
    state.queue = items;
    saveQueue();
}

// Rebuild state.playlists from playlistStates (non-deleted playlists, present videos).
function _wgRebuildPlaylists() {
    const out = {};
    Object.entries(state.playlistStates || {}).forEach(([plid, entry]) => {
        if (entry.deleted) return;
        const videos = Object.values(entry.videos || {})
            .filter(vs => vs.p === 1 && vs.v)
            .sort((a, b) => (a.t || 0) - (b.t || 0))
            .map(vs => vs.v);
        out[plid] = { id: plid, name: entry.name, createdAt: entry.createdAt, videos };
    });
    state.playlists = out;
    savePlaylists();
}

// Merge an incoming flat LWW map ({key: {t,...}}) into a target in place,
// newest `t` wins. Returns whether anything changed. Used for queue + a
// playlist's nested videos map.
function _wgMergeLwwInto(target, incoming) {
    let changed = false;
    Object.entries(incoming || {}).forEach(([key, rec]) => {
        if (!rec || typeof rec.t !== "number") return;
        const cur = target[key];
        if (!cur || rec.t > (cur.t || 0)) { target[key] = rec; changed = true; }
    });
    return changed;
}

function _wgMergeIncomingPlaylists(incoming) {
    if (!state.playlistStates) state.playlistStates = {};
    let changed = false;
    Object.entries(incoming || {}).forEach(([plid, pl]) => {
        if (!pl) return;
        let entry = state.playlistStates[plid];
        if (!entry) { state.playlistStates[plid] = pl; changed = true; return; }
        // Playlist meta (name/deleted) is LWW on the playlist t
        if ((pl.t || 0) > (entry.t || 0)) {
            entry.name = pl.name;
            entry.deleted = !!pl.deleted;
            entry.createdAt = pl.createdAt != null ? pl.createdAt : entry.createdAt;
            entry.t = pl.t;
            changed = true;
        }
        if (!entry.videos) entry.videos = {};
        if (_wgMergeLwwInto(entry.videos, pl.videos)) changed = true;
    });
    return changed;
}

function _wgSyncSnapshot() {
    stampRatingStates();
    stampQueueStates();
    stampPlaylistStates();
    const snapshot = {
        ratings: state.ratingStates || {},
        queue: state.queueStates || {},
        playlists: state.playlistStates || {},
        watched: state.watchedHistory || {},
        mined: state.minedVideos || {},
        topicSignals: state.topicSignals || {}
    };
    // Only ship a profile that exists — an empty object would fight the
    // server's LWW merge for no reason.
    if (state.tasteProfile && state.tasteProfile.generatedAt) {
        snapshot.profile = state.tasteProfile;
    }
    return snapshot;
}

// Rebuild the derived videoRatings map + likedVideos list from ratingStates,
// and nudge the ontology graph for anything that flipped.
function _wgRebuildFromRatingStates(changedIds) {
    const newRatings = {};
    const liked = [];
    // Sort by rating time so likedVideos stays chronological — a sync merge
    // hands us Mongo key order, and every consumer of "recent likes" breaks
    // silently on that (slice(-15) becomes an arbitrary 15).
    Object.entries(state.ratingStates)
        .sort((a, b) => (a[1].t || 0) - (b[1].t || 0))
        .forEach(([id, st]) => {
        if (st.r === 5) {
            newRatings[id] = 5;
            const existing = (state.likedVideos || []).find(v => v && v.id === id);
            liked.push(existing || st.v || { id });
        } else if (st.r === -5) {
            newRatings[id] = -5;
        }
    });
    state.videoRatings = newRatings;
    state.likedVideos = liked;
    saveVideoRatings();
    saveLikedVideos();

    // Reflect flips into the ontology graph (mirrors the manual like/dislike paths)
    if (state.ontologyGraph && changedIds && changedIds.size) {
        changedIds.forEach(id => {
            const st = state.ratingStates[id];
            if (!st) return;
            const delta = st.r === 5 ? 1 : (st.r === -5 ? -1 : 0);
            if (delta !== 0) {
                const v = st.v || { id };
                graphProcessRating(state.ontologyGraph, { ...v, matchedTopics: v.matchedTopics || [] }, delta);
            }
        });
        saveOntologyGraph();
    }
}

// Apply a remote field bundle into local state (LWW ratings + additive rest).
/**
 * Merge remote topic signals into the local ledger.
 *
 * Per-CLIENT max, never a sum: the client re-pushes its whole map every 1.5s,
 * so summing would inflate counts on every push. Each browser only ever writes
 * its own sub-counter, and that sub-counter is monotonic, so max is both
 * lossless and idempotent. The effective total is the sum ACROSS clients, taken
 * at read time in topicSignalTotal().
 *
 * This is why topicSignals cannot use _merge_lww_map like every other synced
 * field: whole-record LWW would throw away the other browser's progress toward
 * a threshold every time this browser wrote.
 */
function mergeTopicSignals(local, remote) {
    const out = local && typeof local === "object" ? local : {};
    Object.entries(remote || {}).forEach(([topic, rec]) => {
        if (!rec || typeof rec !== "object") return;
        const cur = out[topic] || (out[topic] = { t: 0, c: {}, f: {} });
        Object.entries(rec.c || {}).forEach(([cid, per]) => {
            if (!per || typeof per !== "object") return;
            const mine = cur.c[cid] || (cur.c[cid] = {});
            Object.entries(per).forEach(([kind, n]) => {
                if (typeof n === "number") mine[kind] = Math.max(mine[kind] || 0, n);
            });
        });
        // Fired-at marks are high-water marks too — take the larger so a
        // threshold already spent elsewhere is not spent a second time here.
        Object.entries(rec.f || {}).forEach(([kind, n]) => {
            if (typeof n === "number") cur.f[kind] = Math.max(cur.f[kind] || 0, n);
        });
        cur.t = Math.max(cur.t || 0, rec.t || 0);
    });
    return out;
}

function _wgApplyRemoteFields(fields) {
    if (!fields) return;
    _syncApplying = true;
    try {
        if (fields.topicSignals) {
            state.topicSignals = mergeTopicSignals(state.topicSignals, fields.topicSignals);
            persistField("topic_signals", state.topicSignals);
        }
        if (fields.ratings) {
            if (!state.ratingStates) state.ratingStates = {};
            const changed = new Set();
            Object.entries(fields.ratings).forEach(([id, rec]) => {
                if (!rec || typeof rec.t !== "number") return;
                const cur = state.ratingStates[id];
                if (!cur || rec.t > (cur.t || 0)) {
                    // Newer decision from elsewhere wins (incl. unlike r=0, dislike r=-5)
                    if (!cur || cur.r !== rec.r) changed.add(id);
                    state.ratingStates[id] = rec;
                }
            });
            persistField("rating_states", state.ratingStates);
            _wgRebuildFromRatingStates(changed);

            // In-place UI update for rating buttons on already-rendered cards
            if (changed && changed.size > 0 && typeof document !== "undefined") {
                changed.forEach(vidId => {
                    const rating = state.videoRatings ? state.videoRatings[vidId] : undefined;
                    const card = document.querySelector(`.video-card[data-video-id="${vidId}"]`);
                    if (card) {
                        const upBtn = card.querySelector(".thumb-up");
                        const downBtn = card.querySelector(".thumb-down");
                        if (upBtn) upBtn.classList.toggle("active", rating === 5);
                        if (downBtn) downBtn.classList.toggle("active", rating === -5);
                    }
                });
            }
        }
        if (fields.queue) {
            if (!state.queueStates) state.queueStates = {};
            if (_wgMergeLwwInto(state.queueStates, fields.queue)) {
                persistField("queue_states", state.queueStates);
                _wgRebuildQueue();
            }
        }
        if (fields.playlists) {
            if (_wgMergeIncomingPlaylists(fields.playlists)) {
                persistField("playlist_states", state.playlistStates);
                _wgRebuildPlaylists();
            }
        }
        if (fields.watched) {
            if (!state.watchedHistory) state.watchedHistory = {};
            Object.entries(fields.watched).forEach(([vid, ts]) => {
                state.watchedHistory[vid] = Math.max(state.watchedHistory[vid] || 0, ts || 0);
            });
            localStorage.setItem("wallgarden_watched", JSON.stringify(state.watchedHistory));
        }
        if (fields.mined) {
            // Another browser already paid the LLM call — replay its
            // extractions into our local topic pool. applyMinedTopics marks
            // each id in minedVideos, so this is idempotent.
            if (!state.minedVideos) state.minedVideos = {};
            let applied = 0;
            Object.entries(fields.mined).forEach(([vid, rec]) => {
                if (!rec || !Array.isArray(rec.topics)) return;
                const cur = state.minedVideos[vid];
                if (cur && (cur.t || 0) >= (rec.t || 0)) return;
                // Remote entries carry plain labels; re-enter them at the
                // default mined weight (tier unknown -> treat as B).
                applyMinedTopics(vid, rec.topics.map(t2 => ({ topic: t2, tier: "B", weight: 4 })), { quiet: true });
                state.minedVideos[vid] = rec; // keep the remote timestamp
                applied++;
            });
            if (applied > 0) {
                pruneTopicPool();
                saveTopics();
                saveLikedTopics();
                persistField("mined_videos", state.minedVideos);
                saveOntologyGraph();
                debug(`[Sync] Applied ${applied} mined-video extractions from another browser.`);
            }
        }
        if (fields.profile && fields.profile.generatedAt) {
            if (!state.tasteProfile || (state.tasteProfile.generatedAt || 0) < fields.profile.generatedAt) {
                state.tasteProfile = fields.profile;
                persistField("taste_profile", state.tasteProfile);
                debug("[Sync] Adopted newer taste profile from another browser.");
            }
        }
    } finally {
        _syncApplying = false;
    }
    // Refresh views only when not in smart-feed (smart-feed reconciles in-place)
    if (state.currentView !== "smart-feed") {
        try { renderFeed(); } catch (e) { /* view may not be ready */ }
    }
    try { if (typeof renderQueueUI === "function") renderQueueUI(); } catch (e) {}
    try { if (state.currentView === "liked-videos" && typeof renderLikedVideosView === "function") renderLikedVideosView(); } catch (e) {}
    try { if (state.currentView === "playlists" && typeof renderPlaylistsView === "function") renderPlaylistsView(); } catch (e) {}
}

function schedulePushRemoteState() {
    if (_syncApplying || !WG_SYNC_ENABLED) return;
    clearTimeout(_wgPushTimer);
    _wgPushTimer = setTimeout(pushRemoteState, 1500);
}

async function pushRemoteState() {
    if (!WG_SYNC_ENABLED) return;
    try {
        const res = await fetch(`/sync/${WG_SYNC_KEY}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: _wgSyncSnapshot() })
        });
        if (res.ok) {
            const data = await res.json();
            _wgApplyRemoteFields(data.fields);  // pick up other browsers' merged changes
        }
    } catch (e) {
        debug("[Sync] push failed:", e && e.message);
    }
}

async function pullRemoteState() {
    if (!WG_SYNC_ENABLED) return;
    try {
        const res = await fetch(`/sync/${WG_SYNC_KEY}`);
        if (res.ok) {
            const data = await res.json();
            _wgApplyRemoteFields(data.fields);
            // Upload our local-only decisions so the server has the full picture
            schedulePushRemoteState();
        }
    } catch (e) {
        debug("[Sync] pull failed:", e && e.message);
    }
}

function startCrossBrowserSync() {
    if (!WG_SYNC_ENABLED) return;
    // Seed ratingStates from any pre-existing local ratings on first run
    stampRatingStates();
    pullRemoteState();
    // Poll so decisions made in another browser show up without a manual reload
    setInterval(pullRemoteState, 45000);
    // Flush any pending push before the tab goes away
    window.addEventListener("pagehide", () => {
        if (_wgPushTimer) {
            clearTimeout(_wgPushTimer);
            try {
                navigator.sendBeacon(
                    `/sync/${WG_SYNC_KEY}`,
                    new Blob([JSON.stringify({ fields: _wgSyncSnapshot() })], { type: "application/json" })
                );
            } catch (e) { /* best effort */ }
        }
    });
}

let _graphSaveTimer = null;
function saveOntologyGraph() {
    clearTimeout(_graphSaveTimer);
    _graphSaveTimer = setTimeout(flushOntologyGraphSave, 1500);
}
function flushOntologyGraphSave() {
    clearTimeout(_graphSaveTimer);
    _graphSaveTimer = null;
    localStorage.setItem(getProfileKey("ontology_graph"), JSON.stringify(state.ontologyGraph));
}

function flushPendingSaves() {
    if (_poolSaveTimer !== null) flushSmartFeedSuggestionPoolSave();
    if (_graphSaveTimer !== null) flushOntologyGraphSave();
}
window.addEventListener("pagehide", flushPendingSaves);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSaves();
});

// Mobile Sidebar Helpers
function closeMobileSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.add("hidden");
}

// Setup Interactive UI Listeners
function setupEventListeners() {
    setupNavListeners();
    setupSettingsModalListeners();
    setupSettingsTabListeners();
    setupChannelListeners();
    setupTopicPrefListeners();
    setupSettingsToggleListeners();
    setupSearchListeners();
    setupProfilesUI();
    setupHeaderAndLikedListeners();
    setupKeyboardShortcuts();
}

function setupNavListeners() {
    // Navigation
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
            closeMobileSidebar();
            // If watching a video, minimize to floating miniplayer so the new view has full width
            if (state.currentlyPlayingId && document.body.classList.contains("watch-mode")) {
                setMiniplayerMode(true);
            }
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
            const inputFilterLiked = document.getElementById("input-filter-liked");
            if (inputFilterLiked) inputFilterLiked.value = "";

            state.currentView = btn.dataset.view;
            state.discoverBatchIndex = 0;
            state.discoverMaxReached = false;
            document.getElementById("current-view-title").textContent = btn.querySelector(".nav-label").textContent;
            
            if (state.currentView === "smart-feed") {
                state.smartFeedVideos = [];
                // Do not clear persistent suggestions pool so we can render instantly
                initSmartFeed(); // Repopulates and randomizes topics queue
            } else if (state.currentView === "discover-channels") {
                initDiscoverChannels();
            }
            
            renderFeed();
        });
    });

    // Mobile Sidebar Toggles
    const btnToggle = document.getElementById("btn-sidebar-toggle");
    const btnCloseSidebar = document.getElementById("btn-sidebar-close");
    const sidebarOverlay = document.getElementById("sidebar-overlay");
    const sidebar = document.querySelector(".sidebar");

    if (btnToggle) {
        btnToggle.addEventListener("click", () => {
            if (sidebar) sidebar.classList.add("open");
            if (sidebarOverlay) sidebarOverlay.classList.remove("hidden");
        });
    }

    // Desktop nav collapse to an icon rail. The initial state is applied
    // pre-paint by the inline script in index.html; this only toggles.
    const btnNavCollapse = document.getElementById("btn-nav-collapse");
    if (btnNavCollapse) {
        btnNavCollapse.addEventListener("click", () => {
            const root = document.documentElement;
            const collapsed = root.getAttribute("data-nav-collapsed") === "true";
            if (collapsed) {
                root.removeAttribute("data-nav-collapsed");
                btnNavCollapse.title = "Collapse sidebar";
                btnNavCollapse.setAttribute("aria-label", "Collapse navigation");
            } else {
                root.setAttribute("data-nav-collapsed", "true");
                btnNavCollapse.title = "Expand sidebar";
                btnNavCollapse.setAttribute("aria-label", "Expand navigation");
            }
            localStorage.setItem("nav-collapsed", collapsed ? "0" : "1");
        });
        if (document.documentElement.getAttribute("data-nav-collapsed") === "true") {
            btnNavCollapse.title = "Expand sidebar";
            btnNavCollapse.setAttribute("aria-label", "Expand navigation");
        }
    }
    if (btnCloseSidebar) {
        btnCloseSidebar.addEventListener("click", closeMobileSidebar);
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener("click", closeMobileSidebar);
    }
}

function setupSettingsModalListeners() {
    // Sync button
    const btnSync = document.getElementById("btn-sync-now");
    if (btnSync) {
        btnSync.addEventListener("click", () => syncFeeds());
    }

    // Settings Modal toggles
    const btnOpenSettings = document.getElementById("btn-open-settings");
    const btnCloseSettings = document.getElementById("btn-close-settings");
    const settingsModal = document.getElementById("settings-modal");

    btnOpenSettings.addEventListener("click", () => {
        closeMobileSidebar();
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

    const refreshNewsBtn = document.getElementById("btn-refresh-news");
    if (refreshNewsBtn) {
        refreshNewsBtn.addEventListener("click", () => {
            const btnText = refreshNewsBtn.querySelector(".btn-text");
            const spinner = refreshNewsBtn.querySelector(".sync-spinner");
            if (btnText) btnText.textContent = "Refreshing...";
            if (spinner) spinner.style.animation = "spin 1s linear infinite";
            refreshNewsBtn.disabled = true;
            
            renderNewsFeed().finally(() => {
                if (btnText) btnText.textContent = "Refresh News";
                if (spinner) spinner.style.animation = "none";
                refreshNewsBtn.disabled = false;
            });
        });
    }

    const btnCreatePlaylist = document.getElementById("btn-create-playlist");
    if (btnCreatePlaylist) {
        btnCreatePlaylist.addEventListener("click", () => {
            showPlaylistModal(null);
        });
    }

    const btnBackToPlaylists = document.getElementById("btn-back-to-playlists");
    if (btnBackToPlaylists) {
        btnBackToPlaylists.addEventListener("click", () => {
            renderPlaylistsView();
        });
    }
}

function setupSettingsTabListeners() {
    // Settings Tabs toggles
    document.querySelectorAll(".settings-tab-button").forEach(btn => {
        btn.addEventListener("click", (e) => {
            // Instant UI update
            document.querySelectorAll(".settings-tab-button").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
            e.target.classList.add("active");
            document.getElementById(e.target.dataset.tabIdentifier).classList.add("active");

            if (e.target.dataset.tabIdentifier === "tab-ontology") {
                // Defer heavy graph processing to unblock the main thread and fix poor INP
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        // Run smart prune + channel similarity before rendering
                        if (state.ontologyGraph) {
                            graphSmartPrune(state.ontologyGraph);
                            graphBuildChannelSimilarity(state.ontologyGraph);
                            saveOntologyGraph();
                        }
                        renderOntologyView();
                    }, 0);
                });
            }
        });
    });

    const graphFilterWeight = document.getElementById("graph-filter-weight");
    if (graphFilterWeight) {
        graphFilterWeight.addEventListener("change", () => {
            if (document.getElementById("tab-ontology").classList.contains("active")) {
                renderOntologyView();
            }
        });
    }

    const btnPruneGraph = document.getElementById("btn-prune-graph");
    if (btnPruneGraph) {
        btnPruneGraph.addEventListener("click", () => {
            if (!confirm("Are you sure you want to force prune the knowledge graph? This removes dead nodes and edges below thresholds.")) return;
            graphPrune(state.ontologyGraph);
            state.ontologyGraph.lastPruned = Date.now();
            saveOntologyGraph();
            renderOntologyView();
            showToast("Graph successfully pruned", "success");
        });
    }
}

function setupChannelListeners() {
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
}

function setupTopicPrefListeners() {
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
            state.topics.push({ phrase, weight, addedAt: Date.now(), role: "core", bornRole: "core" });
        }
        
        saveTopics();
        document.getElementById("input-topic-phrase").value = "";
        renderTopicsList();
        
        // If a positive topic was added, seed the smart feed pipeline
        if (weight > 0) {
            if (!state.smartFeedTopicsQueue.includes(phrase)) {
                state.smartFeedTopicsQueue.push(phrase);
            }
            // Kick the preloader + brainstormer if this is among the first topics
            fillSmartFeedPreloadBuffer();
            generateBrainstormTopics(true, 1);
        }
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
}

function setupSettingsToggleListeners() {
    // Close Inline Player — bound dynamically when player is created by playVideo()

    // Global settings toggles
    const googleApiToggle = document.getElementById("toggle-use-google-api-search");
    if (googleApiToggle) {
        googleApiToggle.addEventListener("change", (e) => {
            state.settings.useGoogleApiSearch = e.target.checked;
            saveSettings();
        });
    }
    document.getElementById("toggle-use-ytdlp").addEventListener("change", (e) => {
        state.settings.useYtdlp = e.target.checked;
        saveSettings();
    });
    document.getElementById("toggle-mute-shorts").addEventListener("change", (e) => {
        state.settings.muteShorts = e.target.checked;
        saveSettings();
        renderFeed();
    });
    const groundingToggleEl = document.getElementById("toggle-grounding");
    if (groundingToggleEl) {
        groundingToggleEl.addEventListener("change", (e) => {
            state.settings.groundingEnabled = e.target.checked;
            saveSettings();
            if (e.target.checked) scheduleGrounding(2000);
        });
    }
    const statsToggleEl = document.getElementById("toggle-stats-prompt");
    if (statsToggleEl) {
        statsToggleEl.addEventListener("change", (e) => {
            state.settings.statsPromptEnabled = e.target.checked;
            saveSettings();
            showToast(e.target.checked
                ? "Prompts will use your measured outcomes"
                : "Prompts back to the flat context - compare with wgPromptAB()", "info");
        });
    }
    const selectLlmModel = document.getElementById("select-llm-model");
    if (selectLlmModel) {
        selectLlmModel.addEventListener("change", (e) => {
            state.settings.llmModel = e.target.value;
            saveSettings();
        });
    }
    const btnRefreshModels = document.getElementById("btn-refresh-models");
    if (btnRefreshModels) {
        btnRefreshModels.addEventListener("click", () => {
            fetchWallgardenModels();
        });
    }
    const altPlayerInput = document.getElementById("input-alt-player-instance");
    if (altPlayerInput) {
        altPlayerInput.addEventListener("input", (e) => {
            state.settings.altPlayerInstance = e.target.value.trim() || "https://yewtu.be";
            saveSettings();
        });
    }
    const weatherCityInput = document.getElementById("input-weather-city");
    if (weatherCityInput) {
        weatherCityInput.addEventListener("change", (e) => {
            state.settings.weatherCity = e.target.value.trim();
            saveSettings();
            fetchWeather();
        });
    }

    const weatherWidget = document.getElementById("weather-widget");
    if (weatherWidget) {
        weatherWidget.addEventListener("click", () => {
            const newCity = prompt("Enter a city name for weather forecast (or leave blank to use your IP location):", state.settings.weatherCity || "");
            if (newCity !== null) {
                state.settings.weatherCity = newCity.trim();
                saveSettings();
                weatherWidget.innerHTML = `<div class="weather-loading" style="font-size: 0.85rem; color: var(--text-muted); padding: 0.5rem 1rem;">Loading weather...</div>`;
                fetchWeather();
            }
        });
    }
}

function setupSearchListeners() {
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
        // The explicit escape hatch. Spends anything pending in the checklist
        // first (that work is backed by real signal), and only falls back to a
        // cold brainstorm when there is nothing earned to spend.
        btnBrainstormMore.addEventListener("click", () => {
            if ((state.agentQueue || []).length) return flushAgentQueue(true);
            return generateBrainstormTopics();
        });
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

function setupHeaderAndLikedListeners() {
    // Scroll listener for sticky main header background color / backdrop filter fade
    const feedSection = document.querySelector(".feed-section");
    const mainHeader = document.querySelector(".main-header");
    if (feedSection && mainHeader) {
        feedSection.addEventListener("scroll", () => {
            const scrollTop = feedSection.scrollTop;
            const maxScroll = 100;
            const ratio = Math.min(scrollTop / maxScroll, 1);
            
            // Background opacity goes from 0 to 0.85
            const bgOpacity = ratio * 0.85;
            // Blur goes from 0 to 12px
            const blurAmt = ratio * 12;
            
            mainHeader.style.background = `rgba(3, 7, 18, ${bgOpacity})`;
            mainHeader.style.backdropFilter = `blur(${blurAmt}px)`;
            mainHeader.style.webkitBackdropFilter = `blur(${blurAmt}px)`;
            mainHeader.style.borderColor = `rgba(59, 130, 246, ${ratio * 0.12})`;
        });
    }

    // Liked Videos controls
    const inputFilterLiked = document.getElementById("input-filter-liked");
    if (inputFilterLiked) {
        inputFilterLiked.addEventListener("input", (e) => {
            const query = e.target.value.trim().toLowerCase();
            const cards = document.querySelectorAll("#liked-videos-grid .video-card");
            cards.forEach(card => {
                const title = (card.querySelector(".video-title")?.textContent || "").toLowerCase();
                const channel = (card.querySelector(".channel-link")?.textContent || "").toLowerCase();
                if (title.includes(query) || channel.includes(query)) {
                    card.classList.remove("hidden");
                } else {
                    card.classList.add("hidden");
                }
            });
        });
    }

    const btnClearLiked = document.getElementById("btn-clear-liked-videos");
    if (btnClearLiked) {
        btnClearLiked.addEventListener("click", () => {
            if (!state.likedVideos || state.likedVideos.length === 0) {
                showToast("No liked videos to clear", "info");
                return;
            }
            if (confirm("Are you sure you want to clear all liked videos? This will also revert their weights in the ontology graph.")) {
                // Revert ontology graph weights
                if (state.ontologyGraph) {
                    state.likedVideos.forEach(video => {
                        graphProcessRating(state.ontologyGraph, {
                            ...video,
                            matchedTopics: video._matchedTopics || video.matchedTopics || []
                        }, -1);
                    });
                    saveOntologyGraph();
                }
                
                // Clear state
                state.likedVideos.forEach(v => {
                    delete state.videoRatings[v.id];
                });
                state.likedVideos = [];
                saveLikedVideos();
                saveVideoRatings();
                
                showToast("Cleared all liked videos", "success");
                renderLikedVideosView();
            }
        });
    }
}

// Render profile options inside Settings tab dropdowns
function renderProfileDropdowns() {
    const selectActive = document.getElementById("select-active-profile");
    const selectDelete = document.getElementById("select-delete-profile");
    if (!selectActive || !selectDelete) return;

    selectActive.innerHTML = "";
    selectDelete.innerHTML = "";

    state.profiles.forEach(p => {
        const optActive = document.createElement("option");
        optActive.value = p;
        optActive.textContent = p === "default" ? "Default Profile" : p;
        optActive.selected = (p === state.currentProfile);
        selectActive.appendChild(optActive);

        if (p !== "default") {
            const optDelete = document.createElement("option");
            optDelete.value = p;
            optDelete.textContent = p;
            selectDelete.appendChild(optDelete);
        }
    });
}

// Switch active profile
function switchProfile(profileName) {
    if (!state.profiles.includes(profileName)) return;
    
    debug(`[Profiles] Switching from ${state.currentProfile} to ${profileName}`);
    
    // Save current profile settings/state
    saveSettings();
    saveBlocked();
    saveChannels();
    saveTopics();
    saveLikedTopics();
    saveDislikedTopics();
    saveCache();
    saveVideoRatings();
    saveNewsRatings();
    saveLikedVideos();
    saveSearchHistory();
    saveBurnedQueries();
    savePlaylists();
    saveQueue();
    saveDiscovered();
    // Debounced saves must land under the OLD profile's keys before the switch
    flushSmartFeedSuggestionPoolSave();
    flushOntologyGraphSave();

    // Set new current profile
    state.currentProfile = profileName;
    localStorage.setItem("wallgarden_current_profile", profileName);

    // Reset Smart Feed transient state
    state.smartFeedVideos = [];
    state.smartFeedSuggestionPool = [];
    state.smartFeedTopicsQueue = [];
    state.smartFeedUsedTopics = [];
    state.smartFeedInitialized = false;

    // Load new profile
    loadState();

    // Reset views and clear grid
    state.currentView = "smart-feed";
    state.searchQuery = "";
    const searchInput = document.getElementById("input-search-videos");
    if (searchInput) searchInput.value = "";
    
    document.querySelectorAll(".nav-item").forEach(btn => {
        if (btn.dataset.view === "smart-feed") btn.classList.add("active");
        else btn.classList.remove("active");
    });
    
    const titleEl = document.getElementById("current-view-title");
    if (titleEl) titleEl.textContent = "Smart Feed";

    // Close settings modal to show the fresh feed
    const modal = document.getElementById("settings-modal");
    if (modal) modal.classList.add("hidden");

    showToast(`Switched profile to: ${profileName === "default" ? "Default" : profileName}`, "success");
    
    // Re-render feed and trigger background preload if there are topics
    renderFeed();
    renderSearchSuggestions();
    
    if (state.topics.filter(t => t.weight > 0).length > 0) {
        initSmartFeed();
    }

    // Re-sync against the new profile's shared state (cancel any push still
    // queued from the outgoing profile's flush first).
    clearTimeout(_wgPushTimer);
    pullRemoteState();
}

// Create new profile
function createProfile(profileName) {
    profileName = profileName.trim().replace(/[^a-zA-Z0-9_\s-]/g, "");
    if (!profileName) {
        showToast("Profile name cannot be empty or contain special characters.", "danger");
        return;
    }
    
    const profileKey = profileName.toLowerCase();
    if (state.profiles.includes(profileKey)) {
        showToast(`Profile "${profileName}" already exists.`, "danger");
        return;
    }

    state.profiles.push(profileKey);
    localStorage.setItem("wallgarden_profiles", JSON.stringify(state.profiles));
    
    // Switch to new profile
    switchProfile(profileKey);
    showToast(`Created and switched to profile: ${profileName}`, "success");
}

// Delete profile
function deleteProfile(profileName) {
    if (profileName === "default") {
        showToast("Cannot delete the default profile.", "danger");
        return;
    }

    if (!confirm(`Are you sure you want to permanently delete profile "${profileName}"? This will nuke all its data.`)) {
        return;
    }
    
    // If deleting the active profile, switch to default first
    if (profileName === state.currentProfile) {
        switchProfile("default");
    }

    // Remove from profiles list
    state.profiles = state.profiles.filter(p => p !== profileName);
    localStorage.setItem("wallgarden_profiles", JSON.stringify(state.profiles));

    // Remove all associated keys from localStorage
    const keysToRemove = [
        "channels", "topics", "blocked_channels", "cache", "settings",
        "search_history", "brainstorm_topics", "video_ratings",
        "discovered_channels", "smart_feed_pool", "liked_topics",
        "disliked_topics", "burned_queries", "playlists", "liked_videos",
        "news_ratings", "queue", "ontology_graph",
        "mined_videos", "taste_profile", "grounding_verdicts", "pool_version"
    ];
    keysToRemove.forEach(k => {
        localStorage.removeItem(`wallgarden_${profileName}_${k}`);
    });

    renderProfileDropdowns();
    showToast(`Deleted profile "${profileName}"`, "info");
}

// Setup Profiles Event Listeners
function setupProfilesUI() {
    const btnSwitch = document.getElementById("btn-switch-profile");
    const btnCreate = document.getElementById("btn-create-profile");
    const btnDelete = document.getElementById("btn-delete-profile");
    const selectActive = document.getElementById("select-active-profile");
    const selectDelete = document.getElementById("select-delete-profile");
    const inputNew = document.getElementById("input-new-profile-name");

    if (btnSwitch) {
        btnSwitch.addEventListener("click", () => {
            if (selectActive) switchProfile(selectActive.value);
        });
    }

    if (btnCreate) {
        btnCreate.addEventListener("click", () => {
            if (inputNew) {
                const name = inputNew.value;
                createProfile(name);
                inputNew.value = "";
            }
        });
    }

    if (btnDelete) {
        btnDelete.addEventListener("click", () => {
            if (selectDelete) deleteProfile(selectDelete.value);
        });
    }
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

let isSyncingFeeds = false;

// Fetch Feeds in parallel via Nginx proxy and parse XML
async function syncFeeds() {
    if (isSyncingFeeds) {
        debug("syncFeeds is already running. Skipping concurrent request.");
        return;
    }
    if (state.channels.length === 0) {
        updateStatusText("No channels to sync.");
        return;
    }
    isSyncingFeeds = true;

    // Clear session topic search cache on sync to fetch fresh results next time, but preserve currently loading ones
    for (const key in sessionTopicSearchCache) {
        if (!topicSearchLoading[key]) {
            delete sessionTopicSearchCache[key];
        }
    }

    const btnSync = document.getElementById("btn-sync-now");
    if (btnSync) btnSync.classList.add("spinning");
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
                            const publishedStr = entry.querySelector("published")?.textContent;
                            const published = publishedStr ? Date.parse(publishedStr) : null;
                            
                            const ytMatch = content.match(/href="https:\/\/(?:www\.)?youtube\.com\/watch\?v=([^"&?]+)/) || 
                                            content.match(/href="https:\/\/youtu\.be\/([^"&?]+)/);
                            
                            if (ytMatch && ytMatch[1]) {
                                videos.push({
                                    id: ytMatch[1],
                                    title: title,
                                    channelName: channel.name,
                                    channelId: channel.id,
                                    published: published,
                                    description: content || ""
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
                                                 entry.querySelector("updated")?.textContent || null;
                            const published = publishedStr ? Date.parse(publishedStr) : null;
                            
                            const mediaGroup = entry.getElementsByTagName("media:group")[0];
                            const description = mediaGroup ? mediaGroup.getElementsByTagName("media:description")[0]?.textContent : "";
                                                 
                            if (videoId && title) {
                                videos.push({
                                    id: videoId,
                                    title: title,
                                    channelName: feedTitle || channel.name,
                                    channelId: channel.id,
                                    published: published,
                                    description: description || ""
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
                    debug(`Syncing channel ${channel.name} (${channel.id}) via scraper-service...`);
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
                            limit: 10,
                            days_back: 0,
                            require_transcript: false,
                            sort: "date"
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
                                    published: item.published_at ? Date.parse(item.published_at) : null,
                                    description: item.description || ""
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
                // Sort by publication date (descending)
                merged.sort((a, b) => (b.published || 0) - (a.published || 0));
                results[channel.id] = merged.slice(0, 50);
            } else {
                console.warn(`All sync methods failed for channel ${channel.name}. Retaining cache.`);
                if (state.cache.videos[channel.id]) {
                    results[channel.id] = state.cache.videos[channel.id];
                }
            }
        }
    };
    
    try {
        const workers = Array(Math.min(maxConcurrency, channelsToSync.length))
            .fill(null)
            .map(() => worker());
            
        await Promise.all(workers);
        
        state.cache.videos = results;
        
        // Auto-suppress channels the graph has learned to avoid
        if (state.ontologyGraph) {
            const graphBlocked = graphGetDislikedChannels(state.ontologyGraph, -6);
            graphBlocked.forEach(gc => {
                // gc.id is the channel NAME: graphGetDislikedChannels returns
                // n.label, and every label is overwritten with the human name
                // at upsert. Writing it into `id` as well made auto-blocks
                // match NOTHING — the id compare failed against real UC… ids
                // and the truthy id disabled the old name path. Name-only,
                // matched by equality in isChannelBlocked.
                const already = state.blockedChannels.some(bc =>
                    (bc.name || "").toLowerCase() === String(gc.id).toLowerCase());
                if (!already) {
                    debug(`[Ontology] Auto-suppressing channel ${gc.id} (graph weight: ${gc.weight})`);
                    state.blockedChannels.push({ name: gc.id, id: "", autoBlocked: true });
                }
            });
            saveBlocked();
        }

        state.cache.lastSync = Date.now();
        saveCache();
        saveChannels(); // Updates names if they changed
        
        updateStatusText("Synced successfully just now");
        
        renderFeed();
    } catch (err) {
        console.error("Error during syncFeeds:", err);
        updateStatusText("Sync failed");
    } finally {
        isSyncingFeeds = false;
        const btnSync = document.getElementById("btn-sync-now");
        if (btnSync) btnSync.classList.remove("spinning");
    }
}

// Compute custom interest score for a video
/**
 * A dislike now reaches the pool it used to bounce off.
 *
 * Pool entries persisted with a memoized `_score`, and getScoreAndMatches
 * returns the cached value — so the -15 dislikedTopics penalty and the -50
 * user-disliked penalty never applied to anything already queued: up to 1000
 * videos frozen at fetch-time scores for as long as 14 days. Evicting the
 * disliked video's topic- and channel-mates is the direct fix; dropping the
 * frozen scores is the one that makes every remaining entry re-judge itself.
 *
 * Returns the number of evicted entries.
 */
function evictPoolForDislike(topic, channelName) {
    const dislikedTopic = (topic || "").trim().toLowerCase();
    const dislikedChannel = (channelName || "").toLowerCase();
    if (!dislikedTopic && !dislikedChannel) return 0;

    const before = (state.smartFeedSuggestionPool || []).length;
    state.smartFeedSuggestionPool = (state.smartFeedSuggestionPool || []).filter(pv => {
        const pvTopic = (pv.discoveryTopic || pv._topic || pv.topic || "").trim().toLowerCase();
        const pvChannel = (pv.channelName || "").toLowerCase();
        if (dislikedTopic && pvTopic === dislikedTopic) return false;
        if (dislikedChannel && pvChannel === dislikedChannel) return false;
        return true;
    });
    const evicted = before - state.smartFeedSuggestionPool.length;
    if (evicted) {
        debug(`[Learn] Dislike evicted ${evicted} pool entr(ies) sharing topic/channel`);
        saveSmartFeedSuggestionPool();
    }
    invalidateScoreCache();
    return evicted;
}

function invalidateScoreCache() {
    debug("[Performance] Invalidating video score cache...");
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
    // The pool was the blind spot: the one collection that OUTLIVES the
    // session kept its stale scores through every invalidation.
    if (state.smartFeedSuggestionPool) {
        state.smartFeedSuggestionPool.forEach(v => {
            delete v._score;
            delete v._matchedTopics;
        });
    }
}

// ── Discovery ranking (pure helpers) ─────────────────────────
// Parsers for YouTube's human-readable renderer strings, used by the
// /youtube/results HTML fallback so those videos aren't signal-blind.
function parseYtViewsText(text) {
    if (!text) return null;
    const m = String(text).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    const suffix = (m[2] || "").toUpperCase();
    if (suffix === "K") n *= 1e3;
    else if (suffix === "M") n *= 1e6;
    else if (suffix === "B") n *= 1e9;
    return Math.round(n);
}

function parseYtDurationText(text) {
    if (!text) return null;
    const parts = String(text).trim().split(":").map(p => parseInt(p, 10));
    if (parts.some(isNaN)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function parseYtAgeText(text) {
    if (!text) return null;
    const m = String(text).match(/(\d+)\s*(year|month|week|day|hour|minute)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unitMs = {
        minute: 60e3, hour: 3600e3, day: 86400e3,
        week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3
    }[m[2].toLowerCase()];
    return unitMs ? Date.now() - n * unitMs : null;
}

// Map of channelName(lower) -> like count, from the timestamped rating log.
// Discovery videos carry an empty channelId, so name is the only join key.
/**
 * Is this channel blocked? One predicate for all seven former copy-paste
 * sites. Two deliberate changes from the old inline idiom:
 * - Name matching is EQUALITY, not includes(): a blocked channel called
 *   "Tech" used to hide every channel with "tech" anywhere in its name.
 * - A block that has an id also matches by NAME when the video carries no id
 *   (HTML-fallback discovery) — the old `!bc.id` guard silently disabled the
 *   name path the moment an id was recorded, which is what made auto-blocked
 *   entries (written with id === name) match nothing at all.
 */
function isChannelBlocked(channelId, channelName) {
    const nameLower = (channelName || "").toLowerCase();
    return (state.blockedChannels || []).some(bc => {
        if (bc.id && channelId && bc.id === channelId) return true;
        if (bc.name && nameLower && (!bc.id || !channelId)) {
            return nameLower === bc.name.toLowerCase();
        }
        return false;
    });
}

let _likedChannelCache = null;
function getLikedChannelAffinity() {
    if (_likedChannelCache) return _likedChannelCache;
    const map = new Map();
    Object.values(state.ratingStates || {}).forEach(st => {
        if (!st || st.r !== 5 || !st.v || !st.v.channelName) return;
        const key = st.v.channelName.toLowerCase();
        if (key === "youtube curation") return; // sync placeholder, not a channel
        map.set(key, (map.get(key) || 0) + 1);
    });
    _likedChannelCache = map;
    return map;
}
function invalidateLikedChannelCache() { _likedChannelCache = null; }

// Built-in starter policies for common / polysemous topics.
const BUILTIN_TOPIC_POLICIES = {
    "fish tanks": {
        intent: "aquarium keeping, planted tanks, aquascaping, freshwater and marine fish husbandry",
        includeFacets: ["aquascaping", "planted tank", "reef tank", "fishkeeping", "aquarium setup"],
        excludeFacets: ["lego", "minecraft", "toy", "diorama", "prank", "challenge", "gummy"],
        scope: "broad"
    },
    "aquariums": {
        intent: "aquarium keeping, planted tanks, aquascaping, marine and freshwater care",
        includeFacets: ["aquascaping", "planted aquarium", "freshwater setup", "reef husbandry"],
        excludeFacets: ["lego", "minecraft", "toy", "diorama", "prank"],
        scope: "broad"
    },
    "synthesis": {
        intent: "audio synthesis, modular synthesizers, sound design, analog synths",
        includeFacets: ["modular synth", "sound design", "analog synthesizer", "eurorack", "patch design"],
        excludeFacets: ["organic chemistry", "chemical synthesis", "protein synthesis", "corporate merger", "summary"],
        scope: "broad"
    },
    "restoration": {
        intent: "antique tool, machinery, vintage electronics and furniture restoration",
        includeFacets: ["tool restoration", "antique rescue", "machinery restoration", "woodworking rescue"],
        excludeFacets: ["car crash", "minecraft", "roblox", "speed restoration"],
        scope: "broad"
    }
};

function getTopicPolicy(topic) {
    if (!topic || typeof topic !== "string") return { phrase: "", intent: "", includeFacets: [], excludeFacets: [] };
    const norm = normalizeTopic(topic);
    if (state.topicPolicies && state.topicPolicies[norm]) {
        return { phrase: topic, ...state.topicPolicies[norm] };
    }
    if (BUILTIN_TOPIC_POLICIES[norm]) {
        return { phrase: topic, ...BUILTIN_TOPIC_POLICIES[norm] };
    }
    return {
        phrase: topic,
        intent: topic,
        includeFacets: [],
        excludeFacets: []
    };
}

// 4-axis discovery scorer with semantic intent gating and novelty rejection.
// Pure: reads only its arguments, so it's unit-testable in the VM harness.
const DISCOVERY_WEIGHTS = { intent: 1.0, authority: 0.6, maturity: 0.4, watchability: 0.5 };
const WG_CLICKBAIT_RE = /\b(you won'?t believe|gone wrong|shocking|insane|must (?:see|watch)|top \d+|life hacks?|exposed|destroyed|1 in a million)\b/i;
const WG_NOVELTY_RE = /\b(entirely (?:from|out of) lego|made (?:of|from|out of) lego|lego build|in minecraft|minecraft (?:build|working)|roblox|giant gummy|100 layers|prank|challenge|toy diorama)\b/i;

// ── Era buckets: the calibration target for the feed ─────────────────
// Every discovery video arrived UNDATED until scraper 2026-09-06 (the date
// repair was gated on require_transcript, which the feed never sets), so no
// era logic could work — the maturity axis below read its default on every
// row. Dates are now yt-dlp's approximate_date: month/year real, day-of-month
// = today's, and "N years ago" lands EXACTLY on the N-year edge. The
// tolerance pushes an edge case into the OLDER bucket, which is what
// "N years ago" means on YouTube (N..N+1 years).
const ERA_BUCKETS = ["recent", "mid", "classic", "vintage"];
const ERA_EDGES_YEARS = { recent: 1, mid: 4, classic: 10 };
const ERA_EDGE_TOLERANCE_DAYS = 10;
// Default target mix: 70% within four years keeps the feed current, 30% older
// is the "proven / timeless" share. The user's own dated likes override it as
// they accumulate (deriveEraPrior) — this is Steck's p(c|u).
const ERA_TARGET_MIX = { recent: 0.35, mid: 0.35, classic: 0.25, vintage: 0.05 };
const ERA_PRIOR_SMOOTHING = 12;   // pseudo-likes behind the default before history outweighs it

// "unknown" is a REPORTING bucket only. An undated row means the clock starts
// now, never "this is old" — quota code charges it to "recent".
function eraBucketOf(published, now) {
    if (typeof published !== "number" || !Number.isFinite(published) || published <= 0) return "unknown";
    const at = (typeof now === "number") ? now : Date.now();
    const ageDays = (at - published) / 86400e3 + ERA_EDGE_TOLERANCE_DAYS;
    if (ageDays < ERA_EDGES_YEARS.recent * 365.25) return "recent";
    if (ageDays < ERA_EDGES_YEARS.mid * 365.25) return "mid";
    if (ageDays < ERA_EDGES_YEARS.classic * 365.25) return "classic";
    return "vintage";
}

// p(era | this user): dated likes, smoothed toward the default. With no dated
// likes it IS the default. `likes` is an array of {published}; omitted = the
// user's liked videos from the synced rating log.
function deriveEraPrior(likes, now) {
    const src = likes || Object.values(state.ratingStates || {})
        .filter(st => st && st.r === 5 && st.v && st.v.published)
        .map(st => st.v);
    const counts = {}; let n = 0;
    ERA_BUCKETS.forEach(b => { counts[b] = 0; });
    src.forEach(v => {
        const b = eraBucketOf(v && v.published, now);
        if (b !== "unknown") { counts[b] += 1; n += 1; }
    });
    const p = {};
    ERA_BUCKETS.forEach(b => {
        p[b] = (counts[b] + ERA_PRIOR_SMOOTHING * ERA_TARGET_MIX[b]) / (n + ERA_PRIOR_SMOOTHING);
    });
    return p;
}

// KL(p || q) in nats over p's keys; q is floored so a missing bucket is a
// large finite cost, not Infinity.
function klDivergence(p, q, eps) {
    const floor = eps || 1e-6;
    let kl = 0;
    Object.keys(p).forEach(k => {
        const pk = p[k] || 0;
        if (pk > 0) kl += pk * Math.log(pk / Math.max(q[k] || 0, floor));
    });
    return kl;
}

// ── Feed-mix ledger: what the smart feed SHOWED, and what it earned ─────
// There was no instrument that could see the feed's era/topic/channel mix,
// so the shuffle at the pool could discard the ranking for months unnoticed.
// Every rendered smart-feed batch lands here; play/like are stamped onto the
// row later. Local-only (not synced), capped FIFO. Read with wgFeedMix().
const FEED_MIX_MAX = 600;
// Stamped on each row so two composition strategies can be compared on the
// same ledger ("shuffle" = the pre-2026-09-06 pool shuffle + topic round-robin).
const FEED_COMPOSE_MODE = "slate";

function recordFeedShown(videos, mode) {
    if (!state.feedMix || !Array.isArray(state.feedMix.shown)) state.feedMix = { shown: [] };
    const now = Date.now();
    const hist = {};
    (videos || []).forEach(v => {
        if (!v || !v.id) return;
        const era = eraBucketOf(v.published, now);
        hist[era] = (hist[era] || 0) + 1;
        state.feedMix.shown.push({
            id: v.id, era,
            topic: normalizeTopic(v._topic || v.discoveryTopic || ""),
            channel: (v.channelName || "").toLowerCase(),
            form: v._form || "", mode: mode || FEED_COMPOSE_MODE, t: now
        });
    });
    const overflow = state.feedMix.shown.length - FEED_MIX_MAX;
    if (overflow > 0) state.feedMix.shown.splice(0, overflow);
    persistField("feed_mix", state.feedMix);
    if (videos && videos.length) debug(`[Feed Mix] ${videos.length} shown (${mode || FEED_COMPOSE_MODE}) eras ${JSON.stringify(hist)}`);
    return hist;
}

// Stamp a play/like onto the most recent shown row for the video. Returns
// false when the video was never shown by the smart feed (a sub-feed play).
function markFeedEvent(videoId, kind) {
    const shown = state.feedMix && state.feedMix.shown;
    if (!shown || !videoId || (kind !== "play" && kind !== "like")) return false;
    for (let i = shown.length - 1; i >= 0; i--) {
        if (shown[i].id !== videoId) continue;
        if (!shown[i][kind]) shown[i][kind] = Date.now();
        persistField("feed_mix", state.feedMix);
        return true;
    }
    return false;
}

// Pure: the report wgFeedMix() prints. Charges "unknown" to "recent" for the
// KL (an undated row is a clock that starts now), reports it separately.
function feedMixReport(shown, target, windowSize) {
    const rows = shown || [];
    const w = windowSize || 12;
    const n = rows.length;
    const eras = {};
    ERA_BUCKETS.concat(["unknown"]).forEach(b => { eras[b] = { target: target[b] || 0, shown: 0, plays: 0, likes: 0 }; });
    rows.forEach(r => {
        const e = eras[r.era] || (eras[r.era] = { target: 0, shown: 0, plays: 0, likes: 0 });
        e.shown += 1; if (r.play) e.plays += 1; if (r.like) e.likes += 1;
    });
    const q = {};
    ERA_BUCKETS.forEach(b => { q[b] = n ? eras[b].shown / n : 0; });
    if (n) q.recent += eras.unknown.shown / n;
    Object.keys(eras).forEach(b => {
        const e = eras[b];
        e.shown_pct = n ? Math.round(1000 * e.shown / n) / 10 : 0;
        e.plays_per_100 = e.shown ? Math.round(1000 * e.plays / e.shown) / 10 : 0;
        e.likes_per_100 = e.shown ? Math.round(1000 * e.likes / e.shown) / 10 : 0;
        e.target = Math.round(1000 * e.target) / 10;
    });
    const share = (key) => {
        const counts = {}; const maxWin = {};
        rows.forEach((r, i) => {
            const k = r[key] || "?";
            counts[k] = (counts[k] || 0) + 1;
            let c = 0;
            for (let j = Math.max(0, i - w + 1); j <= i; j++) if ((rows[j][key] || "?") === k) c += 1;
            if (c > (maxWin[k] || 0)) maxWin[k] = c;
        });
        return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10)
            .map(k => ({ [key]: k, shown: counts[k], share_pct: Math.round(1000 * counts[k] / n) / 10, max_in_any_12: maxWin[k] }));
    };
    const byMode = {};
    rows.forEach(r => {
        const m = r.mode || "?";
        const b = byMode[m] || (byMode[m] = { n: 0, plays: 0, likes: 0, eras: {} });
        b.n += 1; if (r.play) b.plays += 1; if (r.like) b.likes += 1;
        b.eras[r.era] = (b.eras[r.era] || 0) + 1;
    });
    Object.values(byMode).forEach(b => {
        b.plays_per_100 = b.n ? Math.round(1000 * b.plays / b.n) / 10 : 0;
        b.likes_per_100 = b.n ? Math.round(1000 * b.likes / b.n) / 10 : 0;
    });
    return { n, eras, kl: n ? klDivergence(target, q) : null, topics: n ? share("topic") : [], channels: n ? share("channel") : [], byMode };
}

window.wgFeedMix = function () {
    const target = deriveEraPrior();
    const rep = feedMixReport((state.feedMix && state.feedMix.shown) || [], target);
    console.log(`feed mix over the last ${rep.n} shown (cap ${FEED_MIX_MAX}); KL(target || shown) = ${rep.kl === null ? "n/a" : rep.kl.toFixed(3)}`);
    console.table(rep.eras);
    console.log("by composition mode:"); console.table(rep.byMode);
    console.log("top topics:"); console.table(rep.topics);
    console.log("top channels:"); console.table(rep.channels);
    if (rep.n < 60) console.log(`n=${rep.n} is too small to read the era mix from — browse a few batches first.`);
    return rep;
};

window.wgEraPrior = function () {
    const dated = Object.values(state.ratingStates || {}).filter(st => st && st.r === 5 && st.v && st.v.published).length;
    const out = { default: ERA_TARGET_MIX, derived: deriveEraPrior(), datedLikes: dated };
    console.table({ default: ERA_TARGET_MIX, derived: out.derived });
    console.log(`${dated} dated likes behind the derived prior (smoothing ${ERA_PRIOR_SMOOTHING})`);
    return out;
};

function scoreDiscoveryVideo(video, ctx) {
    const w = (ctx && ctx.weights) || DISCOVERY_WEIGHTS;
    const rawTitle = video.title || "";
    const title = rawTitle.toLowerCase();
    const topic = (ctx && ctx.topic) || "";
    const policy = (ctx && ctx.topicPolicy) || getTopicPolicy(topic);

    // Intent & Semantic Classification:
    let intent = 0.5;
    let classificationPenalty = 0;
    // Same-topic verdicts only — a cross-topic verdict is about a different
    // question (see cachedClassificationFor).
    const cachedRec = video._classification ? null : cachedClassificationFor(video.id, topic);
    const classification = video._classification || (cachedRec && cachedRec.classification);

    if (classification === "ON_TOPIC") {
        intent = 1.0;
    } else if (classification === "ADJACENT") {
        intent = 0.75;
    } else if (classification === "NOVELTY") {
        intent = 0.05;
        classificationPenalty = 0.6;
    } else if (classification === "OFF_TOPIC") {
        intent = 0.0;
        classificationPenalty = 0.8;
    } else {
        const topicTokens = topic.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        let overlap = topicTokens.length
            ? topicTokens.filter(t => title.includes(t)).length / topicTokens.length
            : 0;

        // Boost overlap if title hits an intended positive facet
        if (policy && Array.isArray(policy.includeFacets) && policy.includeFacets.length > 0) {
            const hasFacet = policy.includeFacets.some(f => title.includes(f.toLowerCase()));
            if (hasFacet) overlap = Math.min(1.0, overlap + 0.3);
        }

        // Hard negative match against excluded facets
        if (policy && Array.isArray(policy.excludeFacets) && policy.excludeFacets.length > 0) {
            const hasExcluded = policy.excludeFacets.some(f => title.includes(f.toLowerCase()));
            if (hasExcluded) {
                overlap = 0;
                classificationPenalty += 0.7;
            }
        }

        // Novelty pattern match for non-toy topics
        if (WG_NOVELTY_RE.test(rawTitle)) {
            const isToyTopic = /\b(lego|minecraft|roblox|toy|brick)\b/i.test(topic);
            if (!isToyTopic) {
                overlap = Math.min(overlap, 0.1);
                classificationPenalty += 0.5;
            }
        }

        const rankPrior = Math.max(0, 1 - (video._fetchRank || 0) * 0.08);
        intent = Math.max(0, 0.7 * overlap + 0.3 * rankPrior - classificationPenalty * 0.5);
    }

    // authority: log-scale views (capped at 0.5) + liked-channel affinity (0.5)
    // Views are clamped so 10M-view novelty videos cannot overcome relevance.
    const views = Math.max(10, video.viewCount || 10);
    const likedChannel = ctx && ctx.likedChannels &&
        ctx.likedChannels.has((video.channelName || "").toLowerCase()) ? 1 : 0;
    const authority = 0.5 * Math.min(1, Math.log10(views) / 6.5) + 0.5 * likedChannel;

    // maturity: proven beats brand-new
    let maturity = 0.5;
    if (video.published) {
        const ageDays = (Date.now() - video.published) / 86400e3;
        if (ageDays < 7) maturity = 0.3;
        else if (ageDays < 90) maturity = 0.7;
        else if (ageDays < 8 * 365) maturity = 1.0;
        else if (ageDays < 12 * 365) maturity = 0.85;
        // Past ~12 years, age stops being "proven" and starts being "stale
        // thumbnails and dead scenes" — taper below the 90-day tier.
        else maturity = 0.6;
    }

    // watchability: duration fit minus clickbait styling & classification penalty
    let durFit = 0.6;
    const d = video.duration;
    if (typeof d === "number" && d > 0) {
        if (d < 60) durFit = 0.15;          // Shorts
        else if (d < 120) durFit = 0.5;
        else if (d <= 30 * 60) durFit = 1.0;
        else if (d <= 90 * 60) durFit = 0.7;
        else durFit = 0.4;
    }
    let penalty = classificationPenalty;
    const letters = rawTitle.replace(/[^a-zA-Z]/g, "");
    const caps = rawTitle.replace(/[^A-Z]/g, "");
    if (letters.length > 5 && caps.length / letters.length > 0.6) penalty += 0.2;
    if (/[!?]{2,}/.test(rawTitle) || WG_CLICKBAIT_RE.test(rawTitle)) penalty += 0.3;
    const watchability = Math.max(0, durFit - penalty);

    const score = w.intent * intent + w.authority * authority +
        w.maturity * maturity + w.watchability * watchability;
    return { score, breakdown: { intent, authority, maturity, watchability, classification: classification || "heuristic" } };
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
    
    // Vintage bonus: pre-AI-slop videos are more likely to be genuine quality
    // content. Bounded to the 2008-2023 window and worth +1, not +3 — combined
    // with the discovery scorer's maturity curve, the old +3 meant a 20-year-
    // old video was rewarded twice over and outranked everything under 90
    // days regardless of relevance.
    const JAN_2023 = 1672531200000; // new Date("2023-01-01").getTime()
    const JAN_2008 = 1199145600000; // new Date("2008-01-01").getTime()
    if (video.published && video.published < JAN_2023 && video.published > JAN_2008) {
        score += 1;
        matches.push("vintage");
    }
    
    // Viral spam heuristic for post-2023 videos
    if (video.published && video.published > JAN_2023 && video.viewCount) {
        const ageMs = getVideoAge(video.published);
        const ageMonths = ageMs / (30 * 24 * 60 * 60 * 1000);
        // Suspiciously viral: >10M views in <12 months
        if (video.viewCount > 10000000 && ageMonths < 12) {
            score -= 2;
            matches.push("viral-spam");
        }
    }
    
    // Liked-channel affinity: channels the user has actually liked videos
    // from get a direct boost (the graph channel bonus keys on channelId,
    // which discovery videos don't carry — this works by name).
    const likedFromChannel = getLikedChannelAffinity().get((video.channelName || "").toLowerCase()) || 0;
    if (likedFromChannel > 0) {
        score += Math.min(9, 3 * likedFromChannel);
        matches.push("liked-channel");
    }

    // Add graph-learned bonus
    if (state.ontologyGraph) {
        score += graphScoreVideo(state.ontologyGraph, video);
    }

    // Explicit user rating override
    const userRating = state.videoRatings ? state.videoRatings[video.id] : undefined;
    if (userRating > 0) {
        score += 25;
        matches.push("user-liked");
    } else if (userRating < 0) {
        score -= 50;
        matches.push("user-disliked");
    }

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
    showToast(`Locating channel "${channelName}"...`, "info");
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
            showToast(`Could not resolve channel ID for "${channelName}"`, "danger");
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
                                 entry.querySelector("updated")?.textContent || null;
            const published = publishedStr ? Date.parse(publishedStr) : null;
                                 
            if (videoId && title) {
                videos.push({
                    id: videoId,
                    title: title,
                    channelName: feedTitle,
                    channelId: channelId,
                    published: published
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
                    <div class="empty-icon">${icon("alert", 48)}</div>
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
function createVideoCard(video) {
    const card = document.createElement("div");
    card.className = "video-card fade-in";
    if (video.isDiscover) {
        card.classList.add("discover-card");
    }
    
    const userRating = state.videoRatings && state.videoRatings[video.id];
    
    // Publish date removed as requested
    const topMatchedTopic = video.matchedTopics ? video.matchedTopics.find(t => t !== "all-caps" && t !== "punctuation" && !t.startsWith("disliked:") && t !== "vintage" && t !== "viral-spam") : null;
    const categoryText = topMatchedTopic ? capitalizePhrase(topMatchedTopic) : "";
    
    // Format meta/views/date if available
    let metaHtml = `<span class="channel-link" data-id="${video.channelId || ''}" data-name="${escapeHTML(video.channelName)}">${escapeHTML(video.channelName)}</span>`;
    if (video.viewCount && video.viewCount > 0) {
        metaHtml += ` • ${formatViews(video.viewCount)}`;
    }
    if (video.published) {
        metaHtml += ` • ${getRelativeTime(video.published)}`;
    }
    
    // Check if channel is already subscribed
    const isSubscribed = state.channels && state.channels.some(ch => 
        ch && (
            (ch.id && video.channelId && ch.id === video.channelId) || 
            (ch.name && video.channelName && ch.name.toLowerCase() === video.channelName.toLowerCase())
        )
    );
    
    card.innerHTML = `
        <div class="thumbnail-area">
            <img class="thumbnail-img" src="https://i.ytimg.com/vi/${video.id}/hqdefault.jpg" alt="${escapeHTML(video.title)}" loading="lazy" decoding="async">
            <div class="thumbnail-play-overlay">
                <div class="play-icon-circle">▶</div>
            </div>
            <div class="thumbnail-actions">
                <button class="thumbnail-action-btn" data-action="inline-add-to-queue" title="Watch Later">
                    <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
                <button class="thumbnail-action-btn" data-action="inline-add-to-playlist" title="Add to Playlist">
                    <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                </button>
            </div>
            ${video.isDiscover && video.discoveryTopic ? `<div class="category-badge" style="background:var(--accent);color:var(--accent-contrast)">${icon("sparkles", 11)} ${capitalizePhrase(video.discoveryTopic)}</div>` : (video.isDiscover ? `<div class="search-badge">${icon("search", 11)} Search</div>` : (categoryText ? `<div class="category-badge">${categoryText}</div>` : ""))}
        </div>
        <div class="card-details">
            <div class="video-title-row">
                <h3 class="video-title">${escapeHTML(video.title)}</h3>
                <div class="title-rating-actions">
                    <button class="title-rating-btn thumb-up${userRating === 5 ? ' active' : ''}" data-rating="5" title="Like">
                        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
                    </button>
                    <button class="title-rating-btn thumb-down${userRating === -5 ? ' active' : ''}" data-rating="-5" title="Dislike">
                        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm12-3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path></svg>
                    </button>
                </div>
                <button type="button" class="card-action-btn" title="Actions">⋮</button>
            </div>
            <p class="video-channel">${metaHtml}</p>
            <p class="video-time">${video.duration ? formatDuration(video.duration) : ""}</p>
        </div>
    `;
    
    const openAction = () => {
        playVideo(video);
    };
    card.querySelector(".thumbnail-play-overlay").addEventListener("click", openAction);
    card.querySelector(".video-title").addEventListener("click", openAction);
    
    // New inline buttons listeners
    card.querySelector('[data-action="inline-add-to-queue"]').addEventListener("click", (ev) => {
        ev.stopPropagation();
        addToQueue(video, false);
    });

    card.querySelector('[data-action="inline-add-to-playlist"]').addEventListener("click", (ev) => {
        ev.stopPropagation();
        showPlaylistModal(video);
    });

    const videoTopicForRating = video.discoveryTopic || (video.matchedTopics ? video.matchedTopics.find(t => t !== "all-caps" && t !== "punctuation" && !t.startsWith("disliked:")) : null) || "";

    wireCardRatingButtons(card, video, videoTopicForRating);

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
    wireCardActionMenu(card, video, isSubscribed);
    
    // ── Intersection Observer: passive watch signal for graph ──
    const watchObserver = getWatchSignalObserver();
    if (watchObserver) {
        watchSignalVideos.set(card, video);
        watchObserver.observe(card);
    }

    return card;
}

function wireCardRatingButtons(card, video, videoTopicForRating) {
    card.querySelectorAll(".title-rating-btn").forEach(btn => {
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const rating = parseInt(ev.currentTarget.dataset.rating, 10);
            const isAlreadyActive = ev.currentTarget.classList.contains("active");
            
            if (isAlreadyActive) {
                // Toggle OFF
                delete state.videoRatings[video.id];
                if (rating === 5) {
                    state.likedVideos = state.likedVideos.filter(v => v.id !== video.id);
                    saveLikedVideos();
                }
                saveVideoRatings();
                ev.currentTarget.classList.remove("active");
                showToast(rating > 0 ? 'Removed Like' : 'Removed Dislike', "info");
            } else {
                // Toggle ON or Switch rating
                state.videoRatings[video.id] = rating;
                if (rating === 5) {
                    if (!state.likedVideos.some(v => v.id === video.id)) {
                        state.likedVideos.push(video);
                    }
                } else {
                    state.likedVideos = state.likedVideos.filter(v => v.id !== video.id);
                }
                saveLikedVideos();
                saveVideoRatings();
                
                if (rating === -5 && videoTopicForRating) {
                    const normalized = videoTopicForRating.trim().toLowerCase();
                    if (!state.dislikedTopics.includes(normalized)) {
                        state.dislikedTopics.push(normalized);
                        saveDislikedTopics();
                    }
                    if (state.likedTopics.includes(normalized)) {
                        state.likedTopics = state.likedTopics.filter(t => t !== normalized);
                        saveLikedTopics();
                    }
                    state.topics = state.topics.filter(t => t.phrase.toLowerCase() !== normalized);
                    saveTopics();
                }
                if (rating === -5) {
                    evictPoolForDislike(videoTopicForRating, video.channelName);
                }
                
                card.querySelectorAll(".title-rating-btn").forEach(b => b.classList.remove("active"));
                ev.currentTarget.classList.add("active");
                showToast(rating > 0 ? 'Liked' : 'Disliked', rating > 0 ? "success" : "info");
            }

            // ── Ontology Graph Update ──
            if (!isAlreadyActive) {
                graphProcessRating(state.ontologyGraph, {
                    ...video,
                    matchedTopics: video._matchedTopics || video.matchedTopics || []
                }, rating > 0 ? 1 : -1);
            } else {
                // Rating was toggled OFF — reverse the effect
                graphProcessRating(state.ontologyGraph, {
                    ...video,
                    matchedTopics: video._matchedTopics || video.matchedTopics || []
                }, rating > 0 ? -1 : 1);
            }
            saveOntologyGraph();

            // Sync with inline player sidebar if it's currently showing this video
            const activePlayerIframe = document.querySelector(".inline-player iframe");
            if (activePlayerIframe && activePlayerIframe.src.includes(video.id)) {
                const sidebarLike = document.querySelector(".sidebar-btn-like");
                const sidebarDislike = document.querySelector(".sidebar-btn-dislike");
                if (sidebarLike && sidebarDislike) {
                    const currentRating = state.videoRatings[video.id];
                    if (currentRating === 5) {
                        sidebarLike.classList.add("active");
                        sidebarDislike.classList.remove("active");
                    } else if (currentRating === -5) {
                        sidebarLike.classList.remove("active");
                        sidebarDislike.classList.add("active");
                    } else {
                        sidebarLike.classList.remove("active");
                        sidebarDislike.classList.remove("active");
                    }
                }
            }

            // If we are currently in the liked-videos view, refresh the view
            if (state.currentView === "liked-videos") {
                renderLikedVideosView();
            }
        });
    });
}

function wireCardActionMenu(card, video, isSubscribed) {
    const actionBtn = card.querySelector(".card-action-btn");
    actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Close any existing dropdown
        document.querySelectorAll(".card-action-dropdown").forEach(d => d.remove());
        
        const videoTopic = video.discoveryTopic || (video.matchedTopics ? video.matchedTopics.find(t => t !== "all-caps" && t !== "punctuation" && !t.startsWith("disliked:")) : null) || "";
        const dropdown = document.createElement("div");
        dropdown.className = "card-action-dropdown";
        
        dropdown.innerHTML = `
            <button data-action="play-next">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                Play Next
            </button>
            <button data-action="play-inline">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                Play Inline
            </button>
            <button data-action="subscribe">
                ${isSubscribed ? `
                    <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                    Unsubscribe
                ` : `
                    <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                    Subscribe to Channel
                `}
            </button>
            <button class="danger" data-action="block">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                Block Channel
            </button>
            <button data-action="remove-topic"${videoTopic ? '' : ' disabled'}>
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                Remove Topic${videoTopic ? ': ' + capitalizePhrase(videoTopic) : ''}
            </button>
            ${videoTopic ? `
            <button data-action="exclude-niche">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                Exclude Niche Keywords
            </button>
            ` : ''}
            <button data-action="why-seeing">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                Why Am I Seeing This?
            </button>
            <button data-action="hide">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                Hide Video
            </button>
        `;
        
        dropdown.querySelector('[data-action="play-next"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            addToQueue(video, true);
            dropdown.remove();
        });

        dropdown.querySelector('[data-action="play-inline"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            dropdown.remove();
            playVideo(video);
        });
        dropdown.querySelector('[data-action="block"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            const channelName = video.channelName;
            const channelId = video.channelId || "";
            if (channelName && !state.blockedChannels.some(bc => bc && bc.name && bc.name.toLowerCase() === channelName.toLowerCase())) {
                state.blockedChannels.push({ name: channelName, id: channelId });
                saveBlocked();
            }
            dropdown.remove();
            showToast(`Blocked ${channelName || 'Channel'}`, "danger");
            // Remove all cards from this channel with fade-out
            if (channelName) {
                document.querySelectorAll(".video-card").forEach(c => {
                    const chEl = c.querySelector(".video-channel");
                    if (chEl && chEl.textContent && chEl.textContent.toLowerCase().includes(channelName.toLowerCase())) {
                        c.classList.add("fade-out-remove");
                        setTimeout(() => c.remove(), 350);
                    }
                });
            }
        });
        
        dropdown.querySelector('[data-action="subscribe"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            const channelName = video.channelName;
            const channelId = video.channelId || "";
            
            if (isSubscribed) {
                // Unsubscribe
                state.channels = state.channels.filter(ch => 
                    ch && (
                        !(ch.id && video.channelId && ch.id === video.channelId) &&
                        !(ch.name && video.channelName && ch.name.toLowerCase() === video.channelName.toLowerCase())
                    )
                );
                saveChannels();
                updateSubCount();
                dropdown.remove();
                showToast(`Unsubscribed from ${channelName}`, "info");
            } else {
                // Subscribe
                state.channels.push({ name: channelName, id: channelId });
                saveChannels();
                updateSubCount();
                dropdown.remove();
                showToast(`Subscribed to ${channelName}`, "success");
            }
            renderChannelsList();
        });
        
        dropdown.querySelector('[data-action="remove-topic"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (!videoTopic) return;
            dropdown.remove();
            nukeDiscoverTopic(videoTopic);
        });

        const btnExcludeNiche = dropdown.querySelector('[data-action="exclude-niche"]');
        if (btnExcludeNiche) {
            btnExcludeNiche.addEventListener("click", (ev) => {
                ev.stopPropagation();
                dropdown.remove();
                if (!videoTopic) return;
                const normTopic = normalizeTopic(videoTopic);
                if (!state.topicPolicies) state.topicPolicies = {};
                if (!state.topicPolicies[normTopic]) {
                    state.topicPolicies[normTopic] = { ...getTopicPolicy(videoTopic) };
                }
                const policy = state.topicPolicies[normTopic];
                if (!Array.isArray(policy.excludeFacets)) policy.excludeFacets = [];
                
                const topicWords = new Set(normTopic.split(/\s+/));
                const titleWords = (video.title || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2 && !TOPIC_STOPWORDS.has(w) && !topicWords.has(w));
                const added = [];
                titleWords.slice(0, 3).forEach(w => {
                    if (!policy.excludeFacets.includes(w)) {
                        policy.excludeFacets.push(w);
                        added.push(w);
                    }
                });
                saveTopicPolicies();
                card.classList.add("fade-out-remove");
                setTimeout(() => card.remove(), 350);
                showToast(`Excluded niche keywords [${added.join(", ")}] for "${videoTopic}"`, "info");
            });
        }

        const btnWhy = dropdown.querySelector('[data-action="why-seeing"]');
        if (btnWhy) {
            btnWhy.addEventListener("click", (ev) => {
                ev.stopPropagation();
                dropdown.remove();
                const rb = video._rankBreakdown || {};
                const sem = rb.classification || (video._classification ? video._classification : "heuristic");
                const intent = typeof rb.intent === "number" ? rb.intent.toFixed(2) : "N/A";
                const auth = typeof rb.authority === "number" ? rb.authority.toFixed(2) : "N/A";
                const mat = typeof rb.maturity === "number" ? rb.maturity.toFixed(2) : "N/A";
                const watch = typeof rb.watchability === "number" ? rb.watchability.toFixed(2) : "N/A";
                const whyMsg = `Topic: "${videoTopic || 'feed'}" | Semantic Fit: ${sem} | Intent: ${intent}, Authority: ${auth}, Maturity: ${mat}, Watchability: ${watch}`;
                showToast(whyMsg, "info");
            });
        }
        
        dropdown.querySelector('[data-action="hide"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            dropdown.remove();
            card.classList.add("fade-out-remove");
            setTimeout(() => card.remove(), 350);
            showToast(`Video hidden`, "info");
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
}


// One shared observer for all cards' passive watch signals — a per-card
// observer instance made every scroll frame pay for hundreds of observers.
let watchSignalObserver = null;
const watchSignalVideos = new WeakMap();

function getWatchSignalObserver() {
    if (watchSignalObserver || typeof IntersectionObserver === 'undefined') return watchSignalObserver;
    watchSignalObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = watchSignalVideos.get(entry.target);
            if (!video) {
                watchSignalObserver.unobserve(entry.target);
                return;
            }
            if (entry.isIntersecting) {
                entry.target._watchTimer = setTimeout(() => {
                    if (state.ontologyGraph) {
                        graphProcessWatch(state.ontologyGraph, video);
                        saveOntologyGraph();
                    }
                    // Weakest signal: a card from this topic held the viewport
                    // for 5s. Deduped on the VIDEO id, so ten impressions means
                    // ten different videos — not one topic's grid scrolling by.
                    const impTopic = video.discoveryTopic || video._topic || video.topic;
                    if (impTopic) recordTopicSignal(impTopic, "imp", video.id);
                    watchSignalVideos.delete(entry.target);
                    watchSignalObserver.unobserve(entry.target);
                }, 5000);
            } else {
                clearTimeout(entry.target._watchTimer);
            }
        });
    }, { threshold: 0.5 });
    return watchSignalObserver;
}

function renderCard(video, targetContainer) {
    const card = createVideoCard(video);
    const topic = (video.discoveryTopic || video._topic || video.topic || "").trim().toLowerCase();
    if (topic) {
        card.setAttribute("data-discover-topic", topic);
    }
    card.setAttribute("data-video-id", video.id);
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
    const newsFeedContainer = document.getElementById("news-feed-container");
    const playlistsContainer = document.getElementById("playlists-container");
    const likedVideosContainer = document.getElementById("liked-videos-container");
    
    // Setup feed sort dropdown if the current view supports sorting
    const topHeaderActions = document.querySelector(".header-actions");
    if (topHeaderActions) {
        topHeaderActions.innerHTML = "";
        // "smart-feed" is deliberately absent: its render branch never read
        // discoverySortOrder, so the dropdown promised a date sort it never did.
        const sortableViews = ["subscription-feed", "channel_", "topic_", "search_"];
        const isSortable = sortableViews.some(v => state.currentView === v || state.currentView.startsWith(v));
        if (isSortable) {
            const selectEl = document.createElement("select");
            selectEl.className = "select-sort";
            selectEl.id = "feed-sort-select";
            selectEl.innerHTML = `
                <option value="relevance" ${state.settings.discoverySortOrder === "relevance" ? "selected" : ""}>Sort: Relevance</option>
                <option value="date" ${state.settings.discoverySortOrder === "date" ? "selected" : ""}>Sort: Date (Newest)</option>
            `;
            selectEl.addEventListener("change", (e) => {
                state.settings.discoverySortOrder = e.target.value;
                saveSettings();
                renderFeed();
            });
            topHeaderActions.appendChild(selectEl);
        }
    }

    if (grid) grid.classList.remove("hidden");
    if (brainstormContainer) brainstormContainer.classList.add("hidden");
    if (discoverChannelsContainer) discoverChannelsContainer.classList.add("hidden");
    if (newsFeedContainer) newsFeedContainer.classList.add("hidden");
    if (playlistsContainer) playlistsContainer.classList.add("hidden");
    if (likedVideosContainer) likedVideosContainer.classList.add("hidden");
    setupInfiniteScroll();
    
    if (state.currentView === "news-feed") {
        if (grid) grid.classList.add("hidden");
        if (newsFeedContainer) newsFeedContainer.classList.remove("hidden");
        renderNewsFeed();
        return;
    }
    
    if (state.currentView === "discover-channels") {
        if (grid) grid.classList.add("hidden");
        if (discoverChannelsContainer) discoverChannelsContainer.classList.remove("hidden");
        renderDiscoverChannelsView();
        return;
    }
    
    if (state.currentView === "playlists") {
        if (grid) grid.classList.add("hidden");
        if (playlistsContainer) playlistsContainer.classList.remove("hidden");
        renderPlaylistsView();
        return;
    }
    
    if (state.currentView === "liked-videos") {
        if (grid) grid.classList.add("hidden");
        if (likedVideosContainer) likedVideosContainer.classList.remove("hidden");
        renderLikedVideosView();
        return;
    }
    
    // Handle Smart Feed (Discovery) — Reconcile non-destructively to avoid DOM thrashing & thumbnail flashes
    if (state.currentView === "smart-feed") {
        if (shortsGrid) shortsGrid.innerHTML = "";
        if (shortsShelf) shortsShelf.classList.add("hidden");
        if (redditGrid) redditGrid.innerHTML = "";
        if (redditShelf) redditShelf.classList.add("hidden");

        if (state.topics.filter(t => t.weight > 0).length === 0) {
            grid.innerHTML = "";
            // Show new profile CTA
            emptyState.classList.remove("hidden");
            const emptyIcon = emptyState.querySelector(".empty-icon");
            const emptyH3 = emptyState.querySelector("h3");
            const emptyP = emptyState.querySelector("p");
            if (emptyIcon) emptyIcon.innerHTML = icon("sprout", 48);
            if (emptyH3) emptyH3.textContent = "Welcome to your new profile!";
            if (emptyP) emptyP.textContent = "Add your first topic in Settings (Topics & Filters) to start discovering videos.";
            return;
        }

        let suggestionsHeader = grid.querySelector(".suggestions-section-header");
        let suggestionsGrid = document.getElementById("suggestions-grid");

        if (!suggestionsHeader || !suggestionsGrid) {
            grid.innerHTML = "";
            suggestionsHeader = document.createElement("div");
            suggestionsHeader.className = "suggestions-section-header";
            suggestionsHeader.style.gridColumn = "1 / -1";
            suggestionsHeader.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <h2 class="discover-section-title" style="font-size: 1.15rem; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
                            <span>Discovery Feed</span>
                        </h2>
                        <span class="suggestions-badge">AI Discovery</span>
                    </div>
                    <span style="font-size: 0.8rem; color: var(--text-muted);">Based on your topics & interests</span>
                </div>
            `;
            grid.appendChild(suggestionsHeader);
            
            suggestionsGrid = document.createElement("div");
            suggestionsGrid.id = "suggestions-grid";
            suggestionsGrid.className = "video-grid";
            grid.appendChild(suggestionsGrid);
        }

        if (state.smartFeedVideos.length > 0) {
            // Find existing cards currently in the DOM
            const renderedCardMap = new Map();
            suggestionsGrid.querySelectorAll(".video-card[data-video-id]").forEach(card => {
                const vidId = card.getAttribute("data-video-id");
                if (vidId) renderedCardMap.set(vidId, card);
            });

            // Target video set in state
            const targetVideoIds = new Set(state.smartFeedVideos.map(v => v.id));

            // Remove any cards that were removed from state
            renderedCardMap.forEach((cardEl, vidId) => {
                if (!targetVideoIds.has(vidId)) {
                    cardEl.remove();
                }
            });

            // Append only videos that are not yet rendered in the DOM
            const fragment = document.createDocumentFragment();
            state.smartFeedVideos.forEach(video => {
                if (!renderedCardMap.has(video.id)) {
                    renderCard(video, fragment);
                }
            });
            if (fragment.childNodes && fragment.childNodes.length > 0) {
                suggestionsGrid.appendChild(fragment);
            }
        } else {
            loadNextSmartFeedBatch();
        }
        
        if (state.smartFeedVideos.length === 0 && !state.smartFeedLoading) {
            emptyState.classList.remove("hidden");
        } else {
            emptyState.classList.add("hidden");
        }
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
            if (emptyIcon) emptyIcon.innerHTML = icon("tv", 48);
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
                showToast(`Unsubscribed from ${channel.name}`, "info");
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
                <button class="btn btn-danger btn-sm btn-header-unsub">
                    <svg class="icon-svg" style="width:14px; height:14px; margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                    Unsubscribe
                </button>
                <button class="btn btn-danger btn-sm btn-header-block">
                    <svg class="icon-svg" style="width:14px; height:14px; margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                    Block Channel
                </button>
            `;
            headerActions.querySelector(".btn-header-unsub").addEventListener("click", () => {
                state.channels = state.channels.filter(ch => ch.id !== channelId);
                saveChannels();
                updateSubCount();
                showToast(`Unsubscribed from ${channelName}`, "info");
                navigateToChannel(channelId, channelName);
            });
        } else {
            headerActions.innerHTML = `
                <button class="btn btn-primary btn-sm btn-header-sub" style="background:var(--accent);color:var(--bg-primary);border-color:var(--accent);">
                    <svg class="icon-svg" style="width:14px; height:14px; margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                    Subscribe
                </button>
                <button class="btn btn-danger btn-sm btn-header-block">
                    <svg class="icon-svg" style="width:14px; height:14px; margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                    Block Channel
                </button>
            `;
            headerActions.querySelector(".btn-header-sub").addEventListener("click", () => {
                state.channels.push({ name: channelName, id: channelId });
                saveChannels();
                updateSubCount();
                showToast(`Subscribed to ${channelName}`, "success");
                navigateToChannel(channelId, channelName);
            });
        }
        
        headerActions.querySelector(".btn-header-block").addEventListener("click", () => {
            if (!state.blockedChannels.some(bc => bc.id === channelId)) {
                state.blockedChannels.push({ name: channelName, id: channelId });
                saveBlocked();
            }
            showToast(`Blocked ${channelName}`, "danger");
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
        
        if (state.settings.discoverySortOrder === "date") {
            scored.sort((a, b) => (b.published || 0) - (a.published || 0));
        } else {
            scored.sort((a, b) => b.score - a.score);
        }
        
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
    
    // Handle Subscription Feed
    if (state.currentView === "subscription-feed") {
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
            const isBlockedChannel = isChannelBlocked(video.channelId, video.channelName);
            return !isBlockedChannel && video.score > -10;
        });
        
        let subShorts = [];
        if (state.settings.muteShorts) {
            subVideos = subVideos.filter(v => !isShortVideo(v));
        } else {
            subShorts = subVideos.filter(isShortVideo);
            subVideos = subVideos.filter(v => !isShortVideo(v));
        }
        
        if (state.settings.discoverySortOrder === "date") {
            subVideos.sort((a, b) => (b.published || 0) - (a.published || 0));
        } else {
            subVideos.sort((a, b) => {
                if (a.score >= 5 && b.score < 5) return -1;
                if (b.score >= 5 && a.score < 5) return 1;
                return b.score - a.score;
            });
        }
        
        const initialSubVideos = subVideos.slice(0, 50);
        
        if (subShorts.length > 0) {
            shortsShelf.classList.remove("hidden");
            const shortsFragment = document.createDocumentFragment();
            subShorts.slice(0, 15).forEach(short => renderCard(short, shortsFragment));
            shortsGrid.appendChild(shortsFragment);
        }

        if (redditVideos.length > 0 && redditShelf && redditGrid) {
            redditShelf.classList.remove("hidden");
            const redditFragment = document.createDocumentFragment();
            redditVideos.sort((a, b) => b.score - a.score).slice(0, 15).forEach(vid => renderCard(vid, redditFragment));
            redditGrid.appendChild(redditFragment);
        }
        
        if (initialSubVideos.length > 0) {
            const feedFragment = document.createDocumentFragment();
            initialSubVideos.forEach(video => renderCard(video, feedFragment));
            grid.appendChild(feedFragment);
        } else {
            emptyState.classList.remove("hidden");
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
            const isBlockedChannel = isChannelBlocked(video.channelId, video.channelName);
            return !isBlockedChannel && video.score > -10;
        });
        
        allVideos = allVideos.filter(v => 
            (v.title && v.title.toLowerCase().includes(queryTerm)) || 
            (v.channelName && v.channelName.toLowerCase().includes(queryTerm))
        );
        
        if (state.settings.discoverySortOrder === "date") {
            allVideos.sort((a, b) => (b.published || 0) - (a.published || 0));
        } else {
            allVideos.sort((a, b) => {
                if (a.score >= 5 && b.score < 5) return -1;
                if (b.score >= 5 && a.score < 5) return 1;
                return b.score - a.score;
            });
        }
        
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
                const isBlockedChannel = isChannelBlocked(video.channelId, video.channelName);
                return !isBlockedChannel && video.score > -10;
            });
            
            discoverVideos = discoverVideos.filter(dv => !allVideos.some(sv => sv.id === dv.id));
            
            if (state.settings.discoverySortOrder === "date") {
                discoverVideos.sort((a, b) => (b.published || 0) - (a.published || 0));
            } else {
                discoverVideos.sort((a, b) => b.score - a.score);
            }
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
                    <div class="loader-spinner" style="margin: 2rem auto;"></div>
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
                <h2 class="discover-section-title">Public Search Results for "${capitalizePhrase(searchQuery)}"</h2>
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
            // Render the first 18 instantly via fragment, then the rest in chunks
            // of 12 per animation frame — one reflow per chunk instead of per card
            const instantBatch = discoverVideos.slice(0, 18);
            const staggeredBatch = discoverVideos.slice(18);

            const discoverFragment = document.createDocumentFragment();
            instantBatch.forEach(video => renderCard(video, discoverFragment));
            grid.appendChild(discoverFragment);

            let staggerIndex = 0;
            const renderChunk = () => {
                const chunkFragment = document.createDocumentFragment();
                const end = Math.min(staggerIndex + 12, staggeredBatch.length);
                for (; staggerIndex < end; staggerIndex++) {
                    renderCard(staggeredBatch[staggerIndex], chunkFragment);
                }
                grid.appendChild(chunkFragment);
                if (staggerIndex < staggeredBatch.length) {
                    renderRafs.push(requestAnimationFrame(renderChunk));
                }
            };
            if (staggeredBatch.length > 0) {
                renderRafs.push(requestAnimationFrame(renderChunk));
            }
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
    const inlinePlayer = ensureInlinePlayer();

    // Use querySelector on the player element - never document.getElementById
    const playerWrapper = inlinePlayer.querySelector(".player-wrapper-box");
    const titleEl = inlinePlayer.querySelector(".player-title");
    const channelEl = inlinePlayer.querySelector(".player-channel");
    const statsEl = inlinePlayer.querySelector(".player-stats");

    if (titleEl) titleEl.textContent = video.title;
    if (channelEl) channelEl.textContent = video.channelName;
    if (statsEl) statsEl.textContent = "";

    // Fetch YouTube API Statistics if key is available
    if (GOOGLE_API_KEY && video.id) {
        fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${video.id}&key=${GOOGLE_API_KEY}`)
            .then(res => res.json())
            .then(data => {
                if (data.items && data.items.length > 0) {
                    const stats = data.items[0].statistics;
                    const snippet = data.items[0].snippet;
                    if (statsEl) {
                        const views = stats.viewCount ? Number(stats.viewCount).toLocaleString() : 'N/A';
                        const likes = stats.likeCount ? Number(stats.likeCount).toLocaleString() : 'N/A';
                        const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString() : 'N/A';
                        statsEl.textContent = `${views} views • ${likes} likes • Published ${publishedAt}`;
                    }
                }
            })
            .catch(err => console.error("[Google API] Failed to fetch stats:", err));
    }

    const isSameVideo = state.currentlyPlayingId === video.id;
    state.currentlyPlayingId = video.id;

    if (playerWrapper && !isSameVideo) {
        // Clear previous player/iframe
        playerWrapper.innerHTML = '<div id="yt-player-element" style="width: 100%; height: 100%; min-height: 360px; display: flex; align-items: center; justify-content: center; background: #000; color: var(--text-muted); font-size: 0.9rem;">Loading player...</div>';
        
        // Try stream proxy first (bypasses age restrictions), then fall back to YouTube embed
        playViaStreamProxy(video.id, playerWrapper).catch(() => {
            debug("[Player] Stream proxy failed, falling back to YouTube embed");
            playViaYouTubeEmbed(video.id, playerWrapper);
        });
    }

    const sidebar = inlinePlayer.querySelector(".inline-player-sidebar");
    if (sidebar) {
        const videoChannelId = video.channelId || "";
        const videoChannelName = video.channelName || "Unknown Channel";
        const isSubscribed = state.channels && state.channels.some(ch => 
            ch && (
                (ch.id && videoChannelId && ch.id === videoChannelId) || 
                (ch.name && videoChannelName && ch.name.toLowerCase() === videoChannelName.toLowerCase())
            )
        );
        const videoTopic = video.discoveryTopic || (video.matchedTopics ? video.matchedTopics.find(t => t !== "all-caps" && t !== "punctuation" && !t.startsWith("disliked:")) : null) || "";
        const currentRating = state.videoRatings[video.id];

        // pubDateStr removed

        const isTopicActive = videoTopic ? state.topics.some(t => t.phrase.toLowerCase() === videoTopic.toLowerCase()) : false;
        let topicBtnHtml = '';
        if (videoTopic) {
            if (isTopicActive) {
                topicBtnHtml = `<button type="button" class="btn btn-sm sidebar-btn-topic"><svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>Remove Topic: ${capitalizePhrase(videoTopic)}</button>`;
            } else {
                topicBtnHtml = `<button type="button" class="btn btn-sm sidebar-btn-topic" disabled style="opacity: 0.5;"><svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>Topic Removed</button>`;
            }
        }

        sidebar.innerHTML = buildPlayerSidebarHtml(video, currentRating, isSubscribed, topicBtnHtml);

        const btnAddPlaylist = sidebar.querySelector(".sidebar-btn-playlist");
        if (btnAddPlaylist) {
            btnAddPlaylist.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                showPlaylistModal(video);
            });
        }

        sidebar.querySelector(".sidebar-btn-like").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            let graphRating;
            if (state.videoRatings[video.id] === 5) {
                delete state.videoRatings[video.id];
                state.likedVideos = state.likedVideos.filter(v => v.id !== video.id);
                graphRating = -1; // Reverse like
            } else {
                state.videoRatings[video.id] = 5;
                if (!state.likedVideos.some(v => v.id === video.id)) {
                    state.likedVideos.push(video);
                }
                graphRating = 1; // Apply like
            }
            graphProcessRating(state.ontologyGraph, {
                ...video,
                matchedTopics: video._matchedTopics || video.matchedTopics || []
            }, graphRating);
            saveOntologyGraph();

            saveVideoRatings();
            saveLikedVideos();
            playVideo(video);
            renderFeed();
        });
        sidebar.querySelector(".sidebar-btn-dislike").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            let graphRating;
            if (state.videoRatings[video.id] === -5) {
                delete state.videoRatings[video.id];
                graphRating = 1; // Reverse dislike
            } else {
                state.videoRatings[video.id] = -5;
                state.likedVideos = state.likedVideos.filter(v => v.id !== video.id);
                graphRating = -1; // Apply dislike
                // Same eviction the card button performs — otherwise the
                // behaviour would depend on WHICH dislike button was pressed.
                evictPoolForDislike(
                    video.discoveryTopic || video._topic || video.topic,
                    video.channelName
                );
            }
            graphProcessRating(state.ontologyGraph, {
                ...video,
                matchedTopics: video._matchedTopics || video.matchedTopics || []
            }, graphRating);
            saveOntologyGraph();

            saveVideoRatings();
            saveLikedVideos();
            playVideo(video);
            renderFeed();
        });
        sidebar.querySelector(".sidebar-btn-subscribe").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isSubscribed) {
                state.channels = state.channels.filter(ch => ch.id !== videoChannelId && ch.name !== videoChannelName);
            } else {
                state.channels.push({ id: videoChannelId, name: videoChannelName });
            }
            saveChannels();
            renderChannelsList();
            playVideo(video);
            renderFeed();
        });
        const btnTopic = sidebar.querySelector(".sidebar-btn-topic");
        if (btnTopic && isTopicActive) {
            btnTopic.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (videoTopic) {
                    state.topics = state.topics.filter(t => t.phrase.toLowerCase() !== videoTopic.toLowerCase());
                    saveTopics();
                    renderTopicsList();
                    if (typeof renderPreferencesLists === 'function') {
                        renderPreferencesLists(document.getElementById("input-topic-search")?.value || "");
                    }
                    playVideo(video);
                }
            });
        }
        sidebar.querySelector(".sidebar-btn-block").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!state.blockedChannels.some(bc => bc.id === videoChannelId)) {
                state.blockedChannels.push({ id: videoChannelId, name: videoChannelName });
                saveBlocked();
                renderBlockedList();
            }
            showToast(`Blocked ${videoChannelName}`, "danger");
            closePlayer();
            renderFeed();
        });
    }

    // Show and animate in
    state.isMiniplayer = false;
    document.body.classList.remove("miniplayer-mode");
    inlinePlayer.classList.remove("is-miniplayer");
    document.body.classList.add("watch-mode");
    inlinePlayer.classList.remove("hidden", "closing");
    inlinePlayer.style.display = "";
    updateMiniplayerButtonState(false);
    updateMiniplayerPlayButton(true);

    // Scroll the main content area so player is visible & apply custom width if saved
    const mainContent = document.querySelector(".main-content");
    if (mainContent) {
        mainContent.scrollTop = 0;
        const savedWidth = localStorage.getItem("watch-sidebar-width");
        if (savedWidth) {
            mainContent.style.gridTemplateColumns = `1fr 6px ${savedWidth}px`;
        } else {
            mainContent.style.gridTemplateColumns = ""; // Use CSS default
        }
    }

    // Playing a video is the STRONGEST browse signal, but it is still browsing:
    // it counts, it does not generate. The old code fired /similar here on a 3s
    // timer that was never cleared — clicking through five videos queued five
    // concurrent calls and pushed five raw video TITLES into the topic pool.
    const playedTopic = video.discoveryTopic || video._topic || video.topic;
    if (playedTopic) recordTopicSignal(playedTopic, "play");
    markFeedEvent(video.id, "play");

    renderQueueUI();
}

function ensureInlinePlayer() {
    let inlinePlayer = document.getElementById("inline-player");
    if (inlinePlayer) return inlinePlayer;
    // Dynamically create the inline player and insert before feed-section
    inlinePlayer = document.createElement("div");
    inlinePlayer.id = "inline-player";
    inlinePlayer.className = "inline-player";
    inlinePlayer.innerHTML = [
        '<div class="inline-player-inner">',
        '  <div class="inline-player-main">',
        '    <div class="inline-player-video">',
        '      <div class="player-wrapper-box"></div>',
        '      <div class="miniplayer-controls-overlay">',
        '        <div class="miniplayer-top-actions">',
        '          <button type="button" class="btn-miniplayer-expand" title="Expand to Watch Page (i)">' + icon("expand", 14) + '</button>',
        '          <button type="button" class="btn-miniplayer-close" title="Close Player">' + icon("x", 14) + '</button>',
        '        </div>',
        '        <button type="button" class="btn-miniplayer-playpause" title="Play/Pause">' + icon("pause", 20) + '</button>',
        '      </div>',
        '    </div>',
        '    <div class="inline-player-bar">',
        '      <div class="inline-player-meta">',
        '        <h2 class="player-title"></h2>',
        '        <p class="player-channel"></p>',
        '        <p class="player-stats" style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px;"></p>',
        '      </div>',
        '      <div class="player-bar-actions" style="display: flex; gap: 0.5rem; align-items: center;">',
        '        <button type="button" class="btn btn-outline btn-sm btn-miniplayer-bar-playpause" title="Play/Pause" style="display: none;">' + icon("pause", 14) + '</button>',
        '        <button type="button" class="btn btn-outline btn-sm btn-toggle-miniplayer" title="Minimize to Miniplayer (i)">' + icon("miniplayer", 14) + ' <span class="btn-miniplayer-text">Miniplayer</span></button>',
        '        <button type="button" class="btn btn-primary btn-sm btn-open-youtube" title="Open Video on YouTube (New Tab)">' + icon("tv") + ' Watch on YouTube</button>',
        '        <button type="button" class="inline-player-close" title="Close Player">' + icon("x", 12) + ' Close</button>',
        '      </div>',
        '    </div>',
        '  </div>',
        '  <div class="inline-player-sidebar">',
        '  </div>',
        '</div>'
    ].join("");
    // Create resizer bar
    const resizer = document.createElement("div");
    resizer.id = "watch-resizer";
    resizer.className = "watch-resizer";

    // Insert before .feed-section inside .main-content
    const feedSection = document.querySelector(".feed-section");
    if (feedSection && feedSection.parentNode) {
        feedSection.parentNode.insertBefore(inlinePlayer, feedSection);
        feedSection.parentNode.insertBefore(resizer, feedSection);
    } else {
        const mainContent = document.querySelector(".main-content");
        if (mainContent) {
            mainContent.appendChild(inlinePlayer);
            mainContent.appendChild(resizer);
        }
    }

    // Setup resizer dragging logic (pointer events)
    let isDragging = false;
    resizer.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        isDragging = true;
        resizer.classList.add("dragging");
        resizer.setPointerCapture(e.pointerId);
    });

    resizer.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        const mainContent = document.querySelector(".main-content");
        if (!mainContent) return;

        const rect = mainContent.getBoundingClientRect();
        const minRight = 300; // minimum width of feed-section in px
        const minLeft = 400;  // minimum width of inline-player in px

        let rightWidth = rect.right - e.clientX;

        if (rightWidth < minRight) rightWidth = minRight;
        if (rect.width - rightWidth < minLeft) rightWidth = rect.width - minLeft;

        mainContent.style.gridTemplateColumns = `1fr 6px ${rightWidth}px`;
        localStorage.setItem("watch-sidebar-width", rightWidth);
    });

    const stopDragging = (e) => {
        if (isDragging) {
            isDragging = false;
            resizer.classList.remove("dragging");
            try {
                resizer.releasePointerCapture(e.pointerId);
            } catch (err) {}
        }
    };

    resizer.addEventListener("pointerup", stopDragging);
    resizer.addEventListener("pointercancel", stopDragging);

    // Bind close buttons
    inlinePlayer.querySelectorAll(".inline-player-close, .btn-miniplayer-close").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            closePlayer();
        });
    });

    // Bind toggle miniplayer button
    const btnToggleMini = inlinePlayer.querySelector(".btn-toggle-miniplayer");
    if (btnToggleMini) {
        btnToggleMini.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleMiniplayerMode();
        });
    }

    // Bind expand miniplayer button
    const btnExpandMini = inlinePlayer.querySelector(".btn-miniplayer-expand");
    if (btnExpandMini) {
        btnExpandMini.addEventListener("click", (e) => {
            e.stopPropagation();
            setMiniplayerMode(false);
        });
    }

    // Bind miniplayer play/pause buttons
    inlinePlayer.querySelectorAll(".btn-miniplayer-playpause, .btn-miniplayer-bar-playpause").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleVideoPlayback();
        });
    });

    // Clicking anywhere on miniplayer (except controls/buttons) expands it back to watch mode
    inlinePlayer.addEventListener("click", (e) => {
        if (!state.isMiniplayer) return;
        if (e.target.closest("button") || e.target.closest("a")) return;
        setMiniplayerMode(false);
    });

    // Bind open on YouTube button
    const btnOpenYoutube = inlinePlayer.querySelector(".btn-open-youtube");
    if (btnOpenYoutube) {
        btnOpenYoutube.addEventListener("click", () => {
            if (state.currentlyPlayingId) {
                window.open(`https://www.youtube.com/watch?v=${state.currentlyPlayingId}`, "_blank");
                if (window.logYouTubeLaunch) window.logYouTubeLaunch(state.currentlyPlayingId);
            }
        });
    }
    return inlinePlayer;
}

function setMiniplayerMode(enable) {
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) return;
    const mainContent = document.querySelector(".main-content");

    if (enable) {
        if (!state.currentlyPlayingId) return;
        document.body.classList.remove("watch-mode");
        document.body.classList.add("miniplayer-mode");
        inlinePlayer.classList.add("is-miniplayer");
        inlinePlayer.classList.remove("hidden");
        inlinePlayer.style.display = "";
        state.isMiniplayer = true;

        if (mainContent) {
            mainContent.style.gridTemplateColumns = ""; // Restore full-width feed
        }
        updateMiniplayerButtonState(true);
    } else {
        document.body.classList.remove("miniplayer-mode");
        inlinePlayer.classList.remove("is-miniplayer");
        state.isMiniplayer = false;

        if (state.currentlyPlayingId) {
            document.body.classList.add("watch-mode");
            if (mainContent) {
                const savedWidth = localStorage.getItem("watch-sidebar-width");
                if (savedWidth) {
                    mainContent.style.gridTemplateColumns = `1fr 6px ${savedWidth}px`;
                } else {
                    mainContent.style.gridTemplateColumns = "";
                }
            }
        }
        updateMiniplayerButtonState(false);
    }
}

function toggleMiniplayerMode() {
    if (!state.currentlyPlayingId) return;
    setMiniplayerMode(!state.isMiniplayer);
}

function updateMiniplayerButtonState(isMiniplayer) {
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) return;
    const toggleBtn = inlinePlayer.querySelector(".btn-toggle-miniplayer");
    if (toggleBtn) {
        if (isMiniplayer) {
            toggleBtn.innerHTML = icon("expand", 14) + ' <span class="btn-miniplayer-text">Expand</span>';
            toggleBtn.setAttribute("title", "Expand to Watch Page (i)");
        } else {
            toggleBtn.innerHTML = icon("miniplayer", 14) + ' <span class="btn-miniplayer-text">Miniplayer</span>';
            toggleBtn.setAttribute("title", "Minimize to Miniplayer (i)");
        }
    }
}

function updateMiniplayerPlayButton(isPlaying) {
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) return;
    const playPauseBtns = inlinePlayer.querySelectorAll(".btn-miniplayer-playpause, .btn-miniplayer-bar-playpause");
    playPauseBtns.forEach(btn => {
        btn.innerHTML = isPlaying ? icon("pause", 18) : icon("play", 18);
        btn.setAttribute("title", isPlaying ? "Pause (k)" : "Play (k)");
    });
}

function toggleVideoPlayback() {
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) return;
    const videoEl = inlinePlayer.querySelector("video");
    if (videoEl) {
        if (videoEl.paused) {
            videoEl.play().catch(() => {});
            updateMiniplayerPlayButton(true);
        } else {
            videoEl.pause();
            updateMiniplayerPlayButton(false);
        }
        return;
    }
    if (window.ytPlayer && typeof window.ytPlayer.getPlayerState === "function") {
        try {
            const playerState = window.ytPlayer.getPlayerState();
            if (playerState === 1) { // playing
                window.ytPlayer.pauseVideo();
                updateMiniplayerPlayButton(false);
            } else {
                window.ytPlayer.playVideo();
                updateMiniplayerPlayButton(true);
            }
        } catch (err) {
            console.warn("Could not toggle YT player playback:", err);
        }
    }
}

function setupKeyboardShortcuts() {
    window.addEventListener("keydown", (e) => {
        const target = e.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.tagName === "SELECT")) {
            return;
        }
        if (e.altKey || e.ctrlKey || e.metaKey) return;

        if (e.key === "i" || e.key === "I") {
            if (state.currentlyPlayingId) {
                e.preventDefault();
                toggleMiniplayerMode();
            }
        } else if (e.key === "Escape") {
            if (state.isMiniplayer) {
                e.preventDefault();
                setMiniplayerMode(false);
            }
        }
    });
}

function buildPlayerSidebarHtml(video, currentRating, isSubscribed, topicBtnHtml) {
    return `
            <div class="sidebar-meta" style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem; border-bottom: 1px solid var(--card-border); padding-bottom: 0.5rem; display: none;">
                <!-- Publish date removed -->
            </div>
            <div class="sidebar-description-box">
                ${escapeHTML(video.description || "No description available.").replace(/\n/g, '<br>')}
            </div>
            <div class="sidebar-actions-grid">
                <button type="button" class="btn btn-sm sidebar-btn-like${currentRating === 5 ? ' active' : ''}">
                    <svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
                    Like
                </button>
                <button type="button" class="btn btn-sm sidebar-btn-dislike${currentRating === -5 ? ' active' : ''}">
                    <svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm12-3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path></svg>
                    Dislike
                </button>
                <button type="button" class="btn btn-sm sidebar-btn-subscribe${isSubscribed ? ' active' : ''}">
                    ${isSubscribed ? `
                        <svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                        Unsubscribe
                    ` : `
                        <svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                        Subscribe
                    `}
                </button>
                <button type="button" class="btn btn-sm sidebar-btn-playlist">
                    <svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                    Save
                </button>
            </div>
            <div class="sidebar-actions-row">
            ${topicBtnHtml}
            <button type="button" class="btn btn-sm btn-danger sidebar-btn-block">
                <svg class="icon-svg" style="width: 14px; height: 14px; margin-right: 6px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                Block Channel
            </button>
            </div>

            <div class="sidebar-queue-section" style="margin-top: 1.25rem; border-top: 1px solid var(--card-border); padding-top: 1rem;">
                <h4 style="font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); margin-bottom: 0.75rem; display: flex; justify-content: space-between; align-items: center;">
                    <span style="display: inline-flex; align-items: center; gap: 6px;">
                        <svg class="icon-svg" style="width: 14px; height: 14px; color: var(--accent);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        Play Queue (<span class="queue-count">0</span>)
                    </span>
                    <div style="display: flex; gap: 0.4rem; align-items: center;">
                        <button type="button" class="btn-save-queue btn-primary btn-sm" style="padding: 2px 6px; font-size: 0.7rem; border-radius: 4px; display: none;">Save</button>
                        <button type="button" class="btn-clear-queue btn-danger btn-sm" style="padding: 2px 6px; font-size: 0.7rem; border-radius: 4px; display: none;">Clear</button>
                    </div>
                </h4>
                <div class="sidebar-queue-list" style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 250px; overflow-y: auto; padding-right: 0.25rem;">
                </div>
            </div>
    `;
}

// ── Stream Proxy Player (bypasses age restrictions) ─────────
async function playViaStreamProxy(videoId, playerWrapper) {
    debug(`[Stream Proxy] Attempting direct stream for ${videoId}...`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout
    
    try {
        const response = await fetch(`/scraper/stream/${videoId}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`Stream proxy returned ${response.status}: ${errText.substring(0, 200)}`);
        }
        
        const data = await response.json();
        
        if (!data.url) {
            throw new Error("No stream URL in response");
        }
        
        debug(`[Stream Proxy] Got direct URL for ${videoId} (${data.width || "?"}x${data.height || "?"}, cached: ${data.cached})`);
        
        // Destroy any existing YT player
        if (window.ytPlayer) {
            try { window.ytPlayer.destroy(); } catch (e) {}
            window.ytPlayer = null;
        }
        
        // Create native HTML5 video player
        playerWrapper.innerHTML = `
            <video id="yt-player-element"
                   src="${data.url}"
                   autoplay
                   controls
                   playsinline
                   style="width: 100%; height: 100%; min-height: 360px; background: #000; outline: none;"
                   controlsList="nodownload">
                Your browser does not support HTML5 video.
            </video>`;
        
        const videoEl = playerWrapper.querySelector("video");
        if (videoEl) {
            videoEl.addEventListener("play", () => updateMiniplayerPlayButton(true));
            videoEl.addEventListener("pause", () => updateMiniplayerPlayButton(false));

            // Handle video end -> play next from queue
            videoEl.addEventListener("ended", () => {
                playNextFromQueue();
            });
            
            // Handle playback errors (likely CORS) -> fall back to YouTube embed
            videoEl.addEventListener("error", (e) => {
                console.warn(`[Stream Proxy] Video playback error for ${videoId}:`, e);
                debug("[Stream Proxy] Falling back to YouTube embed due to playback error");
                playViaYouTubeEmbed(videoId, playerWrapper);
            });
            
            // Attempt to start playback
            videoEl.play().catch(err => {
                console.warn(`[Stream Proxy] Autoplay blocked for ${videoId}:`, err.message);
                // Don't fall back — user can click play manually
            });
        }
        
        showToast("Playing via direct stream (bypasses restrictions)", "info");
        
    } catch (err) {
        clearTimeout(timeoutId);
        console.warn(`[Stream Proxy] Failed for ${videoId}:`, err.message);
        throw err; // Propagate so the caller falls back to YouTube embed
    }
}

// ── YouTube IFrame API Embed (standard player) ──────────────
function playViaYouTubeEmbed(videoId, playerWrapper) {
    debug(`[Player] Using YouTube IFrame embed for ${videoId}`);
    
    // Clean up any HTML5 video element
    const existingVideo = playerWrapper.querySelector("video");
    if (existingVideo) {
        existingVideo.pause();
        existingVideo.src = "";
    }
    
    playerWrapper.innerHTML = '<div id="yt-player-element" style="width: 100%; height: 100%; min-height: 360px;"></div>';
    
    loadYouTubeApi().then((YT) => {
        const playerEl = document.getElementById("yt-player-element");
        if (!playerEl) return;
        
        // Clean up old player if it existed
        if (window.ytPlayer) {
            try { window.ytPlayer.destroy(); } catch (e) {}
            window.ytPlayer = null;
        }
        
        window.ytPlayer = new YT.Player('yt-player-element', {
            height: '100%',
            width: '100%',
            videoId: videoId,
            playerVars: {
                autoplay: 1,
                rel: 0,
                modestbranding: 1,
                playsinline: 1
            },
            events: {
                onStateChange: (event) => {
                    if (event.data === YT.PlayerState.ENDED) {
                        playNextFromQueue();
                    } else if (event.data === YT.PlayerState.PLAYING) {
                        updateMiniplayerPlayButton(true);
                    } else if (event.data === YT.PlayerState.PAUSED) {
                        updateMiniplayerPlayButton(false);
                    }
                },
                onError: (event) => {
                    console.warn(`[Player] YouTube embed failed with error code ${event.data} for ${videoId}`);
                    showToast("YouTube embed restricted. Opening popup...", "warning");
                    
                    const playerEl = document.getElementById("yt-player-element");
                    if (playerEl && playerEl.parentNode) {
                        playerEl.parentNode.innerHTML = `
                            <div class="restricted-mode-panel" style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; min-height: 360px; background: var(--bg-elevated); border: 1px solid var(--card-border); border-radius: 8px; text-align: center; padding: 2rem;">
                                <div class="empty-icon">${icon("tv", 48)}</div>
                                <h3 style="margin-bottom: 0.5rem; color: var(--text-primary);">Playing in New Tab</h3>
                                <p style="color: var(--text-muted); margin-bottom: 1.5rem; max-width: 400px;">This video is restricted and has opened in a new tab.</p>
                                <button class="btn btn-primary" onclick="window.open('https://www.youtube.com/watch?v=${videoId}', '_blank'); if(window.logYouTubeLaunch) window.logYouTubeLaunch('${videoId}');">Re-open Tab</button>
                            </div>
                        `;
                    }
                    if (window.logYouTubeLaunch) window.logYouTubeLaunch(videoId);
                    window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
                }
            }
        });
    });
}

function closePlayer() {
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) return;
    document.body.classList.remove("watch-mode");
    document.body.classList.remove("miniplayer-mode");
    inlinePlayer.classList.remove("is-miniplayer");
    state.isMiniplayer = false;
    
    // Reset gridTemplateColumns on close
    const mainContent = document.querySelector(".main-content");
    if (mainContent) {
        mainContent.style.gridTemplateColumns = "";
    }

    inlinePlayer.classList.add("closing");
    state.currentlyPlayingId = null;
    state.currentlyPlayingVideo = null;
    setTimeout(() => {
        inlinePlayer.classList.add("hidden");
        inlinePlayer.classList.remove("closing");
        const pw = inlinePlayer.querySelector(".player-wrapper-box");
        if (pw) pw.innerHTML = ""; // Stops playback
        if (window.ytPlayer) {
            try {
                window.ytPlayer.destroy();
            } catch (e) {
                console.error("Error destroying YT player:", e);
            }
            window.ytPlayer = null;
        }
    }, 250);
}

// ============================================================
//  PLAY QUEUE LOGIC & YT API LOADERS
// ============================================================

let ytApiPromise = null;
function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
        if (window.YT && window.YT.Player) {
            resolve(window.YT);
            return;
        }
        
        // Define or chain window.onYouTubeIframeAPIReady
        const previousCallback = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = function() {
            if (previousCallback) previousCallback();
            resolve(window.YT);
        };

        // Check if script already exists
        const scripts = document.getElementsByTagName('script');
        let exists = false;
        for (let i = 0; i < scripts.length; i++) {
            if (scripts[i].src === 'https://www.youtube.com/iframe_api') {
                exists = true;
                break;
            }
        }
        
        if (!exists) {
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            const firstScriptTag = document.getElementsByTagName('script')[0];
            if (firstScriptTag && firstScriptTag.parentNode) {
                firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            } else {
                document.head.appendChild(tag);
            }
        }
    });
    return ytApiPromise;
}

function playNextFromQueue() {
    if (state.queue && state.queue.length > 0) {
        const nextVideo = state.queue.shift();
        saveQueue();
        playVideo(nextVideo);
        renderQueueUI();
    } else {
        closePlayer();
        showToast("Queue finished", "info");
    }
}

function addToQueue(video, playNext = false) {
    if (state.queue.some(v => v.id === video.id)) {
        showToast("Already in Play Queue", "info");
        return;
    }
    
    // Check if the video is currently playing
    const inlinePlayer = document.getElementById("inline-player");
    const isPlayingCurrent = inlinePlayer && !inlinePlayer.classList.contains("hidden") && window.ytPlayer && window.ytPlayer.getVideoData && window.ytPlayer.getVideoData().video_id === video.id;
    if (isPlayingCurrent) {
        showToast("Currently playing this video", "info");
        return;
    }
    
    if (playNext) {
        state.queue.unshift(video);
        showToast("⏳ Will play next", "success");
    } else {
        state.queue.push(video);
        showToast("⏳ Added to Play Queue", "success");
    }
    
    saveQueue();
    
    const isWatchMode = document.body.classList.contains("watch-mode");
    if (!isWatchMode) {
        // Start playing immediately if not in watch mode
        if (playNext) {
            state.queue.shift();
        } else {
            state.queue.pop();
        }
        saveQueue();
        playVideo(video);
    } else {
        renderQueueUI();
    }
}

function renderQueueUI() {
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer) return;
    
    const countEl = inlinePlayer.querySelector(".queue-count");
    const listEl = inlinePlayer.querySelector(".sidebar-queue-list");
    const clearBtn = inlinePlayer.querySelector(".btn-clear-queue");
    const saveBtn = inlinePlayer.querySelector(".btn-save-queue");
    
    if (!listEl) return;
    
    if (countEl) countEl.textContent = state.queue.length;
    
    if (state.queue.length === 0) {
        listEl.innerHTML = `<p style="font-size: 0.75rem; color: var(--text-muted); text-align: center; padding: 1rem 0;">Queue is empty.</p>`;
        if (clearBtn) clearBtn.style.display = "none";
        if (saveBtn) saveBtn.style.display = "none";
        return;
    }
    
    if (clearBtn) {
        clearBtn.style.display = "block";
        if (!clearBtn.dataset.hooked) {
            clearBtn.dataset.hooked = "true";
            clearBtn.onclick = (e) => {
                e.stopPropagation();
                state.queue = [];
                saveQueue();
                renderQueueUI();
                showToast("Play Queue cleared", "info");
            };
        }
    }
    
    if (saveBtn) {
        saveBtn.style.display = "block";
        if (!saveBtn.dataset.hooked) {
            saveBtn.dataset.hooked = "true";
            saveBtn.onclick = (e) => {
                e.stopPropagation();
                showPlaylistModal([...state.queue]);
            };
        }
    }
    
    listEl.innerHTML = "";
    state.queue.forEach((v, index) => {
        const item = document.createElement("div");
        item.className = "queue-item";
        item.style.display = "flex";
        item.style.alignItems = "center";
        item.style.gap = "0.5rem";
        item.style.padding = "0.4rem";
        item.style.borderRadius = "4px";
        item.style.background = "var(--bg-elevated)";
        item.style.border = "1px solid var(--border-subtle)";
        item.style.cursor = "pointer";
        item.style.position = "relative";
        
        item.innerHTML = `
            <img src="https://i.ytimg.com/vi/${v.id}/default.jpg" style="width: 50px; aspect-ratio: 16/9; object-fit: cover; border-radius: 2px; flex-shrink: 0;" alt="${escapeHTML(v.title)}">
            <div style="flex: 1; min-width: 0;">
                <div style="font-size: 0.75rem; font-weight: 500; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3;">
                    ${escapeHTML(v.title)}
                </div>
                <div style="font-size: 0.65rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 0.15rem;">
                    ${escapeHTML(v.channelName)}
                </div>
            </div>
            <button class="btn-remove-queue" style="background: transparent; border: none; color: var(--text-muted); font-size: 0.85rem; cursor: pointer; padding: 0.2rem 0.4rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" title="Remove from Queue">${icon("x", 12)}</button>
        `;
        
        item.onclick = (e) => {
            if (e.target.classList.contains("btn-remove-queue")) return;
            state.queue.splice(index, 1);
            saveQueue();
            playVideo(v);
            renderQueueUI();
        };
        
        item.querySelector(".btn-remove-queue").onclick = (e) => {
            e.stopPropagation();
            state.queue.splice(index, 1);
            saveQueue();
            renderQueueUI();
            showToast("Removed from Queue", "info");
        };
        
        listEl.appendChild(item);
    });
}

function triggerGlobalSearch(query) {
    if (!query) return;
    
    // If watching a video, minimize to floating miniplayer so search results have full width
    if (state.currentlyPlayingId && document.body.classList.contains("watch-mode")) {
        setMiniplayerMode(true);
    }

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
    
    // Searching counts as intent, but one search is not a mandate to generate.
    // The topic expands once the user has come back to it SIGNAL_THRESHOLDS.open
    // times — see recordTopicSignal.
    recordTopicSignal(query, "open");

    // Auto-sync feeds on search
    syncFeeds();
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
            <button class="btn-remove" data-idx="${idx}">${icon("x", 12)}</button>
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
            row.style.background = "var(--bg-elevated)";
            
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
                <button class="btn-remove" data-phrase="${escapeHTML(topic)}">${icon("x", 12)}</button>
            `;
            row.querySelector(".btn-remove").addEventListener("click", (e) => {
                deleteCallback(e.target.dataset.phrase);
            });
            container.appendChild(row);
        });
    };

    renderList("liked-topics-list", state.likedTopics, (phrase) => {
        // "Remove from my liked list" is NOT "never show me this again" — this
        // used to call nukeDiscoverTopic, which burned the topic and demoted
        // every sibling sharing its identity. Now it just stops protecting the
        // topic from decay; burning stays available on the suggestion pills.
        state.likedTopics = state.likedTopics.filter(t => normalizeTopic(t) !== normalizeTopic(phrase));
        saveLikedTopics();
        renderPreferencesLists(q);
    });

    renderList("disliked-topics-list", state.dislikedTopics, (phrase) => {
        state.dislikedTopics = state.dislikedTopics.filter(t => t !== phrase);
        saveDislikedTopics();
        renderPreferencesLists(q);
    });

    // Burns render as their phrase (with a strike count when > 1); deleting
    // removes the RECORD, which is a full pardon rather than a parole.
    renderList("burned-queries-list",
        state.burnedQueries.map(b => { const r = burnRecord(b); return r.strikes > 1 ? `${r.q} (x${r.strikes})` : r.q; }),
        (label) => {
            const phrase = label.replace(/ \(x\d+\)$/, "");
            state.burnedQueries = state.burnedQueries.filter(b => burnRecord(b).q !== phrase);
            invalidateBurnedSignatures();
            saveBurnedQueries();
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
                <button class="btn-like-legacy" data-phrase="${escapeHTML(topic.phrase)}" title="Move to Liked Topics" style="background: transparent; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: var(--accent); padding: 4px;">
                    <svg class="icon-svg" style="width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
                </button>
                <button class="btn-remove btn-remove-legacy" data-phrase="${escapeHTML(topic.phrase)}" title="Remove Topic">${icon("x", 12)}</button>
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
            nukeDiscoverTopic(phrase);
        });
        list.appendChild(row);
    });
}

// Export Settings to JSON file
function exportSettings() {
    const backup = {
        channels: state.channels,
        topics: state.topics,
        blockedChannels: state.blockedChannels,
        likedTopics: state.likedTopics,
        dislikedTopics: state.dislikedTopics,
        burnedQueries: state.burnedQueries
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
                if (Array.isArray(backup.likedTopics)) { state.likedTopics = backup.likedTopics; saveLikedTopics(); }
                if (Array.isArray(backup.dislikedTopics)) { state.dislikedTopics = backup.dislikedTopics; saveDislikedTopics(); }
                if (Array.isArray(backup.burnedQueries)) { state.burnedQueries = backup.burnedQueries.map(burnRecord); invalidateBurnedSignatures(); saveBurnedQueries(); }
                saveChannels();
                saveTopics();
                saveBlocked();
                
                renderChannelsList();
                renderTopicsList();
                renderBlockedList();
                renderPreferencesLists();
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
            <button class="btn-remove" data-idx="${idx}">${icon("x", 12)}</button>
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
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalizePhrase(str) {
    return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseRelativeTime(str) {
    if (!str || typeof str !== 'string') return 0;
    
    const cleanStr = str.toLowerCase().trim()
        .replace(/^(streamed|premiered)\s+/, '')
        .replace(/s\s+ago$/, ' ago')
        .replace(/\s+ago$/, '');
    
    if (cleanStr === 'yesterday') {
        return Date.now() - 24 * 60 * 60 * 1000;
    }
    if (cleanStr === 'just now' || cleanStr === 'today') {
        return Date.now();
    }
    
    const parsed = Date.parse(cleanStr);
    if (!isNaN(parsed)) {
        return parsed;
    }
    
    const match = cleanStr.match(/^(\d+)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day|w|wk|week|mo|month|y|yr|year)s?$/);
    if (!match) {
        return 0;
    }
    
    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    const second = 1000;
    const minute = 60 * second;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;
    const year = 365 * day;
    
    let msDiff = 0;
    switch (unit) {
        case 's': case 'sec': case 'second': msDiff = value * second; break;
        case 'm': case 'min': case 'minute': msDiff = value * minute; break;
        case 'h': case 'hr': case 'hour': msDiff = value * hour; break;
        case 'd': case 'day': msDiff = value * day; break;
        case 'w': case 'wk': case 'week': msDiff = value * week; break;
        case 'mo': case 'month': msDiff = value * month; break;
        case 'y': case 'yr': case 'year': msDiff = value * year; break;
    }
    
    return Date.now() - msDiff;
}

// Canonical publish timestamps are milliseconds (Date.parse of the feed's
// <published>). Some sync paths historically wrote seconds (Date.now()/1000),
// which renders as "56y ago" (≈1970). Heal those on read: a value in the
// ~1e9–1e12 window is unambiguously seconds — a real millisecond timestamp
// for any actual video is > 1e12 (year 2001+). Scales already-stored bad data
// too, not just newly synced videos.
function normalizeTimestamp(timestamp) {
    if (!timestamp || typeof timestamp !== "number") return timestamp;
    if (timestamp > 1e9 && timestamp < 1e12) return timestamp * 1000;
    return timestamp;
}

function getRelativeTime(timestamp) {
    timestamp = normalizeTimestamp(timestamp);
    if (!timestamp) return "";
    const diffMs = Date.now() - timestamp;
    if (diffMs < 0) return "Just now";
    
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHr / 24);
    
    if (diffDays >= 365) {
        const years = Math.floor(diffDays / 365);
        return `${years}y ago`;
    }
    if (diffDays >= 30) {
        const months = Math.floor(diffDays / 30);
        return `${months}mo ago`;
    }
    if (diffDays >= 7) {
        const weeks = Math.floor(diffDays / 7);
        return `${weeks}w ago`;
    }
    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHr > 0) return `${diffHr}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return "Just now";
}

function getVideoAge(timestamp) {
    timestamp = normalizeTimestamp(timestamp);
    if (!timestamp) return 0;
    return Date.now() - timestamp;
}

// Smart date formatting removed
function updateStatusText(text) {
    document.getElementById("dashboard-status-text").textContent = text;
}

// Fetch general YouTube search results for a topic in the background (CORS bypassed)
async function fetchTopicSearchDiscovery(topicPhrase, offset) {
    const cacheKey = topicPhrase.toLowerCase();
    offset = offset || 0;
    const url = `/youtube/results?search_query=${encodeURIComponent(topicPhrase)}&sp=CAI%253D`;
    if (DEBUG) debug(`[Search Debug] fetchTopicSearchDiscovery initiated for: "${topicPhrase}" (cacheKey: "${cacheKey}", offset: ${offset})`);
    if (topicSearchLoading[cacheKey]) {
        if (DEBUG) debug(`[Search Debug] fetchTopicSearchDiscovery already loading for "${cacheKey}". Aborting duplicate call.`);
        return;
    }
    topicSearchLoading[cacheKey] = true;
    
    updateStatusText(`Searching YouTube for "${topicPhrase}"...`);
    
    let videos = [];
    let success = false;
    
    // --- Google API Search Override ---
    if (state.settings.useGoogleApiSearch && GOOGLE_API_KEY) {
        try {
            updateStatusText(`Searching via Google API for "${topicPhrase}"...`);
            let pageTokenParam = "";
            if (offset > 0 && topicSearchPageTokens[cacheKey]) {
                pageTokenParam = `&pageToken=${topicSearchPageTokens[cacheKey]}`;
            }
            
            const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(topicPhrase)}&type=video&maxResults=${DISCOVER_BATCH_SIZE}&key=${GOOGLE_API_KEY}${pageTokenParam}`;
            debug(`[Google API] Fetching search for "${topicPhrase}"`);
            
            const searchResp = await fetch(searchUrl);
            if (searchResp.status === 403) {
                console.warn("[Google API] Quota Exceeded or Forbidden. Falling back to yt-dlp.");
                state.settings.useGoogleApiSearch = false;
                const toggle = document.getElementById("toggle-use-google-api-search");
                if (toggle) toggle.checked = false;
                saveSettings();
                throw new Error("Quota Exceeded");
            }
            if (!searchResp.ok) throw new Error(`Google API returned ${searchResp.status}`);
            
            const searchData = await searchResp.json();
            topicSearchPageTokens[cacheKey] = searchData.nextPageToken || null;
            
            const items = searchData.items || [];
            if (items.length > 0) {
                const videoIds = items.map(i => i.id.videoId).join(",");
                // Fetch stats and durations
                const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${GOOGLE_API_KEY}`;
                const statsResp = await fetch(statsUrl);
                let statsData = { items: [] };
                if (statsResp.ok) statsData = await statsResp.json();
                
                const statsMap = {};
                for (const item of statsData.items || []) {
                    statsMap[item.id] = item;
                }
                
                if (!sessionTopicSearchCache[cacheKey]) {
                    sessionTopicSearchCache[cacheKey] = [];
                }
                const existingIds = new Set(sessionTopicSearchCache[cacheKey].map(v => v.id));
                
                for (const item of items) {
                    const id = item.id.videoId;
                    if (existingIds.has(id)) continue;
                    
                    const statItem = statsMap[id];
                    let durationSecs = 0;
                    if (statItem && statItem.contentDetails && statItem.contentDetails.duration) {
                        // Parse ISO 8601 duration (PT1H2M10S)
                        const match = statItem.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                        if (match) {
                            const h = parseInt(match[1] || '0');
                            const m = parseInt(match[2] || '0');
                            const s = parseInt(match[3] || '0');
                            durationSecs = h * 3600 + m * 60 + s;
                        }
                    }
                    
                    const video = {
                        id: id,
                        title: item.snippet.title,
                        channelName: item.snippet.channelTitle,
                        channelId: item.snippet.channelId,
                        published: item.snippet.publishedAt ? Date.parse(item.snippet.publishedAt) : null,
                        duration: durationSecs,
                        viewCount: statItem && statItem.statistics ? statItem.statistics.viewCount : null,
                        isDiscover: true
                    };
                    
                    existingIds.add(video.id);
                    sessionTopicSearchCache[cacheKey].push(video);
                    
                    const currentActiveTopic = state.currentView.startsWith("topic_") ? state.currentView.substring(6).toLowerCase() : "";
                    const currentActiveSearch = state.currentView.startsWith("search_") ? state.currentView.substring(7).toLowerCase() : "";
                    if (currentActiveTopic === cacheKey || currentActiveSearch === cacheKey) {
                        appendStreamedDiscoverVideo(video, topicPhrase);
                    }
                }
                
                success = true;
            } else {
                success = true; // empty results
            }

            if (success) {
                // Cards were already appended by appendStreamedDiscoverVideo();
                // clear the loading flag so infinite scroll can fetch the next page
                topicSearchLoading[cacheKey] = false;
                updateStatusText("Ready");
                if (!topicSearchPageTokens[cacheKey]) {
                    state.discoverMaxReached = true;
                }
                finishDiscoverBatch(cacheKey, offset);
            }
        } catch (err) {
            console.error("[Google API Search Error]", err);
        }
    }
    // --- End Google API Search Override ---
    
    if (!success && state.settings.useYtdlp) {
        try {
            if (DEBUG) debug(`[Search Debug] Fetching /scraper/collect stream for "${topicPhrase}" via POST (limit: ${DISCOVER_BATCH_SIZE}, offset: ${offset})...`);
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
                    limit: DISCOVER_BATCH_SIZE,
                    offset: offset,
                    days_back: 0,
                    require_transcript: false,
                    stream: true,
                    sort: "relevance"
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (DEBUG) debug(`[Search Debug] /scraper/collect response status: ${resp.status} (${resp.statusText})`);
            if (resp.ok) {
                if (!sessionTopicSearchCache[cacheKey]) {
                    sessionTopicSearchCache[cacheKey] = [];
                }
                const existingIds = new Set(sessionTopicSearchCache[cacheKey].map(v => v.id));
                success = true;

                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                if (DEBUG) debug("[Search Debug] Stream reader obtained. Starting read loop...");

                while (true) {
                    if (DEBUG) debug("[Search Debug] Awaiting reader.read()...");
                    const { value, done } = await reader.read();
                    if (DEBUG) debug(`[Search Debug] Reader chunk received. done: ${done}, chunk size: ${value ? value.length : 0} bytes`);
                    if (done) {
                        if (DEBUG) debug("[Search Debug] Done flag is true. Exiting read loop.");
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop();
                    if (DEBUG) debug(`[Search Debug] Split buffer into ${lines.length} lines. Remaining buffer size: ${buffer.length} chars`);

                    for (const line of lines) {
                        if (line.trim()) {
                            try {
                                if (DEBUG) debug(`[Search Debug] Parsing NDJSON line: ${line.substring(0, 120)}...`);
                                const item = JSON.parse(line);
                                if (item.error) {
                                    console.warn("[Search Debug] Stream item contains error:", item.error);
                                    continue;
                                }
                                const video = {
                                    id: item.video_id,
                                    title: item.title,
                                    channelName: item.channel,
                                    // UC… id from the scraper (added 2026-08-22).
                                    channelId: item.channel_id || "",
                                    published: item.published_at ? Date.parse(item.published_at) : null,
                                    duration: item.duration_secs,
                                    viewCount: item.view_count,
                                    isDiscover: true
                                };

                                if (!sessionTopicSearchCache[cacheKey]) {
                                    if (DEBUG) debug("[Search Debug] Re-initializing session cache (must have been cleared by sync).");
                                    sessionTopicSearchCache[cacheKey] = [];
                                }
                                // Deduplicate against existing cached results
                                if (!existingIds.has(video.id)) {
                                    existingIds.add(video.id);
                                    sessionTopicSearchCache[cacheKey].push(video);
                                    if (DEBUG) debug(`[Search Debug] Cached video: "${video.title}" (ID: ${video.id})`);

                                    // Append directly if the user is still looking at this topic or search
                                    const currentActiveTopic = state.currentView.startsWith("topic_") ? state.currentView.substring(6).toLowerCase() : "";
                                    const currentActiveSearch = state.currentView.startsWith("search_") ? state.currentView.substring(7).toLowerCase() : "";
                                    if (DEBUG) debug(`[Search Debug] View check - ActiveTopic: "${currentActiveTopic}", ActiveSearch: "${currentActiveSearch}", cacheKey: "${cacheKey}"`);
                                    if (currentActiveTopic === cacheKey || currentActiveSearch === cacheKey) {
                                        if (DEBUG) debug(`[Search Debug] Match! Appending streamed video card directly.`);
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
                if (DEBUG) debug("[Search Debug] Stream ended successfully.");
                updateStatusText("Ready");
                topicSearchLoading[cacheKey] = false;
                
                // Check if we hit the max results cap
                if (sessionTopicSearchCache[cacheKey] && sessionTopicSearchCache[cacheKey].length >= DISCOVER_MAX_RESULTS) {
                    state.discoverMaxReached = true;
                }
                
                finishDiscoverBatch(cacheKey, offset);
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
            if (DEBUG) debug(`[Search Debug] Executing HTML scraper fallback for: "${topicPhrase}"...`);
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
                                const publishedText = vr.publishedTimeText?.simpleText || "";
                                const published = publishedText ? parseRelativeTime(publishedText) : null;
                                videos.push({
                                    id: videoId,
                                    title: title,
                                    channelName: channelName,
                                    channelId: channelId,
                                    published: published,
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

// Post-batch cleanup for discover fetches. Cards are appended incrementally
// by appendStreamedDiscoverVideo() as they arrive — a full renderFeed() here
// would wipe and rebuild the whole grid (re-triggering every thumbnail), so
// it only runs when nothing streamed in, to surface the empty state.
function finishDiscoverBatch(cacheKey, offset) {
    const currentActiveTopic = state.currentView.startsWith("topic_") ? state.currentView.substring(6).toLowerCase() : "";
    const currentActiveSearch = state.currentView.startsWith("search_") ? state.currentView.substring(7).toLowerCase() : "";
    if (currentActiveTopic !== cacheKey && currentActiveSearch !== cacheKey) return;

    const grid = document.getElementById("video-grid");
    if (!grid) return;

    const loader = grid.querySelector(".infinite-scroll-loader");
    if (loader) loader.remove();

    if (state.discoverMaxReached && !grid.querySelector(".end-of-results")) {
        const endMsg = document.createElement("div");
        endMsg.className = "end-of-results";
        endMsg.textContent = `Showing top ${DISCOVER_MAX_RESULTS} results. Refine your search for more.`;
        grid.appendChild(endMsg);
    }

    if (offset === 0 && !grid.querySelector(".video-card")) {
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
    const isBlockedChannel = isChannelBlocked(enrichedVideo.channelId, enrichedVideo.channelName);
    if (isBlockedChannel || enrichedVideo.score <= -10) {
        return; // Filtered out
    }
    
    // Render as standard or short — same full-featured cards renderFeed()
    // produces, so the post-stream re-render is no longer needed
    const isShort = isShortVideo(enrichedVideo);
    if (isShort) {
        if (state.settings.muteShorts) return;
        const shortsShelf = document.getElementById("shorts-shelf");
        const shortsGrid = document.getElementById("shorts-grid");
        if (shortsShelf) shortsShelf.classList.remove("hidden");

        // Show up to 30 streaming short results
        if (shortsGrid.querySelectorAll(".discover-card").length < DISCOVER_BATCH_SIZE) {
            renderCard(enrichedVideo, shortsGrid);
        }
    } else {
        // Ensure discovery divider exists
        let divider = grid.querySelector(".discover-section-header");
        if (!divider) {
            divider = document.createElement("div");
            divider.className = "discover-section-header";
            const isSearch = state.currentView.startsWith("search_");
            const titleText = isSearch
                ? `Public Search Results for "${capitalizePhrase(topicPhrase)}"`
                : `Discover More on "${capitalizePhrase(topicPhrase)}"`;
            divider.innerHTML = `
                <h2 class="discover-section-title">${titleText}</h2>
                <span class="discover-badge">YouTube Public Search</span>
            `;
            grid.appendChild(divider);
        }

        renderCard(enrichedVideo, grid);
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

/**
 * Binary spam-shape gate for discovery candidates, applied BEFORE scoring and
 * before the LLM classifier spends a call. Every previous filter here was a
 * soft penalty on a scale where only -10 total mattered — a 45-second
 * ALL-CAPS 0-view short passed every gate. Thresholds for the title rules are
 * the extension's proven ones (content.js failsHeuristics), which until now
 * only protected youtube.com, not the dashboard's own feed.
 *
 * Returns the reason string (for debug counts) or null to keep.
 */
function isSpamShapedVideo(v, likedChannels) {
    // Shorts: muteShorts finally applies to the smart feed — it was enforced
    // at four render sites and none of them was the main discovery surface.
    if (state.settings.muteShorts && isShortVideo(v)) return "short";

    const title = v.title || "";
    const letters = title.replace(/[^a-zA-Z]/g, "");
    if (letters.length > 5) {
        const caps = title.replace(/[^A-Z]/g, "");
        if (caps.length / letters.length > 0.8) return "all-caps";
    }
    if (/[!?]{3,}/.test(title)) return "punctuation";

    // Near-zero views is the spam floor. The scorer used to round 0 views UP
    // to 10 and score on. Liked channels are exempt so a followed creator's
    // day-old upload is not punished for being new. Tunable; flagged in the
    // commit for retuning if it costs genuinely new niche videos.
    const views = Number(v.viewCount);
    if (Number.isFinite(views) && views >= 0 && views < 100 && v.viewCount !== undefined && v.viewCount !== null) {
        const lc = (v.channelName || "").toLowerCase();
        if (!(likedChannels && likedChannels.has(lc))) return "low-views";
    }
    return null;
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
// Dual mechanism: IntersectionObserver (primary) + scroll listener (backup)
let infiniteScrollObserver = null;
let smartFeedScrollThrottle = false;

function setupInfiniteScroll() {
    const trigger = document.getElementById("infinite-scroll-trigger");
    const feedSection = document.querySelector(".feed-section");
    if (!trigger) return;
    
    // Disconnect old observer if any
    if (infiniteScrollObserver) {
        infiniteScrollObserver.disconnect();
    }
    
    // Primary: IntersectionObserver
    infiniteScrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                debug("[Infinite Scroll] IO triggered");
                handleTriggerIntersection();
            }
        });
    }, {
        root: feedSection || null,
        rootMargin: "800px"
    });
    
    infiniteScrollObserver.observe(trigger);
    
    // Backup: Throttled scroll listener on the feed-section
    // This guarantees infinite scroll works even if the IO fails to re-fire
    if (feedSection) {
        // Remove any previously attached listener to avoid duplicates
        feedSection.removeEventListener("scroll", handleFeedScroll);
        feedSection.addEventListener("scroll", handleFeedScroll, { passive: true });
    }
}

function handleFeedScroll() {
    if (smartFeedScrollThrottle) return;
    smartFeedScrollThrottle = true;
    setTimeout(() => { smartFeedScrollThrottle = false; }, 200);
    
    const feedSection = document.querySelector(".feed-section");
    if (!feedSection) return;
    
    const distanceFromBottom = feedSection.scrollHeight - feedSection.scrollTop - feedSection.clientHeight;
    if (distanceFromBottom < 800) {
        handleTriggerIntersection();
    }
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
    debug(`[Infinite Scroll] Fetching batch ${state.discoverBatchIndex + 1} (offset: ${offset}) for "${queryTerm}"`);
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

// AI Topic Brainstorming Features — powered by lazy-tool-service backend

async function fetchWallgardenModels() {
    const select = document.getElementById("select-llm-model");
    if (select) select.innerHTML = '<option value="">Loading models...</option>';

    try {
        const resp = await fetch("/api/wallgarden/models");
        if (!resp.ok) throw new Error(`Server returned status ${resp.status}`);
        
        const data = await resp.json();
        const boxes = data.boxes || [];
        
        if (select) select.innerHTML = '';
        let firstModel = "";
        let foundSelected = false;

        for (const box of boxes) {
            if (box.status !== "online" || !box.model) continue;
            
            const option = document.createElement("option");
            option.value = `${box.id}::${box.model}`;
            option.textContent = `${box.nickname} — ${box.model}`;
            if (select) select.appendChild(option);
            
            if (!firstModel) firstModel = `${box.id}::${box.model}`;
            if (state.settings.llmModel === `${box.id}::${box.model}`) {
                option.selected = true;
                foundSelected = true;
            }
        }

        if (!foundSelected && firstModel) {
            state.settings.llmModel = firstModel;
            saveSettings();
            if (select) select.value = firstModel;
        }
        
        if (boxes.filter(b => b.status === "online").length === 0) {
            if (select) select.innerHTML = '<option value="">No vLLM boxes online</option>';
        }
    } catch (err) {
        console.warn("Failed to fetch models from wallgarden backend:", err);
        if (select) {
            select.innerHTML = `<option value="${state.settings.llmModel || ''}">${state.settings.llmModel || 'Error loading models'}</option>`;
        }
    }
}

// Keep backward-compatible alias
const fetchPrismModels = fetchWallgardenModels;

// ── Jetson pin ───────────────────────────────────────────────
// Every wallgarden LLM call runs on the Jetson (10.0.0.30:8000). Gold Spark is
// deliberately not used. The backend enforces this and ignores any client hint
// to the contrary; this constant exists for the one path that bypasses the
// backend (the direct /prism/chat channel recommendation below).
//
// Kept in sync with EXPECTED_JETSON_MODEL in lazy-agent-service
// src/services/wallgarden/WallgardenService.ts.
const JETSON_PIN = { provider: "vllm", model: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit" };

// Prefer whatever the backend actually reports for the Jetson (it discovers the
// live model from /v1/models, so a re-provisioned box heals itself); fall back
// to the pinned constant before the model list has loaded.
function getPinnedModel() {
    const { provider, model } = parseModelSetting(state.settings.llmModel);
    if (provider === JETSON_PIN.provider && model) return { provider, model };
    return { ...JETSON_PIN };
}

// Parse provider::model from settings value
function parseModelSetting(val) {
    if (!val || !val.includes("::")) return { provider: null, model: null };
    const [provider, ...rest] = val.split("::");
    return { provider, model: rest.join("::")};
}

// True-recent liked videos, newest first, from the timestamped ratingStates
// log. state.likedVideos can arrive in Mongo key order after a sync merge, so
// slicing it was an arbitrary subset — ratingStates carries the real times.
// Skips metadata-less sync placeholders ("Liked Video (Synced)").
function getRecentLikedVideos(limit) {
    const fromStates = Object.entries(state.ratingStates || {})
        .filter(([, st]) => st && st.r === 5 && st.v && st.v.title && st.v.title !== "Liked Video (Synced)")
        .sort((a, b) => (b[1].t || 0) - (a[1].t || 0))
        .map(([id, st]) => ({ id, ...st.v }));
    if (fromStates.length) return fromStates.slice(0, limit);
    return (state.likedVideos || []).slice(-limit).reverse();
}

// ── Taste profile ────────────────────────────────────────────
// Regenerate the LLM taste profile when likes have moved enough: 5+ new
// likes since the last profile, or the profile is older than a week.
async function refreshTasteProfile() {
    const likedAll = getRecentLikedVideos(Infinity);
    if (likedAll.length < 5) return; // not enough signal to profile yet
    const prof = state.tasteProfile;
    const stale = !prof ||
        (likedAll.length - (prof.likeCount || 0)) >= 5 ||
        (Date.now() - (prof.generatedAt || 0)) > 7 * 86400e3;
    if (!stale) return;

    try {
        const videos = likedAll.map(v => v.channelName && v.channelName !== "YouTube Curation"
            ? `${v.title} (${v.channelName})` : v.title).filter(Boolean);
        const interests = state.topics.filter(t => t.weight > 0)
            .sort((a, b) => b.weight - a.weight).slice(0, 20).map(t => t.phrase);
        const resp = await countedFetch("/api/wallgarden/taste-profile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videos, interests }),
            signal: AbortSignal.timeout(120000)
        });
        if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
        const data = await resp.json();
        if (data && data.profile) {
            state.tasteProfile = {
                text: data.profile,
                clusters: data.clusters || [],
                generatedAt: Date.now(),
                likeCount: likedAll.length
            };
            saveTasteProfile();
            debug(`[Taste Profile] Regenerated from ${likedAll.length} likes (${state.tasteProfile.clusters.length} clusters).`);
        }
    } catch (err) {
        console.warn("[Taste Profile] Refresh failed:", err.message);
        showToast("Taste profile refresh failed", "danger");
    }
}

// Group liked videos into taste clusters so each brainstorm batch can expand
// a DIFFERENT corner of taste. Channels with 2+ likes seed clusters; the
// rest fold in by shared mined topics (tiny union-find over ≤ a few dozen).
function buildLikedClusters() {
    const likedAll = getRecentLikedVideos(Infinity);
    if (likedAll.length < 4) return [];

    const label = v => v.channelName && v.channelName !== "YouTube Curation"
        ? `${v.title} (${v.channelName})` : v.title;

    // Union-find
    const parent = likedAll.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

    // Same channel -> same cluster
    const byChannel = new Map();
    likedAll.forEach((v, i) => {
        const key = (v.channelName || "").toLowerCase();
        if (!key || key === "youtube curation") return;
        if (byChannel.has(key)) union(byChannel.get(key), i);
        else byChannel.set(key, i);
    });
    // Shared mined topic -> same cluster
    const byTopic = new Map();
    likedAll.forEach((v, i) => {
        const mined = (state.minedVideos || {})[v.id];
        (mined && mined.topics || []).forEach(t => {
            if (byTopic.has(t)) union(byTopic.get(t), i);
            else byTopic.set(t, i);
        });
    });

    const groups = new Map();
    likedAll.forEach((v, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(v);
    });

    // Largest clusters first, singleton leftovers pooled into a final mixed one
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
    const clusters = [];
    const leftovers = [];
    sorted.forEach(members => {
        if (clusters.length < 5 && members.length >= 2) {
            // Name the cluster after its dominant mined topic, if any
            const counts = new Map();
            members.forEach(v => {
                const mined = (state.minedVideos || {})[v.id];
                (mined && mined.topics || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
            });
            const name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            // size = the cluster's real like count (videos is sliced to 10), so
            // the backend and composeTopicQueue can allocate by like share.
            clusters.push({ name, videos: members.slice(0, 10).map(label).filter(Boolean), size: members.length, ids: members.map(v => v.id) });
        } else {
            leftovers.push(...members);
        }
    });
    if (leftovers.length >= 2 && clusters.length < 6) {
        clusters.push({ name: undefined, videos: leftovers.slice(0, 10).map(label).filter(Boolean), size: leftovers.length, ids: leftovers.map(v => v.id) });
    }
    return clusters;
}

// Build the common context payload for brainstorm/similar calls
// ══════════════════════════════════════════════════════════════════════
// TOPIC OUTCOMES — closing the loop
// ══════════════════════════════════════════════════════════════════════
//
// Everything the system learned about how a topic PERFORMED used to be thrown
// away: grounding verdicts were computed and discarded, A/B tiers were assigned
// and never fed back, and `failedExamples` was a duplicate slice of
// burnedQueries — so the one prompt field with real instructional leverage
// ("study their SHAPE") was fed data the model had already seen.
//
// The Phase 1 signal ledger gives us the missing half: what the user actually
// DID with each topic. Three verdicts fall out of it, and the middle one is the
// valuable one because it is MEASURED rather than declared:
//
//   PROVEN  — they liked or repeatedly played its videos.
//   IGNORED — shown to them again and again and never once played. A topic that
//             looks right and is not. The user never told us; the counters did.
//   SLOP    — real YouTube results judged generic by the grounding gate.
//
// Kept deliberately small: a handful of labelled examples with real numbers
// beats a dump. Input is cheap (a brainstorm uses ~3% of the Jetson's 65,536
// window) but attention is not.
const OUTCOME_PROVEN_MAX = 12;
const OUTCOME_IGNORED_MAX = 10;
const OUTCOME_IGNORED_MIN_IMPRESSIONS = 8;  // shown this often…
const OUTCOME_PROVEN_MIN_PLAYS = 2;

/** Likes attributable to each topic, via the mined/matched topics on the rating record. */
function buildTopicLikeCounts() {
    const counts = Object.create(null);
    Object.entries(state.ratingStates || {}).forEach(([id, st]) => {
        if (!st || st.r !== 5) return;
        const labels = new Set();
        const v = st.v || {};
        if (v.discoveryTopic) labels.add(normalizeTopic(v.discoveryTopic));
        (v.matchedTopics || []).forEach(t => {
            // The audit markers are not topics — isTopicLabel() owns that list.
            if (typeof t === "string" && !t.startsWith("disliked:")) labels.add(normalizeTopic(t));
        });
        ((state.minedVideos || {})[id] || {}).topics?.forEach(t => labels.add(normalizeTopic(t)));
        labels.forEach(l => { if (l) counts[l] = (counts[l] || 0) + 1; });
    });
    return counts;
}

/**
 * Turn the ledger into labelled evidence for the prompt.
 * Pure — takes no arguments, reads state, returns a plain object. Unit-tested.
 */
/**
 * The IGNORED verdict, shared by the prompt (buildTopicOutcomes) and by feed
 * selection (getWeightedRandomTopics) so the two can never drift: shown
 * repeatedly, never once acted on. One open, play or like makes this false —
 * that IS the revival path, no separate mechanism needed.
 */
function isIgnoredTopic(phrase, likeCounts) {
    const t = normalizeTopic(phrase);
    if (!t) return false;
    if (likeCounts && (likeCounts[t] || 0) > 0) return false;
    return topicSignalTotal(t, "imp") >= OUTCOME_IGNORED_MIN_IMPRESSIONS &&
        topicSignalTotal(t, "play") === 0 &&
        topicSignalTotal(t, "open") === 0;
}

/** The PROVEN verdict — liked, or deliberately played enough to trust. */
function isProvenTopic(phrase, likeCounts) {
    const t = normalizeTopic(phrase);
    if (!t) return false;
    if (likeCounts && (likeCounts[t] || 0) > 0) return true;
    return topicSignalTotal(t, "play") >= OUTCOME_PROVEN_MIN_PLAYS;
}

function buildTopicOutcomes() {
    const likeCounts = buildTopicLikeCounts();
    const signals = state.topicSignals || {};
    const proven = [];
    const ignored = [];

    Object.keys(signals).forEach(topic => {
        if (isBurned(topic)) return;   // already a declared failure; burnedQueries covers it
        const imp = topicSignalTotal(topic, "imp");
        const play = topicSignalTotal(topic, "play");
        const open = topicSignalTotal(topic, "open");
        const likes = likeCounts[topic] || 0;

        if (isProvenTopic(topic, likeCounts)) {
            proven.push({ t: topic, likes, plays: play, opens: open });
        } else if (isIgnoredTopic(topic, likeCounts)) {
            // …and never acted on. This is the measured failure.
            ignored.push({ t: topic, shown: imp });
        }
    });

    // A topic can be proven by likes even with no browsing signal yet.
    Object.entries(likeCounts).forEach(([topic, likes]) => {
        if (likes > 0 && !proven.some(p => p.t === topic) && !isBurned(topic)) {
            proven.push({ t: topic, likes, plays: topicSignalTotal(topic, "play"), opens: topicSignalTotal(topic, "open") });
        }
    });

    proven.sort((a, b) => (b.likes - a.likes) || (b.plays - a.plays));
    ignored.sort((a, b) => b.shown - a.shown);

    const slop = Object.entries(state.groundingVerdicts || {})
        .filter(([, v]) => v && (v.verdict === "SLOP" || v.verdict === "DEAD"))
        .sort((a, b) => (b[1].t || 0) - (a[1].t || 0))
        .slice(0, 10)
        .map(([topic]) => topic);

    return {
        proven: proven.slice(0, OUTCOME_PROVEN_MAX),
        ignored: ignored.slice(0, OUTCOME_IGNORED_MAX),
        slop
    };
}

/**
 * Is there enough measured evidence to be worth sending?
 *
 * Below this the block is noise dressed as data — a single "proven" topic tells
 * the model nothing it cannot read off the liked-video list it already gets.
 * This also makes the A/B honest: sessions with no evidence are not counted as
 * "stats enabled".
 */
function hasUsableOutcomes(outcomes) {
    return (outcomes.proven.length + outcomes.ignored.length + outcomes.slop.length) >= 3;
}

function statsPromptEnabled() {
    // Default ON, but a toggle exists so the block can be switched off and the
    // two prompt shapes compared on the same account. Without this the feature
    // is unfalsifiable — see plan/signal_gated_topics.md.
    return state.settings.statsPromptEnabled !== false;
}

function buildLlmContext() {
    const liked = state.topics.filter(t => t.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 15).map(t => t.phrase);
    const graphTopics = Object.values(state.ontologyGraph?.nodes || {})
        .filter(n => n.type === "Topic" && n.weight > 3)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 10)
        .map(n => n.label);
    const combinedInterests = Array.from(new Set([...liked, ...graphTopics]));

    const { provider, model } = parseModelSetting(state.settings.llmModel);

    // Strongest taste signals: actual videos the user liked or saved to the
    // watchlist (including ones synced from YouTube via the extension).
    const formatVideoSignal = v => v.channelName && v.channelName !== "YouTube Curation"
        ? `${v.title} (${v.channelName})`
        : v.title;
    const likedVideos = getRecentLikedVideos(15)
        .map(formatVideoSignal).filter(Boolean);
    const watchlist = (state.queue || []).slice(-15)
        .map(formatVideoSignal).filter(Boolean);

    return {
        interests: combinedInterests,
        disliked: state.topics.filter(t => t.weight < 0).slice(0, 10).map(t => t.phrase),
        recentUsed: state.smartFeedUsedTopics.slice(-20),
        burnedQueries: activeBurnedPhrases().slice(-30),
        searches: state.searchHistory.slice(-10),
        likedVideos: likedVideos,
        watchlist: watchlist,
        tasteProfile: (state.tasteProfile && state.tasteProfile.text) || undefined,
        likedClusters: buildLikedClusters().map(({ ids, ...c }) => c),
        ...buildOutcomeContext(),
        model: model,
        provider: provider
    };
}

/**
 * The measured half of the context.
 *
 * `failedExamples` used to be `burnedQueries.slice(-10)` — the same array the
 * model already receives as `burnedQueries`, one line further up. It now
 * carries topics the user was SHOWN repeatedly and never touched, which is
 * different data and the only kind that teaches a shape the user has not
 * already had to reject by hand.
 */
function buildOutcomeContext() {
    const outcomes = buildTopicOutcomes();
    const useStats = statsPromptEnabled() && hasUsableOutcomes(outcomes);
    // Stamped onto every topic this request produces, so the two prompt shapes
    // can be compared later on real outcomes instead of on impressions.
    _lastContextVariant = useStats ? "stats" : "flat";
    if (!useStats) {
        return { failedExamples: activeBurnedPhrases().slice(-10), promptVariant: "flat" };
    }
    return {
        topicOutcomes: outcomes,
        failedExamples: outcomes.ignored.map(i => i.t).slice(0, 10),
        promptVariant: "stats"
    };
}

// Which context shape produced the topics currently being applied.
let _lastContextVariant = "flat";

/**
 * Score the two prompt shapes against each other on REAL outcomes.
 *
 * The question is never "does the stats prompt work?" — it is "does it beat the
 * flat context that is free and already on the desk?" So this reports both arms
 * side by side on the same account. Run it from the console: wgPromptAB().
 *
 * Tier-A rate is the cheap proxy (weight 8 = the rater called it well-anchored).
 * The honest metric is the engagement one: of the topics each arm produced, how
 * many did the user actually play or like? That needs the counters to fill in,
 * which is why n is printed — a difference on n=3 is not a difference.
 */
window.wgPromptAB = function () {
    const likeCounts = buildTopicLikeCounts();
    const arms = { stats: [], flat: [], unstamped: [] };
    (state.topics || []).forEach(t => {
        if (t.weight <= 0) return;
        (arms[t.src] || arms.unstamped).push(t);
    });

    const score = list => {
        const n = list.length;
        if (!n) return { n: 0 };
        const tierA = list.filter(t => t.weight >= 8).length;
        const played = list.filter(t => topicSignalTotal(t.phrase, "play") > 0).length;
        const liked = list.filter(t => (likeCounts[normalizeTopic(t.phrase)] || 0) > 0).length;
        const shown = list.filter(t => topicSignalTotal(t.phrase, "imp") > 0).length;
        return {
            n,
            tierA_pct: Math.round((tierA / n) * 100),
            // Of the topics that were actually SHOWN, how many earned a play?
            // Rate over `shown`, not over n — a topic never surfaced cannot have
            // failed, and counting it as a failure would punish whichever arm
            // simply produced more.
            engaged_pct: shown ? Math.round((played / shown) * 100) : null,
            shown,
            liked
        };
    };

    const out = { stats: score(arms.stats), flat: score(arms.flat), unstamped: score(arms.unstamped) };
    console.table(out);
    const s = out.stats, f = out.flat;
    if (!s.n || !f.n) {
        console.log("Need topics from BOTH arms before this means anything. " +
                    "Toggle Settings -> 'Use measured outcomes in prompts' to generate the other arm.");
    } else if (s.n < 20 || f.n < 20) {
        console.log(`n is small (stats=${s.n}, flat=${f.n}) — treat any gap as noise until both pass ~20.`);
    }
    return out;
};

/** What the model is being told about outcomes right now. */
window.wgOutcomes = function () {
    const o = buildTopicOutcomes();
    console.log("proven :", o.proven);
    console.log("ignored:", o.ignored);
    console.log("slop   :", o.slop);
    console.log(`usable: ${hasUsableOutcomes(o)} (needs >= 3 items total)`);
    console.log(`variant this request would use: ${statsPromptEnabled() && hasUsableOutcomes(o) ? "stats" : "flat"}`);
    return o;
};

// ── Liked-video topic mining ─────────────────────────────────
// Turns accumulated likes into topics via the backend LLM extractor, then
// feeds every sink that was starving:
//   1. the topic pool (mined evidence enters ABOVE brainstormed guesses),
//   2. state.likedTopics (the graph-discovery seed, previously manual-only),
//   3. matchedTopics on the rating record -> CO_LIKED edges in the graph
//      (extension-synced likes used to build none),
//   4. minedVideos marker so the whole loop is idempotent (and synced, so a
//      second browser reuses the extraction instead of re-paying the LLM).
const MINE_CHUNK_SIZE = 8; // ×3 topics = 24, under the 25-topic output ceiling
let _miningInProgress = false;
let _miningTimer = null;

function scheduleMining(delayMs) {
    if (_miningTimer) clearTimeout(_miningTimer);
    _miningTimer = setTimeout(() => {
        _miningTimer = null;
        mineLikedVideosIntoTopics();
    }, delayMs);
}

function collectUnminedLikes() {
    return Object.entries(state.ratingStates || {})
        .filter(([id, st]) => st && st.r === 5 && st.v && st.v.title &&
            st.v.title !== "Liked Video (Synced)" && !(state.minedVideos || {})[id] &&
            // Videos the extractor has repeatedly returned nothing for are
            // marked failed and never re-sent — they used to be re-paid on
            // every dashboard load, forever.
            !st.v.extractionFailed)
        .sort((a, b) => (b[1].t || 0) - (a[1].t || 0))
        .map(([id, st]) => ({ id, st }));
}

// Apply one extraction result to all sinks. Shared by the mining loop and the
// sync path (remote minedVideos entries replay through here without any LLM
// call). Returns the number of topics that actually entered the pool.
function applyMinedTopics(videoId, ratedTopics, opts) {
    const quiet = opts && opts.quiet;
    let added = 0;
    const acceptedLabels = [];

    ratedTopics.forEach(rt => {
        const phrase = normalizeTopic(rt.topic);
        if (!phrase || isBurned(phrase)) return;
        acceptedLabels.push(phrase);

        // Sink 1: topic pool. Mined topics carry direct evidence, so they
        // enter 2 above their brainstorm-tier weight (A=10, B=6).
        const weight = (rt.weight || 4) + 2;
        const existing = state.topics.find(t => normalizeTopic(t.phrase) === phrase);
        if (!existing) {
            // src = which prompt shape produced it. Without this stamp the
            // A/B can never be scored on outcomes — the lesson from
            // agent_skills, where 145 versions joined 0 outcome rows.
            state.topics.push({ phrase, weight, addedAt: Date.now(), src: _lastContextVariant, role: "core", bornRole: "core" });
            added++;
        } else if (existing.weight > 0) {
            if (existing.weight < weight) existing.weight = weight;
            // A like just got mined into this topic: that is core evidence.
            promoteTopicRole(phrase, "like mined");
        }
        const inQueue = state.smartFeedTopicsQueue.includes(phrase);
        const inUsed = state.smartFeedUsedTopics.includes(phrase);
        if (!inQueue && !inUsed) {
            state.smartFeedTopicsQueue.push(phrase);
        }

        // Sink 2: likedTopics — revives graph-based discovery. A-tier only,
        // capped so the seed list stays sharp.
        if (rt.tier === "A" && !state.likedTopics.some(t => normalizeTopic(t) === phrase)) {
            state.likedTopics.push(phrase);
            if (state.likedTopics.length > 60) {
                state.likedTopics = state.likedTopics.slice(-60);
            }
        }
    });

    // Sink 3: backfill matchedTopics on the rating record and build CO_LIKED
    // edges. Deliberately does NOT bump st.t — a metadata enrichment must not
    // win last-write-wins against a newer decision made elsewhere.
    const st = state.ratingStates[videoId];
    if (st && st.r === 5 && acceptedLabels.length > 0) {
        const existingMatched = (st.v && st.v.matchedTopics) || [];
        const merged = Array.from(new Set([...existingMatched, ...acceptedLabels]));
        if (st.v) st.v.matchedTopics = merged;
        if (state.ontologyGraph) {
            graphProcessRating(state.ontologyGraph, { ...(st.v || {}), id: videoId, matchedTopics: acceptedLabels }, 1);
        }
    }

    // Sink 4: idempotence marker.
    state.minedVideos[videoId] = { t: Date.now(), topics: acceptedLabels };

    if (!quiet && acceptedLabels.length > 0) {
        debug(`[Mining] ${videoId}: ${acceptedLabels.join(", ")}`);
    }
    return added;
}

async function mineLikedVideosIntoTopics() {
    if (_miningInProgress) return;
    const unmined = collectUnminedLikes();
    if (unmined.length === 0) return;
    _miningInProgress = true;
    debug(`[Mining] ${unmined.length} liked videos not yet mined — extracting topics...`);

    let totalAdded = 0;
    let attemptsChanged = false;
    const MAX_EXTRACTION_ATTEMPTS = 3;
    try {
        for (let i = 0; i < unmined.length; i += MINE_CHUNK_SIZE) {
            const chunk = unmined.slice(i, i + MINE_CHUNK_SIZE);
            const payload = chunk.map(({ id, st }) => ({
                id,
                title: st.v.title,
                channel: st.v.channelName || undefined,
                durationSecs: typeof st.v.duration === "number" ? st.v.duration : undefined,
                ageDays: st.v.published ? Math.max(0, (Date.now() - st.v.published) / 86400e3) : undefined
            }));

            const resp = await countedFetch("/api/wallgarden/extract-topics", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ videos: payload }),
                signal: AbortSignal.timeout(120000)
            });
            if (!resp.ok) {
                const errBody = await resp.text().catch(() => "");
                throw new Error(`Backend returned ${resp.status}: ${errBody.substring(0, 200)}`);
            }
            const data = await resp.json();
            (data.extractions || []).forEach(e => {
                if (e && e.id && Array.isArray(e.topics)) {
                    totalAdded += applyMinedTopics(e.id, e.topics);
                }
            });
            // The backend answered but gave some videos nothing usable. Count
            // the strike per video; after MAX_EXTRACTION_ATTEMPTS strikes stop
            // re-sending it forever. Network/HTTP failures throw before this
            // point and deliberately do NOT count — that failure is ours, not
            // the video's. (Does not bump st.t — see applyMinedTopics sink 3.)
            const extractedIds = new Set((data.extractions || []).map(e => e && e.id));
            chunk.forEach(({ id, st }) => {
                if (extractedIds.has(id)) {
                    if (st.v.extractionAttempts) { delete st.v.extractionAttempts; attemptsChanged = true; }
                    return;
                }
                st.v.extractionAttempts = (st.v.extractionAttempts || 0) + 1;
                if (st.v.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS) {
                    st.v.extractionFailed = true;
                    debug(`[Mining] ${id}: giving up after ${st.v.extractionAttempts} failed extraction attempts`);
                }
                attemptsChanged = true;
            });
        }

        if (totalAdded > 0 || attemptsChanged || unmined.some(({ id }) => state.minedVideos[id])) {
            pruneTopicPool();
            saveTopics();
            saveLikedTopics();
            saveMinedVideos();
            saveOntologyGraph();
            persistField("rating_states", state.ratingStates);
            invalidateScoreCache();
            debug(`[Mining] Done: ${totalAdded} new topics entered the pool.`);
            if (totalAdded > 0) {
                showToast(`Mined ${totalAdded} topics from your liked videos`, "success");
            }
        }
    } catch (err) {
        console.error("[Mining] Liked-video mining failed:", err);
        showToast("Liked-video topic mining failed", "danger");
    }
    _miningInProgress = false;
}

async function generateBrainstormTopics(append, numRequests = 1) {
    append = append || false;
    if (state.brainstormLoading) return;
    state.brainstormLoading = true;
    state.lastBrainstormAttempt = Date.now();
    
    debug(`[Smart Feed] Background LLM brainstorming via lazy-tool-service...`);
    
    const likedAll = state.topics.filter(t => t.weight > 0).sort((a, b) => b.weight - a.weight);
    if (likedAll.length === 0) {
        debug("[Smart Feed] No positive topics to brainstorm from. Skipping brainstorm.");
        state.brainstormLoading = false;
        return;
    }

    try {
        const ctx = buildLlmContext();
        // 60, not 100: the roles planner turns this into one CORE batch, cluster
        // ADJACENT batches and one EXPLORE batch (≤6 calls + rating), and the
        // composed queue no longer drains the whole pool anyway.
        ctx.numTopics = 60;
        ctx.rateFit = state.settings.fitRatingEnabled !== false;
        
        const resp = await countedFetch("/api/wallgarden/brainstorm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ctx),
            signal: AbortSignal.timeout(120000)
        });
        
        if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            throw new Error(`Backend returned ${resp.status}: ${errBody.substring(0, 200)}`);
        }
        
        const data = await resp.json();
        // The backend grades each topic for domain-anchoring and hands back a
        // starting weight: specific topics ("raku reduction firing") outrank
        // broad ones ("chemical reactions"), and floating abstractions
        // ("hazard analysis") are dropped before they ever reach us. Older
        // backends only return `topics`, so fall back to the flat weight.
        const rated = Array.isArray(data.rated) && data.rated.length
            ? data.rated
            : (data.topics || []).map(topic => ({ topic, weight: 5 }));
        // Generation arm, so wgTopicMix can compare v1 (no roles) / v2
        // (roles + fit) / v2-nofit (roles, anchoring only) on outcomes.
        const gen = rated.some(r => TOPIC_ROLES.includes(r.role))
            ? (data.rateFit === false ? "v2-nofit" : "v2")
            : "v1";
        let allAddedPhrases = [];

        rated.forEach(r => {
            const { topic: rawPhrase, weight } = r;
            // Store canonical (lowercase) so the existence check below actually
            // matches an existing entry — a raw Title-Case phrase never equalled
            // its lowercased twin, so every brainstorm duplicated the pool. Cards
            // re-capitalize on render, so nothing is lost visually.
            const phrase = normalizeTopic(rawPhrase);
            if (!phrase) return;

            if (isBurned(phrase)) {
                debug(`[Smart Feed] Skipping burned query "${phrase}" from LLM results.`);
                return;
            }

            const existing = state.topics.find(t => normalizeTopic(t.phrase) === phrase);
            if (!existing) {
                const role = TOPIC_ROLES.includes(r.role) ? r.role : undefined;
                // src was never stamped on this path (the "unstamped" arm in
                // wgPromptAB); role/cluster/fit/gen are the new stamps.
                state.topics.push({
                    phrase, weight: weight || 5, addedAt: Date.now(), src: _lastContextVariant,
                    role, bornRole: role, cluster: r.cluster || undefined, fit: r.fit || undefined,
                    tier: r.tier || undefined, gen
                });
            }

            const inQueue = state.smartFeedTopicsQueue.includes(phrase);
            const inUsed = state.smartFeedUsedTopics.includes(phrase);
            if (!inQueue && !inUsed) {
                state.smartFeedTopicsQueue.push(phrase);
                allAddedPhrases.push(phrase);
            }
        });

        pruneTopicPool();
        
        if (allAddedPhrases.length > 0) {
            saveTopics();
            debug("[Smart Feed] Successfully brainstormed and queued new topics:", allAddedPhrases);
            if (!append) {
                renderFeed();
            }
        } else {
            console.warn("[Smart Feed] Brainstorming returned no new usable topics.");
        }
        // Backend worked — even "no new usable topics" (all deduped) ends the
        // failure streak so the refill loop returns to its base cadence.
        state.brainstormFailureStreak = 0;
    } catch (err) {
        console.error(`[Smart Feed] Background brainstorming failed:`, err);
        state.brainstormFailureStreak = (state.brainstormFailureStreak || 0) + 1;
        if (state.brainstormFailureStreak === 1) {
            showToast("Topic brainstorm failed — backing off and retrying", "danger");
        }
        state.brainstormLoading = false;
        state.lastBrainstormTime = Date.now();
        updateStatusText("Brainstorm failed — retrying later");
        return;
    }

    state.brainstormLoading = false;
    state.lastBrainstormTime = Date.now();
    updateStatusText("Ready");
}

/**
 * Expand earned seed topics into new ones. The ONLY path that grows the pool
 * from browsing-derived signal, and it runs from the queue flush — never
 * directly from a user action.
 *
 * Replaces generateSimilarTopicsFromSearch, which fired on every video play and
 * every pill click with no in-flight guard, and which pushed the raw search
 * query (a full video TITLE, when called from playVideo) into the pool as a
 * weight-2 topic before it had earned anything.
 */
async function generateTopicsForSeeds(seeds, budget, strongestReason) {
    const cleanSeeds = (seeds || []).map(normalizeTopic).filter(Boolean);
    // Expansions of something the user PLAYED or OPENED are adjacent; ones
    // that only accumulated impressions are the weaker evidence — explore.
    const bornRole = strongestReason === "imp" ? "explore" : "adjacent";
    if (!cleanSeeds.length) return [];

    // The seed itself has now earned its place in the pool — it crossed a
    // threshold, which is exactly the evidence the old auto-add lacked.
    cleanSeeds.forEach(seed => {
        if (isBurned(seed)) return;
        const idx = state.topics.findIndex(t => normalizeTopic(t.phrase) === seed);
        if (idx === -1) state.topics.push({ phrase: seed, weight: 5, addedAt: Date.now(), role: "core", bornRole: "core" });
        else state.topics[idx].weight = Math.max(state.topics[idx].weight, 5);
        if (!state.smartFeedTopicsQueue.includes(seed)) state.smartFeedTopicsQueue.push(seed);
    });
    saveTopics();

    const query = cleanSeeds[0];
    try {
        const ctx = buildLlmContext();
        // Capped well under the measured ~25-item output ceiling. /similar is a
        // SINGLE un-batched call on the backend, so unlike brainstorm it has no
        // fan-out to rescue an over-long request that bails mid-array.
        ctx.numTopics = Math.min(TOPICS_PER_FLUSH_MAX, Math.max(2, budget || 2));
        ctx.seeds = cleanSeeds.slice(0, 8);
        ctx.rateFit = state.settings.fitRatingEnabled !== false;

        const resp = await countedFetch("/api/wallgarden/similar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...ctx, query }),
            signal: AbortSignal.timeout(60000)
        });

        if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            throw new Error(`Backend returned ${resp.status}: ${errBody.substring(0, 200)}`);
        }

        const data = await resp.json();
        const addedPhrases = [];
        // Newer backends rate /similar output too (weight = f(anchoring, fit));
        // a topic the rater dropped is absent from `rated` and is skipped.
        const ratedMap = Array.isArray(data.rated) && data.rated.length
            ? new Map(data.rated.map(r => [normalizeTopic(r.topic), r]))
            : null;
        const gen = ratedMap ? (data.rateFit === false ? "v2-nofit" : "v2") : "v1";

        (data.topics || []).forEach(raw => {
            const phrase = normalizeTopic(raw);
            if (!phrase) return;
            const r = ratedMap ? ratedMap.get(phrase) : null;
            if (ratedMap && !r) {
                debug(`[Topics] Rater dropped "${phrase}" from seed expansion.`);
                return;
            }
            // isBurned(), not burnedQueries.includes() — the old path used a raw
            // substring test, so a burn never generalised on this route.
            if (isBurned(phrase)) {
                debug(`[Topics] Skipping burned "${phrase}" from seed expansion.`);
                return;
            }
            // normalizeTopic on BOTH sides — the old comparison lowercased only
            // the stored phrase, so a Title-Case reply duplicated the entry.
            if (!state.topics.some(t => normalizeTopic(t.phrase) === phrase)) {
                state.topics.push({
                    phrase, weight: (r && r.weight) || 4, addedAt: Date.now(), src: _lastContextVariant,
                    role: bornRole, bornRole, fit: (r && r.fit) || undefined, tier: (r && r.tier) || undefined, gen
                });
            }
            if (!state.smartFeedTopicsQueue.includes(phrase) && !state.smartFeedUsedTopics.includes(phrase)) {
                state.smartFeedTopicsQueue.push(phrase);
                addedPhrases.push(phrase);
            }
        });

        if (addedPhrases.length) {
            saveTopics();
            pruneTopicPool();
            debug(`[Topics] Seeds [${cleanSeeds.join(", ")}] -> ${addedPhrases.length} new topics`);
            showToast(`Added ${addedPhrases.length} topics from "${query}"`, "success");
            fillSmartFeedPreloadBuffer();
        } else {
            debug("[Topics] Seed expansion returned nothing new.");
        }
        return addedPhrases;
    } catch (err) {
        console.error("[Topics] Seed expansion failed:", err);
        showToast(`Couldn't expand "${query}"`, "danger");
        throw err;
    }
}

// The four retrieval forms per topic. YouTube has no "older than" filter
// (it removed sort-by-upload-date in Jan 2026 and never had an age window),
// so older eras come from relevance/popularity results bucketed by their
// (now real) dates; the recent form is the one era YouTube CAN be asked for.
//   recent: sp = popularity + uploaded this year + type:video (CAMSBAgFEAE=,
//           verified live 2026-09-06 — only uploads from the last year came back)
//   broad:  relevance, any era, bucketed by date downstream
//   depth:  relevance on topic + facet/qualifier, intent-precise
//   proven: YouTube "popularity" (blends watch time; not pure views since
//           Jan 2026) — the only supply of classic/vintage uploads
const DISCOVERY_FORMS = {
    recent: { sp: "CAMSBAgFEAE=", limit: 8 },
    broad: { sort: "relevance", limit: 10 },
    depth: { sort: "relevance", limit: 8 },
    proven: { sort: "views", limit: 6 }
};

// Qualifiers for the "depth" query form when topic policy has no specific facets.
const DEPTH_QUALIFIERS = ["documentary", "deep dive", "explained", "full process", "start to finish"];

function getRandomDepthQualifier() {
    return DEPTH_QUALIFIERS[Math.floor(Math.random() * DEPTH_QUALIFIERS.length)];
}

// Interleave arrays round-robin so dedupe treats the query FORMS evenly.
// (This is not era diversity — era balance is composeSlate's job.)
function interleaveArrays(...arrays) {
    const result = [];
    const maxLen = Math.max(...arrays.map(a => a.length));
    for (let i = 0; i < maxLen; i++) {
        for (const arr of arrays) {
            if (i < arr.length) result.push(arr[i]);
        }
    }
    return result;
}

/**
 * Batched semantic classification of candidate videos via lazy-agent-service.
 * Classifies top candidate videos as ON_TOPIC, ADJACENT, NOVELTY, or OFF_TOPIC.
 */
/**
 * A cached classification is only trusted for the topic it was judged
 * against. The cache used to be keyed on video id alone, so one OFF_TOPIC
 * verdict for topic A permanently poisoned that video for topics B, C, D —
 * "military tank battle" is OFF_TOPIC for "fish tanks" and dead-on for
 * "tank museum restorations". A mismatched topic means re-classify.
 */
function cachedClassificationFor(videoId, topic) {
    const rec = state.candidateClassificationCache && state.candidateClassificationCache[videoId];
    if (!rec) return null;
    if (rec.topic && normalizeTopic(rec.topic) !== normalizeTopic(topic)) return null;
    return rec;
}

async function classifyCandidatesWithLLM(topic, candidates) {
    if (!candidates || candidates.length === 0) return candidates;
    if (state.settings && state.settings.semanticFilterEnabled === false) return candidates;

    const policy = getTopicPolicy(topic);
    if (!state.candidateClassificationCache) state.candidateClassificationCache = {};

    const unclassified = candidates.filter(v =>
        !v._classification && !cachedClassificationFor(v.id, topic)
    );

    if (unclassified.length > 0) {
        try {
            const controller = new AbortController();
            // 12s: the slice below can now span two backend batches of 15;
            // the old 6s budget was sized for one.
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            const resp = await countedFetch("/api/wallgarden/classify-candidates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    topic: topic,
                    intent: policy.intent || topic,
                    includeFacets: policy.includeFacets || [],
                    excludeFacets: policy.excludeFacets || [],
                    candidates: unclassified.slice(0, 30).map(v => ({
                        id: v.id,
                        title: v.title,
                        channel: v.channelName,
                        durationSecs: v.duration,
                        description: (v.description || "").slice(0, 200) || undefined
                    }))
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (resp.ok) {
                const data = await resp.json();
                if (data && Array.isArray(data.classifications)) {
                    data.classifications.forEach(c => {
                        state.candidateClassificationCache[c.id] = {
                            classification: c.classification,
                            reason: c.reason,
                            topic: normalizeTopic(topic),
                            t: Date.now()
                        };
                    });
                    saveCandidateClassificationCache();
                }
            }
        } catch (err) {
            debug(`[Semantic Classifier] /classify-candidates failed or timed out for "${topic}":`, err.message);
        }
    }

    // Hydrate all candidates from cache — same-topic verdicts only.
    candidates.forEach(v => {
        const rec = v._classification ? null : cachedClassificationFor(v.id, topic);
        if (rec) {
            v._classification = rec.classification;
            v._classificationReason = rec.reason;
        }
    });

    return candidates;
}

// ── One rank scale ────────────────────────────────────────────────────
// The discovery axes (0..2.5), the classifier verdict and the legacy keyword
// score used to be combined inline at fetch time and never read again. This
// is the single place that combination lives, so the slate composer can
// recompute it from the CURRENT preferences (a dislike or a new liked channel
// changes the order, not only the gate).
function rankScoreFor(v, ctx) {
    const axis = scoreDiscoveryVideo(v, ctx);
    let semanticBonus = 0;
    if (v._classification === "ON_TOPIC") semanticBonus = 8;
    else if (v._classification === "ADJACENT") semanticBonus = 2;
    else if (v._classification === "NOVELTY") semanticBonus = -30;
    else if (v._classification === "OFF_TOPIC") semanticBonus = -40;
    const legacy = (ctx && typeof ctx.legacyScore === "number") ? ctx.legacyScore
        : (typeof v.score === "number" ? v.score : 0);
    const rankScore = axis.score * 10 + semanticBonus + Math.max(-15, Math.min(15, legacy)) * 0.4;
    return {
        rankScore,
        breakdown: { ...axis.breakdown, classification: v._classification || "heuristic", reason: v._classificationReason }
    };
}

// ── Slate composition: calibrated, capped, deterministic ──────────────
// The pool is a candidate RESERVOIR, not an order. Until 2026-09-06 the ranked
// candidates were shuffled into it and a topic round-robin drew from it, so
// the rank never reached the screen and one channel could fill a batch.
//
// composeSlate is Steck's calibrated re-ranking (RecSys'18) with an MMR-style
// repeat penalty: each slot takes the candidate maximising
//   (1 - λ) · relevance  −  λ · KL(p_era ‖ q_era with this candidate)  −  penalty · repeats
// under per-channel and per-topic caps that relax only when nothing else is
// left. One explore slot mid-slate takes the best candidate from a topic the
// user has never been shown. Pure: no Math.random, ties go to pool order.
const SLATE_DEFAULTS = {
    lambda: 0.6,               // KL term is bounded ~ln(1/β); relevance is [0,1]
    beta: 0.01,                // Steck's smoothing so an empty bucket is finite
    caps: { channel: 2, topic: 3 },   // per 12 shown; scaled with the slate size
    perSlate: 12,
    repeatPenalty: 0.08,
    exploreSlots: 1
};

function composeSlate(pool, n, ctx) {
    const items = Array.isArray(pool) ? pool : [];
    const o = Object.assign({}, SLATE_DEFAULTS, ctx || {});
    const caps = Object.assign({}, SLATE_DEFAULTS.caps, (ctx && ctx.caps) || {});
    const p = o.targetEra || ERA_TARGET_MIX;
    const size = Math.min(Math.max(0, n | 0), items.length);
    const empty = { slate: [], breakdown: { era: {}, eraRaw: {}, topic: {}, channel: {}, target: p, kl: null } };
    if (size === 0) return empty;

    const now = (typeof o.now === "number") ? o.now : Date.now();
    const relFn = o.relevance || (v => (typeof v._rankScore === "number" ? v._rankScore : 0));
    const eraOf = o.eraOf || (v => eraBucketOf(v.published, now));
    const topicOf = o.topicOf || (v => normalizeTopic(v._topic || v.discoveryTopic || ""));
    const channelOf = o.channelOf || (v => ((v.channelName || "").toLowerCase() || v.channelId || ""));
    const scale = size / SLATE_DEFAULTS.perSlate;
    const capC = Number.isFinite(caps.channel) ? Math.max(1, Math.ceil(caps.channel * scale)) : Infinity;
    const capT = Number.isFinite(caps.topic) ? Math.max(1, Math.ceil(caps.topic * scale)) : Infinity;

    const cand = items.map((v, i) => {
        const raw = eraOf(v);
        const rel = relFn(v);
        return { v, i, rel: Number.isFinite(rel) ? rel : 0, eraRaw: raw,
                 // An undated row is a clock that starts now: it competes as
                 // "recent" and can never satisfy an older bucket's share.
                 era: raw === "unknown" ? "recent" : raw,
                 topic: topicOf(v), channel: channelOf(v) };
    });
    let lo = Infinity, hi = -Infinity;
    cand.forEach(c => { lo = Math.min(lo, c.rel); hi = Math.max(hi, c.rel); });
    cand.forEach(c => { c.relN = hi > lo ? (c.rel - lo) / (hi - lo) : 0.5; });

    const chosen = [];
    const used = new Set();
    const cnt = { era: {}, topic: {}, channel: {} };
    const calibWith = (era) => {
        const total = chosen.length + 1;
        const mixed = {};
        ERA_BUCKETS.forEach(b => {
            const q = ((cnt.era[b] || 0) + (b === era ? 1 : 0)) / total;
            mixed[b] = (1 - o.beta) * q + o.beta * (p[b] || 0);
        });
        return -klDivergence(p, mixed);
    };
    const underCaps = (c) => (cnt.channel[c.channel] || 0) < capC && (cnt.topic[c.topic] || 0) < capT;
    const take = (c) => {
        used.add(c.i); chosen.push(c);
        cnt.era[c.era] = (cnt.era[c.era] || 0) + 1;
        cnt.topic[c.topic] = (cnt.topic[c.topic] || 0) + 1;
        cnt.channel[c.channel] = (cnt.channel[c.channel] || 0) + 1;
    };
    const scan = (strict) => {
        let best = null, bestS = -Infinity;
        for (const c of cand) {
            if (used.has(c.i)) continue;
            if (strict && !underCaps(c)) continue;
            const repeat = (cnt.topic[c.topic] || 0) + (cnt.channel[c.channel] || 0);
            const sc = (1 - o.lambda) * c.relN + o.lambda * calibWith(c.era) - o.repeatPenalty * repeat;
            if (sc > bestS) { bestS = sc; best = c; }
        }
        return best;
    };

    let exploreLeft = o.exploreSlots || 0;
    const explorePos = Math.floor(size / 2);
    for (let slot = 0; slot < size; slot++) {
        if (exploreLeft > 0 && slot === explorePos && typeof o.isUnexploredTopic === "function") {
            let best = null, bestRel = -Infinity;
            for (const c of cand) {
                if (used.has(c.i) || !underCaps(c) || !o.isUnexploredTopic(c.topic)) continue;
                if (c.relN > bestRel) { bestRel = c.relN; best = c; }
            }
            if (best) { take(best); exploreLeft -= 1; continue; }
        }
        const best = scan(true) || scan(false);
        if (!best) break;
        take(best);
    }

    const eraRaw = {};
    chosen.forEach(c => { eraRaw[c.eraRaw] = (eraRaw[c.eraRaw] || 0) + 1; });
    const qFinal = {};
    ERA_BUCKETS.forEach(b => { qFinal[b] = (cnt.era[b] || 0) / chosen.length; });
    return {
        slate: chosen.map(c => c.v),
        breakdown: { era: cnt.era, eraRaw, topic: cnt.topic, channel: cnt.channel, target: p, kl: klDivergence(p, qFinal) }
    };
}

// Everything composeSlate needs from live state, built once per slate.
function buildSlateCtx() {
    const now = Date.now();
    const likedChannels = new Set(getLikedChannelAffinity().keys());
    return {
        now,
        targetEra: deriveEraPrior(undefined, now),
        likedChannels,
        // Fresh rank from CURRENT preferences; written back so the render
        // gate and the debug breakdown read the same number.
        relevance: (v) => {
            const topic = v._topic || v.discoveryTopic || "";
            const legacy = getScoreAndMatches(v).score;
            const r = rankScoreFor(v, { topic, likedChannels, legacyScore: legacy });
            v._rankScore = r.rankScore;
            v._rankBreakdown = r.breakdown;
            return r.rankScore;
        },
        isUnexploredTopic: (t) => topicSignalTotal(t, "imp") === 0
    };
}

// Same mutate-and-return contract the old round-robin picker had: the chosen
// videos leave the pool. Breakdown goes to the console under WG_DEBUG.
function takeSlate(pool, n, ctx) {
    const { slate, breakdown } = composeSlate(pool, n, ctx || buildSlateCtx());
    const ids = new Set(slate.map(v => v.id));
    for (let i = pool.length - 1; i >= 0; i--) {
        if (ids.has(pool[i].id)) pool.splice(i, 1);
    }
    if (slate.length) debug(`[Slate] ${slate.length} picked — eras ${JSON.stringify(breakdown.era)} (raw ${JSON.stringify(breakdown.eraRaw)}), KL ${breakdown.kl === null ? "n/a" : breakdown.kl.toFixed(3)}, topics ${Object.keys(breakdown.topic).length}, channels ${Object.keys(breakdown.channel).length}`);
    return slate;
}

// ── Late classification: the model's verdict, off the render path ───────
// At most LATE_CLASSIFY_CONCURRENCY calls in flight; the rest queue. Verdicts
// are written onto the candidate objects (the same objects the pool holds),
// and NOVELTY/OFF_TOPIC survivors are evicted from the pool.
const LATE_CLASSIFY_CONCURRENCY = 2;
const _lateClassifyQueue = [];
let _lateClassifyInFlight = 0;

function scheduleLateClassification(topic, candidates) {
    if (!candidates || !candidates.length) return;
    if (state.settings.semanticFilterEnabled === false) return;
    _lateClassifyQueue.push({ topic, candidates });
    pumpLateClassification();
}

function pumpLateClassification() {
    while (_lateClassifyInFlight < LATE_CLASSIFY_CONCURRENCY && _lateClassifyQueue.length) {
        const job = _lateClassifyQueue.shift();
        _lateClassifyInFlight += 1;
        Promise.resolve()
            .then(() => classifyCandidatesWithLLM(job.topic, job.candidates))
            .then(() => applyLateClassifications(job.topic, job.candidates))
            .catch(err => console.warn(`[Classify] late classification failed for "${job.topic}":`, err && err.message))
            .finally(() => { _lateClassifyInFlight -= 1; pumpLateClassification(); });
    }
}

function applyLateClassifications(topic, candidates) {
    const bad = new Set(candidates
        .filter(v => v._classification === "NOVELTY" || v._classification === "OFF_TOPIC")
        .map(v => v.id));
    if (!bad.size) return 0;
    const pool = state.smartFeedSuggestionPool || [];
    const before = pool.length;
    state.smartFeedSuggestionPool = pool.filter(v => !bad.has(v.id));
    const evicted = before - state.smartFeedSuggestionPool.length;
    if (evicted) {
        saveSmartFeedSuggestionPool();
        debug(`[Classify] "${topic}": late verdicts evicted ${evicted} NOVELTY/OFF_TOPIC candidate(s) from the pool`);
    }
    return evicted;
}

async function fetchVideosForTopic(topic) {
    let videos = [];
    let success = false;
    const fetchCountPerRequest = 10;
    const policy = getTopicPolicy(topic);
    
    if (state.settings.useYtdlp) {
        try {
            // Era-aware 4-way parallel fetch — see DISCOVERY_FORMS.
            let depthQuery = "";
            if (policy && Array.isArray(policy.includeFacets) && policy.includeFacets.length > 0) {
                const facet = policy.includeFacets[Math.floor(Math.random() * policy.includeFacets.length)];
                depthQuery = `${topic} ${facet}`;
            } else {
                depthQuery = `${topic} ${getRandomDepthQualifier()}`;
            }

            debug(`[Smart Feed Fetch] 4-way parallel for "${topic}" — recent(this year) + broad(relevance) + depth(${depthQuery}) + proven(popularity)`);

            const fetchOne = async (query, how, label, limit = fetchCountPerRequest) => {
                const controller = new AbortController();
                // The scraper queues searches behind a 3-wide gate and gives
                // each one 25 s; abort a little above that so a queued form
                // returns instead of being dropped at 15 s and re-asked.
                const timeoutId = setTimeout(() => controller.abort(), 30000);
                try {
                    // The scraper's raw `sp` (YouTube results-filter token) wins
                    // over `sort` when both are sent, so send exactly one.
                    const body = {
                        source: "youtube",
                        query: query,
                        limit: limit,
                        days_back: 0,
                        require_transcript: false
                    };
                    if (how && how.sp) body.sp = how.sp; else body.sort = (how && how.sort) || "relevance";
                    const resp = await fetch("/scraper/collect", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data && Array.isArray(data.items)) {
                            debug(`[Smart Feed Fetch] ${label} returned ${data.items.length} videos`);
                            return data.items;
                        }
                    }
                } catch (err) {
                    clearTimeout(timeoutId);
                    console.warn(`[Smart Feed Fetch] ${label} request failed:`, err.message);
                }
                return [];
            };

            // Four forms, fired in parallel. Each is one yt-dlp subprocess on
            // the scraper (hard 10s timeout there), so the cold-start fan-out
            // below was lowered 6 -> 4 topics to keep peak concurrency flat.
            const F = DISCOVERY_FORMS;
            // Core topics deserve more candidates than an explore experiment:
            // scale every form's limit by the topic's role budget (10/8/5).
            const hint = topicFetchHint(topic);
            const lim = base => Math.max(3, Math.round(base * hint.fetchBudget / QUEUE_COMPOSE.fetchBudget.core));
            const [recentItems, broadItems, depthItems, provenItems] = await Promise.all([
                fetchOne(topic, F.recent, "recent(this-year+popularity)", lim(F.recent.limit)),
                fetchOne(topic, F.broad, "broad(relevance)", lim(F.broad.limit)),
                fetchOne(depthQuery, F.depth, `depth(${depthQuery})`, lim(F.depth.limit)),
                fetchOne(topic, F.proven, "proven(popularity:capped)", lim(F.proven.limit))
            ]);

            // Map items to video objects, tagging form + in-form rank for the scorer
            const mapItems = (items, form) => {
                const mapped = [];
                items.forEach((item, idx) => {
                    if (item.video_id) {
                        mapped.push({
                            id: item.video_id,
                            title: item.title,
                            channelName: item.channel,
                            // UC… id from the scraper (added 2026-08-22) — empty only on
                            // its DuckDuckGo fallback. Real ids make id-based channel
                            // blocking and graph Channel nodes finally work on discovery.
                            channelId: item.channel_id || "",
                            published: item.published_at ? Date.parse(item.published_at) : null,
                            // Approximate (month/year real, day = today's) — see eraBucketOf.
                            publishedEstimated: !!item.published_at_estimated,
                            // First ~200 chars of the results-card snippet; a classifier
                            // hint, stripped again before the pool is persisted.
                            description: item.description || "",
                            duration: item.duration_secs,
                            viewCount: item.view_count,
                            isDiscover: true,
                            discoveryTopic: topic,
                            _form: form,
                            _fetchRank: idx
                        });
                    }
                });
                return mapped;
            };

            const recentVideos = mapItems(recentItems, "recent");
            const broadVideos = mapItems(broadItems, "broad");
            const depthVideos = mapItems(depthItems, "depth");
            const provenVideos = mapItems(provenItems, "proven");

            // Interleave forms round-robin so dedupe treats them evenly
            const interleaved = interleaveArrays(recentVideos, broadVideos, depthVideos, provenVideos);

            // Deduplicate by video id
            const seenIds = new Set();
            interleaved.forEach(v => {
                if (!seenIds.has(v.id)) {
                    seenIds.add(v.id);
                    videos.push(v);
                }
            });

            if (videos.length > 0) {
                success = true;
                const formBreakdown = {
                    recent: videos.filter(v => v._form === "recent").length,
                    broad: videos.filter(v => v._form === "broad").length,
                    depth: videos.filter(v => v._form === "depth").length,
                    proven: videos.filter(v => v._form === "proven").length
                };
                debug(`[Smart Feed Fetch] Total unique videos for "${topic}": ${videos.length} (recent:${formBreakdown.recent}, broad:${formBreakdown.broad}, depth:${formBreakdown.depth}, proven:${formBreakdown.proven})`);
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
                                if (videoId && title) {
                                    videos.push({
                                        id: videoId,
                                        title: title,
                                        channelName: channelName,
                                        // HTML-scrape fallback: the results page carries no
                                        // stable UC… id worth trusting — name-only.
                                        channelId: "",
                                        published: parseYtAgeText(vr.publishedTimeText?.simpleText),
                                        duration: parseYtDurationText(vr.lengthText?.simpleText),
                                        viewCount: parseYtViewsText(vr.viewCountText?.simpleText),
                                        isDiscover: true,
                                        discoveryTopic: topic,
                                        _form: "broad",
                                        _fetchRank: videos.length
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
        const spamLikedChannels = new Set(getLikedChannelAffinity().keys());
        const spamDropped = {};
        const kept = videos.filter(v => {
            // Hard spam-shape gate first — cheaper than scoring, far cheaper
            // than the classifier call the survivors get.
            const spamReason = isSpamShapedVideo(v, spamLikedChannels);
            if (spamReason) {
                spamDropped[spamReason] = (spamDropped[spamReason] || 0) + 1;
                return false;
            }

            const evaluation = getScoreAndMatches(v);
            v.score = evaluation.score;
            v.matchedTopics = evaluation.matches;

            const isBlockedChannel = isChannelBlocked(v.channelId, v.channelName);

            // Never resurface videos already watched (incl. synced from YouTube) or disliked
            const isWatched = state.watchedHistory && state.watchedHistory[v.id];
            const isDisliked = state.videoRatings && state.videoRatings[v.id] < 0;

            // Deterministic hard exclusion: if title matches topic's excludeFacets or novelty pattern
            const titleLower = (v.title || "").toLowerCase();
            const isExcludedFacet = policy.excludeFacets && policy.excludeFacets.some(f => titleLower.includes(f.toLowerCase()));
            const isHardNovelty = WG_NOVELTY_RE.test(v.title || "") && !/\b(lego|minecraft|roblox|toy|brick)\b/i.test(topic);

            if (isExcludedFacet || isHardNovelty) {
                v._classification = "NOVELTY";
                v._classificationReason = isExcludedFacet ? "excluded facet match" : "novelty pattern match";
            }

            return !isBlockedChannel && !isWatched && !isDisliked && v.score > -10;
        });

        if (Object.keys(spamDropped).length) {
            debug(`[Discovery] "${topic}": dropped spam-shaped ${JSON.stringify(spamDropped)}`);
        }

        // The classifier is a ~10 s Jetson call per topic (measured 10.2 s for
        // 30 candidates on 2026-09-06) and it sat on the critical path of every
        // render: nothing appeared until the scraper AND the model had both
        // answered. Candidates now ship on the heuristic rank; the verdicts
        // land in the background and evict NOVELTY/OFF_TOPIC from the pool
        // when they arrive (composeSlate re-ranks from `_classification` at
        // every draw, so a late verdict still orders later slates).
        scheduleLateClassification(topic, kept.slice(0, 30));

        // Rank best-first so the downstream per-topic keep takes the top
        // candidates instead of whatever arrived first.
        const likedChannels = new Set(getLikedChannelAffinity().keys());
        kept.forEach(v => {
            const r = rankScoreFor(v, { topic, topicPolicy: policy, likedChannels, legacyScore: v.score });
            v._rankScore = r.rankScore;
            v._rankBreakdown = r.breakdown;
        });

        // Filter out outright NOVELTY and OFF_TOPIC candidates before feed cap
        const filteredKept = kept.filter(v => {
            if (v._classification === "NOVELTY" || v._classification === "OFF_TOPIC") return false;
            return v._rankScore > -5;
        });

        filteredKept.sort((a, b) => b._rankScore - a._rankScore);
        return filteredKept;
    }

    return [];
}

// ── Grounding gate ───────────────────────────────────────────
// Judge upcoming queue topics by their ACTUAL YouTube results before the
// feed spends a full 3-way fetch on them. Evidence replaces guessing:
// a topic whose top results are unrelated listicle slop gets pulled from
// the queue; one that fronts a real niche gets a weight bump. Fail-open —
// any error just leaves topics ungated.
const GROUNDING_LOOKAHEAD = 5;
let _groundingInProgress = false;
let _groundingTimer = null;

function scheduleGrounding(delayMs) {
    if (!state.settings.groundingEnabled) return;
    if (_groundingTimer) clearTimeout(_groundingTimer);
    _groundingTimer = setTimeout(() => {
        _groundingTimer = null;
        groundNextQueuedTopics();
    }, delayMs);
}

// Per-verdict cache lifetimes. REAL is stable knowledge (30d). SLOP/DEAD are
// short (7d) ON PURPOSE: the candidate filter skips any topic that holds a
// verdict, so under the old flat 30d a first-strike topic could not be
// re-judged — the burn-on-second-strike path was unreachable for a month.
// MIXED also 7d: it takes no action, but it still occupies the filter slot.
const GROUNDING_VERDICT_TTL_MS = {
    REAL: 30 * 86400e3,
    MIXED: 7 * 86400e3,
    SLOP: 7 * 86400e3,
    DEAD: 7 * 86400e3,
};

function sweepGroundingVerdicts() {
    const now = Date.now();
    let removed = 0;
    Object.entries(state.groundingVerdicts || {}).forEach(([k, v]) => {
        const ttl = GROUNDING_VERDICT_TTL_MS[v && v.verdict] || 7 * 86400e3;
        if (now - ((v && v.t) || 0) > ttl) { delete state.groundingVerdicts[k]; removed++; }
    });
    if (removed) saveGroundingVerdicts();
}

let _groundingInterval = null;
function startGroundingInterval() {
    if (_groundingInterval) return;
    _groundingInterval = setInterval(() => {
        if (!state.settings.groundingEnabled) return;
        if (_groundingInProgress) return;
        if (!(state.smartFeedTopicsQueue || []).length) return;
        sweepGroundingVerdicts();   // expiry must not wait for a page load
        groundNextQueuedTopics();
    }, 90_000);
}

function applyGroundingVerdict(topic, verdict) {
    const norm = normalizeTopic(topic);
    const prev = state.groundingVerdicts[norm];
    state.groundingVerdicts[norm] = { verdict, t: Date.now() };

    if (verdict === "MIXED") {
        // Some real signal amid filler: no demotion, no bonus. The verdict is
        // stored (7d) so the lookahead moves on, then the topic gets re-judged
        // once YouTube's results have had a week to shift.
        debug(`[Grounding] "${norm}" judged MIXED — leaving weight untouched.`);
        return;
    }
    if (verdict === "REAL") {
        const entry = state.topics.find(t => normalizeTopic(t.phrase) === norm);
        if (entry && entry.weight > 0) entry.weight += 2; // evidence bonus
        return;
    }
    if (verdict === "SLOP" || verdict === "DEAD") {
        state.smartFeedTopicsQueue = state.smartFeedTopicsQueue.filter(t => normalizeTopic(t) !== norm);
        if (prev && (prev.verdict === "SLOP" || prev.verdict === "DEAD")) {
            // Second strike: burn, which generalises the negative signal.
            debug(`[Grounding] Second ${verdict} verdict for "${norm}" — burning.`);
            burnTopic(norm);
        } else {
            // First strike: demote so pruneTopicPool decays it out.
            const entry = state.topics.find(t => normalizeTopic(t.phrase) === norm);
            if (entry) entry.weight = 0.5;
            debug(`[Grounding] "${norm}" judged ${verdict} — demoted and pulled from the queue.`);
        }
    }
}

async function groundNextQueuedTopics() {
    if (_groundingInProgress || !state.settings.groundingEnabled) return;
    // Next K queue topics without a live verdict
    const pending = state.smartFeedTopicsQueue
        .filter(t => !state.groundingVerdicts[normalizeTopic(t)])
        .slice(0, GROUNDING_LOOKAHEAD);
    if (pending.length === 0) return;
    _groundingInProgress = true;

    try {
        const items = [];
        for (const topic of pending) {
            // One cheap relevance search per topic — sequential, kind to yt-dlp.
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                const resp = await fetch("/scraper/collect", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        source: "youtube",
                        query: topic,
                        limit: 8,
                        days_back: 0,
                        require_transcript: false,
                        sort: "relevance"
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                const data = resp.ok ? await resp.json() : null;
                const results = (data && Array.isArray(data.items)) ? data.items : [];
                if (results.length === 0) {
                    applyGroundingVerdict(topic, "DEAD");
                } else {
                    items.push({
                        topic,
                        titles: results.map(r => r.title).filter(Boolean).slice(0, 8),
                        channels: [...new Set(results.map(r => r.channel).filter(Boolean))].slice(0, 8),
                        // Views + upload year let the judge tell a dead scene
                        // from a live one (verdict DEAD); older backends ignore it.
                        results: results.filter(r => r && r.title).slice(0, 8).map(r => ({
                            title: r.title,
                            channel: r.channel || undefined,
                            views: typeof r.view_count === "number" ? r.view_count : undefined,
                            year: r.published_at ? new Date(r.published_at).getUTCFullYear() : undefined
                        }))
                    });
                }
            } catch (err) {
                debug(`[Grounding] Search failed for "${topic}" — leaving ungated.`, err.message);
            }
        }

        if (items.length > 0) {
            const resp = await countedFetch("/api/wallgarden/judge-topics", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ items }),
                signal: AbortSignal.timeout(120000)
            });
            if (resp.ok) {
                const data = await resp.json();
                (data.verdicts || []).forEach(v => {
                    if (v && v.topic && v.verdict) applyGroundingVerdict(v.topic, v.verdict);
                });
            }
        }
        saveGroundingVerdicts();
        saveTopics();
    } catch (err) {
        console.warn("[Grounding] Gate pass failed (fail-open):", err.message);
    }
    _groundingInProgress = false;
}

let smartFeedPreloadTimeout = null;
let currentPreloadPromise = null;

// Fisher-Yates shuffle for unbiased randomization
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function fillSmartFeedPreloadBuffer() {
    if (state.smartFeedPreloadLoading) {
        return currentPreloadPromise || Promise.resolve();
    }
    
    // Do not pre-load if there are no positive topics added yet
    if (state.topics.filter(t => t.weight > 0).length === 0) {
        return Promise.resolve();
    }
    
    // Keep a larger buffer (1000 suggestions) for instant zero-lag loading
    const targetPreloadCount = 1000;
    if (state.smartFeedSuggestionPool.length >= targetPreloadCount) {
        return Promise.resolve();
    }
    
    // Clear any pending timeout to prevent duplicate schedules
    if (smartFeedPreloadTimeout) {
        clearTimeout(smartFeedPreloadTimeout);
        smartFeedPreloadTimeout = null;
    }
    
    // Check if we need to brainstorm more topics using LLM
    const totalUpcoming = state.smartFeedTopicsQueue.length;

    // DELIBERATELY NO BRAINSTORM HERE.
    //
    // This function re-invokes itself every 1.5s while the video pool is under
    // 1000, and this gate used to ask for 100 fresh topics every 15s — roughly
    // 400 topics/min produced against ~40/min consumed, at 8 LLM calls a pop.
    // That single line was the bulk of the "it spawns topics while I browse"
    // problem. The preloader now only fetches VIDEOS for topics that already
    // earned their place; growing the pool is the queue flush's job alone.
    if (totalUpcoming === 0 && !state.brainstormLoading) {
        notifyTopicQueueEmpty();
    }
    
    if (state.smartFeedTopicsQueue.length === 0) {
        debug("[Smart Feed] Queue is empty! Repopulating from positive topics...");
        // Same burn filter initSmartFeed applies — without it, a mid-session
        // burn's reworded siblings walked straight back into the queue here.
        state.smartFeedTopicsQueue = composeTopicQueue(state.topics);
    }
    
    // If pool is empty or low, fetch multiple topics in parallel for speed and topic diversity
    const isPoolLow = state.smartFeedSuggestionPool.length < 24;
    const isPoolEmpty = state.smartFeedSuggestionPool.length === 0;
    // Cold start is the latency-critical path: fan out wider so the first
    // batch renders after ONE round-trip instead of several sequential rounds.
    // 3, not 6: each topic is four scraper subprocesses and the scraper runs
    // three yt-dlp calls at a time on its 4-core box (the rest queue). A wider
    // fan-out only makes every topic wait for every other topic.
    const parallelCount = isPoolEmpty ? 3 : (isPoolLow ? 2 : 1);
    
    const topicsToFetch = [];
    for (let i = 0; i < parallelCount; i++) {
        const topic = state.smartFeedTopicsQueue.shift();
        if (topic) topicsToFetch.push(topic);
    }
    if (topicsToFetch.length === 0) return Promise.resolve();
    
    state.smartFeedPreloadLoading = true;
    state.smartFeedUsedTopics.push(...topicsToFetch);

    // NO scheduleGrounding here. This loop re-enters every ~1.5s while the
    // video pool is under 1000, and scheduleGrounding is a DEBOUNCE — each
    // pass cancelled the previous 5s timer, so grounding only ever fired when
    // a fetch round happened to take longer than ~3.5s. The gate now runs on
    // its own interval (startGroundingInterval), immune to this loop's pace.
    
    if (isPoolEmpty) {
        debug(`[Smart Feed Preload] Cold start — parallel fetching ${topicsToFetch.length} topics: ${topicsToFetch.join(', ')}`);
    } else {
        debug(`[Smart Feed Preload] Pre-fetching discovery videos for ${topicsToFetch.length} topics: ${topicsToFetch.join(', ')}`);
    }
    
    currentPreloadPromise = (async () => {
        try {
            // Fire all topic fetches in parallel
            const fetchPromises = topicsToFetch.map(topic => 
                fetchVideosForTopic(topic)
                    .then(videos => ({ topic, videos: videos || [] }))
                    .catch(err => {
                        console.warn(`[Smart Feed Preload] Failed for "${topic}":`, err.message);
                        return { topic, videos: [] };
                    })
            );
            
            const timestamp = Date.now();
            let totalAdded = 0;
            let topicsWithVideos = 0;
            const slateCtx = { now: timestamp, targetEra: deriveEraPrior(undefined, timestamp) };

            // Dedupe against everything already in the pool or rendered in the feed
            const knownIds = new Set(state.smartFeedSuggestionPool.map(v => v.id));
            (state.smartFeedVideos || []).forEach(v => knownIds.add(v.id));

            // Absorb each topic AS IT LANDS. The old Promise.all held every
            // topic's videos until the slowest topic answered, so a cold start
            // painted nothing for the full round trip; now the first topic
            // back is the first chunk on screen and the rest fill the pool.
            const absorb = ({ topic, videos }) => {
                if (videos.length > 0) {
                    videos.forEach(v => {
                        v._topic = topic;
                        v.crawledAt = timestamp;
                    });

                    // Keep at most 8 per topic — and pick those 8 as a small
                    // era-calibrated, channel-capped slate rather than the top 8
                    // by rank, which would be whatever era relevance favours.
                    const fresh = videos.filter(v => !knownIds.has(v.id));
                    const limitedVideos = composeSlate(fresh, 8, {
                        ...slateCtx, caps: { channel: 2, topic: Infinity }, exploreSlots: 0
                    }).slate;
                    limitedVideos.forEach(v => knownIds.add(v.id));
                    state.smartFeedSuggestionPool.push(...limitedVideos);
                    totalAdded += limitedVideos.length;
                    if (limitedVideos.length) topicsWithVideos += 1;

                    if (limitedVideos.length && state.currentView === "smart-feed" &&
                        state.smartFeedVideos.length === 0 && !state.smartFeedLoading) {
                        loadNextSmartFeedBatch();
                    }
                } else {
                    console.warn(`[Smart Feed Preload] No videos found for topic "${topic}".`);
                }
            };
            await Promise.all(fetchPromises.map(p => p.then(absorb)));
            
            if (totalAdded > 0) {
                // No shuffle: the pool is a reservoir and composeSlate orders it.
                saveSmartFeedSuggestionPool();
                
                debug(`[Smart Feed Preload] Successfully preloaded ${totalAdded} videos from ${topicsWithVideos} topics. Pool size: ${state.smartFeedSuggestionPool.length}`);
            }
        } catch (err) {
            console.error(`[Smart Feed Preload] Failed preloading:`, err);
        } finally {
            state.smartFeedPreloadLoading = false;
            currentPreloadPromise = null;
            
            // Cooldown delay of 1.5 seconds between fetches to protect from rate-limiting
            if (state.smartFeedSuggestionPool.length < targetPreloadCount) {
                smartFeedPreloadTimeout = setTimeout(() => {
                    fillSmartFeedPreloadBuffer();
                }, 1500);
            }
        }
    })();
    
    return currentPreloadPromise;
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
    
    // Check if we have suggestions in our persistent pool
    if (state.smartFeedSuggestionPool.length > 0) {
        // A calibrated slate of 12: ranked, era-balanced, channel/topic-capped
        const videosToRender = takeSlate(state.smartFeedSuggestionPool, 12);
        
        saveSmartFeedSuggestionPool();
        
        // Dynamic check against active preferences/blocks on-the-fly
        const allowedVideos = videosToRender.filter(v => {
            const evaluation = getScoreAndMatches(v);
            v.score = evaluation.score;
            v.matchedTopics = evaluation.matches;
            
            const isBlockedChannel = isChannelBlocked(v.channelId, v.channelName);
            
            // Both scales gate here: the legacy keyword score (-10 floor) and
            // the unified rank the slate was composed on (-5 floor).
            const rankOk = typeof v._rankScore !== "number" || v._rankScore > -5;
            return !isBlockedChannel && v.score > -10 && rankOk;
        });
        
        const existingIds = new Set(state.smartFeedVideos.map(v => v.id));
        const deduplicated = allowedVideos.filter(v => !existingIds.has(v.id));
        
        if (deduplicated.length > 0) {
            state.smartFeedVideos.push(...deduplicated);
            recordFeedShown(deduplicated);
            
            const fragment = document.createDocumentFragment();
            deduplicated.forEach(video => {
                renderCard(video, fragment);
            });
            suggestionsGrid.appendChild(fragment);
        }
        
        state.smartFeedLoading = false;
        updateStatusText("Ready");
        
        debug(`[Smart Feed Batch] Rendered ${deduplicated.length} cards (pool: ${state.smartFeedSuggestionPool.length}, total rendered: ${state.smartFeedVideos.length})`);
        
        // Trigger preloader asynchronously in background to replenish pool
        fillSmartFeedPreloadBuffer();
        
        // Re-check: if the user is still near the bottom after rendering,
        // schedule another batch immediately. This self-feeds until content
        // fills the viewport, then stops naturally.
        requestAnimationFrame(() => {
            const feedSection = document.querySelector(".feed-section");
            if (feedSection && state.currentView === "smart-feed" && !state.smartFeedLoading) {
                const distFromBottom = feedSection.scrollHeight - feedSection.scrollTop - feedSection.clientHeight;
                if (distFromBottom < 1200) {
                    debug(`[Smart Feed Batch] Still near bottom (${distFromBottom}px), loading another batch...`);
                    loadNextSmartFeedBatch();
                }
            }
        });
        return;
    }
    
    // Fallback if buffer is empty
    let skeletonsAdded = false;
    let scrollLoader = null;
    if (state.smartFeedVideos.length === 0) {
        if (suggestionsGrid.querySelectorAll(".skeleton-card").length === 0) {
            const fragment = document.createDocumentFragment();
            for (let i = 0; i < 12; i++) {
                const skeleton = document.createElement("div");
                skeleton.className = "video-card skeleton-card";
                skeleton.innerHTML = `
                    <div class="skeleton-thumbnail"></div>
                    <div class="skeleton-details">
                        <div class="skeleton-text title" style="width: 90%;"></div>
                        <div class="skeleton-text title" style="width: 70%;"></div>
                        <div class="skeleton-text meta" style="width: 40%; margin-top: 1rem;"></div>
                    </div>
                `;
                fragment.appendChild(skeleton);
            }
            suggestionsGrid.appendChild(fragment);
            skeletonsAdded = true;
        }
    } else {
        const parentContainer = suggestionsGrid.parentNode || suggestionsGrid;
        scrollLoader = document.getElementById("smart-feed-scroll-loader");
        if (!scrollLoader) {
            scrollLoader = document.createElement("div");
            scrollLoader.id = "smart-feed-scroll-loader";
            scrollLoader.className = "infinite-scroll-loader";
            scrollLoader.innerHTML = `<div class="loader-spinner"></div><p>Discovering more videos...</p>`;
            if (suggestionsGrid.nextSibling) {
                parentContainer.insertBefore(scrollLoader, suggestionsGrid.nextSibling);
            } else {
                parentContainer.appendChild(scrollLoader);
            }
        }
    }
    
    if (state.smartFeedTopicsQueue.length === 0) {
        const positiveTopics = state.topics.filter(t => t.weight > 0);
        if (positiveTopics.length > 0) {
            debug("[Smart Feed] Queue is empty! Repopulating from positive topics...");
            // The generateBrainstormTopics(true) that used to sit here was the
            // last surviving automatic 100-topic brainstorm — unreachable only
            // because this branch requires an empty queue AND a non-empty
            // positive pool, and the line above always refilled the queue
            // first. Deleted rather than left one edit from resurrection.
            state.smartFeedTopicsQueue = composeTopicQueue(state.topics);
        }
    }
    
    const topic = state.smartFeedTopicsQueue.shift();
    if (!topic) {
        suggestionsGrid.querySelectorAll(".skeleton-card").forEach(el => el.remove());
        if (scrollLoader) scrollLoader.remove();
        const existingLoader = document.getElementById("smart-feed-scroll-loader");
        if (existingLoader) existingLoader.remove();
        state.smartFeedLoading = false;
        return;
    }
    state.smartFeedUsedTopics.push(topic);
    
    debug(`[Smart Feed] Fetching discovery videos for topic: "${topic}" (on-demand fallback)...`);
    updateStatusText(`Smart Feed: Discovering "${capitalizePhrase(topic)}"...`);
    
    try {
        const videos = await fetchVideosForTopic(topic);
        const existingIds = new Set(state.smartFeedVideos.map(v => v.id));
        const deduplicated = videos.filter(v => !existingIds.has(v.id));
        // Cap per-topic to prevent single-topic flooding (same as preload path)
        const limited = composeSlate(deduplicated, 8, {
            targetEra: deriveEraPrior(), caps: { channel: 2, topic: Infinity }, exploreSlots: 0
        }).slate;
        const limitedIds = new Set(limited.map(v => v.id));
        
        if (limited.length > 0) {
            limited.forEach(v => v._topic = topic);
            state.smartFeedVideos.push(...limited);
            recordFeedShown(limited);
            
            // Also add remaining videos to the pool for future batches
            const remainingForPool = deduplicated.filter(v => !limitedIds.has(v.id));
            if (remainingForPool.length > 0) {
                const timestamp = Date.now();
                remainingForPool.forEach(v => {
                    v._topic = topic;
                    v.crawledAt = timestamp;
                });
                state.smartFeedSuggestionPool.push(...remainingForPool);
                saveSmartFeedSuggestionPool();
            }
            
            const fragment = document.createDocumentFragment();
            limited.forEach(video => {
                renderCard(video, fragment);
            });
            suggestionsGrid.appendChild(fragment);
        }
    } catch (err) {
        console.error(`[Smart Feed] Fallback fetch failed for "${topic}":`, err);
    } finally {
        suggestionsGrid.querySelectorAll(".skeleton-card").forEach(el => el.remove());
        if (scrollLoader) scrollLoader.remove();
        const existingLoader = document.getElementById("smart-feed-scroll-loader");
        if (existingLoader) existingLoader.remove();
        
        state.smartFeedLoading = false;
        updateStatusText("Ready");
        
        fillSmartFeedPreloadBuffer();
        
        // Re-check: if user is still near the bottom, load another batch
        requestAnimationFrame(() => {
            const feedSection = document.querySelector(".feed-section");
            if (feedSection && state.currentView === "smart-feed" && !state.smartFeedLoading) {
                const distFromBottom = feedSection.scrollHeight - feedSection.scrollTop - feedSection.clientHeight;
                if (distFromBottom < 1200) {
                    loadNextSmartFeedBatch();
                }
            }
        });
    }
}

// Replenish Smart Feed with diverse suggestions from pool when topics are removed
async function replenishSmartFeed(count, appendToDom = true) {
    if (count <= 0) return;
    
    const pool = state.smartFeedSuggestionPool;
    if (pool.length < count) {
        // Pool is low! We need to preload more videos right now and wait for them.
        await fillSmartFeedPreloadBuffer();
    }
    
    if (pool.length > 0) {
        const videosToRender = takeSlate(pool, count);
        saveSmartFeedSuggestionPool();
        
        // Filter allowed videos on-the-fly
        const allowedVideos = videosToRender.filter(v => {
            const evaluation = getScoreAndMatches(v);
            v.score = evaluation.score;
            v.matchedTopics = evaluation.matches;
            
            const isBlockedChannel = isChannelBlocked(v.channelId, v.channelName);
            
            // Both scales gate here: the legacy keyword score (-10 floor) and
            // the unified rank the slate was composed on (-5 floor).
            const rankOk = typeof v._rankScore !== "number" || v._rankScore > -5;
            return !isBlockedChannel && v.score > -10 && rankOk;
        });
        
        const existingIds = new Set(state.smartFeedVideos.map(v => v.id));
        const deduplicated = allowedVideos.filter(v => !existingIds.has(v.id));
        
        if (deduplicated.length > 0) {
            state.smartFeedVideos.push(...deduplicated);
            recordFeedShown(deduplicated);
            
            if (appendToDom) {
                const suggestionsGrid = document.getElementById("suggestions-grid") || document.getElementById("video-grid");
                if (suggestionsGrid) {
                    const fragment = document.createDocumentFragment();
                    deduplicated.forEach(video => {
                        renderCard(video, fragment);
                    });
                    suggestionsGrid.appendChild(fragment);
                }
            }
        }
        
        // Kick off buffer preloader in background
        fillSmartFeedPreloadBuffer();
        
        // If we got fewer than the requested count (due to filters), try to replenish more
        const actualAdded = deduplicated.length;
        if (actualAdded < count && pool.length > 0) {
            await replenishSmartFeed(count - actualAdded, appendToDom);
        }
    } else {
        await fillSmartFeedPreloadBuffer();
    }
}

// Mute and remove a discovery topic completely
function nukeDiscoverTopic(topic) {
    if (!topic) return;
    
    const normalizedTopic = topic.trim().toLowerCase();

    // Count the rendered cards BEFORE burning — burnTopic filters
    // smartFeedVideos itself now, so counting afterwards always reads 0 and
    // the replenish below would never fire.
    const removedCount = (state.smartFeedVideos || []).filter(v =>
        ((v.discoveryTopic || v._topic || v.topic || "").trim().toLowerCase()) === normalizedTopic
    ).length;

    // 1-2. Burn it: blacklist (with parole), mark disliked, drive it negative
    // in the graph so its neighbours cool off, and demote its siblings. Also
    // clears the queue, pool, rendered videos, ledger and verdict records.
    burnTopic(normalizedTopic);

    // 3-4. Queue/pool/video cleanup now lives INSIDE burnTopic — it used to be
    // open-coded here only, so every AUTOMATIC burn (grounding second strike,
    // suggestion delete) left the burned topic's videos in the persisted pool.

    // 5. Locate and remove DOM elements
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
    
    showToast(`Burned query "${capitalizePhrase(topic)}" — LLM won't suggest this again`, "info");
    
    // 6. Replenish and load next batch in background
    setTimeout(async () => {
        if (removedCount > 0 && state.currentView === "smart-feed") {
            await replenishSmartFeed(removedCount, true);
        }
        fillSmartFeedPreloadBuffer();
    }, 400);
    
    // 7. Update settings list views if they are currently drawn
    if (typeof renderPreferencesLists === "function") {
        const inputTopicSearch = document.getElementById("input-topic-search");
        renderPreferencesLists(inputTopicSearch ? inputTopicSearch.value : "");
    }
    if (typeof renderTopicsList === "function") {
        const inputLegacyTopicSearch = document.getElementById("input-legacy-topic-search");
        renderTopicsList(inputLegacyTopicSearch ? inputLegacyTopicSearch.value : "");
    }
}

// Edit a discovery topic and replace its contents inline
async function editDiscoverTopic(topic) {
    if (!topic) return;
    
    const normalizedTopic = topic.trim().toLowerCase();
    const newTopic = prompt(`Edit topic "${capitalizePhrase(normalizedTopic)}" keyphrase:`, normalizedTopic);
    if (newTopic === null) return;
    
    const newTopicClean = newTopic.trim().toLowerCase();
    if (!newTopicClean) {
        showToast("Topic keyphrase cannot be empty.", "warning");
        return;
    }
    
    if (newTopicClean === normalizedTopic) return;
    
    // 1. Update/Add in state.topics (replace old topic with new one)
    state.topics = state.topics.filter(t => t.phrase.toLowerCase() !== normalizedTopic);
    const existingNewIndex = state.topics.findIndex(t => t.phrase.toLowerCase() === newTopicClean);
    if (existingNewIndex !== -1) {
        state.topics[existingNewIndex].weight = Math.max(state.topics[existingNewIndex].weight, 5); // Ensure not muted
    } else {
        state.topics.push({ phrase: newTopicClean, weight: 5, addedAt: Date.now(), role: "core", bornRole: "core" });
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
            titleTextEl.innerHTML = `${escapeHTML(capitalizePhrase(newTopicClean))} <span class="loader-spinner" style="width: 12px; height: 12px; border-width: 2px; display: inline-block; margin-left: 0.5rem;"></span>`;
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
    
    showToast(`Updating topic to "${capitalizePhrase(newTopicClean)}"...`, "info");
    
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
                    <span>Discover:</span>
                    <span class="discover-topic-text" style="color: var(--accent);">${escapeHTML(capitalizePhrase(newTopicClean))}</span>
                    <div class="discover-topic-actions">
                        <button class="discover-action-btn edit-btn" title="Edit Topic" data-topic="${escapeHTML(newTopicClean)}"><svg class="icon-svg" style="width: 12px; height: 12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
                        <button class="discover-action-btn remove-btn" title="Remove Topic" data-topic="${escapeHTML(newTopicClean)}">${icon("x", 12)}</button>
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
                recordFeedShown(deduplicated);
                
                const fragment = document.createDocumentFragment();
                deduplicated.forEach(video => {
                    renderCard(video, fragment);
                    const card = fragment.lastElementChild;
                    if (card) {
                        card.setAttribute("data-discover-topic", newTopicClean);
                    }
                });
                
                currentHeaderEl.after(fragment);
                showToast(`Loaded new videos for "${capitalizePhrase(newTopicClean)}"`, "success");
            } else {
                showToast(`No videos found for "${capitalizePhrase(newTopicClean)}"`, "warning");
                currentHeaderEl.classList.add("fade-out-remove");
                setTimeout(() => currentHeaderEl.remove(), 350);
            }
        }
    } catch (err) {
        console.error(`[Edit Topic] Fetch failed for "${newTopicClean}":`, err);
        showToast(`Failed fetching videos for "${capitalizePhrase(newTopicClean)}"`, "danger");
        
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
// (saveDiscovered lives with the other persistence helpers near loadState.)

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
    
    // 1. vLLM Suggestion (via prism /chat with corrected port)
    const vllmPromise = (async () => {
        if (state.channels.length === 0) return;
        try {
            const subscribedNames = state.channels.slice(0, 15).map(c => c.name).join(", ");
            const messages = [
                { role: "system", content: `You are a YouTube channel recommendation engine. Recommend 5 high-quality channels that are similar in nature to the channels the user likes. Avoid recommending channels in the user's list. Return a JSON object with a 'channels' array: {"channels": [{"name": "Channel Name", "handle": "@handle", "reason": "1-sentence reason why the user will like it"}]}` },
                { role: "user", content: `I like these channels: [${subscribedNames}]. Suggest 5 other high-quality YouTube channels.` }
            ];
            
            // This is the ONE call that skips the wallgarden backend and hits
            // prism directly, so the Jetson pin has to be repeated here.
            // Sending the saved dropdown value would resurrect the old bug on
            // any tab whose localStorage still holds a Gold Spark selection.
            const { provider, model } = getPinnedModel();

            // ?stream=false is REQUIRED: prism's /chat streams SSE by
            // default, and the resp.json() below cannot parse "data: {…}"
            // frames. Without it this call threw on every run and the catch
            // swallowed it, so the AI channel suggestion silently never
            // appeared. Verified against the live gateway: the streaming body
            // fails JSON.parse at char 0; ?stream=false returns {text:"OK"}.
            const resp = await fetch("/prism/chat?stream=false", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: model,
                    provider: provider,
                    messages: messages,
                    temperature: 0.2,
                    // camelCase — prism /chat silently DROPS snake_case
                    // max_tokens, so the old cap here was never applied.
                    maxTokens: 1000,
                    // Qwen3.6 reasons by default and puts everything in a
                    // separate `reasoning` field, leaving content empty.
                    thinkingEnabled: false,
                    skipConversation: true
                })
            });
            
            if (resp.ok) {
                const data = await resp.json();
                const content = data.choices?.[0]?.message?.content || data.text;
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
                
            if (topTopics.length > 0) {
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
                <div class="empty-icon">${icon("bulb", 48)}</div>
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
                <button class="btn btn-secondary btn-sm btn-inspect-rec">${icon("search")} Inspect Feed</button>
                <button class="btn btn-primary btn-sm btn-sub-rec" style="background:var(--accent);color:var(--bg-primary);border-color:var(--accent);">
                    <svg class="icon-svg" style="width:14px; height:14px; margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                    Subscribe
                </button>
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
                        showToast(`Subscribed to ${rec.name}`, "success");
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
                btn.innerHTML = `<svg class="icon-svg" style="width:14px; height:14px; margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>Subscribe`;
            }
        });
        
        grid.appendChild(card);
    });
}

async function fetchWeather() {
    try {
        let latitude, longitude, cityDisplay;
        
        if (state.settings.weatherCity && state.settings.weatherCity.trim() !== "") {
            const cityQuery = encodeURIComponent(state.settings.weatherCity.trim());
            const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${cityQuery}&count=1&language=en&format=json`);
            if (!geoRes.ok) throw new Error("Geocoding failed");
            const geoData = await geoRes.json();
            if (!geoData.results || geoData.results.length === 0) throw new Error("City not found");
            
            latitude = geoData.results[0].latitude;
            longitude = geoData.results[0].longitude;
            cityDisplay = geoData.results[0].name;
        } else {
            const geoRes = await fetch("https://ipapi.co/json/");
            if (!geoRes.ok) throw new Error("IP Geolocation failed");
            const geoData = await geoRes.json();
            latitude = geoData.latitude;
            longitude = geoData.longitude;
            cityDisplay = geoData.city;
        }
        
        const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
        if (!weatherRes.ok) throw new Error("Weather fetch failed");
        const weatherData = await weatherRes.json();
        
        const widget = document.getElementById("weather-widget");
        if (widget) {
            const temp = Math.round(weatherData.current_weather.temperature);
            widget.innerHTML = `<div style="font-size: 0.85rem; color: var(--text-muted); padding: 0.5rem 1rem; border-top: 1px solid var(--card-border); border-bottom: 1px solid var(--card-border); margin: 0.5rem 0;">
                🌤️ ${cityDisplay}: ${temp}°C
            </div>`;
        }
    } catch (e) {
        console.error("Weather fetch failed:", e);
        const widget = document.getElementById("weather-widget");
        if (widget) {
            widget.innerHTML = `<div style="font-size: 0.85rem; color: var(--danger-bright); padding: 0.5rem 1rem; border-top: 1px solid var(--card-border); border-bottom: 1px solid var(--card-border); margin: 0.5rem 0;">
                🌤️ Weather unavailable
            </div>`;
        }
    }
}

async function renderNewsFeed() {
    const newsGrid = document.getElementById("news-feed-grid");
    if (!newsGrid) return;
    newsGrid.innerHTML = `<div class="loader-spinner" style="margin: 2rem auto;"></div><p style="text-align:center; color: var(--text-muted);">Fetching news...</p>`;
    
    const ALL_NEWS_SOURCES = [
        { name: "BBC News", url: "http://feeds.bbci.co.uk/news/rss.xml" },
        { name: "CNN", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
        { name: "NYT Home", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
        { name: "NPR News", url: "https://feeds.npr.org/1001/rss.xml" },
        { name: "Fox News", url: "http://feeds.foxnews.com/foxnews/latest" },
        { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
        { name: "WSJ World", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml" },
        { name: "The Guardian", url: "https://www.theguardian.com/world/rss" },
        { name: "NBC News", url: "https://feeds.nbcnews.com/nbcnews/public/news" }
    ];
    
    // Filter out disliked
    const validSources = ALL_NEWS_SOURCES.filter(s => state.newsSourceRatings[s.name] !== -1);
    
    // Prioritize liked sources, random others
    validSources.sort((a, b) => {
        const ratingA = state.newsSourceRatings[a.name] === 1 ? 1 : 0;
        const ratingB = state.newsSourceRatings[b.name] === 1 ? 1 : 0;
        if (ratingA !== ratingB) return ratingB - ratingA;
        return 0.5 - Math.random(); // shuffle the rest
    });
    
    // Pick top 4 sources to avoid slow load times
    const newsSources = validSources.slice(0, 4);
    
    let allNews = [];
    
    try {
        for (const source of newsSources) {
            // Using allorigins to bypass CORS for public RSS feeds
            const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(source.url)}`);
            if (!res.ok) continue;
            const data = await res.json();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(data.contents, "text/xml");
            
            const items = xmlDoc.querySelectorAll("item");
            items.forEach(item => {
                const title = item.querySelector("title")?.textContent || "";
                const link = item.querySelector("link")?.textContent || "";
                const pubDateStr = item.querySelector("pubDate")?.textContent || "";
                const description = item.querySelector("description")?.textContent || "";
                const pubDate = new Date(pubDateStr).getTime() / 1000;
                
                allNews.push({
                    id: link,
                    title: title,
                    channelName: source.name,
                    channelId: source.name,
                    published: pubDate,
                    thumbnailUrl: "",
                    description: description.replace(/<[^>]+>/g, '').substring(0, 200) + "...",
                    link: link,
                    isNews: true
                });
            });
        }
        
        allNews.sort((a, b) => b.published - a.published);
        newsGrid.innerHTML = "";
        
        if (allNews.length === 0) {
            newsGrid.innerHTML = `<div class="empty-state"><h3>No news found</h3></div>`;
            return;
        }
        
        const fragment = document.createDocumentFragment();
        allNews.slice(0, 30).forEach(news => {
            const card = document.createElement("div");
            card.className = "video-card fade-in";
            card.innerHTML = `
                <div class="video-info" style="padding: 1rem;">
                    <div class="video-title" style="margin-bottom: 0.5rem;"><a href="${news.link}" target="_blank" style="color: var(--text-primary); text-decoration: none;">${news.title}</a></div>
                    <div class="video-channel" style="color: var(--accent); margin-bottom: 0.5rem;">${news.channelName}</div>
                    <div class="video-meta" style="margin-bottom: 0.5rem;">${getRelativeTime(news.published)}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 0.75rem;">${news.description}</div>
                    <div class="news-actions" style="display: flex; gap: 0.5rem;">
                        <button class="btn btn-sm btn-news-like ${state.newsSourceRatings[news.channelName] === 1 ? 'active' : ''}" data-source="${news.channelName}">
                            <svg class="icon-svg" style="width: 12px; height: 12px; margin-right: 4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
                            Like Source
                        </button>
                        <button class="btn btn-sm btn-news-dislike" data-source="${news.channelName}">
                            <svg class="icon-svg" style="width: 12px; height: 12px; margin-right: 4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm12-3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path></svg>
                            Dislike Source
                        </button>
                    </div>
                </div>
            `;
            
            card.querySelector(".btn-news-like").addEventListener("click", (e) => {
                const source = e.target.getAttribute("data-source");
                if (state.newsSourceRatings[source] === 1) {
                    delete state.newsSourceRatings[source];
                    e.target.classList.remove("active");
                } else {
                    state.newsSourceRatings[source] = 1;
                    e.target.classList.add("active");
                }
                saveNewsRatings();
            });

            card.querySelector(".btn-news-dislike").addEventListener("click", (e) => {
                const source = e.target.getAttribute("data-source");
                state.newsSourceRatings[source] = -1;
                saveNewsRatings();
                // Remove all cards from this source in the UI
                document.querySelectorAll(".btn-news-dislike").forEach(btn => {
                    if (btn.getAttribute("data-source") === source) {
                        const c = btn.closest(".video-card");
                        if (c) c.remove();
                    }
                });
            });

            fragment.appendChild(card);
        });
        newsGrid.appendChild(fragment);
    } catch (e) {
        newsGrid.innerHTML = `<div class="empty-state"><h3>Error fetching news</h3><p>${e.message}</p></div>`;
    }
}

// PLAYLISTS LOGIC
function renderPlaylistsView() {
    const grid = document.getElementById("playlists-grid");
    const header = document.getElementById("playlist-videos-header");
    const videoGrid = document.getElementById("playlist-videos-grid");
    const title = document.getElementById("current-playlist-title");
    
    grid.innerHTML = "";
    header.classList.add("hidden");
    videoGrid.classList.add("hidden");
    videoGrid.innerHTML = "";
    grid.style.display = "grid";
    
    const playlists = Object.values(state.playlists);
    if (playlists.length === 0) {
        grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;"><h3>No Playlists</h3><p>Create a playlist or add a video to get started.</p></div>`;
        return;
    }
    
    playlists.forEach(pl => {
        const card = document.createElement("div");
        card.className = "playlist-card fade-in";

        // Render the playlist as a stack of thumbnails, so you can see what is
        // inside it without opening it. The two cards peeking out behind the
        // cover are the next videos in the list — they give the stack depth and
        // hint at how much is in there.
        const videos = (pl.videos || []).filter(Boolean);
        const cover = videos[0];
        const behind = videos.slice(1, 3);

        const layers = behind
            .map((v, i) => `<div class="playlist-stack-layer layer-${i + 1}"
                    style="background-image:url('https://i.ytimg.com/vi/${v.id}/hqdefault.jpg')"></div>`)
            .reverse()
            .join("");

        const coverInner = cover
            ? `<img class="playlist-cover-img" src="https://i.ytimg.com/vi/${cover.id}/hqdefault.jpg"
                    alt="${escapeHTML(cover.title || pl.name)}" loading="lazy" decoding="async">`
            : `<div class="playlist-cover-empty">Empty</div>`;

        card.innerHTML = `
            <div class="playlist-stack">
                ${layers}
                <div class="playlist-cover">
                    ${coverInner}
                    <div class="playlist-count">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h11v2H4V6zm0 5h11v2H4v-2zm0 5h7v2H4v-2zm13-4 5 3-5 3v-6z"/></svg>
                        <span>${videos.length}</span>
                    </div>
                    <div class="playlist-play">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
            </div>
            <div class="playlist-info">
                <div class="playlist-name">${escapeHTML(pl.name)}</div>
                <div class="playlist-meta">
                    <svg class="playlist-yt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 12s0-3.9-.5-5.8c-.3-1-1.1-1.8-2.1-2.1C18.5 3.6 12 3.6 12 3.6s-6.5 0-8.4.5c-1 .3-1.8 1.1-2.1 2.1C1 8.1 1 12 1 12s0 3.9.5 5.8c.3 1 1.1 1.8 2.1 2.1 1.9.5 8.4.5 8.4.5s6.5 0 8.4-.5c1-.3 1.8-1.1 2.1-2.1.5-1.9.5-5.8.5-5.8zM9.9 15.5v-7l6.1 3.5-6.1 3.5z"/></svg>
                    <span>${videos.length} ${videos.length === 1 ? "video" : "videos"}</span>
                </div>
            </div>
            <button class="btn btn-danger btn-sm btn-delete-playlist">Delete</button>
        `;

        card.addEventListener("click", (e) => {
            if (e.target.classList.contains("btn-delete-playlist")) {
                e.stopPropagation();
                if (confirm(`Delete playlist "${pl.name}"?`)) {
                    delete state.playlists[pl.id];
                    savePlaylists();
                    renderPlaylistsView();
                }
                return;
            }
            // Open playlist
            grid.style.display = "none";
            header.classList.remove("hidden");
            videoGrid.classList.remove("hidden");
            title.textContent = pl.name;
            
            const videosList = pl.videos || [];
            videoGrid.innerHTML = "";
            if (videosList.length === 0) {
                videoGrid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;"><p>This playlist is empty.</p></div>`;
            } else {
                const fragment = document.createDocumentFragment();
                videosList.forEach((video, index) => {
                    if (!video) return;
                    const vCard = createVideoCard(video);
                    
                    // Add remove button overlay
                    const removeBtn = document.createElement("button");
                    removeBtn.className = "btn btn-danger btn-sm";
                    removeBtn.innerHTML = icon("x", 12);
                    removeBtn.style.position = "absolute";
                    removeBtn.style.top = "5px";
                    removeBtn.style.right = "5px";
                    removeBtn.style.zIndex = "10";
                    removeBtn.style.padding = "2px 6px";
                    removeBtn.onclick = (ev) => {
                        ev.stopPropagation();
                        pl.videos.splice(index, 1);
                        savePlaylists();
                        card.click(); // re-render
                    };
                    vCard.style.position = "relative";
                    vCard.appendChild(removeBtn);
                    
                    fragment.appendChild(vCard);
                });
                videoGrid.appendChild(fragment);
            }
        });
        
        grid.appendChild(card);
    });
}

function showPlaylistModal(videoOrVideos) {
    const modal = document.getElementById("playlist-modal");
    const list = document.getElementById("playlist-modal-list");
    const input = document.getElementById("input-new-playlist");
    const createBtn = document.getElementById("btn-submit-new-playlist");
    const closeBtn = document.getElementById("btn-close-playlist-modal");
    
    modal.classList.remove("hidden");
    input.value = "";
    
    // Support passing either a single video object or an array of videos (like queue)
    const videos = Array.isArray(videoOrVideos) ? videoOrVideos : (videoOrVideos ? [videoOrVideos] : []);
    
    function renderList() {
        list.innerHTML = "";
        const playlists = Object.values(state.playlists);
        if (playlists.length === 0) {
            list.innerHTML = `<p style="color: var(--text-muted); font-size: 0.9rem;">No existing playlists.</p>`;
        } else {
            playlists.forEach(pl => {
                const btn = document.createElement("button");
                // Show the playlist's cover and size here too — picking a
                // destination out of a column of identical name-only buttons
                // meant remembering what was in each one.
                btn.className = "playlist-row";
                const first = (pl.videos || []).filter(Boolean)[0];
                const count = (pl.videos || []).length;
                btn.innerHTML = `
                    <span class="playlist-row-thumb">${first
                        ? `<img src="https://i.ytimg.com/vi/${first.id}/default.jpg" alt="" loading="lazy" decoding="async">`
                        : ""}</span>
                    <span class="playlist-row-text">
                        <span class="playlist-row-name">${escapeHTML(pl.name)}</span>
                        <span class="playlist-row-count">${count} ${count === 1 ? "video" : "videos"}</span>
                    </span>
                    <span class="playlist-row-add">+</span>
                `;
                btn.onclick = () => {
                    if (videos.length > 0) {
                        let addedCount = 0;
                        videos.forEach(video => {
                            if (!pl.videos.find(v => v.id === video.id)) {
                                pl.videos.push(video);
                                addedCount++;
                            }
                        });
                        savePlaylists();
                        if (addedCount > 0) {
                            showToast(`Added ${addedCount} video(s) to ${pl.name}`, "success");
                        } else {
                            showToast(`Videos already in ${pl.name}`, "info");
                        }
                    }
                    modal.classList.add("hidden");
                    if (state.currentView === "playlists") renderPlaylistsView();
                };
                list.appendChild(btn);
            });
        }
    }
    
    renderList();
    
    createBtn.onclick = () => {
        const name = input.value.trim();
        if (!name) return;
        const id = "pl_" + Date.now() + "_" + Math.floor(Math.random()*1000);
        const newPl = { id, name, createdAt: Date.now(), videos: [] };
        if (videos.length > 0) {
            newPl.videos.push(...videos);
        }
        state.playlists[id] = newPl;
        savePlaylists();
        showToast(videos.length > 0 ? `Created ${name} and added video(s)` : `Created ${name}`, "success");
        modal.classList.add("hidden");
        if (state.currentView === "playlists") renderPlaylistsView();
    };
    
    closeBtn.onclick = () => modal.classList.add("hidden");
}

function renderLikedVideosView() {
    const introEl = document.getElementById("liked-videos-intro");
    const likedCount = state.likedVideos ? state.likedVideos.length : 0;
    if (introEl) {
        introEl.textContent = `Videos you have liked (${likedCount})`;
    }

    const grid = document.getElementById("liked-videos-grid");
    if (!grid) return;
    grid.innerHTML = "";
    
    if (!state.likedVideos || state.likedVideos.length === 0) {
        grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;"><h3>No Liked Videos</h3><p>Videos you like will appear here.</p></div>`;
        return;
    }
    
    const fragment = document.createDocumentFragment();
    state.likedVideos.forEach(video => {
        if (!video) return;
        const vCard = createVideoCard(video);
        
        // Add a small unlike button overlay inside thumbnail actions
        const unlikeBtn = document.createElement("button");
        unlikeBtn.className = "thumbnail-action-btn unlike-card-btn";
        unlikeBtn.title = "Remove from Liked Videos";
        unlikeBtn.innerHTML = `
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
        `;
        unlikeBtn.onclick = (ev) => {
            ev.stopPropagation();
            
            // Add card fade-out class for animation
            vCard.classList.add("card-fade-out");
            
            vCard.addEventListener("animationend", () => {
                // Revert ontology graph impact
                if (state.ontologyGraph) {
                    graphProcessRating(state.ontologyGraph, {
                        ...video,
                        matchedTopics: video._matchedTopics || video.matchedTopics || []
                    }, -1);
                    saveOntologyGraph();
                }

                state.likedVideos = state.likedVideos.filter(v => v.id !== video.id);
                delete state.videoRatings[video.id];
                saveLikedVideos();
                saveVideoRatings();
                renderLikedVideosView(); // re-render
            }, { once: true });
        };
        
        const actionsContainer = vCard.querySelector(".thumbnail-actions");
        if (actionsContainer) {
            actionsContainer.appendChild(unlikeBtn);
        } else {
            unlikeBtn.style.position = "absolute";
            unlikeBtn.style.top = "5px";
            unlikeBtn.style.right = "5px";
            unlikeBtn.style.zIndex = "10";
            vCard.appendChild(unlikeBtn);
        }
        
        fragment.appendChild(vCard);
    });

    // Re-apply filter if search query exists
    const inputFilterLiked = document.getElementById("input-filter-liked");
    if (inputFilterLiked && inputFilterLiked.value.trim()) {
        const query = inputFilterLiked.value.trim().toLowerCase();
        const cards = fragment.querySelectorAll(".video-card");
        cards.forEach(card => {
            const title = (card.querySelector(".video-title")?.textContent || "").toLowerCase();
            const channel = (card.querySelector(".channel-link")?.textContent || "").toLowerCase();
            if (!title.includes(query) && !channel.includes(query)) {
                card.classList.add("hidden");
            }
        });
    }
    
    grid.appendChild(fragment);
}

// ── Session Tracking & Reconciliation (Phase 2) ─────────────
window.logYouTubeLaunch = function(videoId) {
    debug(`[Session Tracking] Launched video ${videoId} to YouTube`);
    state.launchedVideoId = videoId;
    state.launchTimestamp = Date.now();
};

window.addEventListener('focus', () => {
    if (state.launchedVideoId && state.launchTimestamp) {
        const timeAway = Date.now() - state.launchTimestamp;
        // If they were away for more than 10 seconds, ask about the video
        if (timeAway > 10000) {
            const vId = state.launchedVideoId;
            setTimeout(() => {
                showReconciliationPrompt(vId);
            }, 500);
        }
        // Clear state so we don't prompt again for this launch
        state.launchedVideoId = null;
        state.launchTimestamp = null;
    }
});

function showReconciliationPrompt(videoId) {
    // Look up the video from cache if possible
    let videoTitle = "the video";
    if (state.cache && state.cache.videos) {
        for (const channelId in state.cache.videos) {
            const v = state.cache.videos[channelId].find(vid => vid.id === videoId);
            if (v) {
                videoTitle = `"${v.title}"`;
                break;
            }
        }
    }

    // Only show if the inline player is still open for THIS video
    const inlinePlayer = document.getElementById("inline-player");
    if (!inlinePlayer || inlinePlayer.classList.contains("hidden") || state.currentlyPlayingId !== videoId) {
        return;
    }

    // Remove existing banner if any
    const existing = inlinePlayer.querySelector(".reconciliation-banner");
    if (existing) existing.remove();

    // Create a banner inside the inline player
    const banner = document.createElement("div");
    banner.className = "reconciliation-banner";
    banner.style.cssText = "background: var(--accent-subtle); border: 1px solid var(--accent); padding: 1rem; border-radius: var(--radius-lg); margin: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; animation: fadeIn 0.3s ease;";
    banner.innerHTML = `
        <div>
            <h4 style="margin: 0 0 0.25rem 0; color: var(--accent);">Welcome back!</h4>
            <p style="margin: 0; font-size: 0.9rem; color: var(--text-primary);">Did you finish watching ${escapeHTML(videoTitle)} on YouTube?</p>
        </div>
        <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-primary btn-sm btn-mark-watched" style="padding: 0.4rem 0.8rem;">${icon("check")} Mark Watched</button>
            <button class="btn btn-secondary btn-sm btn-dismiss" style="padding: 0.4rem 0.8rem;">Dismiss</button>
        </div>
    `;

    banner.querySelector(".btn-mark-watched").onclick = () => {
        if (!state.watchedHistory) state.watchedHistory = {};
        state.watchedHistory[videoId] = Date.now();
        localStorage.setItem("wallgarden_watched", JSON.stringify(state.watchedHistory));
        showToast("Marked as watched in Wallgarden", "success");
        banner.remove();
    };

    banner.querySelector(".btn-dismiss").onclick = () => {
        banner.remove();
    };

    // Insert after the player main area
    const playerInner = inlinePlayer.querySelector(".inline-player-main");
    if (playerInner) {
        playerInner.appendChild(banner);
    }
}

// ── Extension Sync Listener (Phase 4) ─────────────
function findVideoById(videoId) {
    if (!videoId) return null;
    
    // 1. Search in cache
    if (state.cache && state.cache.videos) {
        for (const channelId in state.cache.videos) {
            const v = state.cache.videos[channelId].find(vid => vid.id === videoId);
            if (v) return v;
        }
    }
    
    // 2. Search in smartFeedVideos
    if (state.smartFeedVideos) {
        const v = state.smartFeedVideos.find(vid => vid.id === videoId);
        if (v) return v;
    }
    
    // 3. Search in sessionTopicSearchCache
    if (sessionTopicSearchCache) {
        for (const query in sessionTopicSearchCache) {
            const videos = sessionTopicSearchCache[query];
            if (Array.isArray(videos)) {
                const v = videos.find(vid => vid.id === videoId);
                if (v) return v;
            }
        }
    }
    
    // 4. Search in queue
    if (state.queue) {
        const v = state.queue.find(vid => vid.id === videoId);
        if (v) return v;
    }
    
    // 5. Search in likedVideos
    if (state.likedVideos) {
        const v = state.likedVideos.find(vid => vid.id === videoId);
        if (v) return v;
    }
    
    return null;
}

window.addEventListener("message", (event) => {
    // Make sure we only accept messages from our own domain/content script
    if (event.source !== window || !event.data || event.data.type !== 'WG_EXT_SYNC') return;

    const payload = event.data.data;
    if (!payload || !payload.action || !payload.videoId) return;

    debug("[Wallgarden Sync] Received extension event:", payload);

    if (payload.action === 'LIKE') {
        state.videoRatings[payload.videoId] = 5;
        
        let targetVideo = null;
        // Find full video metadata and sync to state.likedVideos
        const video = findVideoById(payload.videoId);
        if (video) {
            targetVideo = video;
            if (!state.likedVideos.some(v => v.id === video.id)) {
                state.likedVideos.push(video);
            }
        } else {
            // Fallback object using metadata from payload if available
            const fallbackVideo = {
                id: payload.videoId,
                title: payload.title || "Liked Video (Synced)",
                channelName: payload.channelName || "YouTube Curation",
                channelId: payload.channelId || "",
                published: Date.now(),
                thumbnailUrl: `https://i.ytimg.com/vi/${payload.videoId}/hqdefault.jpg`,
                description: payload.description || "Synced from YouTube Likes.",
                duration: payload.duration || 0,
                viewCount: payload.viewCount || 0
            };
            targetVideo = fallbackVideo;
            if (!state.likedVideos.some(v => v.id === fallbackVideo.id)) {
                state.likedVideos.push(fallbackVideo);
            }
        }

        if (state.ontologyGraph && targetVideo) {
            graphProcessRating(state.ontologyGraph, {
                ...targetVideo,
                matchedTopics: targetVideo.matchedTopics || []
            }, 1);
            saveOntologyGraph();
        }
        
        saveVideoRatings();
        saveLikedVideos();
        renderFeed();
        if (state.currentView === "liked-videos") {
            renderLikedVideosView();
        }
        
        showToast("Synced Like from YouTube", "success");
        if (state.currentlyPlayingId === payload.videoId) {
            const likeBtn = document.querySelector(".sidebar-btn-like");
            const dislikeBtn = document.querySelector(".sidebar-btn-dislike");
            if (likeBtn) likeBtn.classList.add("active");
            if (dislikeBtn) dislikeBtn.classList.remove("active");
        }
    } else if (payload.action === 'UNLIKE') {
        delete state.videoRatings[payload.videoId];
        state.likedVideos = state.likedVideos.filter(v => v.id !== payload.videoId);
        
        if (state.ontologyGraph) {
            graphProcessRating(state.ontologyGraph, { id: payload.videoId }, -1); // Reverse like
            saveOntologyGraph();
        }
        
        saveVideoRatings();
        saveLikedVideos();
        renderFeed();
        if (state.currentView === "liked-videos") {
            renderLikedVideosView();
        }
        
        showToast("Removed Like synced from YouTube", "info");
        if (state.currentlyPlayingId === payload.videoId) {
            const likeBtn = document.querySelector(".sidebar-btn-like");
            if (likeBtn) likeBtn.classList.remove("active");
        }
    } else if (payload.action === 'DISLIKE') {
        state.videoRatings[payload.videoId] = -5;
        state.likedVideos = state.likedVideos.filter(v => v.id !== payload.videoId);

        if (state.ontologyGraph) {
            graphProcessRating(state.ontologyGraph, { id: payload.videoId }, -1);
            saveOntologyGraph();
        }
        
        saveVideoRatings();
        saveLikedVideos();
        renderFeed();
        if (state.currentView === "liked-videos") {
            renderLikedVideosView();
        }
        
        showToast("Synced Dislike from YouTube", "info");
        if (state.currentlyPlayingId === payload.videoId) {
            const likeBtn = document.querySelector(".sidebar-btn-like");
            const dislikeBtn = document.querySelector(".sidebar-btn-dislike");
            if (likeBtn) likeBtn.classList.remove("active");
            if (dislikeBtn) dislikeBtn.classList.add("active");
        }
    } else if (payload.action === 'UNDISLIKE') {
        delete state.videoRatings[payload.videoId];
        
        if (state.ontologyGraph) {
            graphProcessRating(state.ontologyGraph, { id: payload.videoId }, 1); // Reverse dislike
            saveOntologyGraph();
        }
        
        saveVideoRatings();
        renderFeed();
        if (state.currentView === "liked-videos") {
            renderLikedVideosView();
        }
        
        showToast("Removed Dislike synced from YouTube", "info");
        if (state.currentlyPlayingId === payload.videoId) {
            const dislikeBtn = document.querySelector(".sidebar-btn-dislike");
            if (dislikeBtn) dislikeBtn.classList.remove("active");
        }
    } else if (payload.action === 'WATCHED') {
        if (!state.watchedHistory) state.watchedHistory = {};
        state.watchedHistory[payload.videoId] = Date.now();
        localStorage.setItem("wallgarden_watched", JSON.stringify(state.watchedHistory));
        showToast("Synced Watch Completion from YouTube", "success");
    } else if (payload.action === 'WATCHLIST_ADD' || payload.action === 'PLAYLIST_SAVE') {
        // User saved a video to Watch Later / a playlist on YouTube —
        // mirror it into the wallgarden queue and treat it as a positive
        // taste signal for the ontology graph.
        let video = findVideoById(payload.videoId);
        if (!video) {
            video = {
                id: payload.videoId,
                title: payload.title || "Saved Video (Synced)",
                channelName: payload.channelName || "YouTube Curation",
                channelId: payload.channelId || "",
                published: Date.now(),
                thumbnailUrl: `https://i.ytimg.com/vi/${payload.videoId}/hqdefault.jpg`,
                description: payload.playlistName
                    ? `Synced from YouTube playlist "${payload.playlistName}".`
                    : "Synced from YouTube Watch Later.",
                duration: payload.duration || 0,
                viewCount: payload.viewCount || 0
            };
        }

        const alreadyQueued = state.queue.some(v => v.id === video.id);
        if (!alreadyQueued) {
            state.queue.push(video);
            saveQueue();
            renderQueueUI();
        }

        if (state.ontologyGraph) {
            graphProcessRating(state.ontologyGraph, {
                ...video,
                matchedTopics: video.matchedTopics || []
            }, 1);
            saveOntologyGraph();
        }

        const label = payload.action === 'WATCHLIST_ADD'
            ? "⏳ Synced Watch Later from YouTube"
            : `Synced save to "${payload.playlistName || 'playlist'}" from YouTube`;
        showToast(alreadyQueued ? "Already in Watchlist (synced)" : label, alreadyQueued ? "info" : "success");
    } else if (payload.action === 'WATCHLIST_REMOVE') {
        const before = state.queue.length;
        state.queue = state.queue.filter(v => v.id !== payload.videoId);
        if (state.queue.length !== before) {
            saveQueue();
            renderQueueUI();
            showToast("Removed from Watchlist (synced from YouTube)", "info");
        }
    } else if (payload.action === 'WALLGARDEN_SAVE') {
        // Explicit save from the extension's on-page "Save to Wallgarden"
        // button. Routes into a specific playlist when one was chosen from the
        // picker, otherwise into the watchlist/queue.
        let video = findVideoById(payload.videoId);
        if (!video) {
            video = {
                id: payload.videoId,
                title: payload.title || "Saved Video (Synced)",
                channelName: payload.channelName || "YouTube Curation",
                channelId: payload.channelId || "",
                published: Date.now(),
                thumbnailUrl: `https://i.ytimg.com/vi/${payload.videoId}/hqdefault.jpg`,
                description: payload.playlistName
                    ? `Saved from YouTube to "${payload.playlistName}".`
                    : "Saved from YouTube via Wallgarden button.",
                duration: payload.duration || 0,
                viewCount: payload.viewCount || 0
            };
        }

        const targetPlaylist = payload.playlistId ? state.playlists[payload.playlistId] : null;
        if (targetPlaylist) {
            if (!targetPlaylist.videos) targetPlaylist.videos = [];
            const already = targetPlaylist.videos.some(v => v && v.id === video.id);
            if (!already) {
                targetPlaylist.videos.push(video);
                savePlaylists();
                if (state.currentView === "playlists") renderPlaylistsView();
            }
            showToast(already
                ? `Already in "${targetPlaylist.name}"`
                : `🌿 Saved to "${targetPlaylist.name}" from YouTube`, already ? "info" : "success");
        } else {
            const already = state.queue.some(v => v.id === video.id);
            if (!already) {
                state.queue.push(video);
                saveQueue();
                renderQueueUI();
            }
            showToast(already
                ? "Already in Watchlist"
                : "🌿 Saved to Watchlist from YouTube", already ? "info" : "success");
        }

        if (state.ontologyGraph) {
            graphProcessRating(state.ontologyGraph, {
                ...video,
                matchedTopics: video.matchedTopics || []
            }, 1);
            saveOntologyGraph();
        }
    }
});

// ── Ontology Graph Rendering ──
function renderOntologyView() {
    const container = document.getElementById('ontology-graph-container');
    const statsEl = document.getElementById('ontology-stats');
    if (!container || !state.ontologyGraph) return;

    const gNodes = state.ontologyGraph.nodes || {};
    const gEdges = state.ontologyGraph.edges || {};

    const nodeCount = Object.keys(gNodes).length;
    const edgeCount = Object.keys(gEdges).length;

    if (statsEl) {
        statsEl.innerHTML = `Nodes: <strong>${nodeCount}</strong> | Edges: <strong>${edgeCount}</strong> | Last Pruned: <em>${state.ontologyGraph.lastPruned ? new Date(state.ontologyGraph.lastPruned).toLocaleString() : 'Never'}</em>`;
    }

    const weightSelect = document.getElementById("graph-filter-weight");
    const minEdgeWeight = weightSelect ? parseInt(weightSelect.value, 10) : 0;

    const nodesArr = Object.values(gNodes);
    const edgesArr = Object.values(gEdges).filter(e => e.weight >= minEdgeWeight);

    if (!window.ontologyCanvas) {
        window.ontologyCanvas = new OntologyGraphCanvas(container, function(node) {
            const detailEl = document.getElementById("ontology-node-detail");
            if (node) {
                if (detailEl) {
                    detailEl.style.display = "block";
                    detailEl.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.5rem;">
                            <h4 style="margin:0; font-size:1rem;">${escapeHTML(node.label || node.id)}</h4>
                            <span style="font-size:0.75rem; background:var(--card-bg); padding:2px 6px; border-radius:4px; border:1px solid var(--card-border);">${node.type || 'default'}</span>
                        </div>
                        <div style="font-size:0.85rem; color:var(--text-secondary); display:grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
                            <div>Weight: <strong style="${(node.weight || 0) > 0 ? 'color:var(--success)' : 'color:var(--danger)'}">${(node.weight || 0).toFixed(2)}</strong></div>
                            <div>Total Hits: <strong>${node.hitCount || node.hits || 0}</strong></div>
                            <div>Last Updated: <strong>${new Date(node.lastUpdated || node.lastSeen || node.createdAt || Date.now()).toLocaleDateString()}</strong></div>
                        </div>
                        <button class="btn btn-sm btn-danger" style="margin-top:0.75rem; width:100%;" onclick="deleteNodeFromGraph('${node.id}')">Delete Node</button>
                    `;
                }
            } else {
                if (detailEl) detailEl.style.display = "none";
            }
        });
        window.ontologyCanvas.setData(nodesArr, edgesArr);
    } else {
        window.ontologyCanvas.updateData(nodesArr, edgesArr);
    }
}

// Global helper for the delete button
window.deleteNodeFromGraph = function(nodeId) {
    if (!confirm("Are you sure you want to delete this node from the knowledge graph?")) return;
    delete state.ontologyGraph.nodes[nodeId];
    // Clean up orphan edges
    for (const [eId, e] of Object.entries(state.ontologyGraph.edges)) {
        if (e.source === nodeId || e.target === nodeId) {
            delete state.ontologyGraph.edges[eId];
        }
    }
    saveOntologyGraph();
    renderOntologyView(); // Refresh
};

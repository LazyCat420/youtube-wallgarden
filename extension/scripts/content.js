// ============================================================
//  WALLGARDEN: Content Script — CSS + Heuristic + Smart Blocklist
// ============================================================
console.log("🌿 Wallgarden Extension content script loaded!");

// Default settings (all ON by default, except blockClipThanks which is opt-in)
let settings = {
    // Homepage
    blockShorts: true,
    blockBreakingNews: true,
    blockTrending: true,
    blockCommunityPosts: true,
    blockPeopleAlsoWatched: true,
    blockAds: true,
    blockMoviesShows: true,
    // Watch Page
    blockMerch: true,
    blockDonations: true,
    blockShortsRemix: true,
    blockChatReplay: true,
    blockInfoCards: true,
    blockClipThanks: false,
    // Global
    blockPremiumUpsell: true,
    blockNotifPopup: true,
    blockMusicUpsell: true,
    // Heuristics
    blockAllCaps: true,
    blockPunctuation: true,
    // Smart Blocklist
    enableSmartBlock: true,
    // Collapsible panels — these HIDE rather than BLOCK: the panel folds down to
    // a title bar you can click to bring it back. Default off, so nothing moves
    // until you ask it to.
    collapseChat: false,
    collapseRelated: false,
    collapseComments: false,
    // Comment filter — hides no-substance comments in place. Off by default;
    // audit mode defaults ON so the first thing you see when you enable it is
    // what it is actually catching, not a silently shorter comment section.
    filterComments: false,
    commentAuditMode: true
};

// Persistent blocklist data
let blocklist = {
    channels: [],       // Array of channel names (lowercase)
    keywords: {},       // { keyword: hitCount } — weighted by rejection frequency
    rejectionLog: []    // Array of { channel, title, timestamp }
};

// State tracker to avoid re-evaluating the same elements
const evaluatedVideos = new Set();

// ── Dashboard integration config ──
// The Wallgarden dashboard the "Save"/"Open" buttons target. Matches the hosts
// the bridge content script is registered on (see manifest.json).
const WG_DASHBOARD_URL = "http://10.0.0.16:8007";

// Cache of the dashboard's state, mirrored back to us over the reverse channel
// (page → bridge → background → chrome.storage.local.wg_app_state). Lets the
// watch-page button offer a real playlist picker and lets us badge videos we've
// already saved — without the dashboard tab needing to be open right now.
let appState = {
    playlists: [],        // [{ id, name, count }]
    savedVideoIds: new Set(),
    watchedIds: new Set()
};

function normalizeAppState(raw) {
    if (!raw) return { playlists: [], savedVideoIds: new Set(), watchedIds: new Set() };
    return {
        playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
        savedVideoIds: new Set(raw.savedVideoIds || []),
        watchedIds: new Set(raw.watchedIds || [])
    };
}

// Load settings + blocklist initially
chrome.storage.local.get(null, (data) => {
    // One-time migration: reset blockShorts to true if it was saved as false from v6 default change
    if (!data._v7_shorts_reset) {
        chrome.storage.local.set({ blockShorts: true, _v7_shorts_reset: true });
        data.blockShorts = true;
    }
    Object.assign(settings, data);
    if (data.blocklist) blocklist = data.blocklist;
    if (data.wg_app_state) appState = normalizeAppState(data.wg_app_state);
    if (Array.isArray(data.commentAllowlist)) commentAllowlist = new Set(data.commentAllowlist);
    applyBlockingCSS();
    syncCollapseClasses();
    injectCollapseBars();
    applyCommentFilterCSS();
    syncCommentFilterClasses();
    startObserver();
    startMenuInterceptor();
    startCollapseWatcher();
    startCommentFilterWatcher();
    startWatchButtonWatcher();
    filterComments();
});

// Re-apply if settings change
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        let appStateChanged = false;
        for (let [key, { newValue }] of Object.entries(changes)) {
            if (key === 'blocklist') {
                blocklist = newValue;
            } else if (key === 'commentAllowlist') {
                commentAllowlist = new Set(newValue || []);
            } else if (key === 'wg_app_state') {
                appState = normalizeAppState(newValue);
                appStateChanged = true;
            } else {
                settings[key] = newValue;
            }
        }
        applyBlockingCSS();
        syncCollapseClasses();
        injectCollapseBars();
        syncCommentFilterClasses();
        // Turning the filter on mid-page must classify what is already rendered;
        // turning it off is handled by the CSS alone, so nothing to undo here.
        if (settings.filterComments) filterComments();
        if (appStateChanged) {
            // Refresh the picker + "already saved" affordances against new data
            refreshWatchButtonState();
            refreshFeedSaveBadges();
        }
    }
});

// YouTube is a SPA: the watch page's chat and sidebar are torn down and rebuilt
// on every navigation, taking our collapse bars with them. Re-inject on each
// navigation, and once more after the panels settle in.
document.addEventListener('yt-navigate-finish', () => {
    syncCollapseClasses();
    injectCollapseBars();
    setTimeout(injectCollapseBars, 800);
    // New video, new comment section: clear the per-page tallies before the
    // next batch of threads mounts, or the bar reports the previous video's.
    resetCommentFilterState();
    syncCommentFilterClasses();
    setTimeout(filterComments, 900);
    // The watch metadata (owner + subscribe row) is rebuilt per navigation and
    // mounts on its own schedule — retry a few times until it settles.
    ensureWatchPageButton();
    setTimeout(ensureWatchPageButton, 300);
    setTimeout(ensureWatchPageButton, 900);
    setTimeout(ensureWatchPageButton, 1800);
});

// ============================================================
//  SMART BLOCKLIST: "Not Interested" / "Don't Recommend" Interceptor
// ============================================================

// Track the video card that triggered the 3-dot menu so we can extract its data
let lastMenuTarget = null;

function startMenuInterceptor() {
    // Track which video/shorts card opened the 3-dot menu + inject block item
    document.addEventListener('click', (e) => {
        // Match both regular video and Shorts ⋮ buttons
        const menuButton = e.target.closest(
            'yt-icon-button#button[aria-label="More actions"], ' +
            'button[aria-label="More actions"], ' +
            'button[aria-label="Action menu"]'
        );
        if (menuButton) {
            // Find parent card (regular videos + Shorts containers)
            const videoCard = menuButton.closest(
                'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ' +
                'ytd-reel-item-renderer, yt-lockup-view-model'
            );
            if (videoCard) {
                lastMenuTarget = videoCard;
                console.log('[Wallgarden] Menu opened on card');

                // Wait for YouTube to populate the popup, then inject our item
                setTimeout(() => tryInjectBlockItem(), 300);
                setTimeout(() => tryInjectBlockItem(), 600);
            }
        }
    }, true);

    // Also watch for "Not interested" / "Don't recommend" in any mutation
    const menuObserver = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                const menuItems = node.querySelectorAll
                    ? node.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item')
                    : [];
                menuItems.forEach(item => {
                    const text = item.textContent.trim().toLowerCase();
                    if (text.includes('not interested') || text.includes("don't recommend")) {
                        if (!item.dataset.wallgardenHooked) {
                            item.dataset.wallgardenHooked = 'true';
                            item.addEventListener('click', () => {
                                handleRejection(text, lastMenuTarget);
                            });
                        }
                    } else if (text.includes('watch later')) {
                        // Direct "Save to Watch later" menu item (cards + watch page)
                        if (!item.dataset.wallgardenSyncHooked) {
                            item.dataset.wallgardenSyncHooked = 'true';
                            item.addEventListener('click', () => {
                                const ctx = getActionContext();
                                console.log("[Wallgarden Sync] WATCHLIST_ADD via menu item:", ctx);
                                if (ctx) sendSyncEvent('WATCHLIST_ADD', ctx);
                            });
                        }
                    } else if (text.includes('save to playlist') || text.includes('save to queue')) {
                        // Opens the "Save video to..." dialog — capture which video it's for.
                        // The actual add/remove is detected on the dialog checkboxes below.
                        if (!item.dataset.wallgardenSyncHooked) {
                            item.dataset.wallgardenSyncHooked = 'true';
                            item.addEventListener('click', () => {
                                pendingSaveContext = getActionContext();
                                console.log("[Wallgarden Sync] Save dialog opening for:", pendingSaveContext);
                            });
                        }
                    }
                });

                // "Save video to..." dialog: each playlist row is a checkbox option.
                // Detect toggles on "Watch later" (and other playlists) with accurate state.
                const saveOptions = node.querySelectorAll
                    ? node.querySelectorAll('ytd-playlist-add-to-option-renderer')
                    : [];
                saveOptions.forEach(opt => {
                    if (opt.dataset.wallgardenPlHooked) return;
                    opt.dataset.wallgardenPlHooked = 'true';
                    opt.addEventListener('click', () => {
                        setTimeout(() => {
                            const checkbox = opt.querySelector('tp-yt-paper-checkbox, #checkbox');
                            const checked = checkbox && (
                                checkbox.hasAttribute('checked') ||
                                checkbox.getAttribute('aria-checked') === 'true'
                            );
                            const label = (opt.querySelector('#label')?.textContent || '').trim();
                            const ctx = pendingSaveContext || getActionContext();
                            if (!ctx) {
                                console.warn("[Wallgarden Sync] Save dialog toggle but no video context");
                                return;
                            }
                            if (label.toLowerCase() === 'watch later') {
                                console.log(`[Wallgarden Sync] Watch Later ${checked ? 'ADD' : 'REMOVE'}:`, ctx);
                                sendSyncEvent(checked ? 'WATCHLIST_ADD' : 'WATCHLIST_REMOVE', ctx);
                            } else if (checked) {
                                console.log(`[Wallgarden Sync] PLAYLIST_SAVE to "${label}":`, ctx);
                                sendSyncEvent('PLAYLIST_SAVE', { ...ctx, playlistName: label });
                            }
                        }, 150);
                    });
                });
            });
        });
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * Find the currently visible popup listbox and inject our block item.
 * Regular videos use: tp-yt-paper-listbox#items
 * Shorts/Sidebar use: yt-sheet-view-model > yt-list-view-model (or yt-list-view-model directly)
 */
function tryInjectBlockItem() {
    if (!lastMenuTarget || lastMenuTarget.closest('ytd-watch-metadata')) {
        lastMenuTarget = null;
        return;
    }
    if (!settings.enableSmartBlock) return;

    // --- Path 1: Regular video popup (tp-yt-paper-listbox) ---
    const listbox = document.querySelector(
        'ytd-popup-container tp-yt-iron-dropdown:not([aria-hidden="true"]) tp-yt-paper-listbox#items,' +
        'ytd-menu-popup-renderer tp-yt-paper-listbox#items'
    );

    if (listbox) {
        // Remove stale block items (YouTube reuses the popup for different videos)
        listbox.querySelectorAll('.wg-block-menu-item').forEach(old => old.remove());
        injectBlockMenuItem(listbox);
        return;
    }

    // --- Path 2: Sheet popup used by Shorts + Sidebar recommended (yt-list-view-model) ---
    const sheetPopup = document.querySelector(
        'tp-yt-iron-dropdown:not([aria-hidden="true"]) yt-sheet-view-model yt-list-view-model,' +
        'tp-yt-iron-dropdown:not([aria-hidden="true"]) yt-list-view-model'
    );

    if (sheetPopup) {
        // Remove stale block items
        sheetPopup.querySelectorAll('.wg-block-menu-item').forEach(old => old.remove());
        injectSheetBlockItem(sheetPopup);
        return;
    }

    console.log('[Wallgarden] No visible popup found');
}

/**
 * Inject a "🌿 Block Channel" item into YouTube's 3-dot popup menu
 */
function injectBlockMenuItem(listbox) {
    if (!settings.enableSmartBlock || !lastMenuTarget) return;

    // Extract channel name: try regular selectors first
    let channelName = '';
    const channelEl = lastMenuTarget.querySelector(
        '#channel-name .yt-simple-endpoint, #channel-name a, ' +
        'ytd-channel-name .yt-simple-endpoint, ytd-channel-name a, ' +
        'a[href^="/@"]'
    );
    if (channelEl) {
        channelName = channelEl.textContent.trim();
    }

    // Fallback for Shorts: try to get channel from "Don't recommend channel" menu item
    if (!channelName) {
        const menuItems = listbox.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item');
        menuItems.forEach(item => {
            const text = item.textContent.trim();
            if (text.toLowerCase().includes("don't recommend channel")) {
                // YouTube's item text is "Don't recommend channel" — channel name may be elsewhere
                // Extract from the card's link href as fallback
                const shortsLink = lastMenuTarget.querySelector('a[href*="/shorts/"], a[href*="/@"]');
                if (shortsLink) {
                    const href = shortsLink.getAttribute('href') || '';
                    const handleMatch = href.match(/\/@([^/]+)/);
                    if (handleMatch) channelName = '@' + handleMatch[1];
                }
            }
        });
    }

    // Fallback: extract title from Shorts card for title-based blocking
    let shortsTitle = '';
    if (!channelName) {
        const titleEl = lastMenuTarget.querySelector(
            '#video-title, h3, .shortsLockupViewModelHostOutsideMetadataTitle, ' +
            'a.shortsLockupViewModelHostOutsideMetadataEndpoint'
        );
        if (titleEl) shortsTitle = titleEl.textContent.trim();
    }

    if (!channelName && !shortsTitle) return;

    const blockLabel = channelName ? `Block "${channelName}"` : `Block this Short`;
    const menuItem = document.createElement('tp-yt-paper-item');
    menuItem.className = 'wg-block-menu-item style-scope ytd-menu-popup-renderer';
    menuItem.setAttribute('role', 'option');
    menuItem.setAttribute('tabindex', '0');
    menuItem.style.cssText = `
        display: flex; align-items: center; gap: 12px;
        padding: 10px 16px; cursor: pointer; min-height: 36px;
        color: #ff5252; font-size: 14px;
        border-top: 1px solid rgba(255,255,255,0.1);
    `;
    menuItem.innerHTML = `
        <span style="font-size: 16px;">🌿</span>
        <span>${blockLabel}</span>
    `;

    const cardRef = lastMenuTarget; // Capture reference at injection time
    menuItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (channelName) {
            blockChannelAndHide(channelName, cardRef);
        } else if (shortsTitle) {
            // No channel available — boost title keywords for auto-blocking
            const keywords = extractKeywords(shortsTitle);
            keywords.forEach(kw => {
                blocklist.keywords[kw] = (blocklist.keywords[kw] || 0) + 5; // Strong weight boost
            });
            saveBlocklist();
            console.log(`[Wallgarden] Blocked Short by title keywords: [${keywords.join(', ')}]`);
        }

        // Hide the source card
        if (cardRef) {
            hideVideo(cardRef, `Blocked: "${channelName || shortsTitle}"`);
        }

        // Close menu using YouTube's native Escape key mechanism
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
        }));
    });

    // Find the inner listbox if we landed on the outer wrapper
    const innerList = listbox.querySelector('tp-yt-paper-listbox') || listbox;
    innerList.appendChild(menuItem);
    console.log(`[Wallgarden] Injected "Block ${channelName}" into menu`);
}

/**
 * Inject a block item into sheet-style popups (yt-list-view-model).
 * Used by Shorts menus AND sidebar recommended video menus.
 */
function injectSheetBlockItem(listContainer) {
    if (!settings.enableSmartBlock || !lastMenuTarget) return;

    // Try all channel selectors across different card types
    let channelName = '';

    // Path A: Standard selectors (#channel-name, ytd-channel-name, handle links)
    const channelEl = lastMenuTarget.querySelector(
        '#channel-name .yt-simple-endpoint, #channel-name a, ' +
        'ytd-channel-name .yt-simple-endpoint, ytd-channel-name a, ' +
        'a[href^="/@"]'
    );
    if (channelEl) {
        channelName = channelEl.textContent.trim();
        if (!channelName && channelEl.getAttribute('href')) {
            channelName = '@' + channelEl.getAttribute('href').replace('/@', '');
        }
    }

    // Path B: Sidebar yt-lockup-view-model uses metadata spans (first span = channel name)
    if (!channelName) {
        const metaSpan = lastMenuTarget.querySelector('.yt-content-metadata-view-model__metadata-text');
        if (metaSpan) {
            channelName = metaSpan.textContent.trim();
        }
    }

    // Fallback: get title for keyword-based blocking (Shorts without channel)
    let shortsTitle = '';
    if (!channelName) {
        const titleEl = lastMenuTarget.querySelector(
            '#video-title, h3 a, .shortsLockupViewModelHostMetadataTitle a, a[title]'
        );
        if (titleEl) shortsTitle = titleEl.getAttribute('title') || titleEl.textContent.trim();
    }

    if (!channelName && !shortsTitle) return;

    const blockLabel = channelName ? `🌿 Block "${channelName}"` : '🌿 Block this Short';

    // Create a menu item styled like YouTube's yt-list-item-view-model
    const blockItem = document.createElement('div');
    blockItem.className = 'wg-block-menu-item';
    blockItem.setAttribute('role', 'menuitem');
    blockItem.setAttribute('tabindex', '0');
    blockItem.style.cssText = `
        display: flex; align-items: center; gap: 16px;
        padding: 12px 16px; cursor: pointer;
        color: #ff5252; font-size: 14px; font-family: "Roboto","Arial",sans-serif;
        border-top: 1px solid rgba(255,255,255,0.1);
    `;
    blockItem.textContent = blockLabel;

    const cardRef = lastMenuTarget;
    menuItem_clickHandler(blockItem, channelName, shortsTitle, cardRef);

    // Hover effect
    blockItem.addEventListener('mouseenter', () => {
        blockItem.style.backgroundColor = 'rgba(255, 82, 82, 0.15)';
    });
    blockItem.addEventListener('mouseleave', () => {
        blockItem.style.backgroundColor = '';
    });

    listContainer.appendChild(blockItem);
    console.log(`[Wallgarden] Injected sheet block: "${channelName || shortsTitle}"`);
}

/**
 * Shared click handler for block menu items across all popup types
 */
function menuItem_clickHandler(element, channelName, fallbackTitle, cardRef) {
    element.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (channelName) {
            blockChannelAndHide(channelName, cardRef);
        } else if (fallbackTitle) {
            const keywords = extractKeywords(fallbackTitle);
            keywords.forEach(kw => {
                blocklist.keywords[kw] = (blocklist.keywords[kw] || 0) + 5;
            });
            saveBlocklist();
            console.log(`[Wallgarden] Blocked by keywords: [${keywords.join(', ')}]`);
        }

        if (cardRef) {
            hideVideo(cardRef, `Blocked: "${channelName || fallbackTitle}"`);
        }

        // Close menu natively
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
        }));
    });
}

/**
 * Block a channel, save to storage, and hide all matching videos
 */
function blockChannelAndHide(channelName, sourceVideoEl) {
    const channelLower = channelName.toLowerCase();
    if (!blocklist.channels.includes(channelLower)) {
        blocklist.channels.push(channelLower);
        saveBlocklist();
        console.log(`[Wallgarden] Blocked channel: "${channelName}"`);
    }

    // Hide all visible videos from this channel
    document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer').forEach(el => {
        if (el.style.display === 'none') return;
        const ch = el.querySelector(
            '#channel-name .yt-simple-endpoint, #channel-name a, ' +
            'ytd-channel-name .yt-simple-endpoint, ytd-channel-name a, ' +
            'a[href^="/@"]'
        );
        if (ch && ch.textContent.trim().toLowerCase() === channelLower) {
            hideVideo(el, `Blocked: "${channelName}"`);
        }
    });
}

/**
 * Inject a small 🚫 block icon button next to the ⋮ menu button on each video card
 */
function injectInlineBlockIcon(videoEl, channelName) {
    if (videoEl.querySelector('.wg-inline-block')) return;

    // Find menu area — different on homepage (button[aria-label]) vs search (ytd-menu-renderer)
    const menuRenderer = videoEl.querySelector(
        'ytd-menu-renderer, #menu, button[aria-label="More actions"]'
    )?.closest('ytd-menu-renderer, #menu') || videoEl.querySelector('button[aria-label="More actions"]')?.parentElement;
    if (!menuRenderer) return;

    const btn = document.createElement('button');
    btn.className = 'wg-inline-block';
    btn.textContent = '🚫';
    btn.title = `Block "${channelName}"`;
    btn.style.cssText = `
        background: none; border: none; cursor: pointer;
        font-size: 16px; padding: 4px 6px; margin-right: 2px;
        opacity: 0; transform: scale(0.7);
        transition: opacity 0.25s ease, transform 0.25s ease;
        border-radius: 50%; line-height: 1;
        pointer-events: none;
    `;

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        blockChannelAndHide(channelName, videoEl);
    });

    // Smooth pop-in on video card hover
    videoEl.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.transform = 'scale(1)';
        btn.style.pointerEvents = 'auto';
    });
    videoEl.addEventListener('mouseleave', () => {
        btn.style.opacity = '0';
        btn.style.transform = 'scale(0.7)';
        btn.style.pointerEvents = 'none';
    });

    // Insert before the ⋮ menu button
    menuRenderer.style.display = 'flex';
    menuRenderer.style.alignItems = 'center';
    menuRenderer.insertBefore(btn, menuRenderer.firstChild);
}

/**
 * Called when user clicks "Not Interested" or "Don't recommend channel"
 */
function handleRejection(menuText, videoCard) {
    if (!settings.enableSmartBlock) return;

    let channel = '';
    let title = '';

    if (videoCard) {
        const titleEl = videoCard.querySelector('#video-title');
        const channelEl = videoCard.querySelector('#channel-name .yt-simple-endpoint, #channel-name a');
        if (titleEl) title = titleEl.textContent.trim();
        if (channelEl) channel = channelEl.textContent.trim();
    }

    console.log(`[Wallgarden] REJECTION: "${menuText}" | Channel: "${channel}" | Title: "${title}"`);

    // --- Block the channel permanently ---
    if (menuText.includes("don't recommend") && channel) {
        const channelLower = channel.toLowerCase();
        if (!blocklist.channels.includes(channelLower)) {
            blocklist.channels.push(channelLower);
            console.log(`[Wallgarden] ✗ Permanently blocked channel: "${channel}"`);
        }
    }

    // --- Extract and weight title keywords ---
    if (title) {
        const keywords = extractKeywords(title);
        keywords.forEach(kw => {
            blocklist.keywords[kw] = (blocklist.keywords[kw] || 0) + 1;
        });
    }

    // --- Log the rejection ---
    blocklist.rejectionLog.push({
        channel: channel.toLowerCase(),
        title,
        action: menuText,
        timestamp: Date.now()
    });

    // Keep log from growing unbounded (last 500)
    if (blocklist.rejectionLog.length > 500) {
        blocklist.rejectionLog = blocklist.rejectionLog.slice(-500);
    }

    // Persist
    saveBlocklist();

    // Show a brief notification badge on the video card
    if (videoCard) {
        showBlockedBadge(videoCard, channel || title);
    }
}

/**
 * Extract meaningful keywords from a title (skip stopwords and short words)
 */
function extractKeywords(title) {
    const stopwords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'is', 'it', 'this', 'that', 'was', 'are', 'be',
        'has', 'had', 'do', 'did', 'will', 'can', 'my', 'your', 'his', 'her',
        'we', 'they', 'you', 'me', 'him', 'us', 'its', 'our', 'who', 'how',
        'what', 'when', 'where', 'why', 'all', 'just', 'not', 'no', 'so',
        'if', 'from', 'up', 'out', 'about', 'into', 'over', 'after', 'new',
        'one', 'two', 'get', 'got', 'like', 'make', 'go', 'going', 'know',
        'see', 'look', 'come', 'think', 'back', 'only', 'also', 'than',
        'most', 'very', 'much', 'more', 'some', 'any', 'every', 'video',
        'watch', 'episode', 'part', 'day', 'time', 'official', 'full'
    ]);

    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '') // strip punctuation
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopwords.has(w));
}

function saveBlocklist() {
    chrome.storage.local.set({ blocklist });
}

/**
 * Show a small "Blocked by Wallgarden" badge on the hidden video
 */
function showBlockedBadge(element, label) {
    const badge = document.createElement('div');
    badge.textContent = `🌿 Blocked: ${label}`;
    badge.style.cssText = `
        background: #1a1a1a; color: #4CAF50; padding: 8px 12px;
        border: 1px solid #333; border-radius: 6px; font-size: 12px;
        font-family: 'Inter', sans-serif; margin: 4px 0;
    `;
    element.innerHTML = '';
    element.appendChild(badge);
}

// ============================================================
//  CSS-Based Blocking
// ============================================================
function applyBlockingCSS() {
    let styleEl = document.getElementById('wallgarden-css');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'wallgarden-css';
        document.head.appendChild(styleEl);
    }

    const rules = [];

    // --- HOMEPAGE CLEANUP ---

    if (settings.blockShorts) {
        // --- SHORTS BLOCKING: Pure CSS, flat selectors only (no :has()) ---
        // Direct element selectors — O(1) browser matching, zero performance cost
        rules.push(`
            #shorts-inner-container,
            ytd-rich-shelf-renderer[is-shorts],
            ytd-reel-shelf-renderer,
            [is-shorts],
            ytd-reel-item-renderer,
            ytm-shorts-lockup-view-model,
            ytm-shorts-lockup-view-model-v2,
            grid-shelf-view-model,
            a[title="Shorts"],
            ytd-mini-guide-entry-renderer[aria-label="Shorts"],
            [tab-identifier="FEshorts"]
        `);
    }

    if (settings.blockBreakingNews) {
        rules.push(`
            ytd-rich-shelf-renderer[is-default-no-title]:has(#title-text:empty),
            ytd-rich-shelf-renderer:has(span.style-scope.ytd-rich-shelf-renderer:not(:empty)),
            #breaking-news-shelf,
            ytd-rich-shelf-renderer[icon="BREAKING_NEWS"]
        `);
    }

    if (settings.blockTrending) {
        rules.push(`
            a[title="Trending"],
            [tab-identifier="FEtrending"],
            ytd-rich-shelf-renderer:has(a[href="/feed/trending"])
        `);
    }

    if (settings.blockCommunityPosts) {
        rules.push(`
            ytd-post-renderer,
            ytd-backstage-post-thread-renderer,
            ytd-rich-item-renderer:has(ytd-post-renderer)
        `);
    }

    if (settings.blockPeopleAlsoWatched) {
        rules.push(`
            ytd-shelf-renderer:has(span:contains("People also watched"))
        `);
    }

    if (settings.blockAds) {
        rules.push(`
            ytd-banner-promo-renderer,
            ytd-statement-banner-renderer,
            ytd-in-feed-ad-layout-renderer,
            ytd-ad-slot-renderer,
            ytd-promoted-sparkles-web-renderer,
            ytd-display-ad-renderer,
            ytd-promoted-video-renderer,
            #masthead-ad,
            .ytd-mealbar-promo-renderer,
            ytd-rich-item-renderer:has(ytd-ad-slot-renderer)
        `);
    }

    if (settings.blockMoviesShows) {
        rules.push(`
            ytd-rich-shelf-renderer:has(a[href*="/storefront"]),
            ytd-rich-shelf-renderer:has(a[href*="/feed/storefront"]),
            ytd-shelf-renderer:has(a[href*="/storefront"]),
            ytd-rich-shelf-renderer:has(span[title="Movies & TV"])
        `);
    }

    // --- WATCH PAGE CLEANUP ---

    if (settings.blockMerch) {
        rules.push(`
            ytd-merch-shelf-renderer,
            ytd-product-details-renderer
        `);
    }

    if (settings.blockDonations) {
        rules.push(`
            ytd-donation-shelf-renderer,
            #donation-shelf,
            ytd-super-thanks-button-renderer,
            .ytd-donation-suggestion-renderer,
            tp-yt-paper-dialog:has(ytd-donation-shelf-renderer)
        `);
    }

    if (settings.blockShortsRemix) {
        rules.push(`
            ytd-reel-shelf-renderer,
            ytd-shelf-renderer:has(span:contains("Shorts remixing"))
        `);
    }

    if (settings.blockChatReplay) {
        rules.push(`
            ytd-live-chat-frame,
            #chat-container,
            #chat
        `);
    }

    if (settings.blockInfoCards) {
        rules.push(`
            .ytp-ce-element,
            .ytp-cards-teaser,
            .ytp-ce-covering-overlay,
            .ytp-ce-element-shadow,
            .ytp-endscreen-content,
            .annotation
        `);
    }

    if (settings.blockClipThanks) {
        rules.push(`
            ytd-button-renderer:has(button[aria-label="Clip"]),
            ytd-button-renderer:has(button[aria-label="Thanks"])
        `);
    }

    // --- GLOBAL ANNOYANCES ---

    if (settings.blockPremiumUpsell) {
        rules.push(`
            ytd-mealbar-promo-renderer,
            tp-yt-paper-dialog:has(yt-upsell-dialog-renderer),
            yt-upsell-dialog-renderer,
            ytd-popup-container:has(yt-upsell-dialog-renderer),
            ytd-enforcement-message-view-model
        `);
    }

    if (settings.blockNotifPopup) {
        rules.push(`
            .yt-notification-action-renderer,
            tp-yt-paper-dialog:has(yt-notification-permission-ui)
        `);
    }

    if (settings.blockMusicUpsell) {
        rules.push(`
            ytmusic-mealbar-promo-renderer,
            ytd-mealbar-promo-renderer:has(a[href*="music.youtube.com"])
        `);
    }

    // Build final CSS — each rule gets its own declaration block
    // so one invalid selector can't break everything else
    if (rules.length > 0) {
        styleEl.textContent = rules
            .map(r => `${r.trim()} { display: none !important; }`)
            .join('\n');
    } else {
        styleEl.textContent = '';
    }

    applyCollapsibleCSS();
}

// ============================================================
//  Collapsible Panels — live chat + related-videos sidebar
// ============================================================
// Distinct from the block* settings above: blocking deletes a panel outright,
// collapsing folds it into a title bar you can click open again. The related
// sidebar in particular is the single biggest source of "just one more video",
// but you still want it reachable, so it earns a fold rather than a delete.

const COLLAPSIBLE_PANELS = [
    {
        key: 'collapseChat',
        cls: 'wg-collapsed-chat',
        label: 'Live chat',
        // #chat-container wraps the frame on watch pages; ytd-live-chat-frame
        // is the frame itself, which is what survives on some layouts.
        hostSelector: '#chat-container, ytd-live-chat-frame#chat',
    },
    {
        key: 'collapseRelated',
        cls: 'wg-collapsed-related',
        label: 'Suggested videos',
        hostSelector: '#related, ytd-watch-next-secondary-results-renderer',
    },
    {
        key: 'collapseComments',
        cls: 'wg-collapsed-comments',
        label: 'Comments',
        // ytd-comments#comments is the watch-page section. Qualify by tag: a bare
        // #comments also matches the comments box inside the Shorts player, where
        // our bar has nowhere sensible to sit.
        hostSelector: 'ytd-comments#comments',
    },
];

function applyCollapsibleCSS() {
    let el = document.getElementById('wallgarden-collapse-css');
    if (!el) {
        el = document.createElement('style');
        el.id = 'wallgarden-collapse-css';
        document.head.appendChild(el);
    }

    el.textContent = `
        .wg-collapse-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            box-sizing: border-box;
            padding: 8px 12px;
            margin-bottom: 8px;
            background: var(--yt-spec-badge-chip-background, rgba(255,255,255,0.08));
            border: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
            border-radius: 10px;
            color: var(--yt-spec-text-primary, #f1f1f1);
            font-family: "Roboto", Arial, sans-serif;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            user-select: none;
        }
        .wg-collapse-bar:hover {
            background: var(--yt-spec-10-percent-layer, rgba(255,255,255,0.14));
        }
        .wg-collapse-bar .wg-chevron {
            transition: transform 0.18s ease;
            font-size: 11px;
            opacity: 0.75;
        }
        .wg-collapse-bar .wg-hint {
            margin-left: auto;
            font-size: 11px;
            font-weight: 400;
            opacity: 0.55;
        }
        /* Collapsed: fold the panel body away but leave our bar (and the host
           element) in the DOM, so YouTube keeps updating it and one click
           brings it straight back.
           Every selector in the list needs its own html.<cls> prefix — a comma
           list does NOT inherit it, and an unprefixed selector here would hide
           the panel permanently whether it was collapsed or not. */
        ${COLLAPSIBLE_PANELS.map(p => `
        ${p.hostSelector.split(',')
            .map(s => `html.${p.cls} ${s.trim()} > *:not(.wg-collapse-bar)`)
            .join(',\n        ')} {
            display: none !important;
        }
        html.${p.cls} .wg-collapse-bar[data-wg-panel="${p.key}"] .wg-chevron {
            transform: rotate(-90deg);
        }`).join('\n')}
    `;
}

/** Put a click-to-toggle bar at the top of each collapsible panel. */
function injectCollapseBars() {
    COLLAPSIBLE_PANELS.forEach(panel => {
        const host = document.querySelector(panel.hostSelector);
        if (!host) return;

        let bar = host.querySelector(`:scope > .wg-collapse-bar[data-wg-panel="${panel.key}"]`);
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'wg-collapse-bar';
            bar.dataset.wgPanel = panel.key;
            bar.addEventListener('click', () => setPanelCollapsed(panel, !settings[panel.key]));
            host.prepend(bar);
        }
        renderCollapseBar(bar, panel);
    });
}

function renderCollapseBar(bar, panel) {
    const collapsed = !!settings[panel.key];
    bar.innerHTML = '';
    const chevron = document.createElement('span');
    chevron.className = 'wg-chevron';
    chevron.textContent = '▼';
    const label = document.createElement('span');
    label.textContent = panel.label;
    const hint = document.createElement('span');
    hint.className = 'wg-hint';
    hint.textContent = collapsed ? 'Show' : 'Hide';
    bar.append(chevron, label, hint);
    bar.title = collapsed
        ? `Show ${panel.label.toLowerCase()}`
        : `Collapse ${panel.label.toLowerCase()} (stays one click away)`;
}

function setPanelCollapsed(panel, collapsed) {
    settings[panel.key] = collapsed;
    chrome.storage.local.set({ [panel.key]: collapsed });
    syncCollapseClasses();
    const bar = document.querySelector(`.wg-collapse-bar[data-wg-panel="${panel.key}"]`);
    if (bar) renderCollapseBar(bar, panel);
}

function syncCollapseClasses() {
    COLLAPSIBLE_PANELS.forEach(p => {
        document.documentElement.classList.toggle(p.cls, !!settings[p.key]);
    });
}

/**
 * Live chat in particular mounts well after the rest of the watch page, and
 * YouTube re-renders the sidebar on its own schedule. Watch for a panel that
 * has lost its bar and put it back — debounced, and cheap enough to sit
 * alongside the heuristics observer.
 */
function startCollapseWatcher() {
    let pending = null;
    const observer = new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => {
            pending = null;
            const missing = COLLAPSIBLE_PANELS.some(p => {
                const host = document.querySelector(p.hostSelector);
                return host && !host.querySelector(`:scope > .wg-collapse-bar[data-wg-panel="${p.key}"]`);
            });
            if (missing) injectCollapseBars();
        }, 400);
    });
    // Scope to the watch-page content container when present: the panels live
    // under it, so there's no need to wake on masthead/guide/popup churn
    // elsewhere in <body>. Falls back to body before #page-manager mounts.
    const root = document.getElementById('page-manager') || document.body;
    observer.observe(root, { childList: true, subtree: true });
}

// ============================================================
//  Comment Filter — heuristic, reversible, auditable
// ============================================================
// Sits underneath the comments collapse bar: instead of folding the whole
// section away, drop the comments that carry no information and leave the rest.
//
// Three rules govern everything below, in priority order:
//
//   1. Nothing is deleted. A filtered comment stays in the DOM with a class on
//      it; the hiding is CSS. Audit mode flips that CSS off and shows every
//      filtered comment with the rule that caught it, so a false positive is
//      always visible rather than silently gone.
//   2. Protections beat rules. Engagement signals (likes, replies, a pin, a
//      creator heart) mean a human already vouched for the comment, so no rule
//      gets to touch it — see COMMENT_PROTECTIONS.
//   3. Rules match FORM, not opinion. "This is bad" with a reason survives;
//      "trash" on its own does not. We are filtering for substance, not
//      sentiment — the sharpest criticism under a video is often the most
//      useful comment on it, and a sentiment filter eats exactly that.
//
// Deliberately NOT a rule: timestamp lists. They pattern-match as low-effort
// (few words, repeated digits) and are frequently the single most useful
// comment on a long video. Cheap to detect, expensive to be wrong about.

/** Likes at or above this mean someone vouched for it — never filter. */
const WG_COMMENT_LIKE_FLOOR = 5;

// Extended_Pictographic plus the joiners/modifiers that decorate it. NOT
// \p{Emoji_Component}, which includes the ASCII digits 0-9 — using it made
// "the treaty was 1919 not 1918" read as eight emoji and get binned as spam.
const WG_EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;

/** "1.2K" / "3M" / "412" → number. Empty or unparseable → 0. */
function parseCommentCount(raw) {
    if (!raw) return 0;
    const m = String(raw).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(n * mult);
}

/**
 * Stable-enough identity for a comment, for the user's "not spam" allowlist.
 * YouTube exposes a real comment id (`lc=` on the timestamp permalink) but only
 * on some surfaces, so fall back to a hash of author + text. djb2.
 */
function commentKey(info) {
    if (info.id) return info.id;
    const src = `${info.author} ${info.text.slice(0, 120)}`;
    let h = 5381;
    for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
    return `h${(h >>> 0).toString(36)}`;
}

/**
 * Pull the fields the rules need out of a rendered comment thread.
 * Every selector has fallbacks: YouTube ships comment DOM changes regularly,
 * and a missing field must degrade to "can't tell" (which protects the
 * comment), never to a confident wrong answer.
 */
function scrapeComment(threadEl) {
    const q = sel => threadEl.querySelector(sel);

    const textEl = q('#content-text, yt-attributed-string#content-text, #comment-content #content-text');
    const text = (textEl?.textContent || '').trim();

    const authorEl = q('#author-text, #header-author #author-text, a#author-text');
    const author = (authorEl?.textContent || '').trim();

    // Likes: the visible count sits in #vote-count-middle. When YouTube renders
    // no count at all the comment has 0 likes, which is the honest reading.
    const likes = parseCommentCount(q('#vote-count-middle, #vote-count-left')?.textContent);

    // Replies: presence of the expander is enough — we only care whether anyone
    // engaged, not how many did.
    const repliesEl = q('#more-replies, ytd-comment-replies-renderer #expander-contents, #replies ytd-button-renderer');
    const replies = repliesEl ? Math.max(1, parseCommentCount(repliesEl.textContent)) : 0;

    const pinned = !!q('#pinned-comment-badge, ytd-pinned-comment-badge-renderer, [aria-label*="Pinned" i]');
    const hearted = !!q('ytd-creator-heart-renderer, #creator-heart-button, #creator-heart');
    // The channel owner's own comments carry an author badge chip.
    const byOwner = !!q('ytd-author-comment-badge-renderer, #author-comment-badge');

    const permalink = q('a[href*="lc="]')?.getAttribute('href') || '';
    const id = permalink.match(/lc=([\w.\-]+)/)?.[1] || '';

    const info = { text, author, likes, replies, pinned, hearted, byOwner, id };
    info.key = commentKey(info);
    return info;
}

/**
 * Reasons a comment is off-limits regardless of what the rules think.
 * Each returns a truthy label when it applies.
 */
const COMMENT_PROTECTIONS = [
    i => !i.text && 'no text scraped',
    i => i.likes >= WG_COMMENT_LIKE_FLOOR && `${i.likes} likes`,
    i => i.replies > 0 && 'has replies',
    i => i.pinned && 'pinned',
    i => i.hearted && 'hearted by creator',
    i => i.byOwner && 'by the channel owner',
];

/** Words that mark a complaint. On their own they prove nothing — see below. */
const WG_COMPLAINT_WORDS = /\b(trash|garbage|mid|cringe|dogshit|dogwater|unwatchable|worst|awful|terrible|sucks?|boring|clickbait|ratio|L\b|flop|overrated)\b/i;
/**
 * Markers that a comment is making an ARGUMENT rather than just booing.
 * Conjunctions only — punctuation and digits were tried here and are far too
 * weak a signal: a comma let "mid video, worst channel" pass as reasoned.
 */
const WG_SUBSTANCE_MARKERS = /\b(because|since|although|however|but|though|imo|actually|instead|whereas|the (?:problem|issue|point)|due to|which is why)\b/i;

const WG_COMMENT_RULES = [
    {
        id: 'emojiOnly',
        label: 'Emoji only',
        test: i => !i.text.replace(WG_EMOJI_RE, '').replace(/[\s\p{P}\p{S}]/gu, ''),
    },
    {
        id: 'scam',
        label: 'Scam / contact bait',
        // The dominant scam genres under finance and tutorial videos: an offer
        // plus an off-platform contact handle.
        test: i => /\b(telegram|whats\s?app|whatsapp|t\.me\/|wa\.me\/)\b/i.test(i.text)
            || /\b(dm|message|contact|reach out to|write)\s+(me|him|her|them|us)\b.{0,40}\b(on|via|at|@)/i.test(i.text)
            || /\b(recovery (?:expert|agent|specialist)|hack(?:er|ing) (?:service|expert)|binary options|forex (?:expert|trader)|crypto (?:expert|mentor)|investment (?:mentor|manager))\b/i.test(i.text)
            || /\b(earn|make|profit)(?:ed|ing)?\s+\$?\d[\d,.]*\s*(k|usd|dollars)?\b.{0,60}\b(week|day|month|trading|invest)/i.test(i.text),
    },
    {
        id: 'selfPromo',
        label: 'Self-promotion',
        test: i => /\b(check out|visit|watch) my (?:channel|videos?|page|profile)\b/i.test(i.text)
            || /\b(sub(?:scribe)? (?:to|back)? ?(?:my|me)|subbed, sub back|sub4sub)\b/i.test(i.text),
    },
    {
        id: 'engagementBait',
        label: 'Engagement bait',
        test: i => /\bwho'?s? (?:still )?(?:watching|here|listening)\b/i.test(i.text)
            || /\b(?:still|anyone) (?:watching|here|listening)\s+in\s+(?:20\d\d|\w+\s+20\d\d)\b/i.test(i.text)
            || /\b(?:like|comment) if you\b/i.test(i.text)
            || /\b\d+% of (?:people|you|viewers) (?:will|won'?t)\b/i.test(i.text)
            || /\b(?:first|early|second)!*$/i.test(i.text.trim()) && i.text.length < 20,
    },
    {
        id: 'characterMash',
        label: 'Character mashing',
        // Ordered ahead of lowEffort: both would catch "great 😂😂😂😂😂😂😂😂",
        // but the audit bar names the FIRST matching rule, and it should report
        // the specific reason rather than the generic one.
        test: i => /(.)\1{7,}/.test(i.text)
            || (i.text.match(WG_EMOJI_RE) || []).length >= 6,
    },
    {
        id: 'lowEffort',
        label: 'Too short to say anything',
        // Short AND unvouched. The like floor and reply protections above have
        // already run, so anything reaching here got zero traction too.
        test: i => i.text.replace(WG_EMOJI_RE, '').trim().length < 12,
    },
    {
        id: 'emptyComplaint',
        label: 'Complaint with no substance',
        // The narrowest rule here on purpose, and the one most worth watching in
        // audit mode. All three must hold: it boos, it makes no argument, and
        // it is short. Drop any one condition and it starts eating real critique.
        test: i => WG_COMPLAINT_WORDS.test(i.text)
            && !WG_SUBSTANCE_MARKERS.test(i.text)
            && i.text.trim().split(/\s+/).length <= 7,
    },
];

/** Comments the user has personally cleared in audit mode. Keys, not text. */
let commentAllowlist = new Set();
/** Per-rule hit counts for the current page, shown on the audit bar. */
let commentFilterStats = {};

/**
 * @returns {{filtered: boolean, rule?: object, protectedBy?: string}}
 */
function classifyComment(info) {
    if (commentAllowlist.has(info.key)) return { filtered: false, protectedBy: 'you cleared it' };
    for (const p of COMMENT_PROTECTIONS) {
        const why = p(info);
        if (why) return { filtered: false, protectedBy: why };
    }
    for (const rule of WG_COMMENT_RULES) {
        let hit = false;
        try { hit = !!rule.test(info); } catch { hit = false; }
        if (hit) return { filtered: true, rule };
    }
    return { filtered: false };
}

function applyCommentFilterCSS() {
    let el = document.getElementById('wallgarden-comment-filter-css');
    if (!el) {
        el = document.createElement('style');
        el.id = 'wallgarden-comment-filter-css';
        document.head.appendChild(el);
    }
    el.textContent = `
        /* Filtering is CSS over a class, never a DOM removal: turning the
           setting off restores every comment with no re-scrape. */
        html.wg-cf-on ytd-comment-thread-renderer.wg-comment-filtered {
            display: none !important;
        }
        /* Audit mode: show the filtered comments, marked, so false positives
           are inspectable instead of invisible. */
        html.wg-cf-on.wg-cf-audit ytd-comment-thread-renderer.wg-comment-filtered {
            display: block !important;
            opacity: 0.6;
            outline: 1px dashed rgba(255, 138, 128, 0.7);
            border-radius: 8px;
            padding: 6px 8px;
            margin: 4px 0;
        }
        html.wg-cf-on.wg-cf-audit ytd-comment-thread-renderer.wg-comment-filtered:hover {
            opacity: 1;
        }
        .wg-cf-tag {
            display: none;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
            font-family: "Roboto", Arial, sans-serif;
            font-size: 11px;
            color: rgba(255, 138, 128, 0.95);
        }
        html.wg-cf-on.wg-cf-audit ytd-comment-thread-renderer.wg-comment-filtered .wg-cf-tag {
            display: flex;
        }
        .wg-cf-tag button {
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.2);
            color: var(--yt-spec-text-primary, #f1f1f1);
            border-radius: 999px;
            padding: 2px 10px;
            font-size: 11px;
            cursor: pointer;
        }
        .wg-cf-tag button:hover { background: rgba(255,255,255,0.2); }
        .wg-cf-bar {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            width: 100%;
            box-sizing: border-box;
            padding: 8px 12px;
            margin-bottom: 8px;
            background: var(--yt-spec-badge-chip-background, rgba(255,255,255,0.08));
            border: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
            border-radius: 10px;
            color: var(--yt-spec-text-primary, #f1f1f1);
            font-family: "Roboto", Arial, sans-serif;
            font-size: 12px;
        }
        html:not(.wg-cf-on) .wg-cf-bar { display: none; }
        .wg-cf-bar .wg-cf-breakdown { opacity: 0.6; font-size: 11px; }
        .wg-cf-bar button {
            margin-left: auto;
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.2);
            color: inherit;
            border-radius: 999px;
            padding: 3px 12px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
        }
        .wg-cf-bar button:hover { background: rgba(255,255,255,0.2); }
    `;
}

function syncCommentFilterClasses() {
    document.documentElement.classList.toggle('wg-cf-on', !!settings.filterComments);
    document.documentElement.classList.toggle('wg-cf-audit', !!settings.commentAuditMode);
}

/** Mark the "not spam" affordance onto a filtered comment. */
function tagFilteredComment(threadEl, info, rule) {
    let tag = threadEl.querySelector(':scope > .wg-cf-tag');
    if (!tag) {
        tag = document.createElement('div');
        tag.className = 'wg-cf-tag';
        threadEl.prepend(tag);
    }
    tag.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = `⚑ hidden — ${rule.label}`;
    const btn = document.createElement('button');
    btn.textContent = 'Not spam';
    btn.title = 'Restore this comment and remember the decision';
    btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        clearFilteredComment(threadEl, info);
    });
    tag.append(label, btn);
}

/** User says we got it wrong: restore it and remember, across pages and sessions. */
function clearFilteredComment(threadEl, info) {
    commentAllowlist.add(info.key);
    chrome.storage.local.set({ commentAllowlist: [...commentAllowlist] });
    threadEl.classList.remove('wg-comment-filtered');
    threadEl.querySelector(':scope > .wg-cf-tag')?.remove();
    const rule = threadEl.dataset.wgCfRule;
    if (rule && commentFilterStats[rule]) {
        commentFilterStats[rule] -= 1;
        if (!commentFilterStats[rule]) delete commentFilterStats[rule];
    }
    delete threadEl.dataset.wgCfRule;
    renderCommentFilterBar();
}

/**
 * Classify every comment thread not yet seen on this page.
 * Idempotent: threads carry data-wg-cf once processed. Cheap enough to run on
 * every mutation batch as YouTube lazy-loads more comments.
 */
function filterComments() {
    if (!settings.filterComments) return;
    const threads = document.querySelectorAll('ytd-comment-thread-renderer:not([data-wg-cf])');
    if (!threads.length) return;

    threads.forEach(threadEl => {
        const info = scrapeComment(threadEl);
        // No text yet means the thread is still rendering — leave it unmarked
        // so the next mutation batch picks it up rather than passing it
        // permanently on an empty read.
        if (!info.text) return;
        threadEl.dataset.wgCf = '1';

        const verdict = classifyComment(info);
        if (!verdict.filtered) return;

        threadEl.classList.add('wg-comment-filtered');
        threadEl.dataset.wgCfRule = verdict.rule.id;
        commentFilterStats[verdict.rule.id] = (commentFilterStats[verdict.rule.id] || 0) + 1;
        tagFilteredComment(threadEl, info, verdict.rule);
    });

    renderCommentFilterBar();
}

/** Summary + audit toggle, injected at the top of the comments section. */
function renderCommentFilterBar() {
    const host = document.querySelector('ytd-comments#comments');
    if (!host) return;

    const total = Object.values(commentFilterStats).reduce((a, b) => a + b, 0);
    let bar = host.querySelector(':scope > .wg-cf-bar');
    if (!total) {
        bar?.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'wg-cf-bar';
        // Below the collapse bar, which prepends itself to the same host.
        const collapseBar = host.querySelector(':scope > .wg-collapse-bar');
        if (collapseBar) collapseBar.after(bar); else host.prepend(bar);
    }

    const auditing = !!settings.commentAuditMode;
    bar.innerHTML = '';

    const summary = document.createElement('span');
    summary.textContent = `🌿 ${total} comment${total === 1 ? '' : 's'} filtered`;

    const breakdown = document.createElement('span');
    breakdown.className = 'wg-cf-breakdown';
    breakdown.textContent = Object.entries(commentFilterStats)
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${WG_COMMENT_RULES.find(r => r.id === id)?.label || id} ${n}`)
        .join(' · ');

    const btn = document.createElement('button');
    btn.textContent = auditing ? 'Hide them' : 'Review what was filtered';
    btn.title = auditing
        ? 'Hide filtered comments again'
        : 'Show every filtered comment with the rule that caught it';
    btn.addEventListener('click', () => {
        settings.commentAuditMode = !settings.commentAuditMode;
        chrome.storage.local.set({ commentAuditMode: settings.commentAuditMode });
        syncCommentFilterClasses();
        renderCommentFilterBar();
    });

    bar.append(summary, breakdown, btn);
}

/** Comments lazy-load forever, so this watcher runs for the life of the page. */
function startCommentFilterWatcher() {
    let pending = null;
    const observer = new MutationObserver(() => {
        if (!settings.filterComments) return;
        if (pending) return;
        pending = setTimeout(() => {
            pending = null;
            filterComments();
        }, 250);
    });
    const root = document.getElementById('page-manager') || document.body;
    observer.observe(root, { childList: true, subtree: true });
}

/** A new video means a new comment section: drop the per-page tallies. */
function resetCommentFilterState() {
    commentFilterStats = {};
    document.querySelectorAll('[data-wg-cf]').forEach(el => {
        delete el.dataset.wgCf;
        delete el.dataset.wgCfRule;
        el.classList.remove('wg-comment-filtered');
        el.querySelector(':scope > .wg-cf-tag')?.remove();
    });
    document.querySelector('.wg-cf-bar')?.remove();
}

// ============================================================
//  MutationObserver — Heuristics + Smart Blocklist + Text Blocking
// ============================================================
function startObserver() {
    const videoSelectors = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer';
    const shelfSelectors = 'ytd-shelf-renderer, ytd-rich-shelf-renderer, ytd-rich-section-renderer';

    // Debounced MutationObserver — batch rapid DOM mutations
    let pendingMutations = [];
    let rafId = null;

    const observer = new MutationObserver((mutations) => {
        pendingMutations.push(...mutations);
        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                const allMutations = pendingMutations;
                pendingMutations = [];
                rafId = null;

                const newVideoNodes = [];
                const newShelfNodes = [];

                allMutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return;

                        if (node.matches && node.matches(videoSelectors)) {
                            newVideoNodes.push(node);
                        } else if (node.querySelectorAll) {
                            node.querySelectorAll(videoSelectors).forEach(v => newVideoNodes.push(v));
                        }

                        if (node.matches && node.matches(shelfSelectors)) {
                            newShelfNodes.push(node);
                        } else if (node.querySelectorAll) {
                            node.querySelectorAll(shelfSelectors).forEach(s => newShelfNodes.push(s));
                        }
                    });
                });

                if (newVideoNodes.length > 0) processVideos(newVideoNodes);
                if (newShelfNodes.length > 0) processShelves(newShelfNodes);

            });
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial scan
    processVideos(document.querySelectorAll(videoSelectors));
    processShelves(document.querySelectorAll(shelfSelectors));

    // Periodic rescan ONLY on homepage for lazy-loaded yt-lockup-view-model cards
    setInterval(() => {
        if (location.pathname !== '/') return; // Only homepage needs rescan
        const cards = document.querySelectorAll(videoSelectors);
        const unprocessed = [];
        cards.forEach(card => {
            if (!evaluatedVideos.has(card) && card.style.display !== 'none') {
                unprocessed.push(card);
            }
        });
        if (unprocessed.length > 0) {
            processVideos(unprocessed);
        }
    }, 5000);
}

// hideShortsElements removed — all Shorts hiding is now pure CSS (no JS scanning needed)

/**
 * Text-based shelf filtering
 */
function processShelves(shelfElements) {
    shelfElements.forEach(shelf => {
        if (evaluatedVideos.has(shelf)) return;
        evaluatedVideos.add(shelf);

        const titleEl = shelf.querySelector('#title-text, .title, span.style-scope, #rich-shelf-header');
        if (!titleEl) return;
        const text = titleEl.textContent.trim().toLowerCase();

        // JS fallback for Shorts shelves (CSS :has-text is not valid browser CSS)
        if (settings.blockShorts && text.includes('shorts')) {
            shelf.style.display = 'none';
            console.log('[Wallgarden] Hid shelf: "Shorts"');
            return; // No need to check further
        }

        if (settings.blockPeopleAlsoWatched && text.includes('people also watched')) {
            shelf.style.display = 'none';
            console.log('[Wallgarden] Hid shelf: "People also watched"');
        }
        if (settings.blockShortsRemix && text.includes('shorts remixing')) {
            shelf.style.display = 'none';
            console.log('[Wallgarden] Hid shelf: "Shorts remixing this video"');
        }
        if (settings.blockBreakingNews && text.includes('breaking news')) {
            shelf.style.display = 'none';
            console.log('[Wallgarden] Hid shelf: "Breaking News"');
        }
        if (settings.blockTrending && text.includes('trending')) {
            shelf.style.display = 'none';
            console.log('[Wallgarden] Hid shelf: "Trending"');
        }
        if (settings.blockMoviesShows && (text.includes('movies') || text.includes('shows'))) {
            shelf.style.display = 'none';
            console.log('[Wallgarden] Hid shelf: "Movies & Shows"');
        }
    });
}

/**
 * Process individual video cards through heuristics + smart blocklist
 * Works on: homepage (ytd-rich-item-renderer), search (ytd-video-renderer),
 *           sidebar (ytd-compact-video-renderer)
 */
function processVideos(videoElements) {
    videoElements.forEach(videoEl => {
        if (evaluatedVideos.has(videoEl) || videoEl.style.display === 'none') return;

        const titleEl = videoEl.querySelector(
            '#video-title, h3 a, yt-formatted-string#video-title'
        );
        const channelEl = videoEl.querySelector(
            '#channel-name .yt-simple-endpoint, #channel-name a, ' +
            'ytd-channel-name .yt-simple-endpoint, ytd-channel-name a, ' +
            '.ytd-channel-name a, a[href^="/@"]'
        );

        if (!titleEl || !channelEl) return;

        evaluatedVideos.add(videoEl);

        const titleText = titleEl.textContent.trim();
        const channelText = channelEl.textContent.trim();

        if (!channelText) return;

        // --- Smart Blocklist: Channel check ---
        if (settings.enableSmartBlock && blocklist.channels.includes(channelText.toLowerCase())) {
            hideVideo(videoEl, `Blocked channel: "${channelText}"`);
            showBlockedBadge(videoEl, channelText);
            return;
        }

        // --- Smart Blocklist: Keyword check (threshold: 3+ rejections) ---
        if (settings.enableSmartBlock) {
            const titleKeywords = extractKeywords(titleText);
            const hotKeywords = titleKeywords.filter(kw => (blocklist.keywords[kw] || 0) >= 3);
            if (hotKeywords.length >= 2) {
                hideVideo(videoEl, `Keyword match: [${hotKeywords.join(', ')}] in "${titleText}"`);
                showBlockedBadge(videoEl, `Keywords: ${hotKeywords.join(', ')}`);
                return;
            }
        }

        // --- Heuristics ---
        if (failsHeuristics(titleText)) {
            hideVideo(videoEl, `Heuristics: "${titleText}"`);
            return;
        }

        // --- Inject inline block icon next to ⋮ button ---
        if (settings.enableSmartBlock) {
            injectInlineBlockIcon(videoEl, channelText);
        }

        // --- Inject inline Wallgarden quick-save icon ---
        const saveMeta = scrapeCardMetadata(videoEl);
        if (saveMeta) injectInlineSaveIcon(videoEl, saveMeta);
    });
}

function failsHeuristics(title) {
    if (settings.blockAllCaps) {
        const letters = title.replace(/[^a-zA-Z]/g, '');
        if (letters.length > 5) {
            const upCount = letters.split('').filter(c => c === c.toUpperCase()).length;
            if (upCount / letters.length > 0.8) return true;
        }
    }

    if (settings.blockPunctuation) {
        if (/[!?]{3,}/.test(title)) return true;
    }

    return false;
}

function hideVideo(element, reason) {
    console.log(`[Wallgarden] Hiding video. Reason: ${reason}`);
    element.style.display = 'none';
}

// ============================================================
//  WALLGARDEN: Native Action Syncing (Phase 4)
// ============================================================

function getVideoIdFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const v = urlParams.get('v');
    if (v) return v;
    // Shorts pages: /shorts/<videoId>
    const shortsMatch = window.location.pathname.match(/\/shorts\/([\w-]{5,})/);
    return shortsMatch ? shortsMatch[1] : null;
}

// Context of the video whose "Save to..." dialog is currently open
let pendingSaveContext = null;

/**
 * Extract videoId + metadata from a feed/search/sidebar card element,
 * so sync events work anywhere on YouTube — not just the watch page.
 */
function scrapeCardMetadata(cardEl) {
    if (!cardEl || !cardEl.querySelector) return null;

    let videoId = '';
    const watchLink = cardEl.querySelector('a[href*="watch?v="]');
    if (watchLink) {
        const m = (watchLink.getAttribute('href') || '').match(/[?&]v=([\w-]{5,})/);
        if (m) videoId = m[1];
    }
    if (!videoId) {
        const shortsLink = cardEl.querySelector('a[href*="/shorts/"]');
        if (shortsLink) {
            const m = (shortsLink.getAttribute('href') || '').match(/\/shorts\/([\w-]{5,})/);
            if (m) videoId = m[1];
        }
    }
    if (!videoId) return null;

    const titleEl = cardEl.querySelector('#video-title, yt-formatted-string#video-title, h3 a, a[title]');
    const title = titleEl
        ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim()
        : '';

    let channelName = '';
    let channelId = '';
    const channelEl = cardEl.querySelector(
        '#channel-name .yt-simple-endpoint, #channel-name a, ' +
        'ytd-channel-name a, .yt-content-metadata-view-model__metadata-text, a[href^="/@"]'
    );
    if (channelEl) {
        channelName = channelEl.textContent.trim();
        const href = channelEl.getAttribute('href') || '';
        if (href.startsWith('/channel/')) {
            channelId = href.replace('/channel/', '');
        } else if (href.startsWith('/@')) {
            channelId = href.replace('/', '');
        }
    }

    return { videoId, title, channelName, channelId };
}

/**
 * Resolve the video an action applies to: the card whose ⋮ menu is open,
 * falling back to the currently playing watch page.
 */
function getActionContext(preferWatchPage = false) {
    const watchPageContext = () => {
        const videoId = getVideoIdFromUrl();
        return videoId ? { videoId, ...scrapeVideoMetadata() } : null;
    };

    if (preferWatchPage) {
        const wp = watchPageContext();
        if (wp) return wp;
    }
    if (lastMenuTarget && lastMenuTarget.isConnected) {
        const meta = scrapeCardMetadata(lastMenuTarget);
        if (meta) return meta;
    }
    return watchPageContext();
}

// Drop duplicate sync events fired by YouTube's re-render churn (the same
// like/save click can bubble through several times). Keyed by action + video +
// playlist so a genuine second save to a different playlist still gets through.
const _recentSync = new Map();
const SYNC_DEDUP_MS = 1500;

function sendSyncEvent(action, data = {}) {
    const videoId = data.videoId || getVideoIdFromUrl();
    if (!videoId) {
        console.warn("[Wallgarden Sync] sendSyncEvent failed: no videoId (not on a watch page and no card context)");
        return;
    }
    const dedupKey = `${action}:${videoId}:${data.playlistId || data.playlistName || ''}`;
    const now = Date.now();
    const last = _recentSync.get(dedupKey);
    if (last && (now - last) < SYNC_DEDUP_MS) {
        console.log(`[Wallgarden Sync] Skipping duplicate ${action} for ${videoId}`);
        return;
    }
    _recentSync.set(dedupKey, now);
    if (_recentSync.size > 100) {
        // Prune stale entries so the map can't grow unbounded on long sessions
        for (const [k, t] of _recentSync) {
            if (now - t > SYNC_DEDUP_MS) _recentSync.delete(k);
        }
    }
    console.log(`[Wallgarden Sync] sendSyncEvent: Sending ${action} for ${videoId}`);
    try {
        chrome.runtime.sendMessage({
            type: 'WALLGARDEN_SYNC',
            data: {
                action,
                videoId,
                ...data
            }
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn("[Wallgarden Sync] sendMessage error callback:", chrome.runtime.lastError.message);
            } else {
                console.log("[Wallgarden Sync] sendMessage success");
            }
        });
    } catch (e) {
        console.error("[Wallgarden Sync] sendMessage failed with exception:", e.message);
    }
}

function scrapeVideoMetadata() {
    let title = '';
    const titleEl = document.querySelector(
        'ytd-watch-metadata h1 yt-formatted-string, ' +
        'h1.ytd-watch-metadata yt-formatted-string, ' +
        'ytd-video-primary-info-renderer h1 yt-formatted-string, ' +
        'h1.title yt-formatted-string'
    );
    if (titleEl) {
        title = titleEl.textContent.trim();
    }
    if (!title) {
        title = document.title.replace(/\s*-\s*YouTube$/, '').trim();
    }

    let channelName = '';
    let channelId = '';
    const channelEl = document.querySelector(
        'ytd-watch-metadata #channel-name a, ' +
        'ytd-video-owner-renderer #channel-name a, ' +
        'ytd-channel-name a, ' +
        '#owner-name a'
    );
    if (channelEl) {
        channelName = channelEl.textContent.trim();
        const href = channelEl.getAttribute('href') || '';
        if (href.startsWith('/channel/')) {
            channelId = href.replace('/channel/', '');
        } else if (href.startsWith('/@')) {
            channelId = href.replace('/', '');
        }
    }

    // Extract duration if available
    let duration = 0;
    const progressEl = document.querySelector('.ytp-time-duration');
    if (progressEl) {
        const parts = progressEl.textContent.trim().split(':').map(Number);
        if (parts.length === 2) {
            duration = parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
            duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
    }

    // Extract view count if available
    let viewCount = 0;
    const viewsEl = document.querySelector('ytd-watch-metadata #info-container span, ytd-video-primary-info-renderer #info-text span');
    if (viewsEl) {
        const match = viewsEl.textContent.replace(/,/g, '').match(/(\d+)\s*views/);
        if (match) {
            viewCount = parseInt(match[1], 10);
        }
    }

    return {
        title,
        channelName,
        channelId,
        duration,
        viewCount
    };
}

function startSyncObservers() {
    // 1. Watch Progress (Video Element)
    let videoObserverAdded = false;
    setInterval(() => {
        const videoEl = document.querySelector('video.html5-main-video');
        if (videoEl && !videoObserverAdded) {
            videoObserverAdded = true;
            
            // Watch completion (ended or > 90%)
            let watchedSynced = false;
            
            videoEl.addEventListener('ended', () => {
                if (!watchedSynced) {
                    sendSyncEvent('WATCHED');
                    watchedSynced = true;
                }
            });
            
            videoEl.addEventListener('timeupdate', () => {
                if (!watchedSynced && videoEl.duration > 0) {
                    if (videoEl.currentTime / videoEl.duration > 0.9) {
                        sendSyncEvent('WATCHED');
                        watchedSynced = true;
                    }
                }
            });
            
            // Reset state on new video load
            videoEl.addEventListener('loadeddata', () => {
                watchedSynced = false;
            });
        }
    }, 2000);

    // 2. DOM Observers for Clicks (Likes, Subscriptions, Playlists)
    document.addEventListener('click', (e) => {
        if (e.target.closest('.wg-block-menu-item')) return; // Never intercept our own items

        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        
        // Log all clicks in DevTools to assist debugging
        const pathTagNames = path.map(el => el.tagName ? el.tagName.toLowerCase() : '').filter(Boolean);
        console.log("[Wallgarden Sync] Clicked path:", pathTagNames);

        // Like/Dislike detection — layered from most to least specific.
        let hasLike = false;
        let hasDislike = false;

        // Path 1: Modern YouTube wraps each button in a dedicated view-model
        // element (inside segmented-like-dislike-button-view-model on watch
        // pages, standalone on Shorts). Most reliable signal.
        const likeVM = e.target.closest('like-button-view-model');
        const dislikeVM = e.target.closest('dislike-button-view-model');
        if (likeVM) hasLike = true;
        else if (dislikeVM) hasDislike = true;

        // Path 2: aria-label on the clicked button. Note "Dislike this video"
        // contains "like this video", so dislike must be checked first.
        if (!hasLike && !hasDislike) {
            const ariaBtn = e.target.closest('button[aria-label], yt-icon-button[aria-label]');
            if (ariaBtn) {
                const aria = (ariaBtn.getAttribute('aria-label') || '').toLowerCase();
                if (aria.includes('dislike this video')) hasDislike = true;
                else if (aria.includes('like this video')) hasLike = true;
            }
        }

        // Path 3: positional fallback inside the segmented container
        // (first yt-button-view-model = Like, second = Dislike)
        if (!hasLike && !hasDislike) {
            const segmentedContainer = e.target.closest(
                'segmented-like-dislike-button-view-model, ytd-segmented-like-dislike-button-renderer'
            );
            if (segmentedContainer) {
                const btnViewModels = Array.from(segmentedContainer.querySelectorAll('yt-button-view-model'));
                const targetVM = e.target.closest('yt-button-view-model');
                if (btnViewModels.length >= 2 && targetVM) {
                    if (targetVM === btnViewModels[0]) hasLike = true;
                    else if (targetVM === btnViewModels[1]) hasDislike = true;
                }
            }
        }

        const isSubscribeElement = (el) => {
            if (!el || !el.tagName) return false;
            const tag = el.tagName.toLowerCase();
            return tag === 'yt-subscribe-button-view-model' || tag === 'ytd-subscribe-button-renderer';
        };

        const isPlaylistSaveElement = (el) => {
            if (!el || !el.tagName) return false;
            const tag = el.tagName.toLowerCase();
            if (tag === 'ytd-menu-service-item-renderer' && el.querySelector && el.querySelector('yt-icon.ytd-playlist-add-icon')) return true;
            if (tag === 'yt-button-view-model') {
                const pathEl = el.querySelector('svg path');
                if (pathEl && (pathEl.getAttribute('d') || '').includes('M14,10H2v2h12V10z')) return true;
            }
            return false;
        };

        let hasSub = path.some(isSubscribeElement);
        let hasPlaylist = path.some(isPlaylistSaveElement);

        if (!hasSub) {
            hasSub = !!e.target.closest('yt-subscribe-button-view-model button, ytd-subscribe-button-renderer button');
        }
        if (!hasPlaylist) {
            hasPlaylist = !!e.target.closest('ytd-menu-popup-renderer ytd-menu-service-item-renderer:has(yt-icon.ytd-playlist-add-icon)');
        }

        if (hasLike || hasDislike) {
            const vmSelector = hasLike ? 'like-button-view-model' : 'dislike-button-view-model';
            const clickedVM = e.target.closest(vmSelector);
            const clickedBtn = e.target.closest('button');
            setTimeout(() => {
                // Re-locate the button AFTER YouTube processes the toggle —
                // the originally clicked node may have been re-rendered.
                const btn = (clickedVM && clickedVM.isConnected && clickedVM.querySelector('button'))
                    || (clickedBtn && clickedBtn.isConnected && clickedBtn)
                    || document.querySelector(`ytd-watch-metadata ${vmSelector} button, ${vmSelector} button`);

                let isSelected;
                if (btn) {
                    isSelected = btn.getAttribute('aria-pressed') === 'true' ||
                        btn.classList.contains('yt-spec-button-shape-next--selected');
                } else {
                    // Can't read the toggle state — assume the click turned it ON.
                    // (Dropping the event loses a like; a rare duplicate is harmless.)
                    console.warn("[Wallgarden Sync] Could not read toggle state, assuming selected");
                    isSelected = true;
                }

                const positive = hasLike ? 'LIKE' : 'DISLIKE';
                const negative = hasLike ? 'UNLIKE' : 'UNDISLIKE';
                console.log(`[Wallgarden Sync] ${positive} clicked, final selected state:`, !!isSelected);
                const metadata = scrapeVideoMetadata();
                sendSyncEvent(isSelected ? positive : negative, metadata);
            }, 250);
        } else if (hasSub) {
            console.log("[Wallgarden Sync] SUBSCRIBE clicked");
            sendSyncEvent('SUBSCRIBE', scrapeVideoMetadata());
        } else if (hasPlaylist) {
            // Opens the "Save video to..." dialog — capture context; the
            // dialog checkbox observer sends the accurate WATCHLIST_ADD/
            // WATCHLIST_REMOVE/PLAYLIST_SAVE event once a playlist is toggled.
            const fromWatchPage = !!e.target.closest('ytd-watch-metadata');
            pendingSaveContext = getActionContext(fromWatchPage);
            console.log("[Wallgarden Sync] Save dialog opening for:", pendingSaveContext);
        }
    }, true); // capture phase — YouTube stopPropagation()s many button clicks,
              // so bubble-phase listeners on document never see them
}

// ============================================================
//  WALLGARDEN: On-page Save button + playlist picker (Phase 1/2)
// ============================================================

/** Lightweight transient toast on the YouTube page itself. */
function wgToast(message) {
    let container = document.getElementById('wg-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'wg-toast-container';
        container.style.cssText = `
            position: fixed; bottom: 24px; right: 24px; z-index: 999999;
            display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
        background: #0f1a12; color: #d7f5df; padding: 10px 16px;
        border: 1px solid #2e7d46; border-radius: 10px; font-size: 13px;
        font-family: "Roboto", Arial, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,0.4);
        opacity: 0; transform: translateY(8px); transition: opacity .2s ease, transform .2s ease;
    `;
    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 250);
    }, 2600);
}

/**
 * Fire a WALLGARDEN_SAVE sync event for the given context. `playlist` is
 * optional { id, name }; when omitted the dashboard files it into the
 * watchlist/queue. Optimistically marks the video saved locally so the
 * button reflects it immediately, even before the dashboard tab confirms.
 */
function sendSaveEvent(ctx, playlist) {
    if (!ctx || !ctx.videoId) {
        wgToast('🌿 Could not read this video');
        return;
    }
    const payload = { ...ctx };
    if (playlist) {
        payload.playlistId = playlist.id;
        payload.playlistName = playlist.name;
    }
    sendSyncEvent('WALLGARDEN_SAVE', payload);
    appState.savedVideoIds.add(ctx.videoId);
    refreshWatchButtonState();
    refreshFeedSaveBadges();
    wgToast(playlist
        ? `🌿 Saved to "${playlist.name}"`
        : '🌿 Saved to Wallgarden watchlist');
}

let wgSaveMenuEl = null;

function closeSaveMenu() {
    if (wgSaveMenuEl) {
        wgSaveMenuEl.remove();
        wgSaveMenuEl = null;
        document.removeEventListener('click', onSaveMenuOutsideClick, true);
    }
}

function onSaveMenuOutsideClick(e) {
    if (wgSaveMenuEl && !wgSaveMenuEl.contains(e.target) && !e.target.closest('.wg-save-wrap')) {
        closeSaveMenu();
    }
}

/** Build & show the destination picker anchored under the caret button. */
function openSaveMenu(anchorBtn) {
    closeSaveMenu();
    const ctx = getActionContext(true);
    const rect = anchorBtn.getBoundingClientRect();

    const menu = document.createElement('div');
    menu.className = 'wg-save-menu';
    menu.style.cssText = `
        position: fixed; z-index: 999999;
        top: ${Math.round(rect.bottom + 6)}px; left: ${Math.round(rect.right - 260)}px;
        width: 260px; max-height: 360px; overflow-y: auto;
        background: #212121; color: #f1f1f1; border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px; padding: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        font-family: "Roboto", Arial, sans-serif; font-size: 14px;
    `;

    const makeRow = (html, onClick, opts = {}) => {
        const row = document.createElement('div');
        row.setAttribute('role', 'menuitem');
        row.style.cssText = `
            display: flex; align-items: center; gap: 10px; padding: 9px 12px;
            border-radius: 8px; cursor: pointer; white-space: nowrap;
            ${opts.color ? `color: ${opts.color};` : ''}
        `;
        row.innerHTML = html;
        row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.1)');
        row.addEventListener('mouseleave', () => row.style.background = '');
        row.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick();
            closeSaveMenu();
        });
        return row;
    };

    // Quick save to watchlist
    menu.appendChild(makeRow(
        `<span style="font-size:16px;">⏳</span><span>Save to Watchlist</span>`,
        () => sendSaveEvent(ctx)
    ));

    // Real playlists mirrored from the dashboard
    if (appState.playlists.length) {
        const hdr = document.createElement('div');
        hdr.textContent = 'Playlists';
        hdr.style.cssText = 'padding: 8px 12px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; opacity: .6;';
        menu.appendChild(hdr);
        appState.playlists.forEach(pl => {
            menu.appendChild(makeRow(
                `<span style="font-size:16px;">🎵</span>
                 <span style="flex:1; overflow:hidden; text-overflow:ellipsis;">${escapeAttr(pl.name)}</span>
                 <span style="opacity:.5; font-size:12px;">${pl.count || 0}</span>`,
                () => sendSaveEvent(ctx, pl)
            ));
        });
    } else {
        const note = document.createElement('div');
        note.textContent = 'Open the dashboard to create playlists';
        note.style.cssText = 'padding: 8px 12px; font-size: 12px; opacity: .5;';
        menu.appendChild(note);
    }

    // Separator + open dashboard
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px; background:rgba(255,255,255,0.1); margin:6px 4px;';
    menu.appendChild(sep);
    menu.appendChild(makeRow(
        `<span style="font-size:16px;">🌿</span><span>Open Wallgarden dashboard ↗</span>`,
        () => window.open(WG_DASHBOARD_URL, '_blank'),
        { color: '#8bd5a0' }
    ));

    document.body.appendChild(menu);
    wgSaveMenuEl = menu;
    setTimeout(() => document.addEventListener('click', onSaveMenuOutsideClick, true), 0);
}

/** Basic attribute-safe escaping for interpolated dashboard strings. */
function escapeAttr(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Update the watch-page button's label/state to reflect saved status. */
function refreshWatchButtonState() {
    const wrap = document.querySelector('.wg-save-wrap');
    if (!wrap) return;
    const main = wrap.querySelector('.wg-save-main');
    if (!main) return;
    const videoId = getVideoIdFromUrl();
    const saved = videoId && appState.savedVideoIds.has(videoId);
    main.querySelector('.wg-save-label').textContent = saved ? 'Saved' : 'Save';
    main.style.background = saved ? 'rgba(46,125,70,0.35)' : 'rgba(255,255,255,0.1)';
    wrap.querySelector('.wg-save-icon').textContent = saved ? '✓' : '🌿';
}

/** Inject the split "Save to Wallgarden" pill next to the Subscribe button. */
function ensureWatchPageButton() {
    if (getVideoIdFromUrl() == null || !location.pathname.startsWith('/watch')) {
        // Not on a standard watch page — nothing to anchor to
        return;
    }
    if (document.querySelector('.wg-save-wrap')) {
        refreshWatchButtonState();
        return;
    }
    const owner = document.querySelector('ytd-watch-metadata #owner');
    if (!owner) return;
    const subscribe = owner.querySelector('#subscribe-button, ytd-subscribe-button-renderer');

    const wrap = document.createElement('div');
    wrap.className = 'wg-save-wrap';
    wrap.style.cssText = `
        display: inline-flex; align-items: stretch; margin-left: 8px;
        border-radius: 18px; overflow: hidden; vertical-align: middle;
        font-family: "Roboto", Arial, sans-serif;
    `;

    const main = document.createElement('button');
    main.className = 'wg-save-main';
    main.title = 'Save this video to Wallgarden watchlist';
    main.style.cssText = `
        display: inline-flex; align-items: center; gap: 8px;
        background: rgba(255,255,255,0.1); color: var(--yt-spec-text-primary, #f1f1f1);
        border: none; cursor: pointer; height: 36px; padding: 0 14px 0 14px;
        font-size: 14px; font-weight: 500; line-height: 36px;
    `;
    main.innerHTML = `<span class="wg-save-icon" style="font-size:15px;">🌿</span><span class="wg-save-label">Save</span>`;

    const caret = document.createElement('button');
    caret.className = 'wg-save-caret';
    caret.title = 'Choose a playlist / open dashboard';
    caret.style.cssText = `
        background: rgba(255,255,255,0.1); color: var(--yt-spec-text-primary, #f1f1f1);
        border: none; border-left: 1px solid rgba(0,0,0,0.25); cursor: pointer;
        height: 36px; padding: 0 10px; font-size: 11px;
    `;
    caret.textContent = '▾';

    [main, caret].forEach(b => {
        b.addEventListener('mouseenter', () => b.style.filter = 'brightness(1.25)');
        b.addEventListener('mouseleave', () => b.style.filter = '');
    });

    main.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendSaveEvent(getActionContext(true));
    });
    caret.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (wgSaveMenuEl) closeSaveMenu();
        else openSaveMenu(caret);
    });

    wrap.appendChild(main);
    wrap.appendChild(caret);

    if (subscribe && subscribe.parentElement) {
        subscribe.insertAdjacentElement('afterend', wrap);
    } else {
        owner.appendChild(wrap);
    }
    refreshWatchButtonState();
    console.log('[Wallgarden] Injected Save button on watch page');
}

/**
 * Watch-page metadata is torn down/rebuilt on navigation and mounts late.
 * A debounced observer re-inserts the button whenever it goes missing.
 */
function startWatchButtonWatcher() {
    let pending = null;
    const observer = new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => {
            pending = null;
            ensureWatchPageButton();
        }, 400);
    });
    const root = document.getElementById('page-manager') || document.body;
    observer.observe(root, { childList: true, subtree: true });
    ensureWatchPageButton();
}

// ── Feed card quick-save + "already saved" badges (Phase 3) ──

/** Small ＋ quick-save icon on feed/search/sidebar cards, shown on hover. */
function injectInlineSaveIcon(videoEl, meta) {
    if (videoEl.querySelector('.wg-inline-save')) return;
    if (!meta || !meta.videoId) return;

    const menuRenderer = videoEl.querySelector(
        'ytd-menu-renderer, #menu, button[aria-label="More actions"]'
    )?.closest('ytd-menu-renderer, #menu') || videoEl.querySelector('button[aria-label="More actions"]')?.parentElement;
    if (!menuRenderer) return;

    const btn = document.createElement('button');
    btn.className = 'wg-inline-save';
    btn.textContent = appState.savedVideoIds.has(meta.videoId) ? '🌿' : '＋';
    btn.title = 'Save to Wallgarden';
    btn.style.cssText = `
        background: none; border: none; cursor: pointer;
        font-size: 15px; padding: 4px 6px; margin-right: 2px;
        opacity: 0; transform: scale(0.7);
        transition: opacity 0.25s ease, transform 0.25s ease;
        border-radius: 50%; line-height: 1; pointer-events: none;
    `;

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendSaveEvent(meta);
        btn.textContent = '🌿';
    });

    videoEl.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.transform = 'scale(1)';
        btn.style.pointerEvents = 'auto';
    });
    videoEl.addEventListener('mouseleave', () => {
        btn.style.opacity = '0';
        btn.style.transform = 'scale(0.7)';
        btn.style.pointerEvents = 'none';
    });

    menuRenderer.style.display = 'flex';
    menuRenderer.style.alignItems = 'center';
    menuRenderer.insertBefore(btn, menuRenderer.firstChild);
}

/** Re-mark already-saved feed cards after appState changes. */
function refreshFeedSaveBadges() {
    document.querySelectorAll('.wg-inline-save').forEach(btn => {
        const card = btn.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model');
        if (!card) return;
        const meta = scrapeCardMetadata(card);
        if (meta && appState.savedVideoIds.has(meta.videoId)) {
            btn.textContent = '🌿';
        }
    });
}

// Start sync observers
startSyncObservers();

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
    enableSmartBlock: true
};

// Persistent blocklist data
let blocklist = {
    channels: [],       // Array of channel names (lowercase)
    keywords: {},       // { keyword: hitCount } — weighted by rejection frequency
    rejectionLog: []    // Array of { channel, title, timestamp }
};

// State tracker to avoid re-evaluating the same elements
const evaluatedVideos = new Set();

// Load settings + blocklist initially
chrome.storage.local.get(null, (data) => {
    // One-time migration: reset blockShorts to true if it was saved as false from v6 default change
    if (!data._v7_shorts_reset) {
        chrome.storage.local.set({ blockShorts: true, _v7_shorts_reset: true });
        data.blockShorts = true;
    }
    Object.assign(settings, data);
    if (data.blocklist) blocklist = data.blocklist;
    applyBlockingCSS();
    startObserver();
    startMenuInterceptor();
});

// Re-apply if settings change
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        for (let [key, { newValue }] of Object.entries(changes)) {
            if (key === 'blocklist') {
                blocklist = newValue;
            } else {
                settings[key] = newValue;
            }
        }
        applyBlockingCSS();
    }
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
                    } else if (text.includes('save to playlist') || text.includes('watch later') || text.includes('save to queue')) {
                        if (!item.dataset.wallgardenSyncHooked) {
                            item.dataset.wallgardenSyncHooked = 'true';
                            item.addEventListener('click', () => {
                                console.log("[Wallgarden Sync] PLAYLIST_SAVE clicked via menu item");
                                sendSyncEvent('PLAYLIST_SAVE');
                            });
                        }
                    }
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
    return urlParams.get('v');
}

function sendSyncEvent(action, data = {}) {
    const videoId = getVideoIdFromUrl();
    if (!videoId) {
        console.warn("[Wallgarden Sync] sendSyncEvent failed: videoId not found in URL");
        return;
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

        // Let's use ultra-robust DOM closest targeting instead of path scanning
        // Segmented button on modern Youtube: <segmented-like-dislike-button-view-model>
        // It contains two yt-smartimation, the first is Like, the second is Dislike.
        
        let hasLike = false;
        let hasDislike = false;

        const segmentedContainer = e.target.closest('ytd-watch-metadata segmented-like-dislike-button-view-model');
        if (segmentedContainer) {
            // If we clicked inside the segmented container, determine if it's the first button (like) or second (dislike)
            const buttons = Array.from(segmentedContainer.querySelectorAll('button, yt-button-view-model'));
            const clickedBtn = e.target.closest('button, yt-button-view-model');
            if (clickedBtn && buttons.length >= 2) {
                if (clickedBtn === buttons[0]) hasLike = true;
                if (clickedBtn === buttons[1]) hasDislike = true;
            }
        }

        // Fallbacks for standard DOM nodes
        if (!hasLike && !hasDislike) {
            const btn = e.target.closest('like-button-view-model, dislike-button-view-model');
            if (btn) {
                const tag = btn.tagName.toLowerCase();
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const title = (btn.getAttribute('title') || '').toLowerCase();
                
                if (tag === 'like-button-view-model' || 
                    aria.includes('like this video') || 
                    (title.includes('like') && !title.includes('dislike')) ||
                    btn.querySelector('yt-icon.ytd-thumb-up, path[d^="M3,11h3v10H3V11z M18.59,10"]')) {
                    hasLike = true;
                } else if (tag === 'dislike-button-view-model' || 
                           aria.includes('dislike this video') || 
                           title.includes('dislike') ||
                           btn.querySelector('yt-icon.ytd-thumb-down, path[d^="M15,3H6c-0.83,0-1.54,0.5-1.84,1.22l-3.02,7.05C1.05,11.5"]')) {
                    hasDislike = true;
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

        if (hasLike) {
            const btn = e.target.closest('button, yt-button-view-model');
            setTimeout(() => {
                const isSelected = btn && (
                    btn.getAttribute('aria-pressed') === 'true' || 
                    btn.classList.contains('yt-spec-button-shape-next--selected') ||
                    !!btn.querySelector('button[aria-pressed="true"]')
                );
                console.log("[Wallgarden Sync] LIKE clicked, final selected state:", !!isSelected);
                const metadata = scrapeVideoMetadata();
                sendSyncEvent(isSelected ? 'LIKE' : 'UNLIKE', metadata);
            }, 50);
        } else if (hasDislike) {
            const btn = e.target.closest('button, yt-button-view-model');
            setTimeout(() => {
                const isSelected = btn && (
                    btn.getAttribute('aria-pressed') === 'true' || 
                    btn.classList.contains('yt-spec-button-shape-next--selected') ||
                    !!btn.querySelector('button[aria-pressed="true"]')
                );
                console.log("[Wallgarden Sync] DISLIKE clicked, final selected state:", !!isSelected);
                const metadata = scrapeVideoMetadata();
                sendSyncEvent(isSelected ? 'DISLIKE' : 'UNDISLIKE', metadata);
            }, 50);
        } else if (hasSub) {
            console.log("[Wallgarden Sync] SUBSCRIBE clicked");
            sendSyncEvent('SUBSCRIBE');
        } else if (hasPlaylist) {
            console.log("[Wallgarden Sync] PLAYLIST_SAVE clicked");
            sendSyncEvent('PLAYLIST_SAVE');
        }
    }, false);
}

// Start sync observers
startSyncObservers();

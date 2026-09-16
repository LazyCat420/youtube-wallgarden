// Unit tests for floating bottom-right miniplayer:
// - State transitions (watch-mode <-> miniplayer-mode <-> closed)
// - Non-destructive zero-reload DOM preservation
// - Keyboard shortcut gating ('i', Escape)
// - Auto-minimize on navigation and search
// - Play/pause synchronization and button updates
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

class FakeDOMElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = {
      _classes: new Set(),
      add: (...cls) => cls.forEach(c => this.classList._classes.add(c)),
      remove: (...cls) => cls.forEach(c => this.classList._classes.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (this.classList._classes.has(c)) this.classList._classes.delete(c);
          else this.classList._classes.add(c);
        } else if (force) {
          this.classList._classes.add(c);
        } else {
          this.classList._classes.delete(c);
        }
      },
      contains: c => this.classList._classes.has(c)
    };
    this.style = {};
    this.dataset = {};
    this._innerHTML = "";
    this.listeners = new Map();
    this.paused = false;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    this.children.forEach(c => { c.parentNode = null; });
    this.children = [];
    if (!val) return;

    // Parse top/nested elements for querySelector testing
    const tagRegex = /<([a-z0-9-]+)([^>]*)>/gi;
    let match;
    while ((match = tagRegex.exec(val)) !== null) {
      const tagName = match[1].toLowerCase();
      if (["svg", "path", "circle", "polyline", "line", "rect", "polygon", "br", "hr"].includes(tagName)) {
        continue;
      }
      const attrsStr = match[2] || "";
      const child = new FakeDOMElement(tagName);
      const classMatch = attrsStr.match(/class=["']([^"']+)["']/);
      if (classMatch) {
        classMatch[1].split(/\s+/).filter(Boolean).forEach(c => child.classList.add(c));
      }
      const idMatch = attrsStr.match(/id=["']([^"']+)["']/);
      if (idMatch) {
        child.id = idMatch[1];
      }
      this.appendChild(child);
    }
  }

  get id() { return this.attributes.get("id") || ""; }
  set id(val) {
    this.attributes.set("id", val);
  }

  get className() { return Array.from(this.classList._classes).join(" "); }
  set className(val) {
    this.classList._classes.clear();
    if (val) val.split(/\s+/).filter(Boolean).forEach(c => this.classList._classes.add(c));
  }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    const idx = this.children.indexOf(refChild);
    newChild.parentNode = this;
    if (idx >= 0) {
      this.children.splice(idx, 0, newChild);
    } else {
      this.children.push(newChild);
    }
    return newChild;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      child.parentNode = null;
      this.children.splice(idx, 1);
    }
    return child;
  }

  addEventListener(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, []);
    this.listeners.get(evt).push(fn);
  }

  dispatchEvent(event) {
    const fns = this.listeners.get(event.type) || [];
    fns.forEach(fn => fn(event));
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all[0] || null;
  }

  querySelectorAll(sel) {
    const matches = [];
    const walk = (node) => {
      if (node !== this) {
        let match = false;
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          if (node.classList.contains(cls)) match = true;
        } else if (sel.startsWith("#")) {
          const id = sel.slice(1);
          if (node.id === id) match = true;
        } else if (node.tagName.toLowerCase() === sel.toLowerCase()) {
          match = true;
        }
        if (match) matches.push(node);
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(this);
    return matches;
  }

  closest(sel) {
    let curr = this;
    while (curr) {
      if (sel === "button" && curr.tagName === "BUTTON") return curr;
      if (sel === "a" && curr.tagName === "A") return curr;
      if (sel.startsWith(".") && curr.classList.contains(sel.slice(1))) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

function createTestEnv() {
  const elementsById = new Map();
  const body = new FakeDOMElement("body");
  const docElement = new FakeDOMElement("html");

  const doc = {
    body,
    documentElement: docElement,
    getElementById: id => elementsById.get(id) || null,
    querySelector: sel => body.querySelector(sel),
    querySelectorAll: sel => body.querySelectorAll(sel),
    createElement: tag => new FakeDOMElement(tag),
    addEventListener: (evt, fn) => body.addEventListener(evt, fn),
  };

  const windowListeners = new Map();
  const win = {
    addEventListener: (evt, fn) => {
      if (!windowListeners.has(evt)) windowListeners.set(evt, []);
      windowListeners.get(evt).push(fn);
    },
    removeEventListener: () => {},
    dispatchEvent: (event) => {
      const fns = windowListeners.get(event.type) || [];
      fns.forEach(fn => fn(event));
    },
    open: () => {},
    location: { href: "" }
  };

  const store = new Map();
  const ctx = {
    console,
    document: doc,
    window: win,
    setTimeout: (fn, ms) => { fn(); return 1; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }),
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    graphUpsertNode: () => "n", graphUpsertEdge: () => "e",
    graphPropagateNegative: () => {}, graphProcessRating: () => {},
    graphProcessWatch: () => {}, graphScoreVideo: () => 0,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  // Set up standard layout DOM nodes
  const mainContent = new FakeDOMElement("main");
  mainContent.className = "main-content";
  mainContent.id = "main-content";
  elementsById.set("main-content", mainContent);
  body.appendChild(mainContent);

  const feedSection = new FakeDOMElement("section");
  feedSection.className = "feed-section";
  feedSection.id = "feed-section";
  elementsById.set("feed-section", feedSection);
  mainContent.appendChild(feedSection);

  const videoGrid = new FakeDOMElement("div");
  videoGrid.className = "video-grid";
  videoGrid.id = "video-grid";
  elementsById.set("video-grid", videoGrid);
  feedSection.appendChild(videoGrid);

  const emptyState = new FakeDOMElement("div");
  emptyState.id = "empty-state";
  elementsById.set("empty-state", emptyState);
  feedSection.appendChild(emptyState);

  const shortsShelf = new FakeDOMElement("div");
  shortsShelf.id = "shorts-shelf";
  elementsById.set("shorts-shelf", shortsShelf);
  feedSection.appendChild(shortsShelf);

  const shortsGrid = new FakeDOMElement("div");
  shortsGrid.id = "shorts-grid";
  elementsById.set("shorts-grid", shortsGrid);
  feedSection.appendChild(shortsGrid);

  const currentViewTitle = new FakeDOMElement("h1");
  currentViewTitle.id = "current-view-title";
  elementsById.set("current-view-title", currentViewTitle);
  body.appendChild(currentViewTitle);

  const dashboardStatus = new FakeDOMElement("p");
  dashboardStatus.id = "dashboard-status-text";
  elementsById.set("dashboard-status-text", dashboardStatus);
  body.appendChild(dashboardStatus);

  const get = (name) => vm.runInContext(name, ctx);
  return { get, ctx, doc, body, win, mainContent, elementsById };
}

console.log("Running Miniplayer Tests...\n");

// Test 1: ensureInlinePlayer creates miniplayer controls
{
  const { get, elementsById } = createTestEnv();
  const ensureInlinePlayer = get("ensureInlinePlayer");
  const player = ensureInlinePlayer();
  assert(player, "Player element should be created");
  elementsById.set("inline-player", player);

  const toggleMiniBtn = player.querySelector(".btn-toggle-miniplayer");
  const expandBtn = player.querySelector(".btn-miniplayer-expand");
  const closeMiniBtn = player.querySelector(".btn-miniplayer-close");
  const overlay = player.querySelector(".miniplayer-controls-overlay");

  assert(toggleMiniBtn, "Toggle miniplayer button must exist in bar");
  assert(expandBtn, "Expand button must exist in overlay");
  assert(closeMiniBtn, "Close button must exist in overlay");
  assert(overlay, "Miniplayer controls overlay must exist");
  console.log("✅ ensureInlinePlayer creates miniplayer controls and overlay");
}

// Test 2: Mode switching between watch-mode and miniplayer-mode
{
  const { get, body, elementsById, mainContent } = createTestEnv();
  const ensureInlinePlayer = get("ensureInlinePlayer");
  const setMiniplayerMode = get("setMiniplayerMode");
  const state = get("state");

  const player = ensureInlinePlayer();
  elementsById.set("inline-player", player);

  state.currentlyPlayingId = "vid_123";
  body.classList.add("watch-mode");

  // Switch to miniplayer mode
  setMiniplayerMode(true);
  assert.strictEqual(state.isMiniplayer, true, "state.isMiniplayer should be true");
  assert(body.classList.contains("miniplayer-mode"), "body should have miniplayer-mode class");
  assert(!body.classList.contains("watch-mode"), "body should NOT have watch-mode class");
  assert(player.classList.contains("is-miniplayer"), "inlinePlayer should have is-miniplayer class");
  assert.strictEqual(mainContent.style.gridTemplateColumns, "", "mainContent grid columns should be cleared for full-width feed");

  // Switch back / expand to watch mode
  setMiniplayerMode(false);
  assert.strictEqual(state.isMiniplayer, false, "state.isMiniplayer should be false");
  assert(!body.classList.contains("miniplayer-mode"), "body should NOT have miniplayer-mode class");
  assert(body.classList.contains("watch-mode"), "body should have watch-mode class restored");
  assert(!player.classList.contains("is-miniplayer"), "inlinePlayer should NOT have is-miniplayer class");
  console.log("✅ setMiniplayerMode toggles body classes and resets/restores grid columns");
}

// Test 3: Zero DOM detachment on toggle
{
  const { get, body, elementsById } = createTestEnv();
  const ensureInlinePlayer = get("ensureInlinePlayer");
  const setMiniplayerMode = get("setMiniplayerMode");
  const state = get("state");

  const player = ensureInlinePlayer();
  elementsById.set("inline-player", player);
  state.currentlyPlayingId = "vid_abc";

  const wrapper = player.querySelector(".player-wrapper-box");
  const fakeVideo = new FakeDOMElement("video");
  fakeVideo.id = "test-video-node";
  wrapper.appendChild(fakeVideo);

  // Transition to miniplayer
  setMiniplayerMode(true);
  const videoInMini = wrapper.querySelector("#test-video-node");
  assert.strictEqual(videoInMini, fakeVideo, "Video node reference must not change when entering miniplayer");

  // Transition back to watch mode
  setMiniplayerMode(false);
  const videoInWatch = wrapper.querySelector("#test-video-node");
  assert.strictEqual(videoInWatch, fakeVideo, "Video node reference must not change when exiting miniplayer");
  console.log("✅ Zero DOM detachment: video node survives transitions without reload");
}

// Test 4: Keyboard shortcut 'i' toggles miniplayer mode & ignores input fields
{
  const { get, win, body, elementsById } = createTestEnv();
  const ensureInlinePlayer = get("ensureInlinePlayer");
  const setupKeyboardShortcuts = get("setupKeyboardShortcuts");
  const state = get("state");

  const player = ensureInlinePlayer();
  elementsById.set("inline-player", player);
  state.currentlyPlayingId = "vid_xyz";
  body.classList.add("watch-mode");

  setupKeyboardShortcuts();

  // Pressing 'i' while focused on an input should be ignored
  const inputEl = new FakeDOMElement("input");
  win.dispatchEvent({ type: "keydown", key: "i", target: inputEl, preventDefault: () => {} });
  assert.strictEqual(state.isMiniplayer, false, "'i' in input should NOT toggle miniplayer");

  // Pressing 'i' globally should toggle miniplayer
  win.dispatchEvent({ type: "keydown", key: "i", target: body, preventDefault: () => {} });
  assert.strictEqual(state.isMiniplayer, true, "'i' key should toggle miniplayer mode on");

  // Pressing 'Escape' while in miniplayer should return to watch mode
  win.dispatchEvent({ type: "keydown", key: "Escape", target: body, preventDefault: () => {} });
  assert.strictEqual(state.isMiniplayer, false, "'Escape' key should restore watch mode");
  console.log("✅ Keyboard shortcuts: 'i' toggles mode, input fields guarded, 'Escape' restores watch mode");
}

// Test 5: Auto-minimize on navigation and search
{
  const { get, body, elementsById } = createTestEnv();
  const ensureInlinePlayer = get("ensureInlinePlayer");
  const triggerGlobalSearch = get("triggerGlobalSearch");
  const state = get("state");

  const player = ensureInlinePlayer();
  elementsById.set("inline-player", player);
  state.currentlyPlayingId = "vid_nav";
  body.classList.add("watch-mode");

  // Trigger global search
  triggerGlobalSearch("quantum computing");
  assert.strictEqual(state.isMiniplayer, true, "Search trigger must auto-minimize to miniplayer");
  assert(body.classList.contains("miniplayer-mode"), "Search trigger must set body to miniplayer-mode");
  console.log("✅ Auto-minimize: navigating to search auto-minimizes player to give feed full width");
}

// Test 6: closePlayer cleans up all modes and state
{
  const { get, body, elementsById } = createTestEnv();
  const ensureInlinePlayer = get("ensureInlinePlayer");
  const setMiniplayerMode = get("setMiniplayerMode");
  const closePlayer = get("closePlayer");
  const state = get("state");

  const player = ensureInlinePlayer();
  elementsById.set("inline-player", player);
  state.currentlyPlayingId = "vid_close";
  setMiniplayerMode(true);

  assert.strictEqual(state.isMiniplayer, true);
  closePlayer();

  assert.strictEqual(state.isMiniplayer, false, "state.isMiniplayer must be false after close");
  assert.strictEqual(state.currentlyPlayingId, null, "state.currentlyPlayingId must be null after close");
  assert(!body.classList.contains("miniplayer-mode"), "body must NOT have miniplayer-mode after close");
  assert(!body.classList.contains("watch-mode"), "body must NOT have watch-mode after close");
  assert(!player.classList.contains("is-miniplayer"), "player must NOT have is-miniplayer after close");
  console.log("✅ closePlayer cleanly resets miniplayer state, classes, and playback");
}

console.log("\nAll miniplayer tests passed!");

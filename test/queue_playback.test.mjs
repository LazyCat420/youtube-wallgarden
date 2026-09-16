// Unit tests for Play Queue & Play Next behavior:
// - addToQueue appends to queue without hijacking active playback
// - addToQueue(video, true) ("Play Next") inserts at index 0 without interrupting current video
// - Playback does not abort when queuing from Miniplayer mode or Watch mode
// - playNextFromQueue advances queue sequentially on video end
// - Video card dropdown menu exposes Play Next, Add to Queue, and Add to Playlist
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
  }

  get className() { return [...this.classList._classes].join(" "); }
  set className(val) {
    this.classList._classes.clear();
    (val || "").split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    this.children.forEach(c => { c.parentNode = null; });
    this.children = [];
    if (!val) return;

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
        classMatch[1].split(/\s+/).filter(Boolean).forEach(cls => child.classList.add(cls));
      }
      const idMatch = attrsStr.match(/id=["']([^"']+)["']/);
      if (idMatch) {
        child.id = idMatch[1];
      }
      const dataActionMatch = attrsStr.match(/data-action=["']([^"']+)["']/);
      if (dataActionMatch) {
        child.dataset.action = dataActionMatch[1];
      }
      this.appendChild(child);
    }
  }

  getBoundingClientRect() {
    return { top: 100, left: 100, bottom: 120, right: 120, width: 20, height: 20 };
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (!this.listeners.has(type)) return;
    const arr = this.listeners.get(type);
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  dispatchEvent(event) {
    const arr = this.listeners.get(event.type) || [];
    for (const listener of arr) {
      listener.call(this, event);
    }
    return true;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const check = (node) => {
      let matches = false;
      if (selector.startsWith("#") && node.id === selector.slice(1)) matches = true;
      else if (selector.startsWith(".") && node.classList.contains(selector.slice(1))) matches = true;
      else if (selector.startsWith("[data-action=\"") && selector.endsWith("\"]")) {
        const val = selector.slice(14, -2);
        if (node.dataset && node.dataset.action === val) matches = true;
      } else if (node.tagName.toLowerCase() === selector.toLowerCase()) matches = true;

      if (matches) results.push(node);
      for (const child of node.children) {
        check(child);
      }
    };
    for (const child of this.children) {
      check(child);
    }
    return results;
  }
}

function bootHarness() {
  const store = new Map();
  const elementsById = new Map();

  const docBody = new FakeDOMElement("body");
  const docEl = new FakeDOMElement("html");
  docEl.appendChild(docBody);

  const document = {
    body: docBody,
    documentElement: docEl,
    createElement: (tag) => new FakeDOMElement(tag),
    getElementById: (id) => elementsById.get(id) || null,
    querySelector: (sel) => docEl.querySelector(sel),
    querySelectorAll: (sel) => docEl.querySelectorAll(sel),
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const registerEl = (id, el) => {
    el.id = id;
    elementsById.set(id, el);
    docBody.appendChild(el);
    return el;
  };

  registerEl("inline-player", new FakeDOMElement("div"));
  registerEl("main-content", new FakeDOMElement("div"));
  registerEl("suggestions-grid", new FakeDOMElement("div"));
  registerEl("playlist-modal", new FakeDOMElement("div"));
  registerEl("playlist-modal-list", new FakeDOMElement("div"));
  registerEl("input-new-playlist", new FakeDOMElement("input"));
  registerEl("btn-submit-new-playlist", new FakeDOMElement("button"));
  registerEl("btn-close-playlist-modal", new FakeDOMElement("button"));

  const ctx = {
    console,
    document,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
      location: { href: "" }
    },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    graphUpsertNode: () => "n",
    graphUpsertEdge: () => "e",
    graphPropagateNegative: () => {},
    graphProcessRating: () => {},
    graphProcessWatch: () => {},
    graphScoreVideo: () => 0
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  const get = (name) => vm.runInContext(name, ctx);
  const state = get("state");
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    queue: [],
    currentlyPlayingId: null,
    isMiniplayer: false,
    playlists: {},
    likedVideos: [],
    videoRatings: {},
    settings: {},
    currentView: "smart-feed"
  });

  return { get, state, document };
}

console.log("Running Queue & Play Next Tests...\n");

// Test 1: Adding to queue during active playback does NOT autoplay or interrupt
{
  const { get, state, document } = bootHarness();
  const addToQueue = get("addToQueue");
  
  // Set playing state in watch mode
  document.body.classList.add("watch-mode");
  state.currentlyPlayingId = "vid_playing_1";

  const videoA = { id: "vid_queue_a", title: "Song A", channelName: "Artist 1" };
  addToQueue(videoA, false);

  assert.strictEqual(state.currentlyPlayingId, "vid_playing_1", "Active playing video should not change");
  assert.strictEqual(state.queue.length, 1, "Queue should have 1 item");
  assert.strictEqual(state.queue[0].id, "vid_queue_a", "videoA should be at index 0");
  console.log("✅ addToQueue in watch-mode preserves playback and appends to queue");
}

// Test 2: Play Next in miniplayer mode inserts at index 0 without interrupting
{
  const { get, state, document } = bootHarness();
  const addToQueue = get("addToQueue");

  // Miniplayer active: body has miniplayer-mode, NOT watch-mode
  document.body.classList.remove("watch-mode");
  document.body.classList.add("miniplayer-mode");
  state.currentlyPlayingId = "vid_mini_active";
  state.isMiniplayer = true;
  state.queue = [{ id: "vid_later", title: "Later Track" }];

  const videoNext = { id: "vid_next", title: "Up Next Track", channelName: "Artist Next" };
  addToQueue(videoNext, true); // playNext = true

  assert.strictEqual(state.currentlyPlayingId, "vid_mini_active", "Miniplayer playback should continue uninterrupted");
  assert.strictEqual(state.queue.length, 2, "Queue should now have 2 items");
  assert.strictEqual(state.queue[0].id, "vid_next", "Play Next video must be at index 0");
  assert.strictEqual(state.queue[1].id, "vid_later", "Existing queued video must be at index 1");
  console.log("✅ Play Next in miniplayer-mode inserts at head of queue without interrupting");
}

// Test 3: playNextFromQueue advances the queue sequentially
{
  const { get, state } = bootHarness();
  const playNextFromQueue = get("playNextFromQueue");

  state.queue = [
    { id: "vid_1", title: "Track 1" },
    { id: "vid_2", title: "Track 2" }
  ];
  state.currentlyPlayingId = "vid_current";

  playNextFromQueue();

  assert.strictEqual(state.currentlyPlayingId, "vid_1", "First queued track should start playing");
  assert.strictEqual(state.queue.length, 1, "Queue should have 1 item remaining");
  assert.strictEqual(state.queue[0].id, "vid_2", "Second track should now be at head of queue");
  console.log("✅ playNextFromQueue plays and shifts items in FIFO order");
}

// Test 4: When nothing is playing, addToQueue enqueues without hijacking or forcing full watch mode
{
  const { get, state, document } = bootHarness();
  const addToQueue = get("addToQueue");

  state.currentlyPlayingId = null;
  state.queue = [];
  document.body.classList.remove("watch-mode");
  document.body.classList.remove("miniplayer-mode");

  const video = { id: "vid_idle", title: "Idle Track", channelName: "Artist Idle" };
  addToQueue(video, false);

  assert.strictEqual(state.queue.length, 1, "Item should be enqueued in state.queue");
  assert.strictEqual(state.queue[0].id, "vid_idle");
  console.log("✅ addToQueue when idle enqueues properly");
}

// Test 5: Card dropdown menu contains Play Next, Add to Queue, and Add to Playlist
{
  const { get } = bootHarness();
  const createVideoCard = get("createVideoCard");

  const v = { id: "vid_card", title: "Test Card Video", channelName: "Artist A" };
  const card = createVideoCard(v);
  const actionBtn = card.querySelector(".card-action-btn");
  assert.ok(actionBtn, "Action button exists on video card");

  // Click action button to generate dropdown
  actionBtn.dispatchEvent({ type: "click", stopPropagation() {} });
  const dropdown = card.querySelector(".card-action-dropdown") || get("document").body.querySelector(".card-action-dropdown");
  assert.ok(dropdown, "Dropdown is created");
  assert.ok(dropdown.querySelector('[data-action="play-next"]'), "Play Next button exists in dropdown");
  assert.ok(dropdown.querySelector('[data-action="add-to-queue"]'), "Add to Queue button exists in dropdown");
  assert.ok(dropdown.querySelector('[data-action="add-to-playlist"]'), "Add to Playlist button exists in dropdown");
  console.log("✅ Card dropdown menu contains Play Next, Add to Queue, and Add to Playlist");
}

console.log("\nAll Queue & Play Next tests passed!");

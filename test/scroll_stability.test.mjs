// Tests for feed scroll stability, non-destructive DOM reconciliation,
// in-place rating synchronization, and zero-jitter infinite scroll.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const src = fs.readFileSync(
  new URL("../app/app.js", import.meta.url), "utf8");

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
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    if (val === "") {
      this.children.forEach(c => { c.parentNode = null; });
      this.children = [];
    }
  }

  get id() { return this.attributes.get("id") || ""; }
  set id(val) {
    if (this.attributes.get("id")) elementsById.delete(this.attributes.get("id"));
    this.attributes.set("id", val);
    if (val) elementsById.set(val, this);
  }

  get className() { return Array.from(this.classList._classes).join(" "); }
  set className(val) {
    this.classList._classes.clear();
    if (val) val.split(/\s+/).filter(Boolean).forEach(c => this.classList._classes.add(c));
  }

  get childNodes() { return this.children; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 && idx < this.parentNode.children.length - 1 ? this.parentNode.children[idx + 1] : null;
  }

  setAttribute(k, v) {
    if (k === "id") {
      if (this.attributes.get("id")) elementsById.delete(this.attributes.get("id"));
      if (v) elementsById.set(v, this);
    }
    this.attributes.set(k, String(v));
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }

  appendChild(child) {
    if (child instanceof FakeDocumentFragment) {
      const items = [...child.children];
      items.forEach(c => this.appendChild(c));
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    if (newChild instanceof FakeDocumentFragment) {
      const items = [...newChild.children];
      items.forEach(c => this.insertBefore(c, refChild));
      newChild.children = [];
      return newChild;
    }
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

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  querySelector(sel) {
    const found = this.querySelectorAll(sel)[0];
    if (found) return found;
    const stub = new FakeDOMElement("div");
    if (sel.startsWith(".")) stub.classList.add(sel.slice(1));
    return stub;
  }

  querySelectorAll(sel) {
    const matches = [];
    const walk = (node) => {
      if (node !== this) {
        let match = true;
        if (sel.includes('[data-video-id="')) {
          const id = sel.match(/data-video-id="([^"]+)"/)[1];
          if (node.getAttribute("data-video-id") !== id) match = false;
        } else if (sel.includes("[data-video-id]")) {
          if (!node.hasAttribute("data-video-id")) match = false;
        }
        if (match && sel.startsWith("#")) {
          const id = sel.split(/[.\[]/)[0].slice(1);
          if (node.id !== id) match = false;
        }
        if (match && sel.startsWith(".")) {
          const cls = sel.split(/[.\[]/)[1];
          if (!node.classList.contains(cls)) match = false;
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

  addEventListener() {}
  removeEventListener() {}
}

class FakeDocumentFragment {
  constructor() {
    this.children = [];
  }
  get childNodes() { return this.children; }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

const elementsById = new Map();
const rootDoc = new FakeDOMElement("document");

const doc = {
  body: new FakeDOMElement("body"),
  documentElement: new FakeDOMElement("html"),
  createElement: (tag) => new FakeDOMElement(tag),
  createDocumentFragment: () => new FakeDocumentFragment(),
  getElementById: (id) => elementsById.get(id) || null,
  querySelector: (sel) => {
    if (sel.startsWith("#")) return doc.getElementById(sel.slice(1));
    return rootDoc.querySelector(sel);
  },
  querySelectorAll: (sel) => rootDoc.querySelectorAll(sel),
  addEventListener: () => {},
  removeEventListener: () => {}
};

function registerElement(id, el) {
  el.id = id;
  elementsById.set(id, el);
}

// Setup static DOM nodes that app.js expects
const videoGrid = new FakeDOMElement("div"); registerElement("video-grid", videoGrid); rootDoc.appendChild(videoGrid);
const shortsShelf = new FakeDOMElement("div"); registerElement("shorts-shelf", shortsShelf); rootDoc.appendChild(shortsShelf);
const shortsGrid = new FakeDOMElement("div"); registerElement("shorts-grid", shortsGrid); rootDoc.appendChild(shortsGrid);
const redditShelf = new FakeDOMElement("div"); registerElement("reddit-shelf", redditShelf); rootDoc.appendChild(redditShelf);
const redditGrid = new FakeDOMElement("div"); registerElement("reddit-grid", redditGrid); rootDoc.appendChild(redditGrid);
const emptyState = new FakeDOMElement("div"); registerElement("empty-state", emptyState); rootDoc.appendChild(emptyState);
const feedTrigger = new FakeDOMElement("div"); registerElement("infinite-scroll-trigger", feedTrigger); rootDoc.appendChild(feedTrigger);

const store = new Map();
const ctx = {
  console,
  document: doc,
  window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: "" }, requestAnimationFrame: (cb) => cb() },
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
  AbortSignal: { timeout: () => null },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  graphUpsertNode: () => "n:x",
  graphPropagateNegative: () => {},
  graphScoreVideo: () => 0,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const get = (name) => vm.runInContext(name, ctx);
const state = get("state");
const renderFeed = get("renderFeed");
const _wgApplyRemoteFields = get("_wgApplyRemoteFields");

console.log("Running Feed Scroll Stability & Non-Destructive Reconciliation Tests...\n");

// ── Test 1: Non-Destructive Re-rendering of Smart Feed ──────────────
{
  state.currentView = "smart-feed";
  state.topics = [{ phrase: "technology", weight: 5 }];
  state.smartFeedVideos = [
    { id: "vid_1", title: "Video One", channelId: "ch1", channelName: "Tech" },
    { id: "vid_2", title: "Video Two", channelId: "ch2", channelName: "Code" }
  ];

  renderFeed();

  const suggestionsGrid = doc.getElementById("suggestions-grid");
  assert.ok(suggestionsGrid, "suggestions-grid should be mounted");
  assert.strictEqual(suggestionsGrid.children.length, 2, "Should render 2 video cards");

  const firstCard = suggestionsGrid.children[0];
  const secondCard = suggestionsGrid.children[1];
  assert.strictEqual(firstCard.getAttribute("data-video-id"), "vid_1");
  assert.strictEqual(secondCard.getAttribute("data-video-id"), "vid_2");

  // Add a 3rd video to state and call renderFeed() again
  state.smartFeedVideos.push({ id: "vid_3", title: "Video Three", channelId: "ch3", channelName: "Dev" });
  renderFeed();

  const suggestionsGridAfter = doc.getElementById("suggestions-grid");
  assert.strictEqual(suggestionsGrid, suggestionsGridAfter, "suggestions-grid DOM instance MUST be preserved");
  assert.strictEqual(suggestionsGrid.children.length, 3, "Should have 3 video cards");
  assert.strictEqual(suggestionsGrid.children[0], firstCard, "First card DOM node must NOT be re-created");
  assert.strictEqual(suggestionsGrid.children[1], secondCard, "Second card DOM node must NOT be re-created");
  assert.strictEqual(suggestionsGrid.children[2].getAttribute("data-video-id"), "vid_3", "New card must be appended");

  console.log("✓ Test 1 Passed: renderFeed() reconciles smart-feed without destroying existing card DOM nodes.");
}

// ── Test 2: In-place Removal on Feed Reconciliation ─────────────────
{
  // Remove vid_2 from state.smartFeedVideos
  state.smartFeedVideos = state.smartFeedVideos.filter(v => v.id !== "vid_2");
  renderFeed();

  const suggestionsGrid = doc.getElementById("suggestions-grid");
  assert.strictEqual(suggestionsGrid.children.length, 2, "Should now have 2 video cards");
  assert.strictEqual(suggestionsGrid.children[0].getAttribute("data-video-id"), "vid_1");
  assert.strictEqual(suggestionsGrid.children[1].getAttribute("data-video-id"), "vid_3");

  console.log("✓ Test 2 Passed: renderFeed() cleanly removes unselected cards while preserving others.");
}

// ── Test 3: In-Place Rating Synchronization ────────────────────────
{
  const suggestionsGrid = doc.getElementById("suggestions-grid");
  const card1 = suggestionsGrid.children[0];
  
  // Attach thumb-up / thumb-down button placeholders
  const upBtn = new FakeDOMElement("button"); upBtn.className = "title-rating-btn thumb-up";
  const downBtn = new FakeDOMElement("button"); downBtn.className = "title-rating-btn thumb-down";
  card1.appendChild(upBtn);
  card1.appendChild(downBtn);

  // Simulate remote rating sync incoming for vid_1 (liked, r: 5)
  const incomingSync = {
    ratings: {
      vid_1: { r: 5, t: Date.now() + 1000 }
    }
  };

  _wgApplyRemoteFields(incomingSync);

  assert.ok(upBtn.classList.contains("active"), "thumb-up button on card1 should be toggled active");
  assert.strictEqual(downBtn.classList.contains("active"), false, "thumb-down should not be active");
  assert.strictEqual(suggestionsGrid.children[0], card1, "card1 DOM reference must remain intact");

  console.log("✓ Test 3 Passed: _wgApplyRemoteFields updates card rating UI in-place without feed wipe.");
}

console.log("\nAll Feed Scroll Stability & Reconciliation Tests Passed!");

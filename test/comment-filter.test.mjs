// Exercise the comment filter's classifier straight out of the real, unmodified
// content.js. The point of this file is FALSE POSITIVES: the `keep` corpus below
// is the contract. A rule that starts eating real comments fails here loudly,
// which is much cheaper than noticing it in audit mode three weeks later.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const src = fs.readFileSync(
  new URL("../extension/scripts/content.js", import.meta.url), "utf8");

// content.js is a plain script: every function is a global, so evaluate it in a
// VM with the browser stubbed and reach in for the classifier.
const stubEl = new Proxy({}, {
  get: (t, k) => k === "classList" ? { add(){}, remove(){}, toggle(){} }
    : k === "dataset" ? {}
    : k === "style" ? { cssText: "" }
    : k === "children" ? []
    : k === "innerHTML" ? ""
    : k === "textContent" ? ""
    : typeof k === "string" ? () => {}
    : undefined,
  set: () => true,
});
const doc = {
  addEventListener: () => {}, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => stubEl, body: stubEl, documentElement: stubEl,
  head: stubEl,
};

const ctx = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  document: doc,
  window: { addEventListener: () => {}, location: { href: "" } },
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  MutationObserver: class { observe(){} disconnect(){} },
  IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
  chrome: {
    // Never fire the callback: we want the top-level declarations evaluated,
    // not the boot path, which would need the whole watch-page DOM. (If you do
    // ever fire it, it MUST be async — a synchronous stub runs boot before the
    // `const` declarations initialize and throws a bogus TDZ error.)
    storage: { local: { get: () => {}, set: () => {} }, onChanged: { addListener: () => {} } },
    runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } },
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const { classifyComment } = ctx;
assert.strictEqual(typeof classifyComment, "function", "classifyComment not exported to global scope");

/** Build a scraped-comment shape with sane defaults (no traction, no badges). */
function c(text, over = {}) {
  const info = {
    text, author: "someone", likes: 0, replies: 0,
    pinned: false, hearted: false, byOwner: false, id: "", ...over,
  };
  info.key = ctx.commentKey(info);
  return info;
}

// ── Comments that MUST survive ───────────────────────────────────────────────
// Every entry here is a comment a person would be annoyed to lose. Critical and
// negative comments are heavily represented on purpose: the filter is for
// substance, not sentiment.
const keep = [
  ["substantive praise", c("The bit at 12:30 about cache invalidation finally made the tradeoff click for me.")],
  ["reasoned criticism", c("This is wrong about the GDP figure because it uses nominal rather than real terms.")],
  ["blunt but specific", c("Honestly this video is trash, the benchmark ran on a thermally throttled laptop.")],
  ["short but useful", c("Fix: run npm ci first, not npm install.")],
  ["correction", c("Small correction, the treaty was 1919 not 1918.")],
  ["negative with a reason", c("Boring for the first ten minutes but the second half is worth it")],
  ["question", c("Does this approach still work if the input is unsorted?")],
  ["disagreement, no hedge words", c("I disagree; the second benchmark contradicts the first one entirely")],
  ["one-liner that earned likes", c("Nailed it.", { likes: 4200 })],
  ["short but someone replied", c("wrong", { replies: 3 })],
  ["pinned by creator", c("🔥🔥🔥", { pinned: true })],
  ["hearted by creator", c("first!", { hearted: true })],
  ["channel owner's own comment", c("thanks all", { byOwner: true })],
  ["timestamp list is NOT filtered", c("0:00 intro 2:14 setup 8:40 results 15:02 outro")],
  ["emoji plus real content", c("😂 the part where the compiler gives up is too real, exactly what happened to me")],
];

// ── Comments that SHOULD go ──────────────────────────────────────────────────
const drop = [
  ["emoji only", c("🔥🔥🔥"), "emojiOnly"],
  ["single emoji", c("😂"), "emojiOnly"],
  ["telegram scam", c("Message me on telegram @cryptoking for signals"), "scam"],
  ["whatsapp bait", c("Contact him via WhatsApp +1 555 0100 he changed my life"), "scam"],
  ["recovery scam", c("Reach out to a recovery expert, he helped me get my funds back"), "scam"],
  ["earnings bait", c("I earned $14,000 in one week trading with her guidance"), "scam"],
  ["self promo", c("check out my channel for more of this content"), "selfPromo"],
  ["sub4sub", c("subbed, sub back everyone"), "selfPromo"],
  ["who's watching", c("who's still watching this in 2026"), "engagementBait"],
  ["percent bait", c("only 1% of people will see this comment"), "engagementBait"],
  ["first", c("first!"), "engagementBait"],
  ["low effort", c("lol"), "lowEffort"],
  ["low effort 2", c("W video"), "lowEffort"],
  ["character mash", c("aaaaaaaaaaaaaaaa"), "characterMash"],
  ["emoji spam", c("great 😂😂😂😂😂😂😂😂"), "characterMash"],
  ["empty complaint", c("absolute garbage"), "emptyComplaint"],
  ["empty complaint 2", c("mid video, worst channel"), "emptyComplaint"],
];

let failures = 0;
for (const [name, info] of keep) {
  const v = classifyComment(info);
  if (v.filtered) {
    console.error(`  ✗ FALSE POSITIVE [${name}] caught by rule "${v.rule.id}": ${info.text}`);
    failures++;
  }
}
for (const [name, info, expected] of drop) {
  const v = classifyComment(info);
  if (!v.filtered) {
    console.error(`  ✗ MISSED [${name}]${v.protectedBy ? ` (protected: ${v.protectedBy})` : ""}: ${info.text}`);
    failures++;
  } else if (v.rule.id !== expected) {
    console.error(`  ✗ WRONG RULE [${name}] expected ${expected}, got ${v.rule.id}: ${info.text}`);
    failures++;
  }
}

// ── Protections outrank rules, unconditionally ───────────────────────────────
assert.ok(!classifyComment(c("🔥", { likes: 99 })).filtered, "like floor must beat emojiOnly");
assert.ok(!classifyComment(c("lol", { replies: 1 })).filtered, "replies must beat lowEffort");
assert.ok(!classifyComment(c("", {})).filtered, "empty scrape must never be filtered");

// ── Count parsing ────────────────────────────────────────────────────────────
assert.strictEqual(ctx.parseCommentCount("1.2K"), 1200);
assert.strictEqual(ctx.parseCommentCount("3M"), 3_000_000);
assert.strictEqual(ctx.parseCommentCount("412"), 412);
assert.strictEqual(ctx.parseCommentCount(""), 0);
assert.strictEqual(ctx.parseCommentCount(undefined), 0);
assert.strictEqual(ctx.parseCommentCount("12 replies"), 12);

// ── Keys are stable (the allowlist depends on it) ────────────────────────────
assert.strictEqual(ctx.commentKey(c("hello there")), ctx.commentKey(c("hello there")));
assert.notStrictEqual(ctx.commentKey(c("hello there")), ctx.commentKey(c("goodbye there")));
assert.strictEqual(ctx.commentKey(c("x", { id: "Ugz123" })), "Ugz123", "real comment id wins over the hash");

if (failures) {
  console.error(`\n✗ comment filter: ${failures} classification failure(s)`);
  process.exit(1);
}
console.log(`✓ comment filter: ${keep.length} keeps, ${drop.length} drops, protections + parsing + keys`);
// content.js leaves timers/observers running in the VM context, which keeps the
// event loop alive forever. We only test pure functions, so exit explicitly.
process.exit(0);

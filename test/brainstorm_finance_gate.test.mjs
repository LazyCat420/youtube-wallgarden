// Brainstorm domain focus gate: the client sends domainFocus/seedDomains only
// when the user's OWN weighted liked topics justify it. Below the threshold the
// request body must stay byte-identical to the pre-focus shape.
import vm from "node:vm";
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const { get, state, fetchCalls, ctx } = boot();

const topic = (phrase, weight, origin = "like-mined") => ({ phrase, weight, origin });

// ── 1. Weighted share and the ≥0.25 gate ─────────────────────────────
{
  const gate = get("brainstormDomainFocus");
  const mixed = [topic("woodworking", 10), topic("equities", 10), topic("macro", 5), topic("fish tanks", 5)];
  const open = plain(gate(mixed));
  assert.strictEqual(open.share, 0.5, "finance share is weighted (15/30)");
  assert.strictEqual(open.focus, "finance", "share 0.5 opens the gate");
  assert.deepStrictEqual(open.seedDomains, ["equities", "macro"], "seeds are the user's own finance topics, weight-ordered");

  const thin = [topic("woodworking", 10), topic("fish tanks", 10), topic("equities", 1)];
  const closed = plain(gate(thin));
  assert.strictEqual(closed.share, 1 / 21, "thin finance share is weighted");
  assert.strictEqual(closed.focus, null, "share < 0.25 sends no focus");
  assert.deepStrictEqual(closed.seedDomains, [], "share < 0.25 sends no seeds");

  const edge = [topic("fish tanks", 3), topic("equities", 1)];
  assert.strictEqual(plain(gate(edge)).share, 0.25, "exact threshold share");
  assert.strictEqual(plain(gate(edge)).focus, "finance", "share == 0.25 is enough (≥ threshold)");

  console.log("✅ [F1] Weighted finance share gates at FINANCE_MIN_SHARE (0.25)");
}

// ── 2. Unknown / empty likes never open the gate ──────────────────────
{
  const gate = get("brainstormDomainFocus");
  for (const likes of [[], undefined, null]) {
    const out = plain(gate(likes));
    assert.strictEqual(out.share, null, "no liked topics → share unknown");
    assert.strictEqual(out.focus, null, "no liked topics → no focus");
    assert.deepStrictEqual(out.seedDomains, [], "no liked topics → no seeds");
  }
  // Negative / zero weights are not likes.
  const negative = [topic("equities", 0), topic("fish tanks", -2)];
  assert.strictEqual(plain(gate(negative)).share, null, "non-positive weights carry no evidence");

  console.log("✅ [F2] Empty and unknown likes send nothing");
}

// ── 3. Generated topics are guesses, never likes ──────────────────────
{
  const gate = get("brainstormDomainFocus");
  // A brainstormed "equities" guess must not open the gate by itself.
  const guessed = [topic("fish tanks", 10), topic("equities", 6, "brainstorm"), topic("crypto", 5, "seed")];
  const out = plain(gate(guessed));
  assert.strictEqual(out.share, 0, "generated topics are excluded from the share");
  assert.strictEqual(out.focus, null, "a guess cannot open the gate");
  assert.deepStrictEqual(out.seedDomains, [], "a guess cannot become a seed");

  // Hand-added and legacy topics ARE the user's own evidence.
  const hand = [topic("fish tanks", 10), topic("macro", 2, "hand")];
  assert.strictEqual(plain(gate(hand)).share, 2 / 12, "hand topics count");
  assert.strictEqual(plain(gate(hand)).focus, null, "hand share below threshold stays closed");

  console.log("✅ [F3] Generated topics never count as likes");
}

// ── 4. Seeds: deduped, capped at 5, mined only from likes ─────────────
{
  const share = get("financeFocusShare");
  const many = [
    topic("equities", 10), topic("Equities", 9), topic("macro", 8), topic("crypto", 7),
    topic("commodities", 6), topic("earnings", 5), topic("personal finance", 4),
    topic("oil", 3), topic("rates", 2), topic("fish tanks", 1)
  ];
  const out = plain(share(many));
  assert.strictEqual(out.seeds.length, 5, "seed array capped at 5");
  assert.deepStrictEqual(out.seeds, ["equities", "macro", "crypto", "commodities", "earnings"],
    "seeds are the strongest own finance topics, deduped by canonical phrase");
  const liked = new Set(many.map(t => t.phrase.toLowerCase()));
  out.seeds.forEach(s => assert.ok(liked.has(s), `seed "${s}" came from a liked topic`));

  // No synthetic list: no finance likes → no seeds even with plenty of likes.
  const noFinance = plain(share([topic("woodworking", 10), topic("fish tanks", 9)]));
  assert.deepStrictEqual(noFinance.seeds, [], "no finance like → no seeds invented");
  assert.strictEqual(noFinance.share, 0, "zero finance share");

  console.log("✅ [F4] Seeds are mined from likes only, deduped and capped");
}

// ── 5. The request body: absent keys below threshold, present above ───
{
  vm.runInContext(`updateStatusText = function () {};`, ctx);
  const logs = [];
  ctx.console = { log: (...a) => logs.push(a.join(" ")), warn: () => {}, error: () => {}, table: () => {} };
  ctx.window.WG_DEBUG = true;

  const send = async (likes) => {
    state.topics = likes;
    state.settings = { fitRatingEnabled: true };
    fetchCalls.length = 0;
    await get("generateBrainstormTopics")(false, 1);
    assert.strictEqual(fetchCalls.length, 1, "exactly one brainstorm request");
    return { body: JSON.parse(fetchCalls[0].opts.body), url: fetchCalls[0].url };
  };

  const open = await send([topic("woodworking", 10), topic("equities", 10), topic("macro", 5), topic("fish tanks", 5)]);
  assert.strictEqual(open.url, "/api/wallgarden/brainstorm", "posts to the brainstorm endpoint");
  assert.strictEqual(open.body.domainFocus, "finance", "share ≥ 0.25 sends domainFocus");
  assert.deepStrictEqual(open.body.seedDomains, ["equities", "macro"], "share ≥ 0.25 sends the own-like seeds");
  const openLog = logs.find(l => l.includes("[Brainstorm] finance share"));
  assert.ok(openLog, "one log line per request");
  assert.ok(openLog.includes("0.500"), "log states the share");
  assert.ok(openLog.includes("domainFocus=finance"), "log states focus was sent");
  assert.ok(openLog.includes("seeds=2"), "log states the seed count");

  logs.length = 0;
  const closed = await send([topic("woodworking", 10), topic("fish tanks", 10), topic("equities", 1)]);
  assert.ok(!("domainFocus" in closed.body), "share < 0.25 sends no domainFocus key");
  assert.ok(!("seedDomains" in closed.body), "share < 0.25 sends no seedDomains key");
  const closedLog = logs.find(l => l.includes("[Brainstorm] finance share"));
  assert.ok(closedLog && closedLog.includes("domainFocus=none") && closedLog.includes("seeds=0"),
    "log records the closed gate");

  console.log("✅ [F5] Request body carries focus only when the gate opens");
}

console.log("Brainstorm finance gate: all checks passed");

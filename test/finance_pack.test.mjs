// Finance precision pack (Option A): topic policy, pump gate, explore drip
// alternation and the finance stamp on the feed-mix ledger. No backend, no
// sync contract — everything here is local app.js behaviour.
import vm from "node:vm";
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const { get, state, ctx } = boot();

const DAY = 86400e3;

// ── 1. Finance topics resolve to the finance facet set ────────────────
{
  const policy = get("getTopicPolicy");
  const equities = policy("equities");
  assert.ok(equities.includeFacets.includes("earnings"), "equities gets earnings facet");
  assert.ok(equities.includeFacets.includes("fomc"), "equities gets fomc facet");
  assert.ok(equities.includeFacets.includes("etf flows"), "equities gets etf flows facet");
  assert.ok(equities.includeFacets.includes("valuation"), "equities gets valuation facet");
  assert.ok(equities.excludeFacets.length <= 8, "exclude list stays short (≤8)");
  assert.ok(equities.excludeFacets.includes("pump"), "exclude list is pump/scam phrasing");

  // Polysemous presets keyed by the exact miner strings.
  for (const t of ["macro", "commodities", "earnings", "personal finance", "crypto", "market", "rates", "oil"]) {
    const p = policy(t);
    assert.ok(p.includeFacets.includes("cpi"), `${t} gets the finance facets`);
    assert.ok(p.excludeFacets.length <= 8, `${t} exclude list stays short`);
  }

  // Lexicon fallback: a finance-looking topic outside the preset keys.
  const fallback = policy("dividend investing");
  assert.ok(fallback.includeFacets.includes("supply"), "lexicon fallback adds include facets");
  assert.ok(fallback.excludeFacets.includes("guaranteed returns"), "lexicon fallback adds exclude facets");

  console.log("✅ [H1] Finance presets + lexicon fallback resolve include/exclude facets");
}

// ── 2. Non-finance topics are unchanged ───────────────────────────────
{
  const policy = get("getTopicPolicy");
  const fish = policy("fish tanks");
  assert.ok(fish.includeFacets.includes("aquascaping"), "fish tanks keeps its own policy");
  assert.ok(!fish.includeFacets.includes("earnings"), "fish tanks does not get finance facets");

  const oilPainting = policy("oil painting");
  assert.deepStrictEqual(plain(oilPainting.includeFacets), [], "oil painting is not finance");
  assert.deepStrictEqual(plain(oilPainting.excludeFacets), [], "oil painting gets no pump excludes");

  const cooking = policy("cooking");
  assert.deepStrictEqual(plain(cooking.includeFacets), [], "generic topic keeps empty facets");
  assert.strictEqual(get("isFinanceText")("oil painting restoration"), false, "lexicon ignores art oil");

  console.log("✅ [H1] Non-finance topics and polysemous collisions are unchanged");
}

// ── 3. Pump gate rejects scam shapes, liked channels exempt ───────────
{
  const gate = get("isSpamShapedVideo");
  const liked = new Set(["trusted trader"]);
  const base = { id: "s1", channelName: "Pump Channel", viewCount: 500000, duration: 600, published: Date.now() };

  const cases = [
    "Bitcoin 100x guaranteed — join now",
    "Join my VIP signal group for guaranteed returns",
    "Claim your airdrop before the presale goes live",
    "Prop firm payout secrets: pass the challenge",
    "Crypto recovery agent: get your money back",
    "Binary options: financial freedom in 30 days"
  ];
  for (const title of cases) {
    assert.strictEqual(gate({ ...base, title }, liked), "finance-scam", `rejects: ${title}`);
  }

  // Rejected before the low-views floor: a 0-view pump is still a pump.
  assert.strictEqual(gate({ ...base, title: "100x guaranteed", viewCount: 0 }, liked), "finance-scam",
    "scam gate runs before low-views");

  // Liked channel exemption: the same title from a followed creator passes.
  assert.strictEqual(gate({ ...base, title: "Bitcoin 100x guaranteed — join now", channelName: "Trusted Trader" }, liked), null,
    "liked channel is exempt from the pump gate");

  // Legit finance news is not a pump.
  for (const title of [
    "Bitcoin hits 100k as ETF flows surge",
    "Fed holds rates: what the FOMC statement means for stocks",
    "Oil prices climb on OPEC supply cuts"
  ]) {
    assert.strictEqual(gate({ ...base, title }, liked), null, `keeps: ${title}`);
  }

  console.log("✅ [H2] Pump titles rejected before the view floor; liked channels exempt");
}

// ── 4. Explore drip alternates only when finance share ≥ 0.25 ─────────
{
  const pick = get("pickExploreDripSeed");
  const topic = (phrase, weight) => ({ phrase, weight, origin: "like-mined" });

  // Finance share 0.5 (2 of 4) → alternates by day.
  const mixed = [
    topic("woodworking", 9),
    topic("equities", 8),
    topic("macro", 4),
    topic("fish tanks", 2)
  ];
  assert.deepStrictEqual(plain(pick(mixed, 2 * DAY)), { seed: topic("equities", 8), mode: "finance" },
    "even day seeds from the strongest finance topic");
  assert.deepStrictEqual(plain(pick(mixed, 3 * DAY)), { seed: topic("woodworking", 9), mode: "overall" },
    "odd day seeds from the strongest overall topic");
  assert.deepStrictEqual(plain(pick(mixed, 4 * DAY)), { seed: topic("equities", 8), mode: "finance" },
    "alternation repeats every other day");

  // Finance share 1/4 = 0.25 exactly → alternates (≥ threshold).
  const quarter = [topic("woodworking", 9), topic("equities", 8), topic("macro", 1), topic("fish tanks", 1)];
  assert.strictEqual(pick(quarter, 2 * DAY).mode, "finance", "share == 0.25 is enough");

  // Finance share below 0.25 → today's behaviour, always overall.
  const thin = [topic("woodworking", 9), topic("equities", 8), topic("fish tanks", 2), topic("synthesis", 1), topic("aquariums", 1)];
  assert.strictEqual(pick(thin, 2 * DAY).mode, "overall", "share < 0.25 keeps overall seed");
  assert.strictEqual(pick(thin, 2 * DAY).seed.phrase, "woodworking");

  // No finance like-mined topic → never invented.
  const noFinance = [topic("woodworking", 9), topic("fish tanks", 2)];
  assert.deepStrictEqual(plain(pick(noFinance, 2 * DAY)), { seed: topic("woodworking", 9), mode: "overall" },
    "no finance topic → unchanged behaviour");

  // Integration: maybeRunExploreDrip passes the picked seed to the expander.
  vm.runInContext(`generateTopicsForSeeds = async function (seeds) { globalThis.__dripSeeds = seeds.slice(); return []; };`, ctx);
  state.topics = mixed;
  state.exploreDripAt = 0;
  state.settings = { muteShorts: false };
  get("maybeRunExploreDrip")();
  await new Promise(r => setTimeout(r, 0));
  assert.deepStrictEqual(plain(ctx.__dripSeeds), ["equities"], "drip expansion uses the finance seed on an even day");

  console.log("✅ [H3] Explore drip alternates only when finance share ≥ 0.25");
}

// ── 5. recordFeedShown stamps the finance flag ────────────────────────
{
  const record = get("recordFeedShown");
  state.feedMix = { shown: [] };
  record([
    { id: "f1", title: "Q3 earnings: guidance raised", channelName: "Market Desk", _topic: "equities", published: Date.now(), viewCount: 5 },
    { id: "n1", title: "Restoring a 1962 bandsaw", channelName: "Shop Time", _topic: "woodworking", published: Date.now(), viewCount: 5 },
    { id: "c1", title: "Weekly recap", channelName: "ETF Flows Weekly", _topic: "macro", published: Date.now(), viewCount: 5 }
  ]);
  const rows = state.feedMix.shown;
  assert.strictEqual(rows.length, 3, "all rows recorded");
  assert.strictEqual(rows[0].finance, true, "finance topic stamps finance:true");
  assert.strictEqual(rows[1].finance, false, "non-finance topic stamps finance:false");
  assert.strictEqual(rows[2].finance, true, "finance channel name stamps finance:true");
  assert.ok(rows.every(r => typeof r.finance === "boolean"), "flag is boolean, not undefined");
  assert.ok(!("syncFinance" in rows[0]) && Object.keys(rows[0]).length === 9,
    "no new sync field — only the local row gains `finance`");

  console.log("✅ [H10] recordFeedShown stamps finance true/false locally");
}

console.log("\nAll Finance Precision Pack tests passed!\n");

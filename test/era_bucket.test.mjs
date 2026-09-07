// Era buckets and the like-derived era prior. Properties, not constants: the
// edges and the default mix can move without touching this file.
import assert from "node:assert";
import { boot, plain } from "./_boot.mjs";

const DAY = 86400e3;
const { get } = boot();
const eraBucketOf = get("eraBucketOf");
const deriveEraPrior = get("deriveEraPrior");
const klDivergence = get("klDivergence");
const ERA_BUCKETS = plain(get("ERA_BUCKETS"));
const ERA_TARGET_MIX = plain(get("ERA_TARGET_MIX"));
const EDGES = plain(get("ERA_EDGES_YEARS"));
const now = Date.UTC(2026, 8, 6);

console.log("Running Era Bucket Tests...\n");

// 1. Monotone in age: walking back in time never moves to a YOUNGER bucket.
{
  let prevIdx = -1;
  for (let days = -30; days <= 20 * 365; days += 7) {
    const b = eraBucketOf(now - days * DAY, now);
    const idx = ERA_BUCKETS.indexOf(b);
    assert.ok(idx >= 0, `real date must land in a real bucket, got ${b}`);
    assert.ok(idx >= prevIdx, `age ${days}d went from ${ERA_BUCKETS[prevIdx]} to ${b}`);
    prevIdx = idx;
  }
  console.log("✅ bucket is monotone in age");
}

// 2. Unknown is unknown — never a real bucket, never "classic".
{
  for (const bad of [null, undefined, 0, NaN, "2019-01-01", -5]) {
    assert.strictEqual(eraBucketOf(bad, now), "unknown", `${String(bad)} must be unknown`);
  }
  console.log("✅ undated → unknown, never a real era");
}

// 3. The approximate-date edge: exactly N years ago reads as the OLDER bucket.
{
  assert.notStrictEqual(eraBucketOf(now - EDGES.recent * 365 * DAY, now), "recent",
    "exactly one year ago (what '1 year ago' becomes) must not read as recent");
  assert.notStrictEqual(eraBucketOf(now - EDGES.mid * 365 * DAY, now), "mid",
    "exactly four years ago must not read as mid");
  assert.strictEqual(eraBucketOf(now - 30 * DAY, now), "recent");
  assert.strictEqual(eraBucketOf(now + 5 * DAY, now), "recent", "a future timestamp is a clock that starts now");
  console.log("✅ N-years-ago edges fall into the older bucket; future → recent");
}

// 4. The prior with no dated likes IS the default; with history it moves toward it.
{
  const p0 = plain(deriveEraPrior([], now));
  for (const b of ERA_BUCKETS) assert.ok(Math.abs(p0[b] - ERA_TARGET_MIX[b]) < 1e-9, `${b} default`);
  const sum = (p) => Object.values(p).reduce((a, x) => a + x, 0);
  assert.ok(Math.abs(sum(p0) - 1) < 1e-9);

  const classicLikes = Array.from({ length: 200 }, () => ({ published: now - 6 * 365 * DAY }));
  const p1 = plain(deriveEraPrior(classicLikes, now));
  assert.ok(p1.classic > ERA_TARGET_MIX.classic, "200 classic likes must raise the classic share");
  assert.ok(p1.classic < 1, "smoothing keeps every bucket above zero");
  for (const b of ERA_BUCKETS) assert.ok(p1[b] > 0, `${b} stays > 0`);
  assert.ok(Math.abs(sum(p1) - 1) < 1e-9);

  const undated = Array.from({ length: 50 }, () => ({ published: null }));
  const p2 = plain(deriveEraPrior(undated, now));
  for (const b of ERA_BUCKETS) assert.ok(Math.abs(p2[b] - ERA_TARGET_MIX[b]) < 1e-9, "undated likes do not count");
  console.log("✅ era prior: default when empty, follows dated likes, ignores undated");
}

// 5. KL is zero at identity, positive otherwise, finite on a missing bucket.
{
  const p = { a: 0.5, b: 0.5 };
  assert.ok(Math.abs(klDivergence(p, { a: 0.5, b: 0.5 })) < 1e-12);
  assert.ok(klDivergence(p, { a: 0.9, b: 0.1 }) > 0);
  assert.ok(Number.isFinite(klDivergence(p, { a: 1 })), "missing bucket is a large finite cost");
  console.log("✅ KL divergence sanity");
}

console.log("\nAll era bucket tests passed.");

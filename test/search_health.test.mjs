// Search path health: the "1-2 results" regressions were silent aborts and
// silent per-video drops. These are wiring checks on the source.
import fs from "node:fs";
import assert from "node:assert";

const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

// 1. The yt-dlp search stream must wait out the scraper's 25s window.
{
  const m = src.slice(src.indexOf("async function fetchTopicSearchDiscovery"));
  const abort = m.match(/controller\.abort\(\), (\d{4,5})\)/);
  assert.ok(abort && Number(abort[1]) >= 30000, `search stream abort too tight: ${abort && abort[1]}ms`);
}

// 2. The HTML fallback's sp token must be single-encoded.
assert.ok(!src.includes("sp=CAI%253D") || src.includes('replace("sp=CAI%253D", "sp=CAI%3D")'), "double-encoded sp token unfixed");

// 3. Per-video drops in the search render path must be counted, not silent.
{
  const append = src.slice(src.indexOf("function appendStreamedDiscoverVideo"));
  assert.ok(/_searchDrops\.push/.test(append), "search drops must be recorded");
  assert.ok(/function wgSearchDrops/.test(src), "wgSearchDrops inspector must exist");
}

console.log("All search health tests passed.");

// Prism exit (2026-10-15): every LLM path must target lazy-agent-service
// (:5591), never prism-service (:7777). Wiring checks on the source + nginx.
import fs from "node:fs";
import assert from "node:assert";

const src = fs.readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
const nginx = fs.readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");

// 1. The client's default LLM endpoint is the gateway's /agent/ proxy.
assert.ok(src.includes('llmEndpoint: "/agent/"'), "default llmEndpoint must be /agent/");
assert.ok(!src.includes('llmEndpoint: "/prism/"'), "stale /prism/ default must be gone");

// 2. Stored "/prism/" settings migrate to "/agent/" on load.
assert.ok(/state\.settings\.llmEndpoint === "\/prism\/"/.test(src),
  "stored /prism/ endpoints must be migrated to /agent/");

// 3. nginx proxies /agent/ to lazy-agent-service :5591 and nothing to :7777.
assert.ok(/location \/agent\/ \{[\s\S]*?proxy_pass http:\/\/10\.0\.0\.16:5591;/.test(nginx),
  "nginx /agent/ must proxy to lazy-agent-service :5591");
assert.ok(!nginx.includes("10.0.0.16:7777"), "nginx must not proxy to prism :7777");

// 4. No production code path may reference the prism proxy port.
assert.ok(!src.includes(":7777"), "app.js must not reference prism :7777");

console.log("All agent-gateway wiring tests passed.");

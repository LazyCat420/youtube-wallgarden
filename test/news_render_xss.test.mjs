// RSS news cards: every feed field is attacker-controlled, so title, link,
// channel name and description must be escaped, and only http(s) links may
// become anchors. Before the fix they went into innerHTML raw, and the
// description tag-strip (/<[^>]+>/) let an unclosed `<img src=x onerror=...`
// through.
import assert from "node:assert";
import { boot } from "./_boot.mjs";

const { get } = boot();
const safeHttpUrl = get("safeHttpUrl");
const newsDescriptionText = get("newsDescriptionText");
const header = get("newsCardHeaderHTML");

// 1. Only http(s) links survive.
assert.strictEqual(safeHttpUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
assert.strictEqual(safeHttpUrl("  http://example.com/  "), "http://example.com/");
for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.example/x", "", null, undefined]) {
  assert.strictEqual(safeHttpUrl(bad), "", `must reject ${bad}`);
}
console.log("✅ safeHttpUrl keeps http(s) only");

// 2. A javascript: link renders no anchor at all.
{
  const html = header({ title: "Hi", link: "javascript:alert(1)", channelName: "Src", published: 0, description: "d" });
  assert.ok(!html.includes("<a "), "no anchor for a non-http link");
  assert.ok(!html.toLowerCase().includes("javascript:"));
}
console.log("✅ non-http link renders as plain text");

// 3. Markup in every field is escaped.
{
  const evil = '<img src=x onerror="alert(1)">';
  const html = header({
    title: evil,
    link: 'https://example.com/"onmouseover="alert(1)',
    channelName: evil,
    published: 0,
    description: newsDescriptionText('<p>ok</p><img src=x onerror=alert(1)//'),
  });
  assert.ok(!/<img/i.test(html), "no live <img> tag");
  assert.ok(!/<a [^>]*"onmouseover=/i.test(html), "href cannot break out of its attribute");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), "title/channel escaped");
  assert.ok(html.includes('rel="noopener noreferrer"'));
}
console.log("✅ title, link, channel and description are escaped");

// 4. The description strip removes an unclosed tag (the old regex missed it).
assert.strictEqual(newsDescriptionText("<b>bold</b> text <img src=x onerror=alert(1)//"), "bold text ...");
console.log("✅ description strip handles unclosed tags");

// 5. In the browser path, DOMParser text is used (entities decoded), and the
//    decoded text is still escaped on render.
{
  const { get, ctx } = boot();
  ctx.DOMParser = class {
    parseFromString(html) {
      const text = html.replace(/<[^>]*>?/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      return { body: { textContent: text } };
    }
  };
  const desc = get("newsDescriptionText")("<p>Tom &amp; Jerry &lt;script&gt;</p>");
  assert.strictEqual(desc, "Tom & Jerry <script>...");
  const html = get("newsCardHeaderHTML")({ title: "t", link: "https://e.x", channelName: "s", published: 0, description: desc });
  assert.ok(html.includes("Tom &amp; Jerry &lt;script&gt;..."));
  assert.ok(!html.includes("<script>"));
}
console.log("✅ DOMParser path decodes entities and output stays escaped");

console.log("\nAll news render XSS tests passed.");

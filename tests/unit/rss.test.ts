import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeFeed } from "../../services/aggregator/src/rss/parse";
const at = "2026-10-02T00:00:00.000Z";
it("removes scripts, HTML, tracking images and dangerous links", () => {
  const f = normalizeFeed(
    readFileSync("tests/fixtures/rss.xml", "utf8"),
    "fixture",
    "テスト",
    at,
  );
  expect(f.status).toBe("ok");
  expect(f.items).toHaveLength(2);
  expect(f.items[0].title).toBe("試験の見出し");
  expect(f.items[0].url).toBe("https://example.com/story");
  expect(f.items[1].url).toBeNull();
  expect(f.items[1].publishedAt).toBeNull();
  expect(JSON.stringify(f)).not.toMatch(
    /script|track.example|javascript|bad\(\)/,
  );
});
it("parses Atom and preserves attribution", () => {
  const f = normalizeFeed(
    readFileSync("tests/fixtures/atom.xml", "utf8"),
    "a",
    "提供元",
    at,
  );
  expect(f.items[0].url).toBe("https://example.com/atom");
  expect(f.items[0].sourceLabel).toBe("提供元");
});
it.each([
  '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
  "<rss><channel>",
  "<random/>",
])("rejects malicious and broken XML", (xml) =>
  expect(normalizeFeed(xml, "x", "x", at).status).toBe("error"),
);
it("bounds headlines/items and deduplicates normalized URL", () => {
  const xml =
    "<rss><channel>" +
    Array.from(
      { length: 30 },
      (_, i) =>
        `<item><guid>${i}</guid><title>${"長".repeat(400)}</title><link>https://example.com/${Math.floor(i / 2)}#${i}</link></item>`,
    ).join("") +
    "</channel></rss>";
  const f = normalizeFeed(xml, "x", "x", at);
  expect(f.items.length).toBe(15);
  expect(f.items[0].title).toHaveLength(300);
});
it("successful empty or unchanged feed is not an error", () => {
  const f = normalizeFeed(
    "<rss><channel><title>empty</title></channel></rss>",
    "x",
    "x",
    at,
  );
  expect(f.status).toBe("ok");
  expect(f.lastSuccessAt).toBe(at);
  expect(f.sourceObservedAt).toBeNull();
});

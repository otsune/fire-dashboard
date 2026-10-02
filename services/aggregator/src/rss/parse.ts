import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createHash } from "node:crypto";
import {
  emptyCommon,
  feedSchema,
  type Feed,
} from "../../../../packages/contracts/src/index";
const array = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
function plain(value: unknown): string {
  const raw =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : value && typeof value === "object"
        ? String((value as Record<string, unknown>)["#text"] ?? "")
        : "";
  return raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function link(value: unknown): string | null {
  try {
    const u = new URL(plain(value));
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      return null;
    u.hash = "";
    return u.href.length <= 2048 ? u.href : null;
  } catch {
    return null;
  }
}
function date(value: unknown): string | null {
  const s = plain(value);
  const n = s ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function normalizeFeed(
  xml: string,
  feedId: string,
  label: string,
  capturedAt: string,
): Feed {
  const base: Feed = {
    ...emptyCommon("error"),
    id: feedId,
    label,
    items: [],
    capturedAt,
    receivedAt: capturedAt,
    errorCode: "invalid_data",
  };
  try {
    if (
      Buffer.byteLength(xml) > 2 * 1024 * 1024 ||
      /<!DOCTYPE|<!ENTITY/i.test(xml) ||
      XMLValidator.validate(xml) !== true
    )
      return base;
    const raw = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: false,
      processEntities: true,
    }).parse(xml);
    const atom = !!raw.feed;
    const container = atom ? raw.feed : raw.rss?.channel;
    if (!container || typeof container !== "object") return base;
    const entries = array(atom ? container.entry : container.item);
    const ids = new Set<string>(),
      urls = new Set<string>();
    const items: Feed["items"] = [];
    for (const unknown of entries) {
      if (!unknown || typeof unknown !== "object") continue;
      const item = unknown as Record<string, unknown>;
      const title = plain(item.title).slice(0, 300);
      if (!title) continue;
      const atomLink = array(item.link).find(
        (v) =>
          v &&
          typeof v === "object" &&
          (!("@_rel" in v) ||
            (v as Record<string, unknown>)["@_rel"] === "alternate"),
      ) as Record<string, unknown> | undefined;
      const url = link(atom ? atomLink?.["@_href"] : item.link);
      const id =
        plain(atom ? item.id : item.guid).slice(0, 2048) ||
        url ||
        createHash("sha256").update(title).digest("hex");
      if (ids.has(id) || (url && urls.has(url))) continue;
      ids.add(id);
      if (url) urls.add(url);
      items.push({
        id,
        title,
        url,
        publishedAt: date(
          atom ? (item.published ?? item.updated) : item.pubDate,
        ),
        sourceLabel: label,
      });
      if (items.length === 20) break;
    }
    return feedSchema.parse({
      ...base,
      status: "ok",
      errorCode: null,
      lastSuccessAt: capturedAt,
      items,
    });
  } catch {
    return base;
  }
}

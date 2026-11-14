import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import MiniSearch from "minisearch";
import { stateDir } from "./config.js";
import { sourceNames, sources, type Document, type Snapshot, type SourceName } from "./knowledge-sources.js";

const folder = join(stateDir, "knowledge");
const maxSnapshot = 24 * 1024 * 1024;
const tokenize = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
const stopWords = new Set(["a", "an", "and", "can", "do", "does", "for", "how", "i", "in", "is", "my", "of", "on", "the", "to", "with"]);
const normalize = (text: string) => tokenize(text).join("");
const aliases = new Map<string, SourceName>([
  ["fivem", "fivem"], ["cfx", "fivem"], ["kqlink", "kq_link"], ["oxlib", "ox_lib"],
  ["oxmysql", "oxmysql"], ["qbox", "qbx"], ["qbx", "qbx"], ["qbxcore", "qbx"],
  ["qbcore", "qbcore"], ["esx", "esx"], ["esxlegacy", "esx"], ["esextended", "esx"],
]);

type Page = Document & { source: SourceName };
type Section = { id: string; page: Page; heading: string; start: number; end: number; content: string };
type Indexed = { id: string; title: string; heading: string; path: string; body: string; exact: string };
type Loaded = { stamp: string; snapshot: Snapshot; pages: Map<string, Page>; sections: Map<string, Section>; index: MiniSearch<Indexed> };
const cache = new Map<SourceName, Promise<Loaded>>();

function sectionList(page: Page) {
  const lines = page.text.split("\n");
  const sections: Section[] = [];
  let heading = page.title;
  let start = 0;
  let codeFence: string | undefined;
  function emit(end: number) {
    if (end <= start) return;
    const content = lines.slice(start, end).join("\n");
    if (!content.trim()) return;
    sections.push({ id: page.id + "#" + (start + 1), page, heading, start: start + 1, end, content });
  }
  for (const [i, line] of lines.entries()) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence && (!codeFence || fence[0] === codeFence[0])) {
      codeFence = codeFence ? undefined : fence;
    }
    const header = !codeFence && page.kind === "guide" ? /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(line)?.[1] : undefined;
    if (header || (page.kind !== "native" && i - start >= 55)) {
      emit(i);
      if (header) heading = header;
      start = i;
    }
  }
  emit(lines.length);
  return sections;
}

function build(source: SourceName, snapshot: Snapshot, stamp: string): Loaded {
  const index = new MiniSearch<Indexed>({
    fields: ["title", "heading", "path", "body", "exact"],
    tokenize,
    processTerm: term => stopWords.has(term) ? null : term,
    searchOptions: { boost: { title: 2, heading: 4, path: 1, exact: 12 }, prefix: true },
  });
  const pages = new Map<string, Page>();
  const sections = new Map<string, Section>();
  for (const doc of snapshot.documents) {
    if (!doc.id || typeof doc.text !== "string" || typeof doc.title !== "string") throw new Error("Invalid cached document");
    const page = { ...doc, source };
    pages.set(doc.id, page);
    for (const section of sectionList(page)) {
      sections.set(section.id, section);
      const symbols = [page.title, section.heading, ...(page.keywords ?? "").split(/\s+/)];
      const codeSymbols = section.content.match(/(?:\bfunction\s+|\bexports\(\s*['"])[A-Za-z_][\w.:]*/g) ?? [];
      symbols.push(...codeSymbols.map(symbol => symbol.replace(/^(?:function\s+|exports\(\s*['"])/, "")));
      index.add({ id: section.id, title: page.title, heading: section.heading, path: page.path ?? "",
        body: section.content, exact: symbols.map(normalize).join(" ") });
    }
  }
  return { stamp, snapshot, pages, sections, index };
}

async function load(source: SourceName) {
  const path = join(folder, source + ".json");
  const info = await stat(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!info) return undefined;
  if (info.size > maxSnapshot) throw new Error("Knowledge snapshot exceeds size limit");
  const stamp = info.mtimeMs + ":" + info.size;
  const previous = cache.get(source);
  if (previous) {
    const loaded = await previous.catch(() => undefined);
    if (loaded?.stamp === stamp) return loaded;
    if (cache.get(source) !== previous) return cache.get(source);
  }
  const pending = readFile(path, "utf8").then(raw => {
    const snapshot = JSON.parse(raw) as Snapshot;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.documents)) throw new Error("Unsupported knowledge snapshot");
    return build(source, snapshot, stamp);
  });
  cache.set(source, pending);
  return pending;
}

function reference(page: Page) {
  const { id, source, title, kind, url, path, apiSet, revision } = page;
  return { id, source, title, kind, url, path, apiSet, revision };
}

export async function knowledgeSources() {
  const results = await Promise.all(sourceNames.map(async source => {
    const path = join(folder, source + ".json");
    try {
      const info = await stat(path);
      if (info.size > maxSnapshot) throw new Error("Knowledge snapshot exceeds size limit");
      const snapshot = JSON.parse(await readFile(path, "utf8")) as Snapshot;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.documents)) throw new Error("Unsupported knowledge snapshot");
      const counts = { guide: 0, native: 0, local_source: 0 };
      for (const doc of snapshot.documents) counts[doc.kind]++;
      return { source, ...sources[source], ready: true, updated: snapshot.updated, documents: snapshot.documents.length, counts };
    } catch (error) {
      return { source, ...sources[source], ready: false, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "Run npm run knowledge:sync" : String(error) };
    }
  }));
  return { sources: results };
}

function excerpt(section: Section, query: string) {
  const terms = tokenize(query).filter(term => !stopWords.has(term));
  const compact = normalize(query);
  const lines = section.content.split("\n");
  const scores = lines.map(line => {
    const tokens = new Set(tokenize(line));
    const exact = compact.length >= 4 && normalize(line).includes(compact);
    return Number(exact) * 4 + terms.filter(term => tokens.has(term)).length;
  });
  const best = scores.indexOf(Math.max(...scores));
  const start = Math.max(0, best - 1);
  return { line: section.start + best, excerpt: lines.slice(start, start + 6).join("\n").trim().slice(0, 750) };
}

export async function searchKnowledge(query: string, source: SourceName | undefined, limit: number, kind?: Document["kind"], apiSet?: Document["apiSet"]) {
  const explicit = /\b(fivem|cfx|kq[ _-]?link|ox[ _-]?lib|oxmysql|qbox|qbx(?:[ _-]?core)?|qb[ _-]?core|esx(?:[ _-]?legacy)?|es[ _-]?extended)\b/gi;
  const mentioned = new Set([...query.matchAll(explicit)].map(match => aliases.get(normalize(match[0]))).filter(source => source !== undefined));
  const selected = source ? [source] : mentioned.size === 1 ? [...mentioned] : sourceNames;
  const filtered = query.replace(explicit, " ").trim();
  const search = filtered && tokenize(filtered).some(term => !stopWords.has(term)) ? filtered : query;
  const compact = normalize(search);
  const unavailable: SourceName[] = [];
  const found = await Promise.all(selected.map(async key => {
    const loaded = await load(key).catch(() => undefined);
    if (!loaded) { unavailable.push(key); return []; }
    const matches = loaded.index.search({ combineWith: "OR", queries: [
      { combineWith: "AND", queries: [search] },
      { combineWith: "AND", queries: [compact], fields: ["exact"], boostDocument: () => 2 },
    ] });
    const target = tokenize(search).at(-1) ?? "";
    const sections = matches.map(match => {
      const section = loaded.sections.get(String(match.id))!;
      const headerTerms = tokenize(section.heading);
      const shortExact = target.length >= 4 && headerTerms.at(-1) === target && compact.endsWith(normalize(section.heading));
      const fullExact = [section.heading, section.page.title, ...(section.page.keywords ?? "").split(/\s+/)]
        .some(value => normalize(value) === compact);
      return { section, score: match.score + (fullExact ? 100 : shortExact ? 70 : 0) };
    })
      .filter(({ section }) => (!kind || section.page.kind === kind) &&
        (!apiSet || section.page.apiSet === apiSet || (apiSet !== "shared" && section.page.apiSet === "shared")));
    return sections.sort((a, b) => b.score - a.score).slice(0, limit * 4);
  }));
  const sorted = found.flat().sort((a, b) => b.score - a.score);
  const seen = new Map<string, number>();
  const results = [];
  for (const { section } of sorted) {
    const key = section.page.source + ":" + section.page.id;
    const hits = seen.get(key) ?? 0;
    if (hits >= 2) continue;
    seen.set(key, hits + 1);
    results.push({ ...reference(section.page), section: section.heading, ...excerpt(section, search) });
    if (results.length === limit) break;
  }
  return { results, unavailable: unavailable.sort() };
}

export async function readKnowledge(source: SourceName, id: string, from: number, lines: number) {
  const loaded = await load(source);
  if (!loaded) throw new Error("Source is not cached. Run npm run knowledge:sync -- " + source);
  const page = loaded.pages.get(id);
  if (!page) throw new Error("Unknown knowledge document. Use knowledge_search first");
  const all = page.text.split("\n");
  if (from > all.length) throw new Error("Starting line is beyond the document");
  const output: string[] = [];
  let chars = 0;
  for (const line of all.slice(from - 1, from - 1 + lines)) {
    const bounded = line.length > 4000 ? line.slice(0, 4000) + " …" : line;
    if (chars + bounded.length + 1 > 12000) break;
    output.push(bounded);
    chars += bounded.length + 1;
  }
  const next = from + output.length;
  return { ...reference(page), from, totalLines: all.length, next: next <= all.length ? next : null, content: output.join("\n") };
}
